# Plugins 管理与 Agent Loop 配置

本轮继续运行官方 AppWebEntry、Plugins 页面、原版配置表单和变更订阅。Host 适配消费上游生成的 Remote ABI，不修改官方页面或上游 checkout。

## 配置来源和执行

`packages/harness-profile` 的 package manifest、profile 依赖声明和 Cordis patch 是实际部署配置包。原版 `applyEntryPatches` 解析 patch，原版 AgentPreset 模块通过 Loader 挂载预设声明。EnvironmentDO 的预设发布记录覆盖声明配置；初始化也使用该配置包，不另写一套默认插件列表。

`pluginInventory/list` 调用原版 `readPluginInventory`，包括 Loader 的真实 enabled、Fiber phase 及预设组合；读取世界会装配所属环境的真实 FS，不创建 Agent 或取得会话写入权。清单反映当前环境声明，不声称把所有 Session 的保留代际合并为一个常驻 Node 进程。

管理能力由同一 EnvironmentDO 的实际管理 RPC 提供，读取上下文负责组合检查。Session 的保留版本和当前环境声明分别读取，不混为一份热内存状态。

`pluginManager/listBundles` 从配置包与 profile 声明读取名称、版本、依赖选择和实际行，`listPlugins` 从同一 Loader 清单读取可持久控制的条目。配置包是部署内置的必要包，不提供移除；默认预设受保护。管理适配只持有当前环境的读取和发布回调，不获得整个 Namespace。

停用、启用预设通过 EnvironmentDO 的原发布器形成新版本，已有会话保留快照。预设改动推进其依赖的设置修订号并发出原版事件，默认选择变化也会通知插件管理清单；没有用假连接重置代替状态更新。

Agent loop 表单复用上游 Config 的 volatile 部分，仅暴露并行调用上限，schema 拒绝 `agents` factory 数组。保存遵守 CAS 与原生 schema。宿主在 prompt assembly 前更新实际 AgentLoop 的 Volatile 引用；调度器仍由原版执行，工具组捕获一次上限，后续步骤和重启读取新值。

## 验证范围

`tests/native-manager.test.ts` 验证：

1. 原版库存、真实 Fiber 状态、配置包行与保护；停用 Creator、变更事件、重启恢复、新任务拒绝选择，以及原有 Creator 会话继续通过实际 Runner 提出插件审批。
2. 默认预设保护、跨环境独立、无效输入拒绝，以及未知包安装不会报告成功。
3. 并发发布和默认选择维持 CAS，最终默认值一定对应启用预设。
4. 实际模型协议同一步请求两个原生 read 工具。第一个模型请求期间修改并发上限：当前步串行，下一步两个调用均先于结果记录，表明实际调度已经并行；继续验证原生校验、冲突和重启恢复。

`tests/browser/manager.spec.ts` 操作原版 Plugins 页面，查看真实配置包、启停 Creator、刷新恢复、未刷新任务选择器的及时更新，以及其他客户端修改默认值后开关保护的及时更新。原版 Agent loop 表单保存后刷新仍保留值。

## 2026-10-18 本地结果

| 验证 | 结果 | 本机记录 |
| --- | --- | --- |
| 完整官方构建链与最终 Worker bundle | 通过 | `.generated/native-manager-final-build.log`、`.generated/native-manager-verified-bundle.log` |
| 严格 TypeScript | 通过 | `.generated/native-manager-verified-types.log` |
| 两个 Worker 的 cf 部署预检 | 通过 | `.generated/native-manager-verified-dryrun.log` |
| 全量单元 / workerd | 64 项通过，0 失败 | `.generated/native-manager-final-unit.log` |
| 最终显示元数据调整后的管理回归 | 4 项再次通过 | `.generated/native-manager-final-targeted.log` |
| 普通浏览器与最终管理页面回归 | 7 项通过，管理页面再次通过 | `.generated/native-manager-final-web.log`、`.generated/native-manager-final-labels-browser.log` |
| 原版 Inbox 与可控模型的双端插件 | 各 1 项通过 | `.generated/native-manager-final-queue.log`、`.generated/native-manager-final-controlled.log` |
| 真实 DeepSeek 浏览器 | 3 项通过 | `.generated/native-manager-final-live.log` |

浏览器按名称去重共 12 项，其中 9 项使用原版 UI，3 项为显式过渡入口回归。元数据调整把三个相同的技术模块标题改为实际配置的预设名称；针对性重跑未重复计入用例总数。真实模型流程覆盖原版聊天、原版双端 Cordis 插件和过渡 TSX 插件。

## 尚未完成

兼容包的精确 npm 版本安装、隔离构建、产物审批、启停卸载与恢复见 [插件包安装第一版](package-installation.md)。通用原版 bundle、Git/本地/私有源、更新回滚和配置编辑仍需接入；不支持的来源与能力明确拒绝。安装不执行依赖脚本。动态 Cordis 源码包继续走已有的精确版本审批与 facet 执行路径。

本地真实 workerd、模型与页面验证不代替 Cloudflare Access 允许用户登录后的云端完整运行验收。旧数据不要求兼容或迁移。
