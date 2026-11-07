# 来源

Qoder CN 传输、认证和编码模块复制自本机维护的 `opencode-qoder-cn`，基于 `opencode-qoder 0.2.1` 修改。

- 本地仓库：`https://github.com/nichem/opencode-qoder-cn`
- 原包记录的上游：`https://github.com/Moorad/opencode-qoder`
- 复制时本地 HEAD：`b937602`；复制的是工作区实际文件。
- 原包许可证元数据：MIT。

原安装包仅包含发布后的 JavaScript 和声明，不含原始 TypeScript。本集合将 JavaScript 整理到 `src/` 直接维护，并新增 2.x 插件适配；没有声称恢复缺失的 TypeScript 源码。

未复制原插件的 Git 历史、真实 `token.txt` 或任何账号凭据。

Qoder Global 复用上述协议实现，国际版接口地址和 Auto 默认参数参考原上游 [opencode-qoder 的 constants.ts](https://github.com/Moorad/opencode-qoder/blob/main/src/constants.ts)。新增地区隔离、独立 OpenCode 2.x 连接和模型发现，不引入原上游的环境变量凭据回退。
