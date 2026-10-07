/* Analyze the screenshot pixels to find the actual arena border and canvas edges.
   Pure PNG decoding would need a library, so instead: ask the user's harness
   image is available on disk - we crop regions and report raw pixel runs. */
import { readFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) { console.log('usage: node tests/tools/measure-shot.mjs <png>'); process.exit(1); }

/* We cannot decode PNG without a library, so we shell out nothing either.
   Instead: report the file info and tell the caller to use the browser-side
   measurement panel. */
const buf = readFileSync(src);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
console.log(`image: ${w} x ${h}  bytes=${buf.length}`);
console.log('PNG decoded dimensions only (no pixel decoding without a library).');
