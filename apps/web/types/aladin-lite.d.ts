// aladin-lite ships no type declarations. This covers only what AladinPanel uses.
declare module "aladin-lite" {
  const A: {
    /** Resolves once the WebAssembly core is ready; rejects without WebGL2. */
    init: Promise<void>;
    aladin: (el: HTMLElement, opts: object) => unknown;
  };
  export default A;
}
