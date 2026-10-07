// Where do the images actually sit relative to the character headings?
// Dump a window of document.xml around each <a:blip> so we can see what
// surrounds it (drawing inside a table cell? a text box? bare paragraph?).
//
// Usage: node tools/docx-blip-context.mjs <docx> [maxBlips]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docx = process.argv[2];
const maxBlips = Number(process.argv[3] || 4);

/* No zip library available in plain Node, so shell out to PowerShell for the
   single entry we need. */
const tmp = mkdtempSync(join(tmpdir(), 'docxxml-'));
const outXml = join(tmp, 'document.xml');
const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${docx.replace(/'/g, "''")}')
$e = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${outXml.replace(/'/g, "''")}', $true)
$zip.Dispose()
`;
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

const xml = readFileSync(outXml, 'utf8');
console.log(`document.xml: ${xml.length} chars`);

const blips = [...xml.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)].map(m => ({ rId: m[1], at: m.index }));
console.log(`blips: ${blips.length}`);

/* Where are the character headings? They are short <w:t> runs. */
const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => ({ t: m[1], at: m.index }));

function nearestTextBefore(pos) {
  let best = null;
  for (const t of texts) { if (t.at < pos) best = t; else break; }
  return best;
}

for (const b of blips.slice(0, maxBlips)) {
  const before = nearestTextBefore(b.at);
  const after = texts.find(t => t.at > b.at);
  console.log(`\n--- blip rId=${b.rId} @${b.at} ---`);
  console.log(`  nearest text BEFORE: ${JSON.stringify(before ? before.t.slice(0, 60) : null)}  (@${before ? before.at : '-'})`);
  console.log(`  nearest text AFTER : ${JSON.stringify(after ? after.t.slice(0, 60) : null)}  (@${after ? after.at : '-'})`);
  console.log(`  raw: ${xml.slice(Math.max(0, b.at - 260), b.at + 120).replace(/\s+/g, ' ').slice(-320)}`);
}

/* Also: how much text lies before the very first blip vs after the last? */
const first = blips[0].at, last = blips[blips.length - 1].at;
console.log(`\nfirst blip @${first} (${texts.filter(t => t.at < first).length} text runs before it)`);
console.log(`last  blip @${last} (${texts.filter(t => t.at > last).length} text runs after it)`);
