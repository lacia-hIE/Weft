/**
 * Browser stand-in for the Node modules the pinned Loader's filesystem resolver
 * imports. Browser boot supplies `loader.internal` before any plugin import, so
 * the resolver never runs here; any access is a defect and fails loudly.
 */
const external: never = new Proxy({}, {
  get(_target, property) {
    throw new Error(`Node module member ${String(property)} is unavailable in the browser Loader`);
  },
}) as never;
export default external;
