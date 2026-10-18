/** One execution contract shared by prompt assembly and API inspection. */
export const nativeHostExample = 'return {inject:["fs"],apply(ctx){ctx.effect(()=>harness.handle("save",async args=>{const target=await ctx.fs.resolve("/workspace/example.txt");await ctx.fs.writeText(target,String(args));return {ok:true}}))}}';
export const nativeClientExample = 'return {inject:["slots"],apply(ctx){function Button(){const [n,setN]=React.useState(0);return React.createElement("button",{onClick:async()=>{await host.call("save",n+1);setN(n+1)}},String(n))}ctx.slots.register({name:"conversation.session.header.utilities",id:"example"},Button)}}';
export const NATIVE_PLUGIN_GUIDE = `
Native Cordis plugins are authored with cordis_define and cordis_run, then reviewed in the official Cordis panel.
For a new plugin, idPrefix must contain 3–6 lowercase English letters. Sources are plain JavaScript async FUNCTION BODIES that return a plugin, not JSX/TypeScript or ES module source.
Host receives harness.defineTool/registerTool/handle. ctx exists ONLY inside the returned apply(ctx). Declare fs/tools/timer in inject before using ctx.fs/ctx.tools/ctx.timer. No top-level ctx or harness.fs. Only these Host services are bridged; no direct network, Node processes, Agent objects, or systemPrompt.
Host example: ${nativeHostExample}
Filesystem read/write methods take FsTarget objects: first await ctx.fs.resolve(path), then pass the returned target to ctx.fs.writeText/readText/etc. Never pass a bare path string to read/write methods.
Handlers receive one JSON argument and return lossless JSON (or null). Register handlers inside apply; ctx.effect owns cleanup. Client host.call(method,args) resolves to that JSON value directly.
Client receives React and host. Use React.createElement, no JSX or harness.import. Declare slots in inject. Slots registration takes TWO arguments: ctx.slots.register({name:FULL_SLOT_PATH,id:UNIQUE_ENTRY_ID,order:10}, Component). name is the slot path (e.g. conversation.session.header.utilities), NOT the entry name; id is the entry name, NOT the slot path. Slot registration metadata lists entry fields but does not replace this name selector.
Client example: ${nativeClientExample}
Inspect exact additional APIs with cordis_inspect_list/query; Workerd.capabilities documents the execution boundary. Defining does not activate. Client versions require the user's exact approval. If an activation fails, use the diagnostic to define a new immutable version and request approval again; never bypass approval or claim success before running.
`;
