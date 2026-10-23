import z from '@deepseek-ai/schemastery';
export const ID = 'weft-javascript';
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('Offer javascript_task to Agents. Existing tasks remain manageable from Worker tasks.'),
  defaultTimeoutMs: z.natural().min(1).max(600000).default(120000).volatile().description('Default execution timeout in milliseconds; the platform maximum is 600000.'),
  allowWritable: z.boolean().default(true).volatile().description('Allow new writable tasks within the Session sandbox. Disabling this does not cancel existing tasks.'),
});
