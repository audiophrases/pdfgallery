#!/usr/bin/env node
// Scans the repo root for folders containing PDFs and writes gallery.json.
// Shape:
//   { "<folder>": { "pdfs": ["a.pdf", "b.pdf"] }, ... }

import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const RESERVED = new Set(['assets', 'scripts', '.git', '.github', 'node_modules']);

function listSubdirs(p) {
  return readdirSync(p, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !RESERVED.has(e.name))
    .map(e => e.name)
    .sort();
}

function listPdfs(p) {
  return readdirSync(p, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map(e => e.name)
    .sort();
}

const manifest = {};
for (const folder of listSubdirs(root)) {
  const pdfs = listPdfs(join(root, folder));
  if (pdfs.length > 0) manifest[folder] = { pdfs };
}

const outPath = join(root, 'gallery.json');
const next = JSON.stringify(manifest, null, 2) + '\n';

let prev = '';
try { prev = readFileSync(outPath, 'utf8'); } catch {}

if (prev === next) {
  console.log('gallery.json unchanged.');
} else {
  writeFileSync(outPath, next);
  console.log(`Wrote gallery.json (${Object.keys(manifest).length} folder${Object.keys(manifest).length === 1 ? '' : 's'}).`);
}
