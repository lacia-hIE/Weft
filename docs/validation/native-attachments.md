# 原版通用文件附件

`packages/native-attachments` 挂载原版 `FileUploads` 和 Commands，使用实际 NativeSessionHost 的 Agent / Session。上传、回执绑定、回滚 guard、消费后的退休及原版浏览器后台上传器沿用上游实现。图片作为模型输入仍未接入；本阶段不声明完整图片附件能力。

## Host 与协议

原版的 `fileUploads/upload` Remote 处理 canonical base64 回退，JSON transport 上限为 8 MiB。原版 `/api/session/uploadFileBinary` 处理流式字节，在环境内的公开挂载位置为 `/v1/tenants/:tenant/environments/:environment/native/api/session/uploadFileBinary`。它在 JSON RPC 解析之前分流，保留原版 POST、content-type、Session 查询参数及 `{ok,value|error}` 响应。

主 Worker 先验证 Access、环境及同源写入，再把固定 scope 交给对应 SessionDO。SessionDO 再验证寻址和会话身份，使用真实 Agent 的上传服务。它不接受客户端伪造的 scope 头或直接提交的 FileAttachmentRef；提示词文件块只能引用属于当前 Session 的上传回执。文件读取和模型凭据仍属于对应环境。

原版 Connection 的物理服务依赖 Node 传输与认证。这里使用真实的 `AuthenticatedFetchRoutes` Cordis Service 接收原版路由注册，由已经鉴权的私有 binding 调用。没有伪造 `ctx.connection` 或 Peer，也没有引入应用 Bearer Token。构建适配仅替换 FileUploads 的路由注入、缓存所有权与缓存物化；原版回执处理保留不变。原版文件名与路径校验、提示词回执解析 helper 从固定源码提取，不把 Node 本地文件存储或图片解码器打包进 workerd。

## 字节存储

ComputerAttachmentStore 实现原生 AttachmentStore seam。每个文件上传只使用一次 ReadableStream RPC，下载只使用一次流式 Response RPC。父服务按至多 64 KiB 拉取源字节，WorkspaceDO 将传输块合并为 64 KiB 后写入并等待持久确认，背压贯穿整个传输，不聚合完整文件，也不依赖逐块 RPC 调用次数。取消和源异常通过流传递，不跨 RPC 序列化 AbortSignal。传输依据 Cloudflare 的[流式 RPC 契约](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response)。Computer 的 createFileSync / writeRangeSync 直接写持久块，不启用整文件写缓冲。上传没有自定义整文件字节上限，仍受 Cloudflare 的请求、存储和运行资源限制；base64 回退另受 JSON transport 上限约束。

临时文件在工作区读取边界之外的 `/.weft-uploads`，未完成的上传没有公开引用。WorkspaceDO 的 SQLite 保存所属 Session、顺序偏移、文件名和更新时间；错误顺序或其他 Session 的块被拒绝。上传方与存储方分别增量计算 SHA-256，提交核对摘要和字节数，再在同一个 SQLite 事务内发布内容对象、原版命名别名和工作区版本。重试通过摘要复用内容，原文件名仍保留在别名末尾。

发布位置为 `/workspace/.weft/attachments/v1`。`.weft` 是保留的只读系统目录，普通 write / edit / mkdir 均不能修改它。模型通过原生 LLM 文件投影获得实际 Computer 路径，使用原生 read 工具读取；默认工作区搜索跳过系统缓存。上传入队事件保存的是引用，后续 read 工具的结果遵循原版历史语义。

每个工作区最多保留 16 个未完成上传，闲置 24 小时的临时记录在下次开始上传时回收。可处理的源流异常立即执行 abort 清理；进程突然终止留下的临时记录依赖后续回收。已经发布内容但尚未产生回执时可能留下不可达内容对象，完整保留和清理策略仍待实现。

## 回执与提示词

SessionDO SQLite 保存回执、FileAttachmentRef 和接受它的 requestId；实际 Session 对象持有原版服务的实时缓存。绑定字段使用持久代理，保留原版 bindPrompt guard 的提交与回滚。Root 销毁释放实时对象，尚未发送的回执不会因服务端冷启动丢失。

恢复时使用真实 Agent 的 Inbox 和原生事件判定绑定状态：待处理的消息保留绑定；已经消费或移除的回执退休；没有入队事件的未完成绑定恢复为可用。提示词和队列仍由原版 AgentLoop 执行，接受响应等待原生持久化 flush。重复 requestId 在回执退休后仍按原生入队记录去重，不重复触发模型。

原版 ApiSessionList 提供 `imageLimits` 和会话列表元数据投影。当前 `mediaTypes` 为空，图片准入明确不可用；通用文件仍按原字节存储。这与已经接通的工作区图片预览是两个不同能力。

## 验证

`tests/native-attachments.test.ts` 验证实际 workerd 和 Computer 文件：

- 大于 1 MiB 的任意二进制、空文件、文件名清理、内容摘要、不可变写保护、原版 multipart 解码与重复上传。
- 上传回执跨 workerd 重启保存，实际 DeepSeek adapter 的请求带有真实路径，真实 read 工具返回上传内容；消费后的回执拒绝复用，requestId 重试保持幂等。
- 同名 Session 的租户 / 环境隔离、其他 Session 的回执拒绝、同源约束、错误 MIME、缺失 Session 及直接引用注入拒绝。
- 运行中排队文件、移除后的回执退休、取消保留、重启恢复队列及真实模型请求中的文件路径。

`tests/fixtures/contracts-worker.ts` 的专用测试入口执行真实私有 WorkspaceDO RPC 和真实 Computer 存储，不进入生产 Worker：

- 连续 16 次在字节写入后中断，并单独验证 AbortSignal 取消，之后仍能使用全部 staging 槽位；同时验证资源上限。
- 34 MiB 的随机文件以 1 MiB 源块生成，断言上传一次 RPC、下载一次 RPC；流式读回验证完整摘要。中断注入先通过仅测试入口确认实际临时字节已经持久写入。
- 其他 Session、乱序块、错误摘要被拒绝；注入版本表失败时，公开文件、版本和目录整体回滚，原临时字节可重试提交。

`tests/browser/attachments.spec.ts` 使用原版输入框、原版后台 Web Worker 上传器与原版文件标签，在首条提示词前上传 34 MiB 文件并发送，刷新后仍能从原生历史恢复。测试从真实本地文件路径选择附件，避免把 34 MiB 字节经 Playwright 调试协议传入页面；测试桥对原始上传也采用流式转发。浏览器测试读取服务端历史确认摘要，避免依赖已经结束的后台 Worker 的调试 response 对象。

`tests/browser/attachments-live.spec.ts` 把随机校验码只写入上传文件，再要求真实 DeepSeek 使用原生 read 工具读取。验收同时检查真实工具事件、助手回复及刷新后的历史，提示词本身不包含校验码。

完整官方 UI 目标仍在进行中。图片准入、更多附件衍生能力、子 Agent、权限与更多静态插件生命周期需要继续接入；本地模型和页面验证不代替 Access 允许用户登录后的云端运行验收。旧数据不做兼容或迁移。

## 2026-10-18 验收记录

| 验证 | 结果 | 本机记录 |
| --- | --- | --- |
| 完整官方构建、严格 TypeScript、两个 Worker 的 cf 部署预检 | 通过 | `.generated/native-attachments-release-build.log`、`native-attachments-release-final-types.log`、`native-attachments-release-dryrun.log` |
| 单元 / workerd | 全量 73 / 74；修正大目录测试的本地 HTTP 连接处理后，该文件 5 项全部通过，共 74 个独立用例完成验证 | `.generated/native-attachments-release-unit.log`、`native-attachments-release-files-final.log` |
| 常规页面 | 全量 8 项通过；修正 Playwright 文件选择方式后，34 MiB 专项通过，共 9 项 | `.generated/native-attachments-release-web.log`、`native-attachments-release-large-recheck.log` |
| 原版 Inbox、可控模型双端插件 | 各 1 项通过 | `.generated/native-attachments-release-queue.log`、`native-attachments-release-controlled.log` |
| 真实 DeepSeek 页面 | 4 项通过，包含上传文件的真实工具读取 | `.generated/native-attachments-release-live.log` |

独立浏览器用例共 15 项，其中 12 项使用原版 UI，3 项为显式过渡入口。全量运行中出现的失败和修正后的专项结果分别保留，复测不重复计数。选择后的记录为 `.generated/native-attachments-local-validation.json`；允许用户登录后的云端运行仍需单独验收。
