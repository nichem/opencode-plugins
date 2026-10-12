# opencode-message-delete

OpenCode 2.x 的 TUI 插件，将旧 message-editor 的用途收窄为：**每次删除末尾一条 AI 消息，保留已修改的文件**。

## 安装

这是纯 TUI 插件，放在 `~/.config/opencode/cli.json` 的 `plugins` 中，合并到已有数组即可，无需添加到 `opencode.json`：

```json
{
  "plugins": ["git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-message-delete"]
}
```

私有仓库需要本机 Git 访问权限。重新打开 OpenCode 后使用 `/delete-last-message`，也可以在命令面板选择“删除末尾一条 AI 消息”。

## 删除范围

- 一次删除一条内部 AI 消息，其正文、思考和工具记录会一起移除。
- AI 一轮回复可能有多条内部消息，可重复执行逐条删除。执行结束的 idle 标记随对应消息一起移除。
- 遇到用户消息、合成消息、压缩记录或其他非 AI 消息就停止，不跨过它去删除更早的回复。
- 已修改的文件保留；不自动重新生成，不调用模型。后续会话上下文不再包含已删除的消息。
- 使用原生 `session.revert.stage(files: false)` 和 `commit`。成功提交后不能用 `/redo` 找回，不代表从底层事件日志中安全擦除数据。
- 生成中、有待处理输入、已有待提交回退时拒绝删除。使用 goal 自动续跑时请先 `/goal pause`。
- 提交失败时可能保留原生回退状态，可用 `/redo` 恢复。插件不自动清除回退，避免唤醒待处理输入。
- 会在提交前复查末尾消息与回退状态；2.x 的两步回退接口不提供原子条件删除，避免其他客户端同时操作同一会话。

不再提供原来的 `/edit-message` 或按片段清空的 `/clear-message`。

## 开发

```powershell
npm ci
npm run check
npm test
node scripts/check-host.mjs
node scripts/smoke.mjs "$env:APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe"
```

接口类型固定为 `@opencode/plugin` 2.0.27。冒烟测试在独立临时目录和数据库中运行本地假模型，不读取真实凭据，不修改真实聊天。
