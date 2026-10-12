# OpenCode 插件集合

个人维护的 OpenCode 插件源码。

| 插件 | 适用版本 | 功能 |
| --- | --- | --- |
| [opencode-providers](./opencode-providers/README.md) | OpenCode 2.x，已针对 2.0.27 验证 | 多供应商插件，包含 Qoder 中国区和 Krill Codex |
| [opencode-goal](./opencode-goal/README.md) | OpenCode 2.x，已针对 2.0.27 验证 | 从原版 0.4.3 迁移的目标管理、自动续跑及状态提示 |
| [opencode-message-delete](./opencode-message-delete/README.md) | OpenCode 2.x，已针对 2.0.27 验证 | 逐条删除末尾 AI 消息，保留项目文件；纯 TUI 插件 |

各插件分别管理依赖和安装配置。Qoder CN 的 PAT 通过 OpenCode 的 `/connect` 输入并保存。

## 安装

OpenCode 2.x：

```powershell
opencode plugin add 'git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers'
```

也可在 `opencode.jsonc` 中添加：

```json
{
  "plugins": ["git+https://github.com/nichem/opencode-plugins.git#main::path:opencode-providers"]
}
```

私有仓库需要本机 Git 已具备仓库访问权限。安装后通过 `/connect` 选择 Qoder CN 并输入 PAT。

Goal 插件安装及 `cli.json` 的状态提示配置见 [opencode-goal](./opencode-goal/README.md)。
