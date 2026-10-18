# 原版图片输入与 DeepSeek Files

原版输入框、图片标签、图库、Lightbox 与 `session/attachment` 使用原生 AttachmentStore 契约。提示词由真实 AgentLoop 入队并消费，事件只保存 ImageAttachmentRef。服务端使用 Cloudflare Images 完整解码并规范化，字节保存在所属环境的 Computer 卷；生产 bundle 不含 Sharp、原版 Node 图片后端或独立 Node 进程。Sharp 仅用于测试输入和独立检查输出像素。

## 准入与存储

支持 PNG、JPEG、WebP、GIF。每张源图最多 **20,000,000 字节**，单条消息最多 20 张、原始字节合计 20 MiB；源图最多 64,000,000 像素、单边 8192。上限先于完整 base64 解码检查，随后沿用原版 canonical base64、所有成员验证及存储流程。`session/prompt` 的 JSON 上限为 30 MiB，为原生 32 MiB RPC frame 留出余量；其他 RPC 和通用文件 base64 回退继续使用各自的限制。

20,000,000 字节是经过真实远端 Images 服务验证的应用配置值，不是对 Cloudflare 所有接口的统一限制声明。远端验证确认该大小能够解码；20 MiB 的同类有效源图被服务拒绝，因此不能将单图限制直接写成 20 MiB。

Images binding 检查声明 MIME 与实际格式、方向后的尺寸和像素上限，完整编码为单帧、8 位 sRGB WebP，保留透明度，剥除 EXIF 和 ICC。GIF 使用第一帧。规范化保持比例并限制在 2048² 像素；4 MiB 是编码目标，按 85 / 75 / 60 质量尝试，不能满足时保留最小的有效输出。逐张验证和编码受原版 CompressionLimiter 限制，不为整个消息缓存所有规范化结果；验证全部输入后才发布文件，输入校验失败的批次不会发布有效前缀。后续编码、存储或入队失败仍可能留下不可达内容对象，完整垃圾回收另行实现。

规范化文件和请求衍生文件复用不可变 SHA-256 内容对象及 `/workspace/.weft/attachments/v1` 只读别名。请求衍生版本的身份包含源摘要、目标宽高、字节目标、编码规则版本和质量序列。WorkspaceDO SQLite 原子发布首个结果；后续读回内容时检查摘要、字节数及 WebP 元数据，冷上下文读取已经存在的版本不需要重新调用 Images。模型请求目标是软字节目标，保持原生返回有效图片的行为。

## 历史读取与模型上传

`session/attachment` 使用生成的原版参数与结果 codec。Access、租户、环境和 Session 寻址验证后，原版引用查找 helper 在实际会话事件中检查附件 ID；仅知道另一会话的摘要不能读取其图片。冷读复用只读会话上下文，不创建 Agent 或取得写入权。

原版 DeepSeekAdapter 获得真实 AttachmentStore、原版图片访问投影和 DeepSeekFileStore。模型接收 Files API 返回的实际 file ID，未将图片改成虚假的文字描述。`EnvironmentUploadIndex` 覆盖原版文件索引的全部公共操作，映射持久保存在当前 EnvironmentDO 的 SQLite；凭据与 endpoint 通过原版哈希函数分隔，索引不保存 API Key。并发上传复用第一个有效发布，过期替换后，旧一代清理不能删除新一代映射。

平台密钥可能由多个租户或环境共享。原版按远端文件名前缀扫描的清理策略不能直接用于此场景；本实现仅删除当前环境、当前凭据命名空间索引中的远端 ID。其他环境不会因为配额恢复而被清理。进程在远端上传成功和索引发布之间终止时，可能留下不在索引内的远端对象，依赖 provider TTL；完整附件保留和垃圾回收仍需实现。

## 工作区图片工具

原生会话配置 Images binding 后，FileTools 注册固定上游的原版 `read_image`，不用自建工具或伪造图片描述。它先要求调用路由明确声明 image 输入，再通过限定在当前环境的 fs 读取有界字节；未知 / 纯文本模型在文件 I/O 前拒绝。图片由同一个 AttachmentStore 完整解码、规范化并持久发布，原版工具结果包含真实图片引用，后续模型请求使用真实 DeepSeek Files 上传。

`tests/native-image-tool.test.ts` 验证真实上传文件、工具执行、请求像素、历史读取和跨会话引用拒绝；还覆盖缺少 codec 时不注册、未声明图片能力的模型、越界路径和伪图片。失败以原版可恢复工具结果返回，不发布图片引用。原版工具执行详情默认折叠，图片沿用原版展开与查看交互。旧消息接口不挂载原生图片存储，因此继续关闭该工具。

`tests/browser/image-tool-live.spec.ts` 只把工作区路径发给真实模型，校验码仍仅存在于图片像素中。验收检查真实 `read_image` 调用、工具结果图片和模型识别；刷新后依次展开执行摘要、图片调用组与单次调用，解码实际图片并打开 / 关闭 Lightbox。点击调用标题展开卡片，点击文件名则打开原版 Files 预览，这是上游的两条不同交互。

## 验证方法

`tests/native-images.test.ts` 在真实本地 workerd 验证原版提示词、摘要和名称、会话读取授权、重启历史、无效批次不发布、四种格式、GIF 第一帧、最大源字节、单条图片数量和合计上限。实际 DeepSeek Files transport 配合确定性 HTTP fixture 验证真实 WebP 上传、模型 file ID、冷启动缓存复用、共享密钥下的环境 / 租户隔离和配额清理。`tests/persistence.test.ts` 通过真实私有 EnvironmentDO RPC 验证并发发布、过期替换、旧代清理、凭据隔离、scope 拒绝及重启恢复。

`tests/browser/images.spec.ts` 在原版 Composer 发送 PNG，刷新后读取原版图片协议，确认实际图片解码和 Lightbox 开关。`tests/browser/images-live.spec.ts` 将随机校验码仅绘制在图片像素中，让真实 DeepSeek 识别；同时检查原生图片事件、助手答案及刷新恢复。

本地 Miniflare 的 Images 模拟对 EXIF 方向、quality 和 anim 的处理与远端不同，不能凭本地通过声称真实服务行为一致。远端验收命令为：

```bash
npm run test:images:remote
```

该命令构建当前代码后，以 `cf dev` 在本机启动测试专用 Worker，连接真实远端 Images binding，Computer / SQLite 留在本地。测试 Worker 不发布、不配置公网入口、不使用应用 Token。验证包括透明 PNG / WebP、JPEG、动态图第一帧、EXIF 旋转、P3 转 sRGB、16 位转 8 位，并独立解码比较实际像素；还覆盖坏输入、尺寸拒绝、缩放几何、质量阶梯、无 codec 的缓存读回、20,000,000 字节和持久内容损坏。选择后的报告保存在 `.generated/native-images-remote-validation.json`。

真实 DeepSeek 与真实 Images 服务分别完成本地 workerd 联调；它们不替代允许用户通过 Access 登录后的云端完整 UI 验收。子 Agent、权限、更多 provider、通用静态插件安装与编辑、环境删除和剩余业务投影仍属于完整官方 UI 目标，不能因为图片功能通过便宣布全部完成。

## 本地验收记录

| 检查 | 已完成范围 | 记录 |
| --- | --- | --- |
| 官方完整构建 | 69 个客户端条目与原版 Boot Graph | `.generated/native-images-release-build.log` |
| workerd 全量 | 80 / 80；合并 Access 修复后，图片与鉴权专项 14 / 14 | `.generated/native-images-release-unit.log`、`native-images-post-access-unit.log` |
| 常规浏览器 | 10 项通过、7 项条件跳过；合并后的启动失败恢复专项另 1 项通过 | `.generated/native-images-release-web.log`、`native-images-post-access-bootstrap.log` |
| 原版 Inbox、动态 Cordis 插件 | 各 1 项通过 | `.generated/native-images-release-queue.log`、`native-images-release-controlled.log` |
| 真实 DeepSeek 浏览器 | 6 项通过：文件工具读取、输入框图片识别、工作区图片工具、双端插件、原版聊天恢复及文件工具编写 UI 插件 | `.generated/native-read-image-release-live.log` |
| 真实远端 Images | 四种格式、四角 EXIF 旋转、色彩 / 透明度、缩放、质量阶梯、冷缓存、字节上限与损坏拒绝通过 | `.generated/native-images-release-remote-oriented.log`、`native-images-remote-validation.json` |
| 严格 TypeScript、两个 Worker 部署预检 | 通过，Images binding 仅配置到主 Worker | `.generated/native-read-image-release-types.log`、`native-read-image-dryrun.log` |
| 工作区图片工具 | 新增工具与原有工作区回归 10 / 10；真实模型、刷新后的工具图片卡片和 Lightbox 专项 1 / 1 | `.generated/native-read-image-release-unit.log`、`native-read-image-live-card.log` |

条件跳过不算通过，也不代替真实模型和远端 Images 专项；对应验证记录独立保存。已发布版本与 Git 构建、Worker 版本、binding 和匿名入口保护的核对结果保存在 `.generated/native-images-deployment-summary.json`，只有记录存在且与实际部署匹配时才能视为部署已验收。该记录不声明用户 Access 会话中的云端功能验收已经完成。
