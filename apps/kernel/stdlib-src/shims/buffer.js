// buffer shim — defer to the VM's globalThis.Buffer (engine BOOTSTRAP provides a Uint8Array-based
// Buffer subset). esbuild aliases require('buffer')/import 'buffer' here so the dep-tree resolves
// at bundle time; at runtime it returns the in-VM Buffer.
const Buffer = (typeof globalThis !== 'undefined' && globalThis.Buffer) ? globalThis.Buffer : undefined;
export { Buffer };
export default { Buffer };
