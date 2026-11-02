/** The `describe` / `it` / `expect` / `vi` subset the ported dsh-superagent specs use, over `node:test`. */
import assert from 'node:assert/strict';
import {after, afterEach as nodeAfterEach, before, beforeEach as nodeBeforeEach, describe as nodeDescribe, it as nodeIt} from 'node:test';

class Asymmetric {constructor(readonly check: (value: unknown) => boolean, readonly label: string) {}}
function matches(actual: unknown, expected: unknown, partial: boolean): boolean {
  if (expected instanceof Asymmetric) return expected.check(actual);
  if (Object.is(actual, expected)) return true;
  if (expected instanceof RegExp) return actual instanceof RegExp && String(actual) === String(expected);
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return false;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  if (Array.isArray(expected)) return expected.length === (actual as unknown[]).length && expected.every((item, index) => matches((actual as unknown[])[index], item, partial));
  if (expected instanceof Map || expected instanceof Set) return matches([...(actual as Map<unknown, unknown>)], [...expected], partial);
  const left = actual as Record<string, unknown>, right = expected as Record<string, unknown>;
  const present = (row: Record<string, unknown>) => Object.keys(row).filter(key => row[key] !== undefined);
  if (!partial && present(left).length !== present(right).length) return false;
  return present(right).every(key => matches(left[key], right[key], partial));
}
interface Mock {(...args: unknown[]): unknown; mock: {calls: unknown[][]; results: {value: unknown}[]}; mockImplementation(next: (...args: never[]) => unknown): Mock; mockReturnValue(value: unknown): Mock; mockClear(): Mock}
function fn(implementation?: (...args: never[]) => unknown): Mock {
  let current = implementation;
  const mock = ((...args: unknown[]) => {mock.mock.calls.push(args); const value = current?.(...args as never[]); mock.mock.results.push({value}); return value;}) as Mock;
  mock.mock = {calls: [], results: []};
  mock.mockImplementation = next => {current = next; return mock;};
  mock.mockReturnValue = value => {current = () => value; return mock;};
  mock.mockClear = () => {mock.mock.calls = []; mock.mock.results = []; return mock;};
  return mock;
}
function thrown(run: () => unknown): {error: unknown} | undefined {try {run();} catch (error) {return {error};} return undefined;}
function throwsLike(error: unknown, expected: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (expected === undefined) return true;
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return error instanceof expected;
  return matches(error, expected, true);
}
function at(value: unknown, path: string | string[]): {found: boolean; value: unknown} {
  let current = value;
  for (const part of Array.isArray(path) ? path : path.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) return {found: false, value: undefined};
    current = (current as Record<string, unknown>)[part];
  }
  return {found: true, value: current};
}
function matchers(actual: unknown, negate: boolean) {
  const verdict = (pass: boolean, message: string) => assert.ok(negate ? !pass : pass, (negate ? 'not ' : '') + message + ': ' + JSON.stringify(actual, (_key, value) => typeof value === 'function' ? '[fn]' : value));
  const calls = () => (actual as Mock).mock.calls;
  return {
    toBe: (expected: unknown) => verdict(Object.is(actual, expected), `toBe ${JSON.stringify(expected)}`),
    toEqual: (expected: unknown) => verdict(matches(actual, expected, false), `toEqual ${JSON.stringify(expected)}`),
    toStrictEqual: (expected: unknown) => verdict(matches(actual, expected, false), `toStrictEqual ${JSON.stringify(expected)}`),
    toMatchObject: (expected: unknown) => verdict(matches(actual, expected, true), `toMatchObject ${JSON.stringify(expected)}`),
    toThrow: (expected?: unknown) => {const result = thrown(actual as () => unknown); verdict(!!result && throwsLike(result.error, expected), `toThrow ${String(expected)} (threw ${String(result?.error)})`);},
    toBeUndefined: () => verdict(actual === undefined, 'toBeUndefined'),
    toBeDefined: () => verdict(actual !== undefined, 'toBeDefined'),
    toBeNull: () => verdict(actual === null, 'toBeNull'),
    toBeTruthy: () => verdict(!!actual, 'toBeTruthy'),
    toBeFalsy: () => verdict(!actual, 'toBeFalsy'),
    toBeGreaterThan: (expected: number) => verdict((actual as number) > expected, `toBeGreaterThan ${expected}`),
    toBeLessThan: (expected: number) => verdict((actual as number) < expected, `toBeLessThan ${expected}`),
    toHaveLength: (expected: number) => verdict((actual as {length: number}).length === expected, `toHaveLength ${expected}`),
    toContain: (expected: unknown) => verdict(typeof actual === 'string' ? actual.includes(String(expected)) : [...actual as Iterable<unknown>].some(item => Object.is(item, expected)), `toContain ${JSON.stringify(expected)}`),
    toContainEqual: (expected: unknown) => verdict([...actual as Iterable<unknown>].some(item => matches(item, expected, false)), `toContainEqual ${JSON.stringify(expected)}`),
    toMatch: (expected: RegExp | string) => verdict(typeof expected === 'string' ? String(actual).includes(expected) : expected.test(String(actual)), `toMatch ${String(expected)}`),
    toHaveProperty: (path: string | string[], ...rest: unknown[]) => {const found = at(actual, path); verdict(found.found && (!rest.length || matches(found.value, rest[0], false)), `toHaveProperty ${String(path)}`);},
    toHaveBeenCalled: () => verdict(calls().length > 0, 'toHaveBeenCalled'),
    toHaveBeenCalledOnce: () => verdict(calls().length === 1, 'toHaveBeenCalledOnce'),
    toHaveBeenCalledTimes: (count: number) => verdict(calls().length === count, `toHaveBeenCalledTimes ${count}`),
    toHaveBeenCalledWith: (...args: unknown[]) => verdict(calls().some(call => matches(call, args, false)), `toHaveBeenCalledWith ${JSON.stringify(args)}`),
    toHaveBeenCalledExactlyOnceWith: (...args: unknown[]) => verdict(calls().length === 1 && matches(calls()[0], args, false), `toHaveBeenCalledExactlyOnceWith ${JSON.stringify(args)}`),
    toHaveBeenLastCalledWith: (...args: unknown[]) => verdict(calls().length > 0 && matches(calls().at(-1), args, false), `toHaveBeenLastCalledWith ${JSON.stringify(args)}`),
  };
}
type Matchers = ReturnType<typeof matchers>;
type Promised = {[K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void>};
export function expect(actual: unknown): Matchers & {not: Matchers; resolves: Promised; rejects: Promised} {
  const settled = (rejects: boolean) => new Proxy({}, {get: (_target, name: string) => async (...args: unknown[]) => {
    const outcome = await (actual as Promise<unknown>).then(value => ({ok: true, value}), error => ({ok: false, value: error}));
    assert.equal(outcome.ok, !rejects, rejects ? `expected a rejection, resolved ${JSON.stringify(outcome.value)}` : `expected to resolve, rejected ${String(outcome.value)}`);
    if (rejects && name === 'toThrow') {assert.ok(throwsLike(outcome.value, args[0]), `rejects.toThrow ${String(args[0])} (rejected ${String(outcome.value)})`); return;}
    (matchers(outcome.value, false) as unknown as Record<string, (...input: unknown[]) => void>)[name]!(...args);
  }}) as Promised;
  return {...matchers(actual, false), not: matchers(actual, true), resolves: settled(false), rejects: settled(true)};
}
expect.any = (type: unknown) => new Asymmetric(value => type === String ? typeof value === 'string' : type === Number ? typeof value === 'number' : type === Boolean ? typeof value === 'boolean' : type === Function ? typeof value === 'function' : type === Object ? typeof value === 'object' && value !== null : value instanceof (type as new () => unknown), 'any') as never;
expect.anything = () => new Asymmetric(value => value !== null && value !== undefined, 'anything') as never;
expect.objectContaining = (expected: object) => new Asymmetric(value => matches(value, expected, true), 'objectContaining') as never;
expect.arrayContaining = (expected: unknown[]) => new Asymmetric(value => Array.isArray(value) && expected.every(item => value.some(row => matches(row, item, false))), 'arrayContaining') as never;
expect.stringContaining = (expected: string) => new Asymmetric(value => typeof value === 'string' && value.includes(expected), 'stringContaining') as never;
export const vi = {fn, mocked: <T>(value: T) => value as T & Mock};
type Each = {each(rows: readonly (readonly any[])[]): (name: string, run: (...args: any[]) => unknown) => void};
const each: Each['each'] = rows => (name, run) => {for (const row of rows) nodeIt(`${name} ${JSON.stringify(row[0])}`, () => run(...row) as void);};
export const it = Object.assign((name: string, run: (...args: any[]) => unknown) => nodeIt(name, () => run() as void), {each}), test = it;
export const describe = nodeDescribe, beforeEach = nodeBeforeEach, afterEach = nodeAfterEach, beforeAll = before, afterAll = after;
