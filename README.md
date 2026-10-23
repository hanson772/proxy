# Local WCS Proxy

基于 Node.js 的本地 HTTP 反向代理，支持多个监听端口、路径转发规则、管理页面、配置热更新和请求日志监控。

## 功能

- 多个监听地址和端口
- 每个监听器配置多条 `pathPrefix` 转发规则
- 支持 HTTP 和 HTTPS 上游地址
- 原样保留 path、query string、HTTP method、请求头和请求体
- 管理页面配置监听器和转发规则
- 监听器启用/关闭开关
- 保存后自动热更新配置，无需重启
- 管理页面显示监听状态和请求日志
- 配置校验：监听地址、端口和规则路径不能为空或重复

## 启动

```bash
npm start
```

程序启动后默认打开管理页面：

```text
http://127.0.0.1:7890
```

管理页面默认只监听本机地址。程序启动时不会自动启用代理监听器，需要在页面中打开监听器开关。

也可以指定配置文件：

```bash
npm start -- --config ./config.json
```

停止程序使用 `Ctrl+C`。不要使用 `Ctrl+Z`，它只会挂起进程，可能继续占用端口。

## 配置文件

配置文件使用 JSON 格式：

```json
{
  "admin": { "host": "127.0.0.1", "port": 7890 },
  "listeners": [
    {
      "enabled": false,
      "listenHost": "127.0.0.1",
      "listenPort": 1999,
      "routes": [
        { "pathPrefix": "/api", "target": "http://api.example.com" }
      ]
    },
    {
      "enabled": false,
      "listenHost": "127.0.0.1",
      "listenPort": 2999,
      "routes": [
        { "pathPrefix": "/", "target": "http://localhost:3000" }
      ]
    }
  ]
}
```

当监听器的 `enabled` 为 `true` 时，程序才会监听对应端口。

访问：

```text
http://127.0.0.1:1999/api/users?id=1
```

会转发到：

```text
http://api.example.com/api/users?id=1
```

## 管理页面

管理页面分为左右两部分：

- 左侧：监听器、端口开关和路径转发规则配置
- 右侧：请求日志、响应状态和耗时

页面支持添加、编辑、删除监听器和转发规则。点击“保存刷新”后会保存配置并触发热更新。日志页面每 3 秒刷新一次。

## 配置热更新

程序会监听配置文件变化。通过页面保存或直接修改 `config.json` 后，程序会重新校验配置并自动重新加载监听器。

如果配置不合法，当前正在运行的配置会继续保留，不会被错误配置覆盖。
