import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {posix} from 'node:path';
import {workspacePath} from '../../workspace/src/protocol.ts';
import {WorkerDocuments, MAX_DOCUMENT_BYTES} from './converter.ts';

/** Original filesystem and tool seams keep tenant access, sandbox policy and normal tool presentation. */
export function mountWorkerDocuments(ctx: Context, ai: Pick<Ai, 'toMarkdown'> | undefined): void {
  const documents = new WorkerDocuments(ai);
  ctx.tools.register(defineTool({
    name: 'document_to_markdown',
    description: 'Read a workspace Office document, PDF, image, HTML or other supported file as Markdown using Cloudflare Workers AI, without a container or Office CLI. PPTX extracts slide text in the Worker before conversion; images and layout are not preserved. Other formats follow the live Cloudflare supported formats. Maximum input 10 MiB, Markdown output 256 KiB. Optional output_path saves a new .md file without overwriting an existing file. Use present to show that file. This extracts content; it does not render Office files to PDF or edit the source document.',
    parameters: {file_path: {type: 'string', required: true}, output_path: {type: 'string'}},
    output: {schema: {type: 'json'}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
    execute: async ({file_path, output_path}, exec) => {
      const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : ctx.workingDirectory.defaultDirectory;
      const path = workspacePath(file_path, cwd);
      const target = await ctx.fs.resolve(path);
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_DOCUMENT_BYTES);
      exec.signal.throwIfAborted();
      const result = await documents.convert(posix.basename(path), bytes);
      exec.signal.throwIfAborted();
      let outputPath: string | undefined;
      if (output_path !== undefined) {
        outputPath = workspacePath(output_path, cwd);
        if (!outputPath.endsWith('.md')) throw new Error('output_path must name a Markdown .md file');
        const destination = await ctx.fs.resolve(outputPath);
        await ctx.fs.writeText(destination, result.markdown, {kind: 'createIfAbsent'}, exec.signal, exec.sandboxPolicy ?? ctx.sandboxPolicy.resolve());
      }
      return {...result, markdown: result.markdown.slice(0, 20000), truncated: result.markdown.length > 20000, ...(outputPath ? {outputPath} : {})};
    },
  }));
}
