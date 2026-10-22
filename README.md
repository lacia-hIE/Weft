# Weft

在 Cloudflare Workers / Durable Objects 上运行 deepseek-harness，提供租户隔离、持久 Session 和可维护的运行环境适配。

当前支持独立 Harness 环境目录：每个用户可创建多个 Agent 环境，隔离预设、客户端插件、会话与工作区；采用新的数据布局，不迁移旧数据。模型提供商使用官方 `llm-deepseek` 与 `llm-pi-ai` 条目（DeepSeek 以及 OpenAI、Anthropic、Kimi 等第三方提供商，在官方 Models 页配置），并接入官方 Web UI：直接运行固定版本的 upstream Agent Loop，支持工具循环、SSE、取消、SQLite、租户隔离及独立 Computer Workspace。Web 可配置原生 Todo、时间上下文、重复调用提醒与 Skills；Agent 可编写客户端 Cordis 插件，由用户审核启用。技术可行性、生态适配和模块边界优先，成本优化后置。

需要 Node.js 22.19+ 和 Git。

```bash
npm ci
npm run check
```

`check` 会校验或获取 `upstream.lock.json` 固定的 Harness 源码，生成源码解析配置和 vendor 类型声明，然后执行严格类型检查及真实 workerd 集成测试。已有 `deepseek-harness/` checkout 的 commit 不匹配或包含 tracked 修改时，会保留它并使用 `.generated/upstream/<commit>` 的独立固定副本；不覆盖你的上游工作。

本地启动：

```bash
cp .env.example .env
# 填入服务端 DeepSeek API Key；用户登录仍由 Cloudflare Access 负责。
npm run dev
```

浏览器打开本地地址先进入 Agent 列表，选择环境后默认进入官方 Harness Web App。在 Settings → Agent presets 选择 Creator，可让 Agent 编写双端 Cordis 插件；运行版本由用户在原版面板批准。默认选择影响新会话，已开始的会话保留原预设版本。浏览器验证为 `npm run test:web`，真实模型生成插件验证为 `npm run test:web:live`，原版队列交互验证为 `npm run test:web:queue`，原生 Cordis 审批与双端插件交互验证为 `npm run test:web:plugins`，首次需 `npx playwright install chromium`。参见 [Web 插件记录](docs/validation/web-plugins.md)。

本地通过 `cloudflare.config.ts` 的 `access.dev` 模拟开发用户；该配置只用于本地运行，不会授予云端访问权限。无需应用 Token 或 `.dev.vars`。先获取当前用户及个人租户 ID，再发送消息：

```bash
curl http://localhost:8787/v1/me
# 将上一步返回的 tenantId 填入 TENANT_ID。
curl http://localhost:8787/v1/tenants/TENANT_ID/sessions/example/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"调用身份工具"}'
curl http://localhost:8787/v1/tenants/TENANT_ID/sessions/example/events
```

云端使用 Cloudflare Access 邮箱登录和浏览器会话。Worker 优先使用运行时 `ctx.access`；上下文缺失时，验证 Access 签发的请求断言或 `CF_Authorization` 登录 Cookie 的 RS256 签名、issuer、应用 audience 和有效期。验证公钥只从配置的 Access 组织获取；Bearer Token 和客户端邮箱身份头不作为认证依据。两条路径均使用 Access 用户的不可变 ID 派生同一租户，拒绝服务凭据。首期每个 Access 用户有独立个人租户，邮箱不作为租户键，组织成员关系后续接入独立授权层。云端默认模型为 `deepseek-flash`；模型密钥只在服务端配置。`npm run check` 使用确定性模型和模拟 HTTP 响应，不需要模型密钥。

发送消息时增加 `Accept: text/event-stream` 可获取增量事件；省略时返回完整 JSON。正在运行 `npm run dev` 时，可另开终端执行 `npm run test:live`，验证真实模型工具调用、SSE 和会话恢复。

创建文件 Session 时，在消息 JSON 中传入 `workspaceId`（例如 `project`），即可使用原生 `read`、`write`、`edit` 和 `workspace_search`。绑定在 Session 中持久保存，后续请求可省略；同一用户的多个 Session 可绑定同一个 Workspace 共享文件。真实文件工具验证命令为 `npm run test:live:workspace`。

容器模式支持真实 PTY、交互式程序、流式 stdin/stdout/stderr、fd7、终端尺寸调整及前台信号；Worker 模式保留轻量行终端。进程与终端内存状态不跨容器重启恢复，详见 [真实进程与 PTY](docs/architecture/workspace-processes.md)。

容器中的源码和 `.git` 持久化；`node_modules`、`.venv` 和常见工具缓存仅保存在容器本地，避免大量依赖文件同步到数据库，容器替换后按锁文件重建。Worker 和文件侧栏看不到这些本地依赖。同步文件有 256 MiB 单文件限制，大型 Git pack 可能导致克隆失败；不需要完整历史时优先浅克隆或稀疏检出。策略、现有缓存处理及真实容器验证见 [Git 项目与容器工作区](docs/architecture/workspace-git.md)。

官方 Harness 的 Files 侧栏通过原版 `WorkspaceFiles` 读取所属环境的真实文件，支持目录、分页文本、字节预览和变更订阅；具体范围与附件待接入项见 [原版文件验证](docs/validation/native-files.md)。当前按新的原生数据布局开发，不要求保留旧数据兼容或迁移。

官方输入框已接通通用文件上传，回执按 Session 持久化，文件可以随提示词进入原生队列并由真实工具读取，详见 [原版附件验证](docs/validation/native-attachments.md)。图片输入通过 Cloudflare Images 解码并保存到环境的 Computer 卷；原版图片历史、查看器和 DeepSeek Files API 已接通，上传缓存按环境隔离。原生会话的 Agent 还可通过原版 `read_image` 查看工作区已有图片，详见 [原版图片验证](docs/validation/native-images.md)。

官方侧栏已接通会话正文搜索，复用原版搜索控制器、语义文本提取、FTS5 排序和摘要；每个环境独立索引实际已提交的会话日志。目录与控制流基线不再截断到 200 条，搜索不激活冷 Agent，也不取得会话写入权。实现与验证见 [会话搜索](docs/validation/native-session-search.md)。

`Delegator` 预设接入原版子 Agent 执行、层级导航、历史、消息与中断服务。spawn / fork 在所属 workerd 内运行真实 Agent，子日志由根会话所属 DO 保存，按租户和环境寻址；限额使用官方 Settings 表单与 volatile 配置。详见 [原生子 Agent](docs/validation/native-subagents.md)。

预设就是官方 Web 的标准、PTC、极简与创造四个模式（PTC 模式的 `run_code` 程序在每次运行独立的 Dynamic Worker 中执行；极简模式的持久 bash 在命令之间保持变量、别名、函数与工作目录），组成与配置读取自官方预设 patch。标准模式：原版命令（`/compact`、`/plan`、`/goal`、`/feedback`）、上下文压缩、AGENTS.md 指令、Plan 模式、`ask_user_question`、Goal、`present`、`web_search` / `web_fetch`、子 Agent fork、workflow 编排与定时提醒均由原版服务提供。提问与审批通过环境 `$events` 的 waterfall 交给浏览器回答；定时提醒存于 SessionDO，并由 DO Alarm 在对象驱逐后唤醒投递。`@` 文件与会话引用、消息反馈、会话分叉、Skills 目录和模型发现使用原版 Remote 服务。bash、后台作业和官方 Terminal 运行在每个工作区自己的 Dynamic Worker 内的 Computer shell（just-bash）上，允许 curl 访问公网；原版权限预设与审批约束 bash 和文件工具。原版插件市场服务读取环境配置的索引源；Office 转 PDF、通用包安装与 DeepSeek 平台账号登录在 workerd 中不可用，外部服务方案见 [外部服务设计](docs/architecture/external-services.md)。详见 [原版交互服务](docs/validation/native-interaction.md)。

目录职责：

| 路径 | 职责 |
| --- | --- |
| `apps/worker` | HTTP 入口、租户授权、SessionDO 寻址及串行执行 |
| `apps/web` | 原生 Cordis UI、官方控件与样式、会话/插件/文件交互 |
| `apps/assets` | 无公网入口的 UI 资产 Worker；主入口在 Access 鉴权后通过 Service Binding 调用 |
| `packages/control-plane` | TenantDO、不可变 Agent/客户端版本、Session 索引 |
| `packages/plugin-runtime` | 预构建原生插件的模块、Schema、校验与装配目录 |
| `packages/harness-profile` | 实际内置配置包、profile 依赖和 Cordis 声明 patch |
| `packages/native-composition` | 原版 Loader / AgentPresetRegistry、插件清单与持久管理适配 |
| `packages/native-files` | 原版 WorkspaceFiles、会话文件范围、字节附件编码和预览订阅 |
| `packages/native-attachments` | 原版 FileUploads、持久会话回执、不可变 Computer 文件与分块传输 |
| `packages/client-plugins` | TSX 转换、原生 API 检查工具、发布工具 |
| `packages/dynamic-runner` | Dynamic Workers/Cordis 隔离 runner 验证 |
| `packages/native-plugins` | 原版动态 Cordis Runner 的持久注册表、审批与隔离 Host facet 适配 |
| `packages/harness-runtime` | 装配 upstream 插件，通过原有 Agent API 创建、恢复和驱动 Session |
| `packages/workspace` | Computer WorkspaceDO、原生 Harness 文件系统适配、版本冲突与文件 API |
| `packages/model-provider` | 回合期限、模型配置错误与安全的失败映射 |
| `packages/native-models` | 以 Loader 条目挂载官方模型提供商、环境级模型目录与发现、失败脱敏 |
| `packages/native-profile` | 会话与环境世界共用的 `WorkerdLoader` |
| `packages/session-persistence-do` | 实现 upstream `SessionPersistence` 和 `SessionHandle`，管理 SQLite 事件与写入所有权 |
| `packages/native-query` | 原版 SQLite 搜索引擎的 DO 数据库端口、环境范围的只读会话来源与官方搜索控制器 |
| `packages/native-subagents` | 原版子 Agent 管理器、spawn / fork provider 与生成的 Remote 协议接线 |
| `packages/native-storage` | 原版 storage / storage-domain 在 DO SQLite 上的 KV 后端 |
| `packages/native-schedule` | 原版 Schedule 服务、所属会话的 Agent 解析与 DO Alarm 同步 |
| `packages/native-environment` | 环境级原版服务：Remote Access 基线与无进程运行器的作业注册表 |
| `packages/tenant` | Access 用户身份映射、SessionScope 校验和租户限定的对象名称 |
| `scripts` | 固定上游、生成类型声明、构建及依赖审计 |
| `tests` | 在本地 workerd 中执行行为、隔离、存储及恢复测试 |

Harness 装配层不依赖 Cloudflare API；模型适配器、模型路由、工具注册和持久化由宿主注入。原生会话由 SessionDO 热实例持有真实 Agent / Context，跨轮次复用；DO 重建时由 upstream 从持久日志恢复。过渡执行接口使用单次装配，拒绝写入原生会话。

`npm run build` 生成 `dist/worker.js`、依赖清单和 `dist/runtime-audit.json`。测试专用的 `dist/contracts-worker.js` 包含故障注入入口，Wrangler 配置只引用应用 Worker。

```bash
npm run deploy:check
```

上述命令通过 `cf deploy --prebuilt --dry-run` 检查两个 Worker。正式部署使用 `npm run deploy`，或在 build 后运行 `npm run deploy:workers`，顺序用 cf 发布私有 UI 资产与主 Worker。构建通过 Cloudflare 官方 config/build-output-utils 生成标准 Build Output；配置分别在 `cloudflare.config.ts` 与 `apps/assets/cloudflare.config.ts`。

内核验证见 [技术验证记录](docs/validation/kernel.md)，真实模型、SSE 与取消协议见 [模型验证记录](docs/validation/model.md)，工作区、原生文件工具与文件 API 见 [Workspace 验证记录](docs/validation/workspace.md)。原始产品提案见 [产品架构 RFC](WEFT_PRODUCT_ARCHITECTURE.md)。上游许可见 [第三方许可](THIRD_PARTY_NOTICES.md)。

云端入口：[Weft](https://weft.luxuncang.com/)，登录后进入 Web UI；用户与租户信息在 `/v1/me`，健康检查同样受 Access 保护。源码保存在 GitHub，Cloudflare 连接 GitHub 仓库；推送代码到 `main` 会触发 Cloudflare 原生 Git 自动构建和部署，无需 GitHub Actions；也可通过 `cf` 手动部署。部署及鉴权说明见 [部署记录](docs/deployment.md)。

`/agents/:environmentId` 只运行原版 AppWebEntry 与 Web 模块树，会话、模型选择、工作区、设置、环境凭据和全局通知连接真实 DO。SessionDO 热实例保留原生 Agent 上下文，支持持久 Inbox 的排队、编辑、删除和 steer；原生动态 Cordis 插件已接通定义、精确版本审批、Host/Client 调用、停止、移除和重建恢复；服务端 Host 在隔离 Dynamic Worker facet 中执行。原版预设列表、声明查看、默认模式和首轮前选择已接通，并保留原生作用域与版本冻结。Creator（原版 ID `cordis`）开启插件编写；原版 Plugins 页面已接通真实配置包清单、预设条目启停和 Agent loop 并行调用表单；通用包安装与插件市场在 workerd 中不可用。本轮使用全新的 `harness-v1` 数据布局，不迁移旧数据。标准 `npm run build` 包含官方 Remote ABI、原始模块构建和 Boot Graph 生成。范围和验收状态见 [多环境与官方 UI](docs/architecture/agent-environments.md)。

模型配置由用户在各环境的官方 **Settings → Models** 中保存，包括 API Key、模型与 HTTPS endpoint。开发和生产均不读取模型环境变量，也不提供平台共享密钥回退。
