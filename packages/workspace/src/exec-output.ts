import { containerFailureHint } from './container-policy.ts';

interface ExecEvent { name: string; value?: unknown; code?: unknown }

/** Keep output streaming; retain only a bounded stderr tail for container failure diagnostics. */
export function shellOutputFrames(container: boolean, release: () => void): TransformStream<ExecEvent, Uint8Array> {
  const encoder = new TextEncoder();
  let stderr = '';
  return new TransformStream({
    transform(event, controller) {
      if (container && event.name === 'stderr' && typeof event.value === 'string') stderr = (stderr + event.value).slice(-8192);
      if (container && event.name === 'exit') {
        const hint = containerFailureHint(stderr, event.code ?? event.value);
        if (hint) controller.enqueue(encoder.encode(JSON.stringify({type: 'stderr', data: '\n' + hint}) + '\n'));
      }
      const frame = event.name === 'exit' ? {type: 'exit', code: event.code ?? event.value} : {type: event.name, data: event.value};
      controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
      if (event.name === 'exit') release();
    },
    flush: release,
  });
}
