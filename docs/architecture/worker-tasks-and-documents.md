# Worker JavaScript 任务与文档提取

Weft 使用 `@cloudflare/computer` 0.7.0 和显式安装的 `just-bash`。长任务与文档提取均可在 Worker 中执行，不要求启动 Linux 容器。

## 可恢复的 JavaScript 任务

原版 Agent 工具注册表提供 `javascript_task`，标准与创造预设可直接使用，PTC 通过 `tools.javascript_task(...)` 调用。普通 `run_code` 保留原版单次工具编排语义；需要跨回合、跨部署继续的程序显式启动为持久任务，避免将任意 Agent 工具调用自动重放。

任务输入为 ES module，默认导出函数接收 JSON `input`：

```js
import fs from 'node:fs/promises';
export default async function (input) {
  const text = await fs.readFile(input.path, 'utf8');
  return {lines: text.split('\n').length};
}
```

`start` 返回任务 ID，`status` 查询输出与结果，`cancel` 主动终止。程序、执行日志和已完成的文件操作由 Computer 保存到 WorkspaceDO 的 SQLite；后台 alarm 在宿主重启后重新连接运行中的任务，查询也可触发恢复。默认只读；`writable: true` 遵循调用会话的沙箱模式和原始项目目录。只读模式拒绝启动可写任务，切换到只读会撤销该会话尚未结束的可写任务。网络出站关闭，附件内部存储受现有文件观察策略保护。

可在程序中设置持久审批检查点：

```js
import {request} from 'ws:approval';
export default async function () {
  const {approved} = await request('继续处理这份报告？');
  return {approved};
}
```

`status` 返回 `waiting`、`callId` 和说明。Agent 调用 `approve`，Weft 使用原版 DSH 审批卡片取得答复，再调用 Computer 的 `respond`。无应答者或拒绝不会变成许可。等待状态跨重启保存，等待时间不计入任务执行时限；审批不会扩大文件权限。取消后的检查点、已答复的检查点以及其他会话的任务不能被再次答复。

默认执行时限 120 秒，上限 600 秒，CPU 上限 30 秒；标准输出与错误合计至多 1 MiB，JSON 结果至多 4 MiB。工作区同时最多启动 4 个计算中的任务；等待审批会释放执行实例。保留最多 256 条任务身份记录，已结束的历史在新任务进入时保留最近 100 条，原生执行日志保留 24 小时。

Computer 的 `replay` 与审批 API 属于实验接口。重放复用已记录的文件操作及宿主调用结果；接入外部写操作时仍须处理调用中断期间的幂等性。本实现没有向程序开放任意网络或 Agent 工具 RPC。

## Office、PDF 与图片转 Markdown

`document_to_markdown` 通过 Worker 的 `AI.toMarkdown` binding 读取所属环境工作区内的文件。Agent 可直接使用，PTC 通过同名工具 SDK 使用。可选的 `output_path` 保存一个新的 `.md` 文件，再通过原版 `present` 展示；保存遵循当前会话的文件沙箱，并拒绝覆盖已存在的文件。

- Word、Excel、PDF、图片、HTML 等格式以 Cloudflare 的实时 `supported()` 返回值为准，输入原始二进制内容，不经过容器 CLI。
- Cloudflare 未直接支持 PPTX 时，Worker 解析幻灯片 XML，将文字按页编号整理成 HTML 后交给转换接口；不提取图片，不保留演示文稿布局。
- 旧版 `.doc`、`.ppt` 等格式不会被假装成受支持的类型；服务不支持时明确返回错误。
- 单文件输入上限 10 MiB，转换后 Markdown 上限 256 KiB；工具返回最多 20,000 字符的预览及截断标记，可通过新建输出文件保留完整内容。每个活跃宿主缓存最近 8 份转换结果，按文件内容与名称区分。
- 缺少 `AI` binding 时明确报告不可用；测试可以替换外部转换服务，生产使用真实 Cloudflare 服务。

这是内容提取能力。原版 `officeToPdf/*` 的保真 PDF 预览、Office 编辑与文档生成仍是独立能力，不会用 Markdown 冒充 PDF 响应。

参考：[Computer JavaScript 运行时](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md)、[Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)、[实时支持格式](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)。
