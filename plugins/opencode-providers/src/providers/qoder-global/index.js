import { setupQoder } from "../qoder/index.js";
import { QODER_GLOBAL } from "./constants.js";

export function setupQoderGlobal(ctx, options = {}) {
    return setupQoder(ctx, options, QODER_GLOBAL);
}
