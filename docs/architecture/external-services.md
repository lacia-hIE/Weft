# 外部服务设计：Office 转 PDF、插件市场与平台账号

状态：插件市场索引读取及兼容包安装第一版已实现，安装边界与验证见 [插件包安装第一版](../validation/package-installation.md)。Office 转 PDF 和平台账号仍是设计，对应调用返回明确拒绝。

三项能力在 workerd 中不能直接运行，原因各不相同：Office 转 PDF 需要 LibreOffice 进程；插件安装需要解析、打包并执行第三方 npm 代码；平台账号登录需要平台接受 Weft 的回调地址。下面的方案都保留原版服务与官方 UI，只替换无法在 Worker 中运行的那一层；外部组件缺失时仍返回原来的明确拒绝。

## Office 转 PDF

原版 `OfficeToPdf` 自身负责授权读取、来源版本检查、排队、并发、缓存与错误映射，只在 `convertBytes` 中通过 `@deepseek-ai/libreoffice-kit` 的 `createConverter(options).render({inputPath, outputPath}, signal)` 调用 LibreOffice。

方案：

- 用 Cloudflare Containers 运行 LibreOffice headless（镜像内置常用 CJK 与拉丁字体），以 Container Durable Object 绑定到主 Worker（如 `OFFICE_CONVERTER`）。容器只暴露一个内部 HTTP 接口：请求体是源文件字节与扩展名，响应是 PDF 字节与缺失字体列表；无公网入口，不访问工作区。
- 构建时与 `scripts/native-web-platform.mjs` 相同，用平台替换把 `@deepseek-ai/libreoffice-kit` 换成容器转换器：`render` 读取 `inputPath`，把字节发给容器，把结果写到 `outputPath`。原版其余代码不改。临时文件使用 workerd `node:fs` 的 `/tmp`；若当前兼容日期不提供可写 `/tmp`，改为替换 `convertBytes` 所在模块中的文件读写。
- 服务挂在 SessionDO 的原生交互层，依赖已有的 `workspaceFiles` 与 `fs`；`render` 的授权仍由原版 `workspaceFiles.readBytes` 完成，容器看不到路径或会话。
- 原版 `Config` 的 `maxInputBytes`、`maxOutputBytes`、`timeoutMs`、`maxConcurrentConversions` 照常生效；容器侧再设置同样的字节与时间上限，超时由 `signal` 取消请求并让容器丢弃该次转换。
- 没有 `OFFICE_CONVERTER` 绑定的部署保持 `officeToPdf/*` 不可用。

验证：单元测试以服务绑定替身代替容器，覆盖成功、超限、超时与取消、来源版本变化；`official-coverage.spec.ts` 在有绑定时移除 `officeToPdf` 例外；云端验收在官方文件预览中打开 docx、xlsx、pptx。

待确认：Containers 的实例规格与冷启动时间（影响首次预览延迟），镜像体积与字体许可。

## 插件市场

原版 `PluginMarket` 分两部分：

1. 索引：`listIndexes`、`setIndexes`、`search` 只用 `fetch` 读取 JSON 索引并经 Settings 保存索引 URL。已实现：原版服务常驻 EnvironmentDO，`scripts/native-market-platform.mjs` 把解析线程换成同 isolate 解析、把运行时版本固定为构建期常量、把 `redirect: 'error'` 换成 `manual`。上游官方 Web profile 不挂载市场，Discover 页属于默认关闭的实验 bundle。
2. 安装：搜索结果给出每个版本的安装参数，安装进入插件管理，需要获取 npm 包、解析依赖、打包，并执行包内的 Host 代码。

安装方案：

- 获取：Worker 从 npm registry 读取包元数据与 tarball，按元数据中的 `integrity`（sha512）校验；只接受精确版本。
- 打包：在 Container 中运行固定版本的 esbuild，把 Host 入口与依赖打成单个 ESM 模块，把 Client 入口打成浏览器模块；打包环境无网络、无凭据，只接收已校验的 tarball。产物按内容哈希存入环境存储。
- 执行：Host 模块沿用现有动态 Cordis 插件的路径，在隔离的 Dynamic Worker facet 中运行，只能通过既有 RPC 访问 Harness；Client 模块经私有 UI 资产路径加载。审批沿用现有“精确版本审批”，审批对象是包名、版本与 integrity。
- 兼容性：打包阶段检查对 `child_process`、原生扩展、`node:fs` 写入等的依赖；不满足 Dynamic Worker 能力的包在安装前拒绝，并在市场页面显示原因。

当前落地：独立离线构建容器、私有 R2 产物、EnvironmentDO 安装与审批记录、受限 ESM Host facet 和 Client 加载器已接通。安装使用原版 dsh.bundle.patch 和标准 Cordis 导出，保留隔离构建与精确审批；不承诺所有依赖 Node 或未桥接服务的插件可运行；不支持安装脚本、私有源、Git 和本地路径。市场 Discover 页仍按原版实验 bundle 的启用规则处理。

验证：索引阶段用 `https://` 夹具索引测试 `search` 分页、缓存与错误；安装阶段测试 integrity 不符、不兼容包拒绝、审批后 Host 在 facet 中运行、重建后恢复。

## DeepSeek 平台账号

原版 `deepseek-account-platform` 只接受 `http://localhost|127.0.0.1|[::1]:<port>` 形式的 `callbackOrigin`，授权完成后浏览器被重定向回该回环地址。Weft 运行在 HTTPS 域名上，浏览器所在机器没有监听回环端口，因此当前协议无法完成登录。

可行路径只有平台侧改变：

- DeepSeek 平台为 Weft 登记 HTTPS 回调（如 `https://<weft 域名>/v1/account/callback`），或提供设备码登录。
- 平台确认后，Weft 以构建补丁放宽 `callbackOrigin` 校验，只接受该登记地址；回调路由按 tenant 与环境找到发起登录的 EnvironmentDO，完成 PKCE 交换。账号授权作为环境凭据保存在 EnvironmentDO，与现有环境 API key 同等隔离，不进入 SessionDO 或浏览器。
- `getProfile`、`getBalance`、`signOut` 等调用由 EnvironmentDO 代为请求平台。

在平台登记前，模型凭据继续使用环境 API key，`account/*` 保持不可用。
