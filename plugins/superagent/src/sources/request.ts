/** Requests authenticated by the management gateway, without any repository event subscription. */
import { z } from 'zod'
import type { SourceKind } from './kind.ts'

export const REQUEST_SOURCE = 'request'
export const REQUEST_OWNER = 'owner'
export const requestKind: SourceKind = {
  kind: REQUEST_SOURCE,
  title: { zh: '用户需求', en: 'User requests' },
  description: { zh: '环境所有者在面板提交需求，经过评估后交给指定执行环境。无需监听代码仓库。', en: 'The environment owner submits requests for evaluation and execution in the selected environment. No repository subscription is required.' },
  schema: z.object({}).strict(), fields: [], health: [],
  // Outbox receipts are the panel inbox itself; no external transport is involved.
  channel: {send: async () => 'sent', link: () => ({url: '', label: {zh: '用户需求', en: 'User request'}})},
}
