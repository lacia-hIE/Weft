# 原版入口与预设验证

环境入口 `/agents/:environmentId` 默认调用固定上游的 AppWebEntry。Weft 首页只管理环境；环境内的会话、设置、预设选择和动态插件审批使用原版页面。`?ui=transition` 是过渡实现的显式回归入口，不计作官方 UI 验收。

## 实际组合

`packages/native-composition` 使用原版 Loader、AgentPresetRegistry 和配置树。模块来自 `plugin-runtime` 的同一预构建目录；只允许已编译的 `cordis:` 引用及字面配置。Node 模块加载、HMR jobs 和 JavaScript 配置表达式不进入 workerd 运行路径。上游 checkout 不修改，构建 seam 变化会直接失败。

环境持久化 Standard 和 Creator（原版 ID `cordis`），并通过原版设置 schema 保存新任务默认值。列表与声明查看在真实组合上下文和环境文件系统上运行，不启动 Agent、不取得会话写入权。声明查看得到原版 registry 生成的 YAML。

Session 在原版 Agent setup 阶段绑定预设作用域，首轮前选择通过 registry 写入原生事件。创建 header 不重写，当前选择以 projection 为准。预设版本、persona 和插件编写能力冻结在 Session 快照，环境发布新版本不改变已经开始的会话。

## 自动验证范围

`tests/native-composition.test.ts` 包含五个 workerd 用例：

1. 真实列表、激活诊断、配置声明及持久默认选择；无效默认值拒绝保存。
2. 首轮前选择和复用空会话，创建 header 与当前选择分离；环境发布关闭插件编写的新版本后，重启的旧会话仍可用实际 Creator 工具提出审批请求；首轮后拒绝切换。
3. 实际模型协议触发原版 Todo 工具；热读和重启后冷读得到相同投影，读取不调用模型。
4. 注入持久化中断窗口：只有准备边界之后真实提交了选择事件的快照才会提升。注入只存在于测试 Worker，不修改或伪造选择事件。
5. 原版 Loader 的作用域、两种 Todo 策略、空预设、无效模块及表达式诊断、声明查看、首轮锁定和重启恢复；工具不泄漏到宿主根作用域。

`tests/browser/presets.spec.ts` 从默认环境入口操作原版 Settings → Agent presets，查看实际声明、切换默认并刷新，验证已开始会话保留 Creator。新任务在 Hero 中暂选 Creator 后发送，不改变环境的 Standard 默认值。

原生动态插件浏览器用例也通过该原版页面选择 Creator，再由真实 Runner 提出精确版本审批，不依靠过渡配置接口开启编写能力。环境列表用例直接点击 Agent 卡片进入原版页面，并验证 My Agents 往返与会话隔离。

## 2026-10-18 本地结果

| 验证 | 结果 | 本机记录 |
| --- | --- | --- |
| 完整官方构建链、69 个客户端模块与 Worker bundle | 通过 | `.generated/native-preset-full-build.log` |
| 严格 TypeScript 检查 | 通过 | `.generated/native-preset-verified-types.log` |
| 两个 Worker 的 cf 部署预检 | 通过 | `.generated/native-preset-final-dryrun.log` |
| 单元 / workerd 用例 | 60 个独立用例通过 | `.generated/native-preset-unit-summary.json` |
| 普通浏览器流程 | 6 项通过，其中 4 项为原版 UI、2 项为过渡回归 | `.generated/native-preset-final-web2.log` |
| 原版 Inbox 编辑、删除、steer 和刷新恢复 | 1 项通过 | `.generated/native-preset-final-queue.log` |
| 原版 Creator 选择、精确版本审批、Host / Client 调用与生命周期 | 1 项通过 | `.generated/native-preset-final-controlled2.log` |
| 真实 DeepSeek 浏览器流程 | 3 项通过：原版聊天、原版双端插件、过渡 TSX 插件回归 | `.generated/native-preset-final-live.log` |

单元全量首跑为 58 通过、2 失败：旧断言把列表第一项当作 `default`，加入持久的 Standard / Creator 后不再成立。按 ID 查找后，相关两个测试文件的 4 项用例定向重跑全部通过；其余 56 项沿用全量结果。汇总按用例名称去重为 60 项，不将重复执行累计计数。过渡浏览器也明确选择所验证的默认预设。

插件浏览器首跑在默认预设更新尚未完成时刷新，取消了保存请求；修正为等待原版页面显示已保存后再刷新，审批与生命周期用例通过。该调整没有修改生产保存逻辑，也没有绕过页面直接写入配置。

浏览器共 11 个独立用例通过，其中 8 个验证原版 UI，3 个验证过渡入口。真实双端插件用例由 DeepSeek 编写源码，经原版面板批准后在隔离 Host 写入实际文件，再验证 Client 按钮与刷新恢复；没有使用可控模型的结果替代真实模型结果。

## 边界

预设编辑、侧栏静态 Plugins 包管理器和更多权限、文件接口仍待接入。字面配置支持不等于任意 npm 安装；纯 workerd 不提供完整操作系统。旧数据无需兼容或迁移，现有旧对象也没有因新的寻址版本而被物理删除。

本地浏览器使用测试 Access 身份和真实 workerd。真实 DeepSeek 用例验证本地实际模型调用；Cloudflare Git 构建、部署与匿名 Access 跳转验证不替代允许用户在云端登录后的完整运行验收。
