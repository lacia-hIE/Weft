# Harness 兼容性与维护

当前目标为 **DSH `0.2.1-rc.2`**，提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。这是固定的适配基线，不随 npm `latest` 或上游分支自动更新。

本地 Host 连接插件独立支持 `0.2.1-rc.2` 与最新发布的 `0.2.1-rc.3`
（提交 `1f81c047fc48fa190a683e469daa699857e9afe8`）。rc.2 → rc.3 的
WebServer、Client Modules、Connection、Session 存储格式和 Host Remote 协议实现
未变；Client Session 接口仅调整注释。rc.3 的原版客户端包含插件入口菜单与
空白会话草稿复用修复，整体由本机 Host 提供，不混入云端 rc.2 的 Boot Graph。
连接插件的 `package.json` 中 `engines.dsh` 是安装器、Host、中继及 UI 共同使用的
版本清单；CI 对每个支持版本启动 npm 发布的原版，验证真实文件、Git、PTY 与
刷新恢复。此清单不放宽云端保留 revision 的来源检查，也不声明兼容未知后续版本。

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

## alpha.4 → rc.2 的兼容范围

`packages/harness-runtime/src/revision.ts` 明确列出已审查的来源：`86a402200d95fecef4529d969836f1fe13c6cb0d`（本项目此前的 `0.2.1-alpha.4`）。本次对比中 Session V4 存储格式、核心 Agent 生命周期和预设文档契约没有源代码变化；Tools 的变化涉及 PTC 提示词与 SDK 呈现，仍使用原版 `run_code` 和现有 function-body 执行方式。

因此旧会话、旧自定义预设可以保留来源记录，在 rc.2 运行时继续执行，无需重写历史、清除配置或重置工作区。原版预设仍按已有的种子归属规则更新，用户修改过的预设保持原样。回归覆盖保留历史前缀、升级后继续对话、对象重启、旧自定义预设创建会话和未知版本拒绝。这项许可不代表任意版本的本地 Host 或 Client 协议可以混用。

本次同时接通原版 `web-deepseek-api` 插件：Web search 配置页可以选择新版 Search / Fetch API，密钥由环境凭据服务解析；默认仍使用原版 Messages 搜索与 HTTP 抓取。workerd 适配仅把不支持的 `redirect: error` 改为 `manual`，原版错误处理拒绝 3xx，不跟随携带凭据的跳转。旧 Messages 搜索、新 Search / Fetch、Code Mode、终端、插件安装、环境生命周期与浏览器界面均由 `ci` 工作流验证。

上游固定提交也是两份容器镜像内容标签的输入。升级需从通过 CI 的同一提交下载镜像制品，发布到自己的账号并更新私有部署配置，再部署 Worker；不得沿用旧标签绕过镜像一致性检查。
