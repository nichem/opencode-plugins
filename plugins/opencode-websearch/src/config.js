import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse, modify, applyEdits } from "jsonc-parser";

export class ConfigurationError extends Error {}
async function text(path) {
    try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export class ProjectConfiguration {
    constructor(directory, { sources, backupRoot = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-websearch", "backups") } = {}) {
        this.directory = directory;
        this.sources = sources;
        this.backupRoot = backupRoot;
    }
    async snapshot() {
        const paths = ["", ".opencode"].flatMap(folder => ["opencode.json", "opencode.jsonc"].map(file => join(this.directory, folder, file)));
        const documents = [];
        for (const path of paths) {
            const original = await text(path), errors = [];
            const data = parse(original ?? "{}", errors, { allowTrailingComma: true });
            if (errors.length || !data || typeof data !== "object" || Array.isArray(data))
                throw new ConfigurationError(`项目配置格式错误：${path}（未修改）`);
            documents.push({ path, original, data });
        }
        return documents;
    }
    async read(sources) {
        let selection;
        const effective = sources ?? (this.sources ? await this.sources() : (await this.snapshot()).map(({ path, data }) => ({ path, websearch: data.websearch })));
        for (const { websearch } of effective) {
            if (websearch === false) selection = false;
            else if (typeof websearch?.provider === "string") selection = websearch.provider;
        }
        return selection;
    }
    async write(providerID, sources) {
        const documents = await this.snapshot();
        let target = documents.findLast(document => document.original !== null) ?? documents[1];
        // Every inherited .opencode config outranks direct project configs. Add
        // a local override instead of editing an ancestor or global document.
        if (!documents.slice(2).includes(target)) {
            const inherited = (sources ?? await this.sources?.() ?? []).some(({ path, websearch }) => {
                if (!path || websearch === undefined || basename(dirname(path)) !== ".opencode") return false;
                const from = relative(dirname(dirname(path)), this.directory);
                return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`);
            });
            if (inherited) target = documents[3];
        }
        if (target.data.websearch?.provider === providerID) return false;
        const original = target.original ?? "{}\n";
        const property = target.data.websearch && typeof target.data.websearch === "object" && !Array.isArray(target.data.websearch)
            ? ["websearch", "provider"] : ["websearch"];
        const next = applyEdits(original, modify(original, property, property.length === 2 ? providerID : { provider: providerID },
            { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" } }));
        const verify = async () => {
            for (const document of documents)
                if (await text(document.path) !== document.original)
                    throw new ConfigurationError("项目配置被其他程序修改，请重新打开 /search 后重试");
        };
        await verify();
        const backup = join(this.backupRoot, `${Date.now()}-${randomUUID()}`);
        await mkdir(backup, { recursive: true });
        if (target.original !== null) await writeFile(join(backup, "config.json.bak"), target.original, { flag: "wx", mode: 0o600 });
        await writeFile(join(backup, "manifest.json"), JSON.stringify({ path: target.path, existed: target.original !== null }), { flag: "wx", mode: 0o600 });
        const temporary = join(dirname(target.path), `.opencode-websearch-${randomUUID()}.tmp`);
        try {
            await mkdir(dirname(target.path), { recursive: true });
            await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
            await verify();
            await rename(temporary, target.path);
        } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        return true;
    }
}
