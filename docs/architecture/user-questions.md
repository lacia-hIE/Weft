# Native questions in Worker Host plugins

Worker Host packages with the existing Sessions grant can subscribe to ordinary native questions. The Host owns request identity, native state and settlement. Packages own their conversation routes, presentation and respondent checks. No channel routing lives in SessionDO or EnvironmentDO, and no second Agent or tool protocol is introduced.

```js
await ctx.weftSessionEvents.watchQuestions(sessionId);
ctx.effect(() => ctx.weftSessionEvents.onQuestionChanged(async ({sessionId}) => {
  const questions = await ctx.sessionController.questions({sessionId});
  // Pull current state; send only to a conversation this package owns.
}));
const accepted = await ctx.sessionController.answerQuestion({
  sessionId, requestId,
  answer: {answers: [{id: 'format', selected: ['CSV']}]},
});
await ctx.weftSessionEvents.unwatch(sessionId);
```

`watchQuestions` also subscribes to existing turn notifications. Watches are idempotent and persist by package and root Session in the environment's SQLite. Notifications carry only the Session identity; no persistent follow or extra connection is needed. Old turn-only watchers retain their behavior. Package activation, approval and Sessions permission are checked on delivery, reads and answers.

`questions` returns `{requestId, callId?, state, questions}` using the original item and answer shapes. Open requests come from the native `user-questions/request` waterfall; continued requests come from the Session projection. Reads do not activate historical Agents. Late answers invoke the original `userQuestions/answer` method. The first Web or plugin settlement wins; losing answers return false. An answer must name every question exactly once and use offered option labels, custom text or the native empty selection for an explicit skip.

An unrelated Web client delegating its waterfall does not close a request with a live question watcher. Timed requests retain the native timeout: this bridge does not hold a timer claim or extend the foreground wait. A continued question retains its original call id. Durable tool results and native late-answer messages produce another notification after persistence flushes. Foreground waterfalls are process-local; Host restarts cancel them. Native continued questions remain reconstructible from the log. Permission questions with an `approval` intent and `approval/request` are excluded.

## IM presentation

IM 0.11.0 uses this capability for Sessions its own chat bridge created. Questions arrive before the turn ends, with options and a short code. A single pending question in the current conversation accepts the requester's next text. Multiple requests require a quoted question or `/answer <code> <answer>`. Batches collect one question at a time; multi-select choices accept comma-separated numbers. `/answer <code> /skip` skips the current question without granting permission. `/questions` explicitly reopens outstanding questions.

The plugin stores prompt provenance, original sender, partial answers and delivery receipts in its own storage domain. Mixed-origin or mixed-sender turns are not forwarded. Native runtime/time context snapshots are not human prompts and cannot select a destination. Group answers require the original requester and normal bot access. Feishu replies can identify a question through its returned message id; explicit codes work on every channel. `/new` leaves prior questions explicitly answerable while preventing implicit capture of new conversation messages. `/stop` follows native cancellation.

Web replies end the IM question; IM replies cancel outstanding Web deliveries. Timed questions remain answerable after continuation, and their late replies use the normal IM response cursor. Restarts reconcile retained questions against native state. A send reservation prevents automatic duplicate sends after an uncertain provider response; `/questions` is the explicit resend path.

**Web link for questions** in IM General settings is the environment's public `/native/` URL. Saving the form fills an empty value from the current page. Links open the original Session and native question UI, contain no answer credentials and require normal owner authentication.

A bot assigned through `weftIm` retains its consumer's routing. This bridge does not claim other packages' conversations or forward local Executor questions. Consumers can use the same generic Host interfaces for cloud Sessions; local question transport needs a separate connector extension.

## Validation

`tests/im-question-flow.test.ts` installs the actual bundled plugin and drives signed QQ webhooks through Worker Host, the native ask-user tool, Session notifications, IM replies and Web answers. `tests/im-questions.test.ts` covers Web/plugin arbitration, delegated Web listeners, approval exclusion, cross-Session and cross-chat replies, requester checks, batches, multi-select answers, continued questions, `/new` and duplicate submissions. Both run in CI, including a build-stage smoke check.
