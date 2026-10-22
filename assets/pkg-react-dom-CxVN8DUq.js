const parts = ["pkg-react-dom-CxVN8DUq.part0","pkg-react-dom-CxVN8DUq.part1","pkg-react-dom-CxVN8DUq.part2","pkg-react-dom-CxVN8DUq.part3","pkg-react-dom-CxVN8DUq.part4","pkg-react-dom-CxVN8DUq.part5","pkg-react-dom-CxVN8DUq.part6","pkg-react-dom-CxVN8DUq.part7","pkg-react-dom-CxVN8DUq.part8","pkg-react-dom-CxVN8DUq.part9","pkg-react-dom-CxVN8DUq.part10","pkg-react-dom-CxVN8DUq.part11"];
let source = "";
for (const name of parts) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(name);
  source += await response.text();
}
const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const mod = await import(url);
export default mod.default;
export const browser = mod.browser;
export const createPortal = mod.createPortal;
export const flushSync = mod.flushSync;
export const preconnect = mod.preconnect;
export const prefetchDNS = mod.prefetchDNS;
export const preinit = mod.preinit;
export const preinitModule = mod.preinitModule;
export const preload = mod.preload;
export const preloadModule = mod.preloadModule;
export const requestFormReset = mod.requestFormReset;
export const unstable_batchedUpdates = mod.unstable_batchedUpdates;
export const useFormState = mod.useFormState;
export const useFormStatus = mod.useFormStatus;
export const version = mod.version;
export const c = mod.c;
