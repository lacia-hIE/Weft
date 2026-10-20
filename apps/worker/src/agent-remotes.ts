import commandRemote from '../../../.generated/official-remotes/packages/interaction/commands/typert.remote-client.js';
import questionRemote from '../../../.generated/official-remotes/packages/interaction/user-questions/typert.remote-client.js';
import goalRemote from '../../../.generated/official-remotes/packages/goal/goal/typert.remote-client.js';
import sessionRemote from '../../../.generated/official-remotes/packages/api/session-controller/typert.remote-client.js';
import scheduleRemote from '../../../.generated/official-remotes/packages/schedule/schedule/typert.remote-client.js';
import messageFeedbackRemote from '../../../.generated/official-remotes/packages/feedback/message-feedback/typert.remote-client.js';
import sessionFeedbackRemote from '../../../.generated/official-remotes/packages/feedback/command-feedback/typert.remote-client.js';
import sessionReferenceRemote from '../../../.generated/official-remotes/packages/context/session-reference/typert.remote-client.js';
import jobRemote from '../../../.generated/official-remotes/packages/api/job-controller/typert.remote-client.js';
import terminalRemote from '../../../.generated/official-remotes/packages/api/terminal-controller/typert.remote-client.js';
import type { RemoteInfo } from '../../../packages/harness-runtime/src/remote-dispatch.ts';

/** Official Agent-scoped Remote services that live on a SessionDO's native root. */
const sessionServices: RemoteInfo = {methods: {'skills/list': sessionRemote.methods['skills/list'], 'fileReferences/list': sessionRemote.methods['fileReferences/list']}};
// `schedule/catalog` spans every Session of the environment and is aggregated by the entry Worker.
const { 'schedule/catalog': _catalog, ...sessionSchedule } = scheduleRemote.methods;
const remotes: readonly RemoteInfo[] = [commandRemote, questionRemote, goalRemote, sessionServices, {methods: sessionSchedule}, messageFeedbackRemote, sessionFeedbackRemote, sessionReferenceRemote, jobRemote, terminalRemote];

export function agentRemoteFor(endpoint: string): RemoteInfo | undefined {
  return remotes.find(info => Object.hasOwn(info.methods, endpoint));
}
