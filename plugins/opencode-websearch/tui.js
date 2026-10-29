import { installPicker } from "./src/picker.js";

export default {
    id: "opencode-websearch.tui",
    setup(ctx) {
        installPicker(ctx, async (...args) => {
            const { showPicker } = await import("./src/dialog.js");
            return showPicker(...args);
        });
    },
};
