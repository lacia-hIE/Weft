# 使用本地 DSH 环境

本地模式支持 **DSH 0.2.1-rc.2**。本机运行原版 `dsh web`，安装
`@weft/dsh-local-host` Host 组合包；Weft 提供环境目录、设备配对与出站连接中继。
会话、预设、模型凭据、工作区、Git、终端和插件均由本地 Host 管理。
第一版接入原版 `dsh web` profile；仅有 Desktop IPC 的宿主暂不支持。

## 部署者配置 Cloudflare Access

保留站点现有的 Access 登录策略。另建一个更具体的 Self-hosted Access
application，仅匹配同一域名的 **`/v1/local-hosts/*`**，使用 Bypass 策略。
不要放行 `/v1/tenants/*`、首页、插件下载或其他接口。检查 Access 的路径匹配
优先级，确保设备端点不会收到登录重定向，而网页入口仍要求用户登录。

这两个设备端点使用应用自身认证，不信任浏览器 Cookie 或自报的用户 ID：

- `POST /v1/local-hosts/:tenant/:environment/pair`：256 bit 配对密钥，10 分钟
  有效且仅可交换一次。返回的设备密钥仅属于该租户与环境。
- `GET /v1/local-hosts/:tenant/:environment/connect`：带设备密钥的 TLS
  WebSocket，校验传输版本与 DSH 版本。拒绝浏览器 Origin。

密钥只以 SHA-256 摘要保存在 TenantDO。登记目录仍在平台 D1；云端不创建该
环境的 Harness、SessionDO 或 WorkspaceDO。连接关闭后，运行中的 HTTP 请求
与网页流会结束；中继不会重放命令。设备连接可重试，浏览器使用原版连接恢复。

Cloudflare 是 TLS 终点，中继会处理传输内容；本版不提供端到端加密。每个
租户最多 64 条网页连接、每个中继实例最多 64 个在途 HTTP 请求，正文分块
32 KiB 并逐块确认，文件不会整体读入内存。
本版中继支持的原版 Mux 单条完整消息上限为 4 MiB（与 HTTP 文件正文上限独立），中继编码帧
最多 16 MiB；超限会结束连接，不重放调用。超大历史快照需要后续分页或分帧适配。

## 用户安装

1. 首页选择「连接本地 DSH」，输入名称并生成配置，下载
   `weft-connection.json`。
2. 保存为 `~/.dsh/weft-connection.json`，设置 `chmod 600`。其他位置可通过
   `WEFT_LOCAL_HOST_CONFIG=/absolute/path/weft-connection.json` 指定。
3. 下载页面提供的 `.tgz` 插件包。在本地原版 DSH「插件」页中，以这个文件的
   绝对路径安装组合包。它原生声明 `dsh.bundle.patch`，不需要 Weft 专用安装器。
4. 启用后重新加载或重启 `dsh web`。默认使用回环 HTTP 监听；不要改为公网监听。
   如果启用了本地 HTTPS，应为 Node 配置受信任的本地证书。
5. 回到首页，状态变成可进入后打开本地工作台。

连接插件自动把配对密钥换成设备密钥，以 `0600` 权限原子写回配置文件。
首次配对后无需每次网页登录。为不同电脑或不同本地 profile 使用不同环境和
配置文件；同一环境的新连接会替换旧连接。

「断开连接」会立即撤销设备密钥和所有活动连接。「重新配对」生成新的一次性
配置，也会撤销旧密钥。移除环境只删除 Weft 登记和授权，保留本地文件与进程。
停止本地 DSH 或关闭本地连接插件会停止连接重试。Web 不远程启动已关闭的电脑。

## 插件与版本边界

网页加载本地 Host 生成的完整原版前端、Boot Graph 和客户端插件资源，因此
客户端与 Host 保持同源版本。工作台从环境路径挂载，原版使用相对地址的
`/api/`、`/plugins/`、`/assets/` 路由可以透传。Web 环境与本地环境的数据不会
合并或自动迁移；已有云端环境保持现有行为。

自定义根路径、硬编码站点绝对路径、外部 origin 和客户端 HMR 路由暂不代理。
这类第三方插件需支持挂载路径后接入；安装后的插件和 DSH 升级需重新校验版本。
