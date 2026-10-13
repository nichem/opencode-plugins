// Native AI SDK loader entry. The scoped hook supplies the connected model.
// Failing closed prevents the generic loader from using config/env credentials.
export function createCursor() {
    return { languageModel() { throw new Error("Cursor: connection adapter is not active; reload opencode-providers."); } };
}
