#!/usr/bin/env node
import { select, confirm } from "@inquirer/prompts";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfigs } from "../installer/config.js";
import { statuses, opencode } from "../installer/status.js";
import { createSelection, reviewOperations, actionLabels } from "../installer/selection.js";
import { managePlugins } from "../installer/manage-prompt.js";
import { applyOperations } from "../installer/install.js";
import { createUpdateCheck } from "../installer/updates.js";
import { BACKUP_LIMIT } from "../installer/backups.js";

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
        console.log("OpenCode 插件安装器\n用法：npx github:nichem/opencode-plugins\n统一管理插件：空格安装/卸载，u 标记更新/修复/迁移，回车预览并确认（默认否）。\n已安装默认勾选，保持勾选不自动更新。只管理本集合的全局配置，不读取 agent 文档。\n要求：Node.js 24+、Git、OpenCode 2.x。退出：Ctrl+C。");
        return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在交互式终端运行；查看用法请加 --help。");
    let version;
    try { version = (await opencode("version")).stdout.trim(); } catch { throw new Error("找不到 OpenCode，请先安装 OpenCode 2.x 并加入 PATH。"); }
    if (!/^(?:opencode\s+)?v?2\./i.test(version)) throw new Error(`此安装器要求 OpenCode 2.x，当前版本：${version}`);
    console.log("OpenCode 插件集合 · GitHub 安装\n空格安装/卸载，u 标记更新/修复/迁移，回车预览后确认。\n正在后台准备版本和安装状态…\n");
    const updates = createUpdateCheck(version);
    try {
        for (;;) {
            const action = await select({ message: "你想做什么？", choices: [
                { name: "管理插件（安装 / 更新 / 卸载）", value: "manage" }, { name: "退出", value: "exit" },
            ] });
            if (action === "exit") return;
            const configs = await readConfigs();
            const prepared = await updates.get(configs, { onWait: () => console.log("版本数据仍在准备，请稍候…") });
            for (const message of prepared.messages) console.log(message);
            if (prepared.error) console.log(`${prepared.error} 仍可取消勾选以卸载已配置的插件。`);
            const { latest, installed = "", trees = new Map() } = prepared;
            const rows = createSelection(statuses(configs, latest, installed, trees, { hostVersion: version }), latest);
            const operations = await managePlugins({ rows, pageSize: 10 });
            if (!operations) continue;
            if (!await reviewOperations(operations, { confirm: options => submenu(confirm, options, false) })) continue;
            let backup;
            try {
                backup = await applyOperations(configs, operations, latest,
                    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-plugins", "backups"),
                    { report: message => console.log(message) });
            } catch (error) { console.log(error.message); updates.refresh(); continue; }
            for (const { plugin, action } of operations) console.log(`✓ ${plugin.id}：${actionLabels[action]}完成`);
            if (backup) console.log(`原配置备份：${backup}（保留最近 ${BACKUP_LIMIT} 次）`);
            try { await opencode("reload"); console.log("OpenCode 配置已重新加载。"); }
            catch { console.log("配置已保存，但重新加载失败。请运行 opencode reload 或重新启动 OpenCode。"); }
            console.log("请重新打开 OpenCode 终端界面加载变更。\n");
            updates.refresh();
        }
    } finally { await updates.close(); }
}
main().catch(error => {
    if (error.name === "ExitPromptError" || error.name === "AbortPromptError") { console.log("\n已退出。"); return; }
    console.error(error.message); process.exitCode = 1;
});
