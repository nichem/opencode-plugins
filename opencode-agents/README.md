# opencode-agents

OpenCode 2.x 服务端插件。读取插件自带 `agents/` 目录中的 Markdown，每个文件注册一个 agent，提示词与注册代码分离。

已提交的 `agents/` 文档随插件分发。新增文档默认由 `.gitignore` 排除，需经授权显式加入 Git 后才会公开发布。

## 安装

在 `opencode.json` 的 `plugins` 中添加（不是 `cli.json`）：

```json
{
  "plugins": ["git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-agents"]
}
```

安装后自带的 Markdown 会被注册；空目录不会添加 agent。仅扫描插件自身目录，不读取 `~/.config/opencode/agents` 或项目的 agent 文档。重新加载插件后更新；不会监控文件或自动发起模型请求。

## 文档格式

纯 Markdown 即可，文件名作为名称，正文作为提示词。也支持 YAML frontmatter：

```markdown
---
name: reviewer
description: 检查代码缺陷并提供修改建议
mode: subagent
model: krill/gpt-6.1-sol
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
这里填写 agent 的提示词。
```

- 注册名称带 `bundled-` 前缀，例如 `bundled-reviewer`，避免与本机同名 agent 冲突；完整名称仍冲突时跳过。
- `mode` 支持 `primary`、`subagent`、`all`，默认 `primary`。不指定模型时交由 OpenCode 选择。
- 可选字段：`name`、`description`、`mode`、`model`、`hidden`、`color`、`steps`、`permissions`、`request`。
- 权限使用 2.x 规则数组，附加到默认规则后；不支持 1.x 的 `permission`、`tools` 等字段。
- 只加载该目录直接包含的 `.md` 文件，不递归、不跟随符号链接。
- 格式错误会阻止本次注册，错误信息不回显正文或 YAML 内容。

文档随仓库公开发布后，任何人都能读取。不要在预设中写入密钥或私人资料。

## 验证

```powershell
npm ci
npm run check
npm test
```

测试使用临时目录和测试内的虚构提示词，不读取实际 `agents/` 目录。
