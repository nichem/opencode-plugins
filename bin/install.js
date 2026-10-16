#!/usr/bin/env node
import { select, checkbox, confirm } from "@inquirer/prompts";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfigs, planChanges, writeChanges } from "../installer/config.js";
import { latestRevision, loadVersionTrees, statuses, opencode } from "../installer/status.js";

async function submenu(prompt, options, fallback) {
    const controller = new AbortController();
    const back = (_text, key) => { if (key?.name === "escape") controller.abort(); };
    process.stdin.on("keypress", back);
    try { return await prompt(options, { signal: controller.signal }); }
    catch (error) { if (controller.signal.aborted) return fallback; throw error; }
    finally { process.stdin.off("keypress", back); }
}

async function main() {
    if (process.argv.includes("--help")) {
        console.log("OpenCode 插件安装器\n用法：npx github:nichem/opencode-plugins\n安装/更新与卸载均支持多选。只管理本集合的全局配置，不读取 agent 文档。\n要求：Node.js 24+、Git、OpenCode 2.x。退出：Ctrl+C。");
        return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在交互式终端运行；查看用法请加 --help。");
    let version;
    try { version = (await opencode("version")).stdout.trim(); } catch { throw new Error("找不到 OpenCode，请先安装 OpenCode 2.x 并加入 PATH。"); }
    if (!/^(?:opencode\s+)?v?2\./i.test(version)) throw new Error(`此安装器要求 OpenCode 2.x，当前版本：${version}`);
    console.log("OpenCode 插件集合 · GitHub 安装\n空格多选，回车确认，Ctrl+C 退出。最新版在安装页不可选。\n");
    for (;;) {
        const action = await select({ message: "你想做什么？", choices: [
            { name: "安装 / 更新", value: "install" }, { name: "卸载", value: "remove" }, { name: "退出", value: "exit" },
        ] });
        if (action === "exit") return;
        const configs = await readConfigs();
        let latest, installed = "", trees = new Map();
        if (action === "install") {
            console.log("正在检查 GitHub 版本与本机安装状态…");
            try { latest = await latestRevision(); } catch { console.log("GitHub 版本检查失败；检查网络和 Git 后返回重试。未修改配置。"); continue; }
            try { installed = (await opencode("list")).stdout; } catch { console.log("无法读取缓存版本，未知版本可选择重新安装。"); }
            trees = await loadVersionTrees(configs, latest, installed);
        }
        const items = statuses(configs, latest, installed, trees).filter(p => action !== "remove" || p.state !== "absent");
        if (!items.length) { console.log("没有可卸载的插件。"); continue; }
        const selected = await submenu(checkbox, { message: action === "remove" ? "选择要卸载的插件（不删除凭据和数据）" : "选择要安装、更新或修复的插件",
            choices: items.map(p => ({ name: `${p.id} — ${p.title} [${action === "remove" ? "已配置" : p.label}]`, value: p,
                disabled: action === "install" && p.state === "current" ? "已是最新"
                    : action === "install" && p.state === "unknown" ? "请返回重试" : false })),
            instructions: "空格选择，回车确认；Esc 返回", pageSize: 10 }, []);
        if (!selected.length) continue;
        if (action === "remove" && !await submenu(confirm, { message: `将卸载 ${selected.map(p => p.id).join("、")}，仅移除配置。确认？`, default: false }, false)) continue;
        const changes = planChanges(configs, selected, action, latest);
        const backup = await writeChanges(changes, join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-plugins", "backups"));
        for (const p of selected) console.log(`✓ ${p.id}：${action === "remove" ? "已移除配置" : "已配置所选版本"}`);
        if (backup) console.log(`原配置备份：${backup}`);
        try { await opencode("reload"); console.log("OpenCode 配置已重新加载。"); }
        catch { console.log("配置已保存，但重新加载失败。请运行 opencode reload 或重新启动 OpenCode。"); }
        console.log("请重新打开 OpenCode 终端界面；插件由 OpenCode 下载和加载。卸载保留缓存、账号及插件数据。\n");
    }
}
main().catch(error => {
    if (error.name === "ExitPromptError" || error.name === "AbortPromptError") { console.log("\n已退出。"); return; }
    console.error(error.message); process.exitCode = 1;
});
