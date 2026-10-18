# 原版文件 Host 与环境工作区

`packages/native-files` 挂载固定上游的真实 `WorkspaceFiles`、Sessions、SandboxPolicy 和 Typert Registry，读取所属 SessionDO 的持久 header。预览不创建 Agent、不加载整个事件日志、不获取会话写入权。原版 Files 侧栏和文本 / 文档查看器使用生成的 Remote ABI 调用该宿主。

## 已接入的契约

- `workspaceFiles/list`、`stat`、`read`、`readBytes` 与 `changes`。
- 相对路径以会话 header 的 cwd 解析；目录列表限制在当前项目内。按上游规则，文件预览可以读取项目目录外、同一环境卷内的文件；整个卷始终限定在 `/workspace`，无法进入其他租户或环境。
- 文本按 16 KiB 字节块严格解码 UTF-8，跨块字符由 decoder 保留；上游负责行分页、NUL 检查和单页 2 MiB / 5000 行上限。原来的文本写入 / 编辑上限仍为 256 KiB。
- 字节窗口由 Computer 的 `openSync/readSync/closeSync` 直接读取，不为局部预览读入完整文件。原版限制为窗口 2 MiB、完整文件 32 MiB；过大请求拒绝，不静默截断。
- 字节结果使用生成的 Typert codec 与原版 Connection multipart 编码函数，客户端得到真正的 `Uint8Array`。构建脚本提取该纯函数，避免把依赖 Node 传输和认证的 RPC Host 带入 workerd。
- 原版目录服务保留 2000 项上限及 `truncated` 标记；FS 适配器读取至多 2001 项以判断是否截断。
- 冷读上下文挂载真实 WorkingDirectory 服务和原版 projection，重启后仍能提供工作目录。

Typert Registry 使用原实现，通过一个仅声明公共 Service 构造契约的 JS 边界导入，避免用 Weft 的严格选项重新检查上游内部擦除泛型存储。其实现没有改写；上游 checkout 保持不变。

## 变更与资源释放

WorkspaceDO 在文件写入、编辑或目录创建同步落盘后通知观察者。发送方对同一目标合并失效通知，上游 `WorkspaceChangeFeed` 再读取当前元数据并产生原版 ready / change 帧；这不是持久事件日志。每个工作区和 Session 各最多 32 个订阅，FS 消费方最多容忍 64 次尚未读取元数据的失效通知，超限结束订阅，由原版客户端重新连接。

浏览器 transport 为文件订阅分配 observer ID，退出时通过同源、Access 鉴权、租户 / 环境 / Session 绑定的关闭接口释放。该 ID 只是订阅身份，不提供认证权限。WorkspaceDO 也提供私有关闭 RPC，不仅依靠跨 DO Response 的流取消。服务端租约最长 2 分钟，结束后由原版 stream supervisor 重连并重新建立基线，限制断网时的孤儿订阅寿命。

本地浏览器测试服务器使用 HTTP/2，避免原版多个长期 Remote 流占满 HTTP/1 浏览器连接而阻塞后续文件请求。测试需要本机 OpenSSL；TLS 证书临时生成并在退出时删除，仅影响测试桥接服务。

## 验证入口

`tests/native-files.test.ts` 覆盖原版客户端 multipart 解码、UTF-8 跨块分页、空文件、字节范围、路径与数值拒绝、相同 Session ID 的租户和环境隔离、项目 cwd、真实文件通知、连续 35 次订阅关闭、取消请求的所属范围与提前取消、2001 个真实目录项的截断，以及 workerd 重启后的预览和正常提示词执行。

`tests/browser/files.spec.ts` 操作完整官方 UI：打开 Files、读取 Markdown、修改工作区文件、观察预览更新及刷新恢复、新文件出现在目录中，以及 SVG 经真实字节协议送入原版图片预览器并解码出实际尺寸。它也断言本地页面确实使用 HTTP/2。

## 边界

这一阶段接入文件浏览和预览。上传回执、提示词文件 / 图片附件、图片验证与提取、通用文件删除 / 重命名及大文件写入尚未接入，不将本阶段视为完整附件流程验收。现有原生 write / edit 工具和受保护文件 API 继续提供实际文本写入。

旧数据无需兼容或迁移。清理旧数据不应成为新宿主的隐藏运行依赖。

## 2026-10-18 验证结果

| 验证 | 结果 | 本机记录 |
| --- | --- | --- |
| 69 个官方客户端的完整构建及最终 Worker bundle | 通过 | `.generated/native-files-final-build.log`、`.generated/native-files-final-bundle.log` |
| 严格 TypeScript | 通过 | `.generated/native-files-final-types.log` |
| 两个 Worker 的 cf 部署预检 | 通过 | `.generated/native-files-final-dryrun.log` |
| 单元 / workerd | 69 个独立用例完成验证；全量通过 68 个，修正测试 fixture 后剩余 1 个专项通过 | `.generated/native-files-final-unit.log`、`.generated/native-files-final-observer-scope.log` |
| 普通浏览器 | 8 项通过 | `.generated/native-files-final-web.log` |
| 原版 Inbox、可控模型双端插件 | 各 1 项通过 | `.generated/native-files-final-queue.log`、`.generated/native-files-final-controlled.log` |
| 真实 DeepSeek 浏览器 | 3 项通过 | `.generated/native-files-final-live.log` |

全量运行中的唯一失败来自跨用户关闭订阅测试误用仅提供 alpha 身份的单用户 fixture：beta 地址仍由 alpha 身份处理，无法验证用户隔离。改为包含各 Access 身份的 runtime 后，该用例单独通过，包括越权 / 跨来源拒绝、不同 Session 无法关闭目标观察者、提前取消及 35 次资源释放检查；生产授权逻辑没有为此改动。复测不重复计入独立用例数。选择后的验证汇总为 `.generated/native-files-local-validation.json`。

浏览器按名称去重共 13 项，其中 10 项使用原版 UI，3 项为显式过渡入口回归。本地真实 workerd、模型和页面通过不代替 Cloudflare Access 允许用户登录后的云端运行验收。
