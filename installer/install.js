import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { catalog, specifier } from "./catalog.js";
import { planChanges, writeChanges } from "./config.js";
import { opencode } from "./status.js";

export async function preparePackages(selected, revision, { run = opencode, env = process.env, report = () => {} } = {}) {
    const ids = [...new Set(selected.map(plugin => plugin.id))];
    if (!/^[a-f0-9]{40}$/.test(revision) || ids.some(id => !catalog.some(plugin => plugin.id === id)))
        throw new Error("无效的插件或提交版本（未修改配置）");
    if (!ids.length) return;
    const directory = await mkdtemp(join(tmpdir(), "opencode-plugin-install-"));
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
            report(`正在下载并准备 ${id}…`);
            const timer = setInterval(() => report(`仍在准备 ${id}，请稍候…`), 15000).unref();
            try {
                await run("add", { target: specifier(id, revision), env: isolated, cwd: directory, timeout: 300000 });
            } catch (error) {
                throw new Error(`${id} 下载或安装失败（可能是网络、超时或 OpenCode 安装错误）；未修改配置，请重试。`, { cause: error });
            } finally { clearInterval(timer); }
            report(`✓ ${id}：插件包已准备好`);
        }
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("无效的临时目录");
        await rm(directory, { recursive: true, force: true });
    }
}

export async function applySelection(configs, selected, action, revision, backupRoot,
    { prepare = preparePackages, write = writeChanges, report = () => {} } = {}) {
    const changes = planChanges(configs, selected, action, revision);
    if (action === "install") await prepare(selected, revision, { report });
    return write(changes, backupRoot, { warn: report });
}
