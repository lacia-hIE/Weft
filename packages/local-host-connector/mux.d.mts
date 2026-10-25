export const MAX_MUX_BYTES: number;
export class MuxChannel {
  constructor(send: (frame: Record<string, unknown>) => void, deliver: (id: string, text: string) => void | Promise<void>, failed: (id: string, error: Error) => void, options?: {timeoutMs?: number; maxBufferedBytes?: number; maxMessageBytes?: number});
  send(id: string, text: string): Promise<void>;
  handle(frame: {type: string; id: string; [key: string]: unknown}): boolean;
  drop(id: string, error?: Error): void;
  close(): void;
}
