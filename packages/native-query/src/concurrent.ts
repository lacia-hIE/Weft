/** Bound storage fan-out and drain accepted reads before reporting a failure. */
export async function mapConcurrent<Input, Output>(values: readonly Input[], operation: (value: Input) => Promise<Output>, signal?: AbortSignal): Promise<Output[]> {
  const output: Output[] = new Array(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({length: Math.min(4, values.length)}, async () => {
    while (!failed && next < values.length) {
      try {
        signal?.throwIfAborted();
        const index = next++;
        output[index] = await operation(values[index]!);
        signal?.throwIfAborted();
      } catch (error) {
        if (!failed) {failed = true; failure = error;}
      }
    }
  }));
  signal?.throwIfAborted();
  if (failed) throw failure;
  return output;
}
