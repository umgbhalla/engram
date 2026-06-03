// HTML imported as a string. At build time esbuild inlines it via the `.html` text loader;
// at type-check time it is a plain string module.
declare module "*.html" {
  const content: string;
  export default content;
}
