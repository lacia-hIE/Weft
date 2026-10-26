import type {Context} from '@deepseek-ai/cordis';
import type {VerifiedWebhookDelivery,WebhookSessionRequest} from '@deepseek-ai/dsh-webhook';

/** Host seam: original rule execution stays local; only the Session action crosses isolates. */
export async function createWebhookSession(ctx:Context,delivery:VerifiedWebhookDelivery,ruleId:string,request:WebhookSessionRequest,signal:AbortSignal):Promise<void> {
  const action=ctx.get('weftWebhookSessions') as unknown as {create(delivery:VerifiedWebhookDelivery,ruleId:string,request:WebhookSessionRequest,signal:AbortSignal):Promise<void>} | undefined;
  if(!action)throw new Error('Worker webhook Session service is unavailable');
  await action.create(delivery,ruleId,request,signal);
}
