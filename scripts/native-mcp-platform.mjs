import {readFileSync} from 'node:fs';

/**
 * Keep the original MCP transport factory and its Streamable HTTP client;
 * replace only the stdio branch. A Worker Session has no child processes, so a
 * stdio server fails with an explicit error instead of bundling a spawner.
 */
export const nativeMcpPlatform = {
  name: 'harness-native-mcp-platform',
  setup(builder) {
    builder.onLoad({filter: /packages\/mcp\/mcp-client\/src\/transport\.ts$/}, ({path}) => {
      let source = readFileSync(path, 'utf8');
      for (const [before, after] of [
        ["import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'\n", ''],
        ["import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'\n", ''],
        ["function buildChildEnv(extra: Record<string, string>): Record<string, string> {\n  return { ...scrubbedParentEnv(), ...extra }\n}\n", ''],
        [`    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
`, `    case 'stdio':
      throw new Error('MCP stdio servers need a local process; Worker Sessions connect to remote servers over streamable-http')
`],
      ]) {
        if (!source.includes(before)) throw new Error('Upstream MCP transport changed: ' + before.slice(0, 60));
        source = source.replace(before, after);
      }
      return {contents: source, loader: 'ts'};
    });
  },
};
