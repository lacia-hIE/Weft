# 插件包安装第一版

入口为官方 Plugins 页的 Package installations（插件包安装），并接入原版 `pluginManager/inspect`、`installBundle`、清单、条目/组合包启停和卸载。安装默认保持停用；查看实际构建代码、依赖锁与权限后，以精确 SHA-256 批准并启用。Host 在各会话下轮运行前装配，Client 经原版环境扩展加载。内置必要包的保护保持。

本版支持公开 npm 的精确版本和最多 32 个包的无冲突依赖图；每个环境最多安装 16 个包。依赖图、tarball 地址及 SHA-512 全部固定并校验。每个压缩包最多 4 MiB，合计 12 MiB；解包合计 64 MiB、4096 文件；每半编译产物最多 1 MiB。超限、不支持的依赖协议、不满足的 peer、链接/特殊 tar 条目和安装脚本均明确拒绝。不支持 Git、本地目录、私有源、原生扩展、任意原版 bundle patch、CSS/静态资源导入或直接 Node 宿主服务；没有伪装成全部 dsh 插件兼容。

兼容包在 package.json 声明：

```json
{
  "name": "my-weft-plugin",
  "version": "1.0.0",
  "weft": {
    "plugin": {
      "abi": "weft-plugin-v1",
      "host": "./host.js",
      "client": "./client.js",
      "permissions": {"files": "read", "tools": false, "timer": false, "client": true}
    }
  }
}
```

Host 和 Client 均为 ESM，默认导出 `factory(sdk)`，返回 Cordis 插件对象。Host sdk 提供既有 defineTool/registerTool/handle；可声明的服务只有已授权的 fs/tools/timer。文件方法沿用 FsTarget 异步契约；files=read 不能 writeText/editText。无直接网络、宿主凭据或进程能力。Client sdk 提供共享 React 和 `host.call(method,args)`；`import React from 'react'` 使用宿主版本。Client 在工作台浏览器执行，不是另一个安全隔离区，批准面板明确提示这一点。

构建在独立 Node/esbuild 容器执行，关闭公网出口，不挂载工作区，不传模型、R2 或 registry 凭据；只接收 Worker 校验过的 archives。包代码在构建期间不执行，路径解包和模块加载限制在临时构建根下。运行时模块作为真正 ESM 送入 Dynamic Worker facet，不塞入 Creator 的 64 KiB 函数体源码记录；两者复用工具与能力桥接。

EnvironmentDO SQLite 保存安装声明和任务，私有 R2 保存带摘要的不可变产物。审批前与每次读取验证摘要；资产入口沿用 Access、tenant/environment 和已批准启用状态检查。请求 ID 持久去重，DO alarm 恢复未完成构建。断开浏览器不会取消任务。停止/卸载先持久撤销，再清理已有会话，不启动冷 Agent；旧浏览器调用与文件能力再次校验声明。卸载不删除用户工作区数据。卸载清理无引用的构建产物，任务元数据保留用于请求去重；中断上传的孤立产物自动回收和版本更新不在本版。

测试只在 ci 分支运行：真实无网络 Docker 编译；workerd/R2/真实 facet 的安装、审批、调用、重建恢复、租户隔离和撤销；官方页面的安装审批控件。构建平台原生 Container API 的云端启动仍需部署后验收，GitHub Docker 不替代 Cloudflare VM。

`node scripts/plugin-builder.mjs --local` 仅在 CI 构建镜像；成功任务导出镜像 artifact。发布时加载该镜像并执行 `--publish`，不在本地重新构建。生产增加 PLUGIN_ARTIFACTS R2 和独立 PluginBuilderDO 容器应用。
