import { readdir, readFile, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

export const BACKUP_LIMIT = 10;
const backupName = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Only recognize this installer's flat backup sets. Never descend into other
// directories or follow links, and never use the manifest's restore paths for deletion.
async function backupFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || !/^(manifest\.json|\d+\.json\.bak)$/.test(entry.name))) return;
    if (!entries.some(entry => entry.name === "manifest.json")) return;
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); }
    catch (error) { if (error instanceof SyntaxError || error.code === "ENOENT") return; throw error; }
    if (!Array.isArray(manifest) || !manifest.length || manifest.some((entry, i) =>
        !entry || typeof entry.path !== "string" || (entry.backup !== null && entry.backup !== `${i}.json.bak`))) return;
    const allowed = new Set(["manifest.json", ...manifest.map(entry => entry.backup).filter(Boolean)]);
    if (entries.some(entry => !allowed.has(entry.name))) return;
    return entries.map(entry => entry.name);
}

export async function pruneBackups(backupRoot, { limit = BACKUP_LIMIT, keep } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("备份上限必须为正整数");
    let root;
    try { root = await realpath(backupRoot); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const protectedPath = keep ? await realpath(keep) : undefined;
    const candidates = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !backupName.test(entry.name)) continue;
        const directory = resolve(root, entry.name);
        if (dirname(directory) !== root) throw new Error("无效的备份目录");
        try {
            const files = await backupFiles(directory);
            if (files) candidates.push({ directory, name: entry.name });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Always retain the backup just written, even if the system clock moved backwards.
    candidates.sort((a, b) => Number(b.directory === protectedPath) - Number(a.directory === protectedPath) || b.name.localeCompare(a.name));
    for (const { directory } of candidates.slice(limit)) {
        try {
            if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) continue;
            const files = await backupFiles(directory);
            if (!files) continue;
            // Flat deletion cannot recursively remove an unexpected nested directory.
            for (const file of files.filter(file => file !== "manifest.json")) await unlink(join(directory, file));
            await unlink(join(directory, "manifest.json"));
            await rmdir(directory);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
