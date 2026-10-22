import type {RunnerFailureRule} from '@deepseek-ai/dsh-sandbox';
import type { ShellSandbox } from './shell.ts';
import type { SubprocessOutcome, SubprocessTerminalActivity, SubprocessTerminalForeground, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess';

export const PROCESS_PATH = '/weft/process';
export const PROCESS_PORT = 8081;
export interface ProcessSpec {
  kind: 'pipe' | 'pty'; argv: string[]; cwd: string; env?: Record<string, string>; sandbox: ShellSandbox;
  graceMs: number; control?: boolean; rows?: number; cols?: number; terminalType?: string; shellActivity?: boolean;
}
export interface ProcessOffsets {stdout: number; stderr: number; control: number}
export interface ProcessRead {
  stdout: Uint8Array; stderr: Uint8Array; control: Uint8Array; offsets: ProcessOffsets;
  outcome?: SubprocessOutcome; error?: string; active: boolean;
}
export interface ProcessService {
  info(): {generation: string};
  resolve(command: string, env?: Readonly<Record<string, string>>): Promise<string>;
  confine(policy: ShellSandbox): Promise<{enforcement: 'full' | 'partial'; denialSignatures: string[]; runnerFailureRules: readonly RunnerFailureRule[]}>;
  start(id: string, spec: ProcessSpec): Promise<{pid: number}>;
  read(id: string, offsets: ProcessOffsets): Promise<ProcessRead>;
  write(id: string, sequence: number, channel: 'stdin' | 'control', data: Uint8Array, end: boolean): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  foreground(id: string): Promise<SubprocessTerminalForeground | undefined>;
  activity(id: string): Promise<SubprocessTerminalActivity>;
  signal(id: string, signal: SubprocessTerminalSignal): Promise<number>;
  terminate(id: string): Promise<void>;
  wait(id: string): Promise<boolean>;
}
