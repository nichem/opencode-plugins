import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { catalog, specifier } from "./catalog.js";
import { planOperations, writeChanges } from "./config.js";
import { opencode } from "./status.js";

export async function preparePackages(selected, revision,
    { run = opencode, env = process.env, report = () => {}, remove = rm, signal } = {}) {
    const ids = [...new Set(selected.map(plugin => plugin.id))];
    if (!/^[a-f0-9]{40}$/.test(revision) || ids.some(id => !catalog.some(plugin => plugin.id === id)))
        throw new Error("无效的插件或提交版本（未修改配置）");
    if (!ids.length) return;
    const shutdown = new AbortController();
    const interrupted = () => shutdown.abort();
    const activeSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
    const canceled = () => Object.assign(new Error("已取消插件准备；未修改配置。"), { code: "ABORT_ERR" });
    if (activeSignal.aborted) throw canceled();
    const directory = await mkdtemp(join(tmpdir(), "opencode-plugin-install-"));
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    try {
        const config = join(directory, "config", "opencode");
        await mkdir(config, { recursive: true });
        await mkdir(join(directory, "home"));
        for (const file of ["opencode.json", "cli.json"]) await writeFile(join(config, file), "{}\n", { mode: 0o600 });
        // Native `plugin add` waits for installation but also writes configuration.
        // Give it disposable config/data while keeping the real cache and its locks.
        const isolated = Object.fromEntries(Object.entries(env).filter(([key]) =>
            !/^OPENCODE_(CONFIG|CONFIG_CONTENT|CLI_CONFIG_CONTENT|CONFIG_DIR|DB|TEST_HOME)$/i.test(key)));
        Object.assign(isolated, {
            XDG_CONFIG_HOME: join(directory, "config"), OPENCODE_CONFIG_DIR: config,
            XDG_DATA_HOME: join(directory, "data"), OPENCODE_TEST_HOME: join(directory, "home"),
            XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        });
        for (const id of ids) {
            if (activeSignal.aborted) throw canceled();
            report(`正在下载并准备 ${id}…`);
            const started = Date.now();
            const timer = setInterval(() => report(`仍在准备 ${id}（已等待 ${Math.floor((Date.now() - started) / 1000)} 秒，上限 300 秒）…`), 15000).unref();
            try {
                await run("add", { target: specifier(id, revision), env: isolated, cwd: directory, timeout: 300000, signal: activeSignal });
            } catch (error) {
                if (error.terminationFailed) report("安装子进程未能完整终止，请检查遗留的 plugin add 进程；不要结束正常使用中的 OpenCode。");
                const detail = error.code === "ETIMEDOUT" ? "准备超时（300 秒），请检查网络、代理或插件缓存锁后重试"
                    : error.code === "ABORT_ERR" ? "准备已取消"
                    : Number.isInteger(error.code) ? `下载或安装失败（OpenCode 退出码 ${error.code}）`
                    : "下载或安装失败，请检查网络和 OpenCode 后重试";
                throw Object.assign(new Error(`${id} ${detail}；未修改配置。`, { cause: error }), { code: error.code });
            } finally { clearInterval(timer); }
            report(`✓ ${id}：插件包已准备好`);
        }
    } finally {
        try {
            if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("无效的临时目录");
            await remove(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
        } catch {
            // Cleanup is secondary: never hide the download error or turn a
            // successful preparation into a failed installation.
            report(`临时目录清理失败，已保留：${directory}；请在占用进程退出后清理。`);
        } finally {
            process.off("SIGINT", interrupted);
            process.off("SIGTERM", interrupted);
        }
    }
    if (activeSignal.aborted) throw canceled();
}

export function applySelection(configs, selected, action, revision, backupRoot, options) {
    return applyOperations(configs, selected.map(plugin => ({ plugin, action })), revision, backupRoot, options);
}

export async function applyOperations(configs, operations, revision, backupRoot,
    { prepare = preparePackages, write = writeChanges, report = () => {} } = {}) {
    if (!operations.length) return;
    const changes = planOperations(configs, operations, revision);
    const selected = operations.filter(operation => operation.action !== "remove").map(operation => operation.plugin);
    if (selected.length) await prepare(selected, revision, { report });
    return write(changes, backupRoot, { warn: report });
}
