# OpenCode 插件集合

个人维护的 OpenCode 插件源码。

| 插件 | 适用版本 | 功能 |
| --- | --- | --- |
| [opencode-providers](./opencode-providers/README.md) | OpenCode 2.x，已针对 2.0.27 验证 | 多供应商插件，目前包含 Qoder 中国区 |

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
