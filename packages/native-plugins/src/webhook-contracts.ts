import {z} from 'zod';
import type {VerifiedWebhookDelivery,WebhookSessionRequest,WebhookRuleId} from '@deepseek-ai/dsh-webhook';
import type {ModelSelection} from '@deepseek-ai/dsh-agent';

const text=z.string().min(1).max(32768).refine(value=>value.trim().length>0);
export const webhookDelivery=z.object({kind:text,source:text,deliveryId:text,receivedAt:z.number().int().nonnegative().safe(),event:z.json()}).strict();
export const webhookSessionRequest=z.object({workspacePath:text,title:text,prompt:text,agentPreset:text,permissionPreset:text,
  model:z.object({provider:text,model:text,maxTokens:z.number().int().positive().safe().optional()}).strict().optional(),
}).strict();
export interface WorkerWebhookSeed {
  delivery:VerifiedWebhookDelivery;ruleId:WebhookRuleId;request:WebhookSessionRequest;
  selection:ModelSelection;
}
export function readWebhookSeed(raw:unknown):WorkerWebhookSeed {
  return z.object({delivery:webhookDelivery,ruleId:text,request:webhookSessionRequest,
    selection:z.object({provider:text,model:text,reasoningEffort:z.string().optional()}).strict(),
  }).strict().parse(raw) as WorkerWebhookSeed;
}
