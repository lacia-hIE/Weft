declare module 'weft:official-modules' {
  /** The enabled official profile rows' modules, keyed by package specifier. */
  const modules: Readonly<Record<string, unknown>>;
  export default modules;
}
