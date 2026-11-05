/**
 * One program checks Worker code and the pinned browser sources together, so
 * the Workers and Node globals merge into the DOM ones. These overloads restore
 * the browser signatures the upstream client sources rely on; they change no
 * runtime behavior.
 */

interface Element {
  /** The DOM `ParentNode.append`, hidden by the HTMLRewriter `Element.append` overload. */
  append(...nodes: (Node | string)[]): void;
}

interface Window {
  /** Upstream timers type their handle as `ReturnType<typeof setTimeout>`, which `@types/node` makes `NodeJS.Timeout`. */
  setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): ReturnType<typeof globalThis.setTimeout>;
}
