# Harness 兼容性与维护

当前目标为 **DSH `0.2.1-rc.5`**，提交 `b830ec950faba0a46dda564be3e2d854afed94f1`。这是固定的适配基线，不随 npm `latest` 或上游分支自动更新；云端内核、原版前端和 Remote ABI 一起升级。

本地 Host 连接插件 0.2.7 支持 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 与 `0.2.1-rc.5`。连接协议仍为 3，旧版 0.2.6 使用同一协议；rc.5 需要更新连接插件的精确版本清单。CI 对四个版本分别启动 npm 发布的原版 Web Host，并以 rc.4、rc.5 的 `desktop` profile 验证桌面 Host 启动方式、原生文件、Git、PTY 与刷新恢复。`engines.dsh` 仍是安装器、Host、中继及 UI 共用的精确清单，不接受未经审查的后续版本。

rc.3（`1f81c047fc48fa190a683e469daa699857e9afe8`）→ rc.4（`504a01a9578abc2c6f1fb896b1dc322c9fe24f66`）→ rc.5 的源码审查覆盖完整 Git diff，包含 GitHub Compare API 的 300 文件截断之后的文件。所有包清单除版本号外没有变化，未增加依赖。Session V4、核心 Agent、权限、预设、WebServer、浏览器认证、Client Modules 与 Host Remote 协议实现未变。

变化包括会话视图标签、DeepSeek 账号目录日志改走 stderr、MCP 服务未声明资源能力时直接返回空列表，以及 rc.5 的思考文本显示：`conversation.chat.reasoning.body` 同时提供原始 `rawText` 与显示用 `text`，原版显示层过滤开头的 `<signature>…</signature>` 元数据；思考原文仍留在原生历史。Weft 不覆写该 Slot，直接构建原版实现。浏览器回归覆盖签名隐藏、Markdown 正文显示、刷新恢复和原始历史保留。第三方思考正文扩展应使用 `text` 渲染，需原始模型输出时使用 `rawText`，参见[上游发布与升级说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)。

upstream.lock.json 固定 commit。服务端插件、模型协议、浏览器内核、UI 控件与样式从同一份源码构建。prepare-upstream.mjs 保留用户现有 checkout，必要时使用独立固定副本；所有公共及内部导入均指向同一副本。管理的副本若版本不匹配或有 tracked 修改则停止。升级需显式审查兼容契约。

| 适配边界 | 职责 |
| --- | --- |
| `packages/harness-runtime`、`apps/worker/src/native-session-host.ts` | 原生 Agent 创建、恢复、turn 生命周期与会话所有权 |
| `packages/native-profile`、`packages/harness-profile` | 原版配置、插件分类、workerd Loader 与装配顺序 |
| `packages/environment-storage`、`packages/control-plane` | 环境本地持久化、预设发布、Session 索引及平台目录 |
| `packages/native-plugins`、`packages/package-install` | 隔离 Host 插件、标准 `dsh.bundle.patch` 安装、版本审批与生命周期 |
| `packages/native-composition` | 原版预设、插件清单、可选 bundle 与平台配置装配 |
| `apps/web/src/official`、`apps/web/src/runtime` | 原版浏览器入口、Weft 环境插件与共享 ESM 导出面 |
| `scripts/generate-official-remotes.mjs` | 从同一份源码生成并校验官方 Remote ABI |
| `scripts/build-official-ui.mjs`、`scripts/prepare-official-boot.mjs` | 使用上游构建预设生成 Client 模块，并用原版解析器验证 Boot Graph |

Weft 实现 Access、DO 存储、Workspace FileSystem、凭据、HTTP/SSE 和发布；上游实现 AgentLoop、Tools、Session、投影、Cordis、Slots、Store 和 UI 原子组件。

浏览器使用原版 Client 装配和工作台，通过生成的 Remote 契约访问所属环境。Weft 以普通插件增加环境入口及平台能力。Host 插件在隔离 Dynamic Worker 中运行，通过明确桥接的服务访问所属会话；未实现能力在插件清单中说明，不因升级自动获得本机或系统访问权限。

升级验收：

1. 审查 Session/Tools/FileSystem/Config/Slot/Store/Renderer 接口及内部 UI 引用路径。
2. 审查构建中版本加载与 provider fetch 两个适配锚点；锚点变化会使构建失败。
3. 执行严格类型检查、workerd 和浏览器生命周期测试，检查 runtime-audit.json 的 Node imports、插件包、UI 与执行依赖。
4. 在 CI 使用脚本模型验证原版工具与插件的真实 workerd 执行、浏览器交互、手机与深色模式。真实模型验证需单独配置凭据，不能把无密钥 CI 当作实模验收。
5. 审查旧发布及持久事件。revision 保留来源 upstream commit；仅允许当前提交及下方列出的已审查来源继续执行，其他版本仍拒绝。旧日志读取不等于允许旧版本运行。

vendor 使用独立声明；上游 repeat-tool-reminder 的 broad-union 类型问题、仅类型引用的 Node Gateway 也通过声明边界消费。生产仍打包原始模块，Weft 核心代码保持严格检查，相关行为由 workerd 测试覆盖。

Cordis 兼容不自动提供浏览器、Node 主机、进程或真实 Shell 能力。扩展任意生态包时先判定宿主需求，建立适配与验收后加入目录。

## alpha.4 / rc.2–rc.4 → rc.5 的兼容范围

`packages/harness-runtime/src/revision.ts` 明确列出已审查的来源：`86a402200d95fecef4529d969836f1fe13c6cb0d`（本项目此前的 `0.2.1-alpha.4`）、`687f282e8625c6b8d11ff58211a90524be2e4317`（`0.2.1-rc.2`）、`1f81c047fc48fa190a683e469daa699857e9afe8`（`0.2.1-rc.3`）和 `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`（`0.2.1-rc.4`）。对比中 Session V4 存储格式、核心 Agent 生命周期和预设文档契约没有源代码变化；Tools 的变化涉及 PTC 提示词与 SDK 呈现，仍使用原版 `run_code` 和现有 function-body 执行方式。

因此旧会话、旧自定义预设可以保留来源记录，在 rc.5 运行时继续执行，无需重写历史、清除配置或重置工作区。原版预设仍按已有的种子归属规则更新，用户修改过的预设保持原样。回归覆盖四种旧来源的历史前缀、升级后继续对话、对象重启、旧自定义预设创建会话和未知版本拒绝。这项许可不代表任意版本的本地 Host 或 Client 协议可以混用。

rc.3 的插件「更多」菜单与草稿复用使用原版实现。API Key 模型目录也使用原版 `/models` 跟随逻辑；workerd 仅把该请求的 `redirect: error` 替换为 `manual`，原版非 2xx 分支继续拒绝重定向，避免转发密钥。CI 验证模型目录请求、重定向拒绝、插件入口与未发送草稿恢复。

本次同时接通原版 `web-deepseek-api` 插件：Web search 配置页可以选择新版 Search / Fetch API，密钥由环境凭据服务解析；默认仍使用原版 Messages 搜索与 HTTP 抓取。workerd 适配仅把不支持的 `redirect: error` 改为 `manual`，原版错误处理拒绝 3xx，不跟随携带凭据的跳转。旧 Messages 搜索、新 Search / Fetch、Code Mode、终端、插件安装、环境生命周期与浏览器界面均由 `ci` 工作流验证。

上游固定提交也是两份容器镜像内容标签的输入。升级需从通过 CI 的同一提交下载镜像制品，发布到自己的账号并更新私有部署配置，再部署 Worker；不得沿用旧标签绕过镜像一致性检查。
