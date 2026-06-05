// engram stdlib entry: isomorphic-git, bundled CJS with ALL deps inlined (single IIFE).
// Self-installs into globalThis.__mods so require('isomorphic-git') resolves from the in-VM
// stdlib bundle — NO CDN, NO ESM dep-tree, NO relative-require (the spike's fragility).
import * as git from 'isomorphic-git';

(function () {
  var mod = git && git.default ? git.default : git;
  // surface both the namespace and a callable default for interop.
  globalThis.__mods = globalThis.__mods || {};
  globalThis.__mods['isomorphic-git'] = mod;
  globalThis.git = mod;
})();
