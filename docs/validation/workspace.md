# Computer Workspace 与原生文件工具验证

验证日期：2026-10-16。固定 npm 包 `@cloudflare/computer@0.5.1`，版本和完整性由 package-lock 管理；Harness 继续使用 upstream.lock 固定的源码。

## 实现边界

`WorkspaceDO` 独立于 `SessionDO`，使用 `[tenantId, workspaceId]` 寻址；每次内部 RPC 重新核对 scope 与实际 DO ID。它持有 Computer `Workspace`，文件由 Computer SQLite VFS 保存。执行后端只有 Computer Worker Shell（见 [原版交互服务](native-interaction.md)），没有 Container、动态 JavaScript 或 Git 后端，也没有公开不带 scope 的原始 Computer stub。

`ComputerFileSystem` 实现 Harness 的 `ctx.fs` 服务。`read`、`write`、`edit` 工具、working-directory 服务和 fs-observation-policy 均直接来自固定的上游源码，保留上游参数、读取窗口、输出格式、Diff 与先观察后修改的规则。额外的 `workspace_search` 是 Weft 注册的有界字面文本搜索工具。

未传 `workspaceId` 的新 Session 使用纯聊天配置，不调用 WorkspaceDO。新 Session 的第一次运行可绑定一个 Workspace；后续省略该字段会沿用绑定，显式切换返回 409 / WORKSPACE_MISMATCH。纯聊天 Session 不能中途切换为文件 Session；旧部署尚未产生绑定记录的 Session 在升级后的第一次运行固定其配置。

一个租户的多个 Session 可显式绑定相同 workspaceId，共享文件。不同用户即使使用相同 workspaceId，仍对应不同 DO；当前不提供跨用户或组织共享。

## 文件一致性与范围

- 根目录固定为虚拟路径 `/workspace`，相对路径从此处解析。拒绝越界、反斜杠、NUL、换行，以及经过符号链接的路径。
- 模型工具和公开 HTTP API 均通过带 scope 的操作协议访问文件。HTTP 写入必须携带 expectedVersion，原生工具的观察策略决定创建或版本替换。
- Computer 同步 VFS 修改、文件版本与 workspaceRevision 在同一个 DO SQL transactionSync 中提交。失败时一起回滚；相同内容再次写入也推进版本，避免 ABA。
- 文件版本是工作区内单调修订号；目录元数据采用保守的工作区修订标记。未来 Git 等写入口必须接入相同版本桥接后才能开放。
- 当前文本文件上限 256 KiB。原生 fs 服务提供有界原始字节与字节范围读取；原生界面会话配置 Images binding 后启用原版 `read_image`。本文使用的旧消息接口不挂载图片存储，公开文件 API 仍只写 UTF-8 文本。
- 列目录最多 1000 个直接条目。搜索为字面文本，最多遍历 1000 个条目、读取 4 MiB、返回 50 条匹配，每行最多 2000 字符；结果带 truncated 标记。
- Native streamText 将有界文本分块交给上游消费，目前不是面向超大文件的磁盘流方案。

本轮 schema 为 1，未来格式停止初始化。会话绑定保存在 SessionDO 的独立元数据表中；没有改写上游 Session 格式或原始源码。

## HTTP 使用

以下为本地开发示例。云端保持 Cloudflare Access 浏览器登录，无应用 Token。先从 `/v1/me` 获取 tenantId。

创建文件，expectedVersion:null 表示仅允许创建不存在的文件：

```bash
curl -X PUT http://localhost:8787/v1/tenants/TENANT_ID/workspaces/project/files \
  -H 'Content-Type: application/json' \
  -d '{"path":"notes/todo.md","content":"TODO: verify workspace","expectedVersion":null}'
```

读取文件或列出目录：

```bash
curl 'http://localhost:8787/v1/tenants/TENANT_ID/workspaces/project/files?path=/workspace/notes/todo.md'
curl 'http://localhost:8787/v1/tenants/TENANT_ID/workspaces/project/files?path=/workspace'
curl 'http://localhost:8787/v1/tenants/TENANT_ID/workspaces/project/search?query=TODO'
```

文件操作成功响应为 `{ "value": ... }`。读取返回 path、type、size、content 和 version，写入返回 before、after、version 和 revision。

按已读取的版本进行替换或编辑：

```bash
curl -X PATCH http://localhost:8787/v1/tenants/TENANT_ID/workspaces/project/files \
  -H 'Content-Type: application/json' \
  -d '{"path":"notes/todo.md","oldString":"TODO","newString":"DONE","expectedVersion":"1"}'
```

使用模型的原生文件工具：

```bash
curl -N http://localhost:8787/v1/tenants/TENANT_ID/sessions/coding/messages \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"workspaceId":"project","text":"读取 notes/todo.md，将任务状态改为 VERIFIED，再读取确认"}'
```

所有修改接口复用 JSON 大小限制和跨 Origin 写入拒绝。冲突返回 409 / FS_STALE_VERSION 或 FS_NOT_OBSERVED；模型工具收到对应原生错误，可重新读取后决定合并。文件删除、Git、执行命令、快照和工作区索引尚未开放。

## 验证

真实 workerd 测试覆盖：租户与工作区隔离、同工作区多 Session、并发 CAS 竞争、相同字节版本推进、原生读写编辑与观察策略、外部并发修改后的重新读取、格式拒绝、路径与符号链接限制、有界字节读取、注入 SQL 失败后的内容及版本回滚、进程重建后的文件与会话绑定恢复。

真实模型验证独立于无密钥回归测试：

```bash
# 终端一：服务端 .env 已配置模型密钥
npm run dev
# 终端二：真实 DeepSeek 原生文件工具 + 第二个 Session 读取共享文件
npm run test:live:workspace
```

文件修改与 Session 工具结果分属两个 DO，不构成跨 DO 原子事务；系统靠以下三条保证不重复施加副作用：

- **不自动重放**：上游恢复时，已记录开始但没有持久结果的工具调用，会被补写为 `TOOL_OUTCOME_UNKNOWN`，并提示模型先核实外部状态，Harness 不会重新执行它；未记录开始的调用按"未开始"关闭。
- **版本前置条件**：原版 `fs-observation-policy` 让写入和编辑都携带读取时观察到的版本（`replaceIfVersion` / `createIfAbsent`），WorkspaceDO 在同一事务中校验。模型若盲目重发一个已生效的修改，会收到 `FS_STALE_VERSION`、`FS_NOT_OBSERVED` 或 `FS_EDIT_NOT_FOUND`，不会被施加两次。见 `tests/workspace.test.ts` 中的重发用例。
- **Shell 与外部请求不在此列**：命令执行和插件出站请求不具备幂等性，结果未知时由模型按上游提示核实或询问用户。

由此得到的语义是"每个已记录的调用至多派发一次，文件修改有版本校验"，而不是任意副作用的 exactly-once。工作区快照仍未实现。

## 依赖记录

Worker Shell 已经评审后启用，见 [原版交互服务](native-interaction.md#shell终端与权限)。just-bash 以 Computer 预打包的模块文本在每个工作区自己的 Dynamic Worker 中运行；父 isolate 构建把 worker-shell 模块对 just-bash 的静态引入替换为会失败的桩，构建检查继续禁止 just-bash、guarded-fetch、sprintf-js 进入生产应用 bundle，runtime-audit.json 记录执行后端与出口策略。npm audit 告警评审：undici 与 guarded-fetch 不在 shell 模块中（undici 被 Computer 替换为桩，curl 使用 isolate 全局 fetch），因此不可达；sprintf-js 的中危 DoS 位于 shell 核心模块内，影响限于该工作区自己的 Dynamic Worker。本轮没有降级 Computer 或强制替换传递依赖。

参考：[Cloudflare Computer 官方说明](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)。

本次严格类型检查及 32 项真实 workerd 集成测试通过；`npm ci` 后重建的生产 Worker SHA-256 与已测试产物相同，`cf deploy --dry-run` 通过。真实 DeepSeek 实测执行 `write → read → edit → read`，文件版本为 `2`，第二个 Session 成功读取共享文件，总耗时约 7857 ms。该耗时仅为此次验证观察。真实 API 验证在本地 `cf dev` 的 workerd 中完成，云端 Access 登录后的用户端到端验证仍需允许的用户完成。
