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

`index.js` 使用标准 Cordis `apply(ctx, config)`、对象或 class 导出；保留原版 `Config` 和 `inject`。Host 不需要接收私有 SDK。Client 使用原版 `dsh.client.platform=web` 与 `exports["./client"]`，也直接导出 Cordis 插件。React 与 Cordis 使用平台实例。

构建器从已验证的归档读取一个 patch 文件或按顺序读取 patch 文件列表，以固定上游的真正 `applyEntryPatches` 处理插入、组和配置覆盖。启用的条目必须来自本包及锁定依赖。覆盖本包之前插入的行有效；第三方包对其他宿主配置的修改明确拒绝，不能跨隔离边界停用或重配基础服务。已经适配的官方组合包仍走[官方组合包](official-bundles.md)的可信预编译路径。

Host 与 Client 使用真正 Cordis Loader，并隔离自己的 loader 服务。Host 在 Dynamic Worker facet 执行；Supervisor 不执行包代码。安装先在无工作区、无凭据、无网络的 facet 中检查标准导出和服务依赖，缺少的宿主服务明确报错。当前桥接 fs、tools、timer；授权上限来自平台能力，并不是包自报权限。审核页面可收紧文件、工具、计时器和 Client 授权，拒绝越权授予。文件写入逐次校验环境中当前的授权；停用先持久撤销，再释放已有实例。

Client 在工作台页面执行，具有页面代码的信任级别；用户在详情页明确批准后才加载。批准前和每次读取均验证精确产物摘要。Client 通过同一套原版生命周期加载、刷新恢复和停用卸载。它不获得自定义 Host RPC；需要更多原版宿主服务的插件必须继续适配。

公开 npm 元数据与归档只由 Supervisor 下载并校验 SHA-512。32 个无冲突依赖、16 个环境安装；归档单个 4 MiB、合计 12 MiB；解包 64 MiB、4096 文件；patch 最多 16 个文件、128 条操作、64 个条目；每半编译代码最多 1 MiB。拒绝安装脚本、私有源、Git/本地路径、原生扩展、Node 内置导入、CSS/静态资源依赖、YAML 表达式、别名/循环和配置越界。原版包格式已经接通，不表示所有依赖 Node 或未桥接服务的原版插件都能运行。

EnvironmentDO 保存安装选择和持久任务，私有 R2 保存不可变产物。请求 ID 去重、Alarm 重建恢复、审批摘要、跨租户隔离、停用撤销及不删除工作区数据保持。旧的专用格式不再接收；旧安装记录显示需移除并以原版包重装，不沿用旧审批，也不阻断其他插件清单。

构建、类型检查、真实无网络 Docker 编译、workerd/R2/真实 facet 工具执行、原版详情页审核与 Client 生命周期测试仅在 ci 分支运行。生产使用 CI 导出的已测构建器镜像，不在本地重新构建。
