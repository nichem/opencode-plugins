import { QoderLanguageModel } from "../qoder/language-model.js";
import { QODER_GLOBAL } from "./constants.js";

export function createQoderGlobal(options = {}) {
    return {
        languageModel(modelID) {
            return new QoderLanguageModel(modelID, options, QODER_GLOBAL);
        },
    };
}
