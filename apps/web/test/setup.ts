import { configure } from "@testing-library/dom";

// The graph view loads elkjs (a 1.4 MB bundle) on demand. When the suite runs its files in
// parallel under jsdom, the first layout after mount measured 1.1–2.6 s on a loaded laptop,
// so testing-library's 1 s findBy/waitFor default failed a different test on each run.
// 10 s is well above the slowest observed mount and still well under the 30 s test timeout.
configure({ asyncUtilTimeout: 10_000 });

// Node 25 and later define their own localStorage and sessionStorage globals, which are
// undefined without --localstorage-file and hide jsdom's, so every test that touched storage
// failed on Node 26. Under jsdom, put the window's own storage back.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom !== undefined) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
}
