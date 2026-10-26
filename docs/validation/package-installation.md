# 原版插件包安装

统一入口为官方 Plugins 页的“添加插件”。公开 npm 的包名会解析并锁定确切版本，也可直接指定精确版本。包必须使用原版 `package.json.dsh.bundle.patch`；不要求任何 Weft 专用声明或 factory 导出。构建完成后保持停用，在该包自己的详情页审核原始 patch、依赖锁、构建代码和 SHA-256，选择允许的能力并批准启用。重复的“插件包安装”页面已经移除。

```json
{
  "name": "my-dsh-plugin",
  "version": "1.0.0",
  "main": "./index.js",
  "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
}
```

```yaml
- insert:
    - id: my-plugin
      name: my-dsh-plugin
      config:
        message: hello
- id: my-plugin
  config:
    message: configured
```

`index.js` 使用标准 Cordis `apply(ctx, config)`、对象或 class 导出；保留原版 `Config` 和 `inject`。Host 不需要接收私有 SDK。Client 使用原版 `dsh.client.platform=web` 与 `exports["./client"]`，也直接导出 Cordis 插件。React、Cordis 和 `@deepseek-ai/dsh-client-ui-primitives` 使用平台实例，避免插件重复打包一份界面基础库。

构建器从已验证的归档读取一个 patch 文件或按顺序读取 patch 文件列表，以固定上游的真正 `applyEntryPatches` 处理插入、组和配置覆盖。启用的条目必须来自本包及锁定依赖。覆盖本包之前插入的行有效；第三方包对其他宿主配置的修改明确拒绝，不能跨隔离边界停用或重配基础服务。已经适配的官方组合包仍走[官方组合包](official-bundles.md)的可信预编译路径。

Host 与 Client 使用真正 Cordis Loader，并隔离自己的 loader 服务。Host 在 Dynamic Worker facet 执行；Supervisor 不执行包代码。安装先在无工作区、无凭据、无网络的 facet 中检查标准导出和服务依赖，缺少的宿主服务明确报错。普通会话插件桥接 fs、tools、timer；环境插件还支持受控 HTTPS、原版 storage/storageDomain、部分 sessionController、credentials.resolve 和有限 webServer 路由，需审核相应权限，详见[Worker Host 服务](../architecture/worker-host-plugins.md)。授权上限来自平台能力，并不是包自报权限。审核页面可收紧文件、工具、计时器和 Client 授权，拒绝越权授予。文件写入逐次校验环境中当前的授权；停用先持久撤销，再释放已有实例。

Client 支持普通 CSS、CSS Modules、CSS `@import` / `url()`、`?inline` 样式、`?raw` 文本，以及 JS 导入图片、字体、Wasm / 文本静态文件（也支持 `?url`）。仅处理归档内的依赖，不下载远程样式。编译器把样式和资源字节放入同一份不可变产物，SHA-256 覆盖全部内容；资源无需单独复制或获得另一套授权。普通样式在 Client 的 Cordis effect 中加载，停用、更新和初始化失败均释放样式；插件自行插入的 inline 样式仍由该插件释放。CSS Modules 保留类名映射，并以包名和版本生成类名前缀，避免独立编译的插件互相覆盖；普通全局 CSS 保持其原有作用域。

资源经过环境认证与当前版本授权后提供；未审批、停用、撤销 Client 权限、其他租户或其他环境均不能读取。旧版本在更新后也不能继续读取。接口支持 GET / HEAD，使用固定内容类型、no-store 与 nosniff；SVG 等资源直接打开时有 sandbox CSP。每个资源最多 1 MiB，合计最多 4 MiB / 128 个，样式最多 1 MiB。动态构造的文件路径、HTML、原生扩展、未支持的资源类型和任意 Node 宿主服务仍不在适配范围。

Client 在工作台页面执行，具有页面代码的信任级别；用户在详情页明确批准后才加载。批准前和每次读取均验证精确产物摘要。Client 通过同一套原版生命周期加载、刷新恢复和停用卸载。它不获得自定义 Host RPC；需要更多原版宿主服务的插件必须继续适配。

公开 npm 元数据与归档只由 Supervisor 下载并校验 SHA-512。32 个无冲突依赖、16 个环境安装；归档单个 4 MiB、合计 12 MiB；解包 64 MiB、4096 文件；patch 最多 16 个文件、128 条操作、64 个条目；每半编译代码最多 1 MiB。拒绝安装脚本、私有源、Git/本地路径、原生扩展、Node 内置导入、YAML 表达式、别名/循环和配置越界。原版包格式已经接通，不表示所有依赖 Node 或未桥接服务的原版插件都能运行。

## 版本更新与回滚

原版 Plugins 页的包详情提供目标精确版本、构建更新、审核更新、放弃更新及恢复上一版本。也可再次通过原版“添加插件”提交该包的新版本。更新的下载、编译或验证失败不替换当前版本；构建成功保存为停用且未审批的候选版本，旧版本继续运行。每次新版本都需针对其精确摘要重新审核能力，不继承旧批准。审核页同时展示 patch、依赖锁、代码、样式和静态资源清单。

批准时先持久撤销旧版本，再释放各 Session 实例，最后提交新版本；会话 Host 在下一轮运行前加载，环境 Host 由环境生命周期协调，Client 随原版变更事件切换。保存上一版本的精确产物与原有授权，可手动恢复。若新 Host 或 Client 初始化失败，自动恢复上一版已经批准的声明；没有可用旧版时停用该包。Host 在下一轮重新加载恢复的版本，Client 则重新协调加载。失败通知同时校验产物摘要和启用批次，迟到通知不能回退其他版本或同版本的新实例。重新调整当前版本授权后若初始化失败，只停用该版本，不借回滚恢复旧权限。自动回滚不会撤回插件已写入的工作区内容或外部副作用，也不能检测初始化之后的任意业务错误。

版本切换记录会持久保存；Supervisor 在切换中断后通过 Alarm 恢复旧声明，不自动重放命令。一次仅保留一个待审版本与一个上一版本；重建前需批准或放弃候选版本。不可变产物保留到环境删除，以免并发读取、复制快照或历史版本丢失字节；移除插件立即撤销访问，不删除工作区。环境复制仅带当前选中版本，候选与历史版本及其批准不转移。

EnvironmentDO 保存安装选择和持久任务，私有 R2 保存不可变产物。请求 ID 去重、Alarm 重建恢复、审批摘要、跨租户隔离、停用撤销及不删除工作区数据保持。旧的专用格式不再接收；旧安装记录显示需移除并以原版包重装，不沿用旧审批，也不阻断其他插件清单。

构建、类型检查、真实无网络 Docker 编译、workerd/R2/真实 facet 工具执行、原版详情页审核、资源鉴权、版本更新/回滚与 Client 样式生命周期测试仅在 ci 分支运行。生产使用 CI 导出的已测构建器镜像，不在本地重新构建。
