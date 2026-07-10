/**
 * Builds a Chrome Web Store upload zip containing ONLY the runtime extension
 * files (manifest + src + icons). Excludes node_modules, tests, tools, docs,
 * .git, and dev config. Zero dependencies (writes the ZIP by hand).
 *
 *   node tools/package.mjs   ->   dist/localcaptions-v<version>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Everything the packaged extension needs at runtime -- nothing else.
const INCLUDE = ['manifest.json', 'src', 'icons'];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) walk(full, rel, out);
    else out.push({ rel, full });
  }
}

const files = [];
for (const inc of INCLUDE) {
  const full = path.join(ROOT, inc);
  if (!fs.existsSync(full)) { console.error(`missing: ${inc}`); process.exit(1); }
  if (fs.statSync(full).isDirectory()) walk(full, inc, files);
  else files.push({ rel: inc, full });
}

// Deterministic DOS timestamp (2024-01-01 00:00) so repeated builds are stable.
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

const localParts = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const crc = crc32(data);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(f.rel.replace(/\\/g, '/'), 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);   // UTF-8 filename flag
  local.writeUInt16LE(8, 8);        // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, comp);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([cd, nameBuf]));

  offset += local.length + nameBuf.length + comp.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...localParts, centralBuf, eocd]);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
fs.mkdirSync(DIST, { recursive: true });
const outPath = path.join(DIST, `localcaptions-v${manifest.version}.zip`);
fs.writeFileSync(outPath, zip);

console.log(`Packaged ${files.length} files -> dist/${path.basename(outPath)} (${(zip.length / 1024).toFixed(1)} KB)`);
for (const f of files) console.log(`  ${f.rel}`);
