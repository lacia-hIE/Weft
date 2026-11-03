# Dynamic Workers 身份与计费

Weft 按执行语义选择复用范围。复用 ID 只复用代码与可能的热 isolate；持久业务状态继续写入 DO / facet SQLite，不能依赖命中同一 isolate。

## 计费依据

[Cloudflare 定价](https://developers.cloudflare.com/dynamic-workers/pricing/)按每日唯一的「Worker ID + 代码」计创建数。同一天相同 ID、相同代码调用多次只计一次；相同代码不同 ID、相同 ID 不同代码都增加创建数；`.load()` 每次调用都增加创建数。每月含 1,000 个创建计量单位，超出部分每个每日 $0.002。复用不会免除次日的创建计量，也不会免除请求或 CPU。

请求和 CPU 共享 Workers Standard 额度：每月含 1,000 万请求、3,000 万 CPU ms，超出分别为 $0.30 / 百万请求和 $0.02 / 百万 CPU ms；Dynamic Workers 的启动 CPU 也参与计费。普通 RPC 方法调用各计一次请求；从原始 RPC 返回的 `RpcTarget` stub 后续调用共享原 RPC 会话，按官方规则不额外计请求。不能把宿主的一个模型工具调用等同于一条 Cloudflare 请求。

## 各条路径

| 执行路径 | Worker 身份 | 原因 |
| --- | --- | --- |
| 原生编写插件、禁止网络的会话安装包 | 宿主 DO + scope + 插件 + 代码及授权配置 | 重跑和重建不再因随机 runId 新增 Worker |
| 允许网络的会话安装包 | 上述身份 + runId | `globalOutbound` 捕获本次运行的能力，必须随运行更换 |
| 环境后台包 | 宿主 DO + scope + 插件 + 代码及授权配置 + 稳定 activationId | 同一启用批次的重建复用 ID；新启用批次重新绑定出口 |
| 安装检查 | 宿主 DO + scope + 检查插件 + 代码及检查配置 | 不传宿主能力，重复检查可复用代码 |
| Workspace shell | Computer 的 `workspace-shell:<workspace DO ID>:<egress>` | 现有 WorkerShellBackend 已使用 `.get()`，每条 shell 命令不创建新身份 |
| PTC `run_code`、Computer JavaScript 任务 | 每次执行 `.load()` | 任意程序可改写全局变量、内置对象或模块状态；保留每次运行的新 isolate |
| 独立 dynamic-runner 技术验证 | tenant + revision + source + config | 非生产调用路径 |

例如，同一无网络插件在一个会话中每天重启 1,000 次，30 天内创建计量从 30,000 降到 30；代码版本或授权配置变化会增加计量。这是创建数量的估算，实际账单还取决于账户共享额度、其他路径、请求及 CPU。一次性生成的不同程序即使改为代码摘要 ID，也通常不能减少创建数。

## 能力与隔离

`NativePluginPlatform` 分开管理三种身份：

- **Worker 代码身份**：包含真实宿主 DO ID，防止不同租户、环境、会话使用相同业务名称时共享模块全局状态；Kernel 内容先计算一次摘要，避免每次激活重新序列化整个 Kernel。兼容日期、兼容标志和调用限额也参与身份，设置变化时不会命中旧定义。
- **facet 身份**：继续使用 `harness-plugin:<pluginId>`，保留 SQLite 数据与原有停止、取消、删除语义。
- **运行能力身份**：`HOST`、`ACTIVATION` 及服务、配置通过 facet `props` 传入。重新构建 facet 时传入当前能力，不依赖已缓存 Worker 的 `env`。宿主继续验证 plugin/run 或安装启用批次，旧 proxy 不会自动获得新运行的权限。

同一宿主、同一插件的 Worker 模块全局变量可能在重跑后仍存在。插件实例状态应在 factory / `apply` 内初始化；需要可靠恢复的状态写入 storage。不能承诺重新执行 ESM 模块顶层或清空 isolate 全局变量。不同宿主的代码 ID 必须不同，不能为减少账单跨租户共享不可信模块。

## 验证与观测

`tests/dynamic-worker-identity.test.ts` 在真实 Miniflare/workerd 中检查重复运行使用相同代码 ID、新 facet 收到新能力、旧 FS proxy 失效、同名 scope 的不同 DO 不共享模块全局、源码/配置/权限变化更新 ID，以及会话网络出口和环境激活的不同复用边界。原有插件和 Worker Host 用例继续覆盖审批、重建、文件权限、持久存储、后台计时器与取消。

本地检查只证明身份与能力行为，不能证明 Cloudflare 云端计费或 CPU 上限。云端用 Workers 用量面板或官方 GraphQL Analytics 的 `workersInvocationsByOwnerAndScriptGroups.uniq.distinctDynamicWorkerCount` 观察实际创建量，并结合请求和 CPU 用量核对。
