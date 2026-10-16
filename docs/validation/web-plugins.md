# Web UI 与 Harness 插件验证

服务端与浏览器固定 Harness commit `86a402200d95fecef4529d969836f1fe13c6cb0d`，从同一个未修改的 checkout 构建。

## 使用流程

1. 通过 Cloudflare Access 登录 Web UI。
2. 在「Agent 预设」配置原生 Todo、时间上下文、重复调用提醒、Skills，发布不可变版本后开始会话。
3. Skills 放入 `/workspace/.agents/skills/<name>/SKILL.md`。官方 skill-filesystem 使用 Weft FileSystem 访问 Computer Workspace；关闭宿主默认目录与 watch。
4. 需要界面扩展时开启「允许 Agent 创建 UI 插件」，发布后开启新会话。Agent 通过官方 `cordis_inspect_list/query` 查询支持的 API，用原生文件工具写 TSX，再调用 `ui_publish_plugin`。
5. 在「UI 插件」审核源码、配置与版本并启用。浏览器原生 Cordis 装配插件；停用销毁 Fiber，官方 SlotRegistry 撤下贡献。

## 官方 UI 复用

实际使用上游 Cordis、SlotRegistry、React renderer、Store、Schemastery、完整 ui-primitives 公共导出、DockKit、DisclosureRow、MarkdownText。代码高亮、复制和公式由官方实现提供。配色、字体、阴影、焦点、滚动条与圆角直接导入 ui-theme。侧栏、输入卡片、空会话、用户气泡、插件页使用上游 CSS module；列宽计算使用上游 computeColumns。

交互采用官方 280px 侧栏、56px 折叠轨道、窄屏折叠、拖动列宽、右侧面板开关、居中空会话输入、运行后底部输入与紧凑工具折叠行。保留 Weft 品牌和托管需要的发布、文件界面。完整官方 Web App 仍依赖 Node 主机与 Remote/WebSocket 图，当前没有原样启动它。

## 存储与权限

- TenantDO 保存租户配置、不可变 Agent/客户端模块版本与 Session 索引。Agent 发布校验 expectedRevision，冲突返回 409。
- Session 固定创建时的 Agent 版本、Workspace 和 upstream commit，后续发布不会暗中改变已有会话。
- 客户端编译只做 Sucrase 转换与 AST import 检查，不在服务端求值。支持单文件 TSX/TS/JS 和明确的共享 ESM imports；没有任意 npm 安装、相对模块图或 Node API。
- 新客户端发布默认停用。启用校验精确 revision；模块获取校验 Access、租户和当前启用版本。React、Cordis 与 Store 共享同一份实例。
- 客户端插件与当前用户页面同权，需用户审核；CSP/import 限制不是浏览器 isolate 沙箱。平台模型密钥和任意租户绑定不会传入客户端。
- `/?safe=1` 跳过插件恢复，可停用错误版本。加载与卸载有期限；同步阻塞浏览器主线程的代码需重新进入安全模式恢复。
- 主 Worker 先验证 ctx.access，再通过 Service Binding 从私有 weft-ui-assets Worker 返回资产，避免 Static Assets 内部路由丢失 ctx.access。资产 Worker 无公网路由、workers.dev 或预览地址，无租户或模型绑定；业务 Worker 不嵌入大体积 UI 资产。资产与源码均为 private/no-store，第三方许可在 /licenses.txt。

## 验证

2026-10-17 验收：35 项 workerd 回归通过；固定源码目录切换后，3 项控制面 / Dynamic Worker 补充测试再次通过。严格类型检查通过。两项浏览器回归通过，覆盖自动 JSX、原生 Store/Config、完整 UI primitives 中的 Markdown 与控件、DockKit、用户消息与历史恢复、文件 CAS、插件卸载、安全模式、移动端和深色模式。真实 DeepSeek 浏览器验证通过（12.3 秒）：模型写入 TSX、发布、用户启用、点击计数器、刷新恢复。

React 的 CommonJS 入口在共享 ESM SDK 中使用显式具名导出，避免 `export *` 丢失 JSX 和 ReactDOM API。客户端 imports 的唯一目录为 `packages/client-plugins/sdk.json`，构建入口与发布编译器共同消费。

```bash
npm run check
npx playwright install chromium
npm run test:web
npm run test:web:live
```

workerd 测试覆盖原生 Todo/Skills、时间上下文、Config、发布冲突、版本冻结、重启、跨租户、编译不求值与精确启用。浏览器测试覆盖挂载/交互/卸载/刷新、Agent 配置、聊天、文件 CAS、原生 Store/Config/控件、错误配置、安全模式、手机布局及深色模式。

真实模型测试从 Web 发送请求，由 DeepSeek 用原生文件工具生成并发布插件，用户启用后点击计数器并刷新恢复。测试桥 tests/browser/server.ts 仅用于本地，生产入口仍为 workerd。显式 WEFT_BROWSER_LIVE=1 才读取 .env 的模型密钥。截图在 dist/web-*.png，失败 trace 在忽略的 test-results/。

本地原生 Access 模拟与真实模型验证不等于云端邮箱验证码登录验证；云端登录后的操作仍需允许用户完成。

参见 [上游兼容性](../architecture/upstream-compatibility.md) 与 [Dynamic runner](dynamic-runner.md)。
