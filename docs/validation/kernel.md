# 第一阶段：Harness / workerd 内核验证

验证日期：2026-10-16。目标是在 Cloudflare 执行环境中保留 upstream Harness 行为，并建立多租户托管所需的存储与授权边界。

## 固定输入

- Harness commit：`86a402200d95fecef4529d969836f1fe13c6cb0d`，由 `upstream.lock.json` 管理。
- Workers compatibility date：`2026-07-30`；启用 `nodejs_compat`。兼容模式提供部分 Node API，执行仍由 workerd 承载。
- 测试使用 Miniflare `5.20261012.1-beta` 及其 workerd，版本与 Wrangler 的依赖一致。
- 模型使用确定性 `LlmAdapter`，实际执行 upstream Cordis、SessionStore、SessionProjectionRegistry、SystemPrompt、ToolRuntime、AgentRegistry 和 AgentLoop。

## 已覆盖的验证

| 验证 | 证据 |
| --- | --- |
| Agent Loop 和工具执行 | 工具调用进入 Session 日志，工具结果成为后续模型输入，第二个模型步骤正常结束 |
| 多租户命名隔离 | 两个 Access 用户使用相同 sessionId，提示词、输入、工具结果和历史分别保存 |
| 入口授权 | 缺失可信 Access 身份、错误 audience、服务身份、伪造头、跨租户读写和 body 中的租户覆盖均被拒绝 |
| DO 内部身份检查 | 发给 alpha 对象的 beta scope 被拒绝，匹配 scope 可正常读取 |
| 同 Session 并发 | 两个请求按独立 turn 串行完成，事件 seq 连续 |
| 进程重建 | 关闭原 workerd，使用同一持久目录创建新进程，读取原日志并继续第二个 turn |
| 存储协议 | 重复创建、重复 writer、只读句柄、原子批追加、读取可见性、flush、关闭及取消 |
| 写入所有权 | 模拟对象重建后，旧句柄不能追加，也不能释放新 writer 的所有权 |
| 格式拒绝 | 未来 Session 版本和未知 required 事件被拒绝 |
| 中断日志恢复 | 保存至 tool/call 的有效前缀，upstream resume 补充未知工具结果和关闭事件，再启动新 turn |

中断恢复测试验证的是 upstream 对已持久化日志的修复。它没有证明模型请求能从中间继续，也没有证明外部副作用 exactly-once。进程重建测试在已确认完成的请求后执行；执行中的硬终止和调度恢复仍待验证。

## 架构与维护边界

`harness-runtime` 只使用 Harness 的公开服务与 Agent API；宿主提供模型适配器、模型配置、工具和持久化。Tenant 身份、HTTP 协议与 DO 寻址留在平台侧。第一版继续使用 upstream 驱动，独立 Model Runner 和 Durable Step Driver 等行为兼容性验证后再决定。

`session-persistence-do` 通过 upstream 存储校验函数检查事件、版本和连续性。事件追加和计数更新在同步 SQLite 事务中完成，`flush` 使用存储同步屏障。写入者使用随机 token；DO 构造时清除旧所有权，旧句柄的修改和释放仍需匹配 token。数据库 schema 版本保存在普通表中，未知版本停止初始化。

跨请求队列仅用于当前对象内的串行执行。它不是持久任务队列，客户端断线后继续执行、请求幂等和后台调度尚未承诺。当前每个 DO 仅保存一个租户限定 Session；跨 Session 的检索索引尚未实现。

## 上游适配与发现

唯一源码内容适配位于构建插件：将 LLM attribution 中的 `createRequire(import.meta.url)('../package.json')` 改为静态 JSON 导入，保留 upstream 版本和请求身份。原操作会导致打包后的 workerd 启动失败。匹配不到固定源码时构建失败，要求重新审查；上游 checkout 未修改。

Cordis、Cosmokit 和 Schemastery 在 upstream 各自使用不同的编译设置。准备脚本单独生成这些固定 vendor 的声明供 Weft 使用；Weft 与被引用的 Harness 包保持严格检查。该步骤不代表执行了 upstream 全仓类型检查或测试。

应用产物仍有 `node:async_hooks`、`node:crypto`、`node:fs`、`node:os`、`node:path`、`node:util/types` 导入。`fs` / `os` 来自工具注册所关联的 sandbox 模块；当前测试没有激活本地文件或子进程后端。模块可导入与完整插件可用应分别验证。

Cloudflare DO SQL 对部分 PRAGMA 操作有限制；本工程使用普通 schema 表记录版本。本地 Miniflare v4 配置转换器未保留旧的持久目录选项，重启测试改为显式设置 v5 的 `resourcePersistencePath`。

## 下一阶段

1. 接入 upstream DeepSeek 模型 Provider，在 workerd 中验证真实 HTTP、流式解析、错误及取消；凭据按租户解析。
2. 固定 Computer 版本，增加独立 WorkspaceDO，验证文件读写、搜索、编辑、Git、JS 和工作区重建。
3. 选择首批受支持的 Harness profile / 插件，明确加载、配置和权限策略，形成兼容清单。
4. 注入运行中进程终止、超时和重复投递，决定哪些任务需要持久调度及执行器改造。
5. 在现有 Access 用户认证上增加组织成员权限、模型凭据服务和会话列表；随后验证前端协议与 UI。

成本路由、账单对照和流式批次优化暂缓。

## Cloudflare 云端复核

2026-10-16 使用 `cf@1.0.0-beta.17` 实际部署 `weft-kernel-validation`，Durable Object 通过 exports 生命周期声明创建 SQLite 存储。云端健康检查、alpha / beta 两租户工具循环、持久日志读取和跨租户拒绝均通过。云端进程硬终止、实际模型和 Computer 仍待验证。持续部署状态与配置见 [部署记录](../deployment.md)。

2026-10-16 已将用户入口切换至 Cloudflare Access。认证通过运行时 `ctx.access`；本地使用官方 `access.dev` 模拟并在真实 workerd 执行测试。应用不再提供 Bearer Token 用户认证；新增身份发现、邮箱变更后租户稳定性和跨站写入拒绝验证。
