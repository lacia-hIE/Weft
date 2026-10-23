import z from '@deepseek-ai/schemastery';
export const ID = 'weft-documents';
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('Offer document_to_markdown to Agents.'),
  maxInputMiB: z.natural().min(1).max(10).default(10).volatile().description('Maximum input size in MiB, up to the platform limit of 10.'),
  previewCharacters: z.natural().min(1).max(20000).default(20000).volatile().description('Characters returned to the Agent; a saved Markdown file retains the full result.'),
});
