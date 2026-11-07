import { readConfigs } from "./config.js";
import { latestRevision, opencode, loadVersionTrees, statuses } from "./status.js";

const fingerprint = configs => JSON.stringify(configs.map(({ kind, path, original }) => [kind, path, original]));

// Start while the main menu is open. Buffer diagnostics so background checks
// never overwrite an interactive prompt. Each check owns its cancellation scope.
export function createUpdateCheck(hostVersion, {
    read = readConfigs, latest = latestRevision, list = options => opencode("list", options),
    loadTrees = loadVersionTrees, now = Date.now, maxAge = 60000,
} = {}) {
    let current;
    let closed = false;
    const pending = new Set();
    function refresh(configs) {
        if (closed) return;
        current?.controller.abort();
        const controller = new AbortController();
        const entry = { controller, settled: false, used: false, completed: 0 };
        current = entry;
        entry.promise = (async () => {
            const signal = controller.signal;
            const messages = [];
            const [configuration, revision, inventory] = await Promise.allSettled([
                configs ?? read(), latest({ signal }), list({ signal }),
            ]);
            signal.throwIfAborted();
            if (configuration.status === "rejected") throw configuration.reason;
            const snapshot = configuration.value;
            if (revision.status === "rejected") return { key: fingerprint(snapshot), messages,
                error: "GitHub 版本检查失败；检查网络和 Git 后返回重试。未修改配置。" };
            const installed = inventory.status === "fulfilled" ? inventory.value.stdout : "";
            if (inventory.status === "rejected") messages.push("无法读取缓存版本，未知版本可选择重新安装。");
            const trees = await loadTrees(snapshot, revision.value, installed, undefined,
                { hostVersion, signal, report: message => messages.push(message) });
            signal.throwIfAborted();
            const reusable = inventory.status === "fulfilled"
                && !statuses(snapshot, revision.value, installed, trees, { hostVersion }).some(plugin => plugin.state === "unknown");
            return { key: fingerprint(snapshot), latest: revision.value, installed, trees, messages, reusable };
        })().catch(error => ({ error: controller.signal.aborted ? "版本检查已取消。" : error.message, messages: [] }))
            .then(result => { entry.settled = true; entry.completed = now(); entry.result = result; return result; });
        pending.add(entry.promise);
        void entry.promise.then(() => pending.delete(entry.promise));
    }
    refresh();
    return {
        get ready() { return current.settled; },
        refresh,
        async get(configs, { onWait = () => {} } = {}) {
            if (closed) throw new Error("版本检查已关闭");
            if (current.settled && (now() - current.completed >= maxAge || (current.used && !current.result.reusable)
                || (current.result.key && current.result.key !== fingerprint(configs)))) refresh(configs);
            let entry = current;
            if (!entry.settled) onWait();
            let result = await entry.promise;
            if (result.key && result.key !== fingerprint(configs)) {
                refresh(configs);
                entry = current;
                result = await entry.promise;
            }
            entry.used = true;
            return result;
        },
        async close() {
            closed = true;
            current.controller.abort();
            await Promise.all(pending);
        },
    };
}
