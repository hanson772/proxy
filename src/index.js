import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';

function getConfigPath() {
  const configArgumentIndex = process.argv.indexOf('--config');
  return configArgumentIndex >= 0
    ? process.argv[configArgumentIndex + 1]
    : path.resolve('config.json');
}

const CONFIG_PATH = getConfigPath();

function readConfig() {
  const configPath = CONFIG_PATH;
  if (!configPath || configPath === '--config') {
    throw new Error('Usage: npm start -- --config <config.json>');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const listenerConfigs = config.listeners ?? [config];
  const listeners = listenerConfigs.map((listener, listenerIndex) => {
    const listenHost = listener.listenHost ?? '127.0.0.1';
    const listenPort = Number(listener.listenPort ?? 1999);
    const enabled = listener.enabled === true;
    const routes = listener.routes ?? (listener.target ? [{ pathPrefix: '/', target: listener.target }] : []);

    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      throw new Error(`Invalid listenPort in listeners[${listenerIndex}]`);
    }
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new Error(`listeners[${listenerIndex}] must define a non-empty routes array`);
    }

    const normalizedRoutes = routes.map((route, index) => {
    const pathPrefix = route.pathPrefix || '/';
    const target = new URL(route.target);
    if (!pathPrefix.startsWith('/')) {
      throw new Error(`listeners[${listenerIndex}].routes[${index}].pathPrefix must start with /`);
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error(`Unsupported target protocol in listeners[${listenerIndex}].routes[${index}]`);
    }
    return { pathPrefix, target };
  }).sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

    return { enabled, listenHost, listenPort, routes: normalizedRoutes };
  });

  console.log(`Loaded config: ${path.resolve(configPath)}`);
  return {
    listeners,
    admin: {
      host: config.admin?.host ?? '127.0.0.1',
      port: Number(config.admin?.port ?? 7890),
    },
  };
}

let appConfig;
try {
  appConfig = readConfig();
} catch (error) {
  console.error(`Config error: ${error.message}`);
  process.exit(1);
}

let { listeners } = appConfig;
const { admin } = appConfig;
const activeSockets = new Set();
let servers = [];
const logs = [];

function addLog(entry) {
  logs.unshift(entry);
  if (logs.length > 1000) logs.pop();
}

function proxyRequest(req, res, routes, listener) {
  const startedAt = Date.now();
  const requestPath = new URL(req.url || '/', 'http://localhost').pathname;
  const route = routes.find(({ pathPrefix }) =>
    requestPath === pathPrefix || requestPath.startsWith(`${pathPrefix.replace(/\/$/, '')}/`),
  );

  if (!route) {
    addLog({ time: new Date().toISOString(), port: listener.listenPort, method: req.method, path: req.url, status: 404, duration: Date.now() - startedAt, target: '-' });
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('No proxy route matched this path\n');
    return;
  }

  const targetClient = route.target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: route.target.host };
  const options = {
    protocol: route.target.protocol,
    hostname: route.target.hostname,
    port: route.target.port || undefined,
    method: req.method,
    path: req.url || '/',
    headers,
  };

  console.log(`${req.method} ${req.url} -> ${route.target.origin}${options.path}`);

  const upstream = targetClient.request(options, (upstreamRes) => {
    addLog({ time: new Date().toISOString(), port: listener.listenPort, method: req.method, path: req.url, status: upstreamRes.statusCode, duration: Date.now() - startedAt, target: route.target.origin });
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.setTimeout(30_000, () => {
    upstream.destroy(new Error('upstream request timed out'));
  });

  upstream.on('error', (error) => {
    addLog({ time: new Date().toISOString(), port: listener.listenPort, method: req.method, path: req.url, status: 502, duration: Date.now() - startedAt, target: route.target.origin, error: error.message });
    console.error(`Proxy error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`Bad Gateway: ${error.message}\n`);
  });

  req.pipe(upstream);
}

function startListeners(nextListeners) {
  listeners = nextListeners;
  servers = [];
  for (const listener of listeners.filter((item) => item.enabled)) {
    const server = http.createServer((req, res) => proxyRequest(req, res, listener.routes, listener));
    servers.push(server);
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });
  server.on('error', (error) => {
    console.error(`Server error on ${listener.listenHost}:${listener.listenPort}: ${error.message}`);
    process.exitCode = 1;
  });
  server.on('clientError', (error, socket) => {
    console.error(`Client error: ${error.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
    server.listen(listener.listenPort, listener.listenHost, () => {
      console.log(`Proxy listening on http://${listener.listenHost}:${listener.listenPort}`);
      for (const route of listener.routes) {
        console.log(`Route ${route.pathPrefix} -> ${route.target.origin}`);
      }
    });
  }
}

function stopListeners() {
  const closingServers = servers;
  servers = [];
  return Promise.all(closingServers.map((server) => new Promise((resolve) => {
    server.close(() => resolve());
  })));
}

startListeners(listeners);

let reloadTimer;
fs.watch(getConfigPath(), () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      const nextConfig = readConfig();
      await stopListeners();
      startListeners(nextConfig.listeners);
      console.log('Config reloaded successfully');
    } catch (error) {
      console.error(`Config reload failed, keeping current config: ${error.message}`);
    }
  }, 300);
});

const adminServer = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ listeners: listeners.map(({ enabled, listenHost, listenPort, routes }) => ({ enabled, listenHost, listenPort, routes: routes.map(({ pathPrefix, target }) => ({ pathPrefix, target: target.origin })) })) }));
    return;
  }
  if (req.url === '/api/logs') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(logs));
    return;
  }
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return;
  }
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: '配置已保存，正在热更新' }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: `配置保存失败：${error.message}` }));
      }
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ADMIN_HTML);
});

adminServer.listen(admin.port, admin.host, () => {
  const adminUrl = `http://${admin.host}:${admin.port}`;
  console.log(`Admin page: ${adminUrl}`);
  if (process.platform === 'darwin') execFile('open', [adminUrl]);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  stopListeners().then(() => process.exit(0));
  adminServer.close();

  // Existing browser/keep-alive connections can otherwise keep the process
  // alive indefinitely and leave port 1999 occupied.
  setTimeout(() => {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    process.exit(0);
  }, 1_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Proxy Monitor</title><style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#222;background:#f6f7f9}h1{margin-top:0}.layout{display:grid;grid-template-columns:minmax(360px,1fr) minmax(500px,2fr);gap:16px;align-items:start}.card{background:white;border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 4px #0001}.card-title,.details-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-title h2{margin:0}.listener,.route{border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0}.route{background:#fafafa}.route-toolbar{text-align:right}input{padding:6px;margin:4px;width:220px}.listener-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.listener-meta input{width:150px}.switch{position:relative;display:inline-block;width:38px;height:22px;vertical-align:middle}.switch input{opacity:0;width:0;height:0}.slider{position:absolute;inset:0;background:#bbb;border-radius:22px;cursor:pointer;transition:.2s}.slider:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:white;border-radius:50%;transition:.2s}.switch input:checked + .slider{background:#1677ff}.switch input:checked + .slider:before{transform:translateX(16px)}details{margin-top:12px}summary{cursor:pointer;font-weight:600;padding:6px 0;list-style:none}.chevron{display:inline-block;margin-right:6px;transition:transform .15s}details[open] .chevron{transform:rotate(90deg)}button{padding:6px 10px;margin:4px;cursor:pointer}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #eee;font-size:12px}th{color:#666}.ok{color:#16803c}.bad{color:#c62828}.loading{color:#666;margin-left:8px}code{white-space:pre-wrap}@media(max-width:900px){.layout{display:block}}</style></head>
<body><h1>代理监控</h1><div class="layout"><div><div id="status" class="card">正在加载...</div><div class="card"><div class="card-title"><h2>代理配置</h2><div><button onclick="addListener()">添加监听端口</button><button onclick="saveConfig()">保存刷新</button><span id="message"></span></div></div><div id="configForm"></div></div></div><div class="card"><h2>请求日志</h2><table><thead><tr><th>时间</th><th>端口</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>目标</th></tr></thead><tbody id="logs"></tbody></table></div></div>
<script>let model={listeners:[]};function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}function render(){document.querySelector('#configForm').innerHTML=model.listeners.map((l,i)=>'<div class="listener"><b>监听器 '+(i+1)+'</b><div class="listener-meta"><span>地址</span><input data-k="host" data-i="'+i+'" value="'+esc(l.listenHost)+'"><span>端口</span><input type="number" data-k="port" data-i="'+i+'" value="'+(l.listenPort??'')+'"><label class="switch"><input type="checkbox" data-k="enabled" data-i="'+i+'" onchange="toggleListener('+i+',this.checked)" '+(l.enabled?'checked':'')+'><span class="slider"></span></label><button onclick="removeListener('+i+')">删除</button></div><details><summary><span class="chevron">▶</span>路径规则（'+l.routes.length+'）</summary><div class="route-toolbar"><button type="button" onclick="event.preventDefault();event.stopPropagation();addRoute('+i+')">添加转发规则</button></div>'+l.routes.map((r,j)=>'<div class="route">路径：<input data-k="path" data-i="'+i+'" data-j="'+j+'" value="'+esc(r.pathPrefix)+'">目标：<input data-k="target" data-i="'+i+'" data-j="'+j+'" value="'+esc(r.target)+'"><button onclick="removeRoute('+i+','+j+')">删除规则</button></div>').join('')+'</details></div>').join('')}function sync(){document.querySelectorAll('[data-k]').forEach(e=>{const i=+e.dataset.i,j=e.dataset.j===undefined?null:+e.dataset.j,k=e.dataset.k;if(j===null){model.listeners[i][k==='host'?'listenHost':k==='port'?'listenPort':'enabled']=k==='port'?(e.value===''?'':+e.value):k==='enabled'?e.checked:e.value}else{model.listeners[i].routes[j][k==='path'?'pathPrefix':'target']=e.value}})}function duplicateListener(){const seen=new Set();for(const l of model.listeners){if(!l.listenHost||!l.listenPort)return '地址和端口不能为空';const key=l.listenHost+':'+l.listenPort;if(seen.has(key))return key;seen.add(key)}return null}function validateConfig(){const duplicate=duplicateListener();if(duplicate)return duplicate;for(const l of model.listeners){const paths=new Set();for(const route of l.routes){if(!route.pathPrefix)return '路径不能为空';if(paths.has(route.pathPrefix))return '路径重复：'+route.pathPrefix;paths.add(route.pathPrefix)}}return null}function addListener(){sync();const validationError=validateConfig();if(validationError){showMessage(validationError.startsWith('地址')?validationError:validationError.startsWith('路径')?validationError:'地址和端口重复：'+validationError,false);return}model.listeners.push({enabled:false,listenHost:'',listenPort:'',routes:[{pathPrefix:'/',target:'http://localhost:3000'}]});render()}function removeListener(i){sync();model.listeners.splice(i,1);render()}function addRoute(i){sync();model.listeners[i].routes.push({pathPrefix:'',target:''});render();const details=document.querySelectorAll('#configForm details')[i];if(details)details.open=true}function removeRoute(i,j){sync();model.listeners[i].routes.splice(j,1);render();const details=document.querySelectorAll('#configForm details')[i];if(details)details.open=true}function toggleListener(i,enabled){model.listeners[i].enabled=enabled;saveConfig(false)}function showMessage(text,ok){const m=document.querySelector('#message');m.textContent=text;m.className=ok?'ok':'bad'}async function loadConfig(){model=await fetch('/api/config').then(r=>r.json());if(!model.listeners)model.listeners=[model];render()}async function saveConfig(doSync=true){if(doSync)sync();const validationError=validateConfig();if(validationError){showMessage(validationError.startsWith('地址')?validationError:validationError.startsWith('路径')?validationError:'地址和端口重复：'+validationError,false);return}const m=document.querySelector('#message');m.textContent='更新中…';m.className='loading';try{const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(model)});const x=await r.json();m.textContent=x.success?'已更新':'更新失败：'+x.message;m.className=x.success?'ok':'bad'}catch(e){m.textContent='更新失败：'+e.message;m.className='bad'}}async function refresh(){const s=await fetch('/api/status').then(r=>r.json());document.querySelector('#status').innerHTML='<h2>监听端口</h2>'+s.listeners.map(x=>'<div><b>'+x.listenHost+':'+x.listenPort+'</b> '+(x.enabled?'已启用':'已关闭')+' '+x.routes.map(r=>'<code>'+r.pathPrefix+' → '+r.target+'</code>').join('　')+'</div>').join('');const l=await fetch('/api/logs').then(r=>r.json());document.querySelector('#logs').innerHTML=l.map(x=>'<tr><td>'+new Date(x.time).toLocaleTimeString()+'</td><td>'+x.port+'</td><td>'+x.method+'</td><td>'+x.path+'</td><td class="'+(x.status<400?'ok':'bad')+'">'+x.status+'</td><td>'+x.duration+'ms</td><td>'+x.target+'</td></tr>').join('')}loadConfig();refresh();setInterval(refresh,3000)</script></body></html>`;
