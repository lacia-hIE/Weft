/** ripgrep in the workspace container image, which the official file search tools spawn directly. */
export const RIPGREP = '/usr/bin/rg';
/** git in the workspace container image, which the official change recorder spawns directly. */
export const GIT = '/usr/bin/git';
/** `<CONTAINER_SH> -c <script>` runs the script in the workspace container's shell rather than the worker shell. */
export const CONTAINER_SH = '/weft/container/sh';

/** One POSIX shell word holding `value` literally. */
export const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
