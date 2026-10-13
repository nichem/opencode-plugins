# 来源

Qoder CN 传输、认证和编码模块复制自本机维护的 `opencode-qoder-cn`，基于 `opencode-qoder 0.2.1` 修改。

- 本地仓库：`https://github.com/nichem/opencode-qoder-cn`
- 原包记录的上游：`https://github.com/Moorad/opencode-qoder`
- 复制时本地 HEAD：`b937602`；复制的是工作区实际文件。
- 原包许可证元数据：MIT。

原安装包仅包含发布后的 JavaScript 和声明，不含原始 TypeScript。本集合将 JavaScript 整理到 `src/` 直接维护，并新增 2.x 插件适配；没有声称恢复缺失的 TypeScript 源码。

未复制原插件的 Git 历史、真实 `token.txt` 或任何账号凭据。

## Cursor

- 协议依赖：`cursor-opencode-provider@0.8.1`（精确版本及完整性校验见 package-lock.json）。
- 上游：`https://github.com/oakimov/cursor-opencode-provider`，作者 oakimov，MIT 许可证。
- 复用模块由依赖包携带其原始 LICENSE；协议 SDK 生成文件及许可证位于 `src/providers/cursor/vendor/`，版权为 `(c) 2026 Oleksiy Akimov`。构建脚本保留可审查补丁，拒绝协议内直接计划写入、模式切换、图片生成审批和 GitDiff 执行。未复制整个上游插件或启用其全局钩子。
- 本集合自行维护 OpenCode 2.x 接入层：仅保存连接认证、供应商范围内的请求转换、原生模型目录及测试。
- 不应同时安装本集合的 Cursor 接入和上游 Cursor 插件，以免重复注册同名供应商。
