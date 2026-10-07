// Map every embedded image in the character sheet to its character.
//
// The images are ANCHORED (floating frames), so they get their own paragraph and
// a paragraph-based mapping comes back empty. What does work reliably is the
// nearest preceding <w:t> run: each character section starts with a short
// heading that is just the character's name(s), and that heading is the last
// text before the portraits.
//
// Usage: node tools/docx-image-map.mjs <docx> <mediaDirRelativeToDocs>
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docx = process.argv[2];
const tmp = mkdtempSync(join(tmpdir(), 'docxmap-'));
const outXml = join(tmp, 'document.xml');
const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${docx.replace(/'/g, "''")}')
$e = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${outXml.replace(/'/g, "''")}', $true)
$e2 = $zip.Entries | Where-Object { $_.FullName -eq 'word/_rels/document.xml.rels' }
$out2 = '${join(tmp, 'document.xml.rels').replace(/'/g, "''")}'
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e2, $out2, $true)
$zip.Dispose()
`;
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

const xml = readFileSync(outXml, 'utf8');
const rels = readFileSync(join(tmp, 'document.xml.rels'), 'utf8');

const relMap = {};
for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
  relMap[m[1]] = m[2];
}

const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => ({ t: m[1], at: m.index }));
const blips = [...xml.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)].map(m => ({ rId: m[1], at: m.index }));

/* A character heading is a short text run that contains no field punctuation.
   U+FF1A ：  U+3002 。 U+FF0C ， U+FF08 （ */
const isHeading = (s) =>
  s.length > 0 && s.length <= 24 && !/[\uff1a\u3002\uff0c\uff08]/.test(s);

const rows = [];
let cur = '(未归属)';
for (const b of blips) {
  // advance through any headings that appear before this image
  for (const t of texts) {
    if (t.at >= b.at) break;
    if (isHeading(t.t)) cur = t.t;
  }
  const media = (relMap[b.rId] || '').replace(/^media\//, '').replace(/^\.\.\//, '');
  rows.push({ n: rows.length + 1, rId: b.rId, media, who: cur });
}

const byWho = new Map();
for (const r of rows) {
  if (!byWho.has(r.who)) byWho.set(r.who, []);
  byWho.get(r.who).push(r.media);
}

console.log(`=== ${rows.length} 张图，归属 ${byWho.size} 个角色 ===\n`);
for (const [who, media] of byWho) {
  console.log(`${who.padEnd(22)} ${media.length} 张  ${media.join(', ')}`);
}

const tsv = ['idx\trId\tmedia\tcharacter', ...rows.map(r => `${r.n}\t${r.rId}\t${r.media}\t${r.who}`)].join('\n');
writeFileSync('docs/char-image-map.tsv', tsv, 'utf8');
console.log('\n-> docs/char-image-map.tsv');
