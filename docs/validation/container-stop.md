# 主动停止工作区容器

Plugins → Workspace runtime 提供当前容器状态、刷新和“停止容器”。操作属于当前环境默认物理工作区，影响共享该容器的所有会话；逻辑工作区目录不是独立容器。此操作不修改 shell 模式或容器规格，后续新的容器命令仍按配置启动。

入口为环境范围内的 `GET/POST native/workspace-container`，沿用 Access、租户与环境授权，写操作校验同源及空请求体。GET 只读取宿主状态，不启动容器或 Agent；未配置容器的部署报告 unavailable，POST 返回 501。

WorkspaceDO 持久记录停止阶段与单调 epoch，阻止停止期间的新执行、终端升级和同步；重建后仍可重试同一次停止。当前宿主串行处理 start/restart/stop 并保持停止门禁。原生 SessionDO 仅清理已有运行时中的容器进程，取消相关轮次，不打开冷 Agent，也不调用会停用定时提醒的 archive 事件。旧的 shell execution 被终止，最终文件同步成功并落盘后才销毁容器；同步失败保留容器并报告失败。并发停止请求共享一次操作，各自获得独立 Response；关闭设置页不会取消 WorkspaceDO 持有的操作。

进程连接握手携带工作区 epoch，重连及同步校验旧 epoch；旧连接不能为了探测 generation 而先启动新容器。停止后收回连接，只有新建立的进程客户端能继续按需启动。源码、`.git` 与持久文件保留，进程/PTY 状态结束，本地依赖、缓存和临时文件按可重建数据处理。

验证仅在 `ci` 分支运行：

- `tests/container-stop.test.ts`：持久门禁、重建、并发停止、同步顺序、原生 destroy、失败保留、重复停止不唤醒、旧连接拒绝和范围校验。宿主 API 由平台替身提供，不声称在 GitHub runner 调用了真实 Cloudflare Container。
- `tests/native-workspace-runtime.test.ts`：真实 workerd HTTP 入口、不可用部署、租户/同源校验、只读状态与文件保留。
- `tests/process-container.test.ts`：Docker/FUSE 内真实进程和 PTY 的批量终止、新命令恢复，以及旧客户端重连在进入容器前被拒绝；沿用既有文件同步回归。
- `tests/browser/workspace-runtime.spec.ts`：不可用状态、停止请求及完成后的按钮状态；容器可用的界面场景通过拦截响应控制，后端顺序另由上述测试覆盖。
