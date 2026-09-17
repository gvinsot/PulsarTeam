// Deterministic, uncompressed ZIP using Node 24 built-ins; no packaging dependency.
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

// Bundle the lockfile-pinned public suffix parser locally; never fetch code at runtime.
const vendor = new URL('../browser-session-extension/vendor/', import.meta.url);
await mkdir(vendor, { recursive: true });
await copyFile(
  new URL('../node_modules/tldts/dist/index.esm.min.js', import.meta.url),
  new URL('tldts.mjs', vendor)
);
await copyFile(
  new URL('../node_modules/tldts/LICENSE', import.meta.url),
  new URL('tldts.LICENSE', vendor)
);
const files = [
  'manifest.json',
  'background.js',
  'core.mjs',
  'popup.html',
  'popup.js',
  'popup.css',
  'vendor/tldts.mjs',
  'vendor/tldts.LICENSE',
];
const parts = [],
  directory = [];
let offset = 0;
for (const file of files) {
  const data = await readFile(new URL(`../browser-session-extension/${file}`, import.meta.url));
  const name = Buffer.from(file);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x21, 12); // 1980-01-01, stable archive timestamp.
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  header.copy(entry, 6, 4, 30);
  entry.writeUInt32LE(offset, 42);
  parts.push(header, name, data);
  directory.push(entry, name);
  offset += header.length + name.length + data.length;
}
const central = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const output = new URL('../public/extensions/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('pulsarteam-session.zip', output), Buffer.concat([...parts, central, end]));
