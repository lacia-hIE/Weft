# Harness 兼容性与维护

upstream.lock.json 固定 commit。服务端插件、模型协议、浏览器内核、UI 控件与样式从同一份源码构建。prepare-upstream.mjs 保留用户现有 checkout，必要时使用独立固定副本；所有公共及内部导入均指向同一副本。管理的副本若版本不匹配或有 tracked 修改则停止。升级需显式审查兼容契约。

| 适配边界 | 职责 |
| --- | --- |
| packages/harness-runtime | 原生 Agent 创建、恢复、turn 生命周期 |
| packages/plugin-runtime | 经验证的 workerd 插件目录、Config、装配顺序 |
| packages/control-plane | 租户元数据、不可变发布、Session 索引 |
| packages/client-plugins | 源码转换、官方检查工具、宿主 API 描述与发布工具 |
| apps/web/src/runtime | 共享 React/Cordis/Store 等 ESM 导出面 |
| apps/web/src/upstream-ui.ts | 集中引用上游内部 CSS 与纯 UI API |
| apps/web/src/plugin-host.ts | 原生客户端插件装配、依赖检查与销毁 |
| packages/dynamic-runner | 服务端隔离 runner 实验接口 |

Weft 实现 Access、DO 存储、Workspace FileSystem、凭据、HTTP/SSE 和发布；上游实现 AgentLoop、Tools、Session、投影、Cordis、Slots、Store 和 UI 原子组件。

浏览器宿主提供 slots、uiRenderer、weft，并显式发布空的可选 Session scope。没有伪造完整 hostRemote、ui-session 或 Node 包管理。需要这些服务的生态插件应先适配再开放；缺失 inject 服务会报错。支持的 imports 以 browserImports 为准；WeftBrowserAPI 提供静态契约，不宣称查询实时浏览器。

升级验收：

1. 审查 Session/Tools/FileSystem/Config/Slot/Store/Renderer 接口及内部 UI 引用路径。
2. 审查构建中版本加载与 provider fetch 两个适配锚点；锚点变化会使构建失败。
3. 执行严格类型检查、workerd 和浏览器生命周期测试，检查 runtime-audit.json 的 Node imports、插件包、UI 与执行依赖。
4. 运行真实模型从 Web 生成插件的故事，检查手机、深色模式、配置与发布冲突。
5. 处理旧发布及持久事件。revision 包含 upstream commit；当前拒绝用另一 commit 悄悄执行旧发布。迁移、重新发布后开启新 Session，旧日志仍可读取。

vendor 使用独立声明；上游 repeat-tool-reminder 的 broad-union 类型问题、仅类型引用的 Node Gateway 也通过声明边界消费。生产仍打包原始模块，Weft 核心代码保持严格检查，相关行为由 workerd 测试覆盖。

Cordis 兼容不自动提供浏览器、Node 主机、进程或真实 Shell 能力。扩展任意生态包时先判定宿主需求，建立适配与验收后加入目录。
