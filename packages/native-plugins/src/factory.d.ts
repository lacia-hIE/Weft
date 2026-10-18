declare module 'weft:plugin-factory' {
    const factory: (harness: {
        defineTool: unknown;
        registerTool: unknown;
        handle: unknown;
    }) => Promise<unknown>;
    export default factory;
}
