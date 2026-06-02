import { build } from 'esbuild';
const r = await build({
  stdin: { contents: `
    import _ from 'lodash';
    import dayjs from 'dayjs';
    globalThis._ = _;
    globalThis.dayjs = dayjs;
  `, resolveDir: '.', loader: 'js' },
  bundle: true, format: 'iife', minify: true, write: false, platform: 'neutral',
});
import { writeFileSync } from 'fs';
writeFileSync('stdlib.js', r.outputFiles[0].text);
console.log('stdlib bytes', r.outputFiles[0].text.length);
