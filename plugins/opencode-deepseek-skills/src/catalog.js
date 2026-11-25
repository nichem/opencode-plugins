import { readFile } from "node:fs/promises";

export const skills = [
    { id: "search", name: "Search", description: "搜索实时网页，获取来源链接、摘要和可选正文" },
    { id: "fetch", name: "Fetch", description: "抓取指定网页的 Markdown 正文" },
    { id: "ocr", name: "OCR", description: "识别图片、PDF、Word、PowerPoint 中的文字与版面" },
    { id: "asr", name: "ASR", description: "将 WAV / Ogg Opus 音频转写为文字" },
    { id: "tts", name: "TTS", description: "将文字合成为 WAV / PCM 音频文件" },
];
export const skillIDs = skills.map(skill => skill.id);
export const isSkill = id => skillIDs.includes(id);
export const toolNames = ["deepseek_skill", "deepseek_run"];
export const skillDescription = "按需加载 DeepSeek 技能的 SKILL.md，读取后再使用 deepseek_run。\n"
    + skills.map(skill => `${skill.id}: ${skill.description}`).join("\n");
export async function skillDocument(id) {
    if (!isSkill(id)) throw new Error("未知 DeepSeek 技能");
    return readFile(new URL(`../skills/${id}/SKILL.md`, import.meta.url), "utf8");
}
