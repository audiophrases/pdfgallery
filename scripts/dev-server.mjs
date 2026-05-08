#!/usr/bin/env node
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const port = Number(process.env.PORT || process.argv[2] || 8080);
const host = process.env.HOST || '127.0.0.1';
const RESERVED = new Set(['assets', 'scripts', '.git', '.github', 'node_modules']);

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

let writeQueue = Promise.resolve();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  };
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), MIME['.json']);
}

async function enqueueWrite(task) {
  const pending = writeQueue.then(task, task);
  writeQueue = pending.catch(() => {});
  return pending;
}

function isInsideRoot(path) {
  const relative = path.slice(root.length);
  return path === root || (relative.startsWith(sep) && !relative.includes(`..${sep}`));
}

function splitRepoPath(path) {
  if (typeof path !== 'string') throw new Error('Path is required.');
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('Path must be "folder/file.pdf".');
  return parts;
}

function validateFolder(folder) {
  if (!folder || folder === '.' || folder === '..') throw new Error('Invalid folder.');
  if (folder.includes('/') || folder.includes('\\')) throw new Error('Invalid folder.');
  if (folder.startsWith('.') || RESERVED.has(folder)) throw new Error('Reserved folder.');
}

function validatePdfName(name) {
  if (!name || name === '.' || name === '..') throw new Error('Invalid filename.');
  if (name.includes('/') || name.includes('\\')) throw new Error('Invalid filename.');
  if (!name.toLowerCase().endsWith('.pdf')) throw new Error('Filename must end in .pdf.');
}

function pdfPath(repoPath) {
  const [folder, name] = splitRepoPath(repoPath);
  validateFolder(folder);
  validatePdfName(name);
  const path = resolve(root, folder, name);
  if (!isInsideRoot(path)) throw new Error('Invalid path.');
  return { folder, name, path };
}

function buildManifest() {
  const manifest = {};
  const folders = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !RESERVED.has(e.name))
    .map(e => e.name)
    .sort();

  for (const folder of folders) {
    const pdfs = readdirSync(join(root, folder), { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
      .map(e => e.name)
      .sort();
    if (pdfs.length > 0) manifest[folder] = { pdfs };
  }

  return writeFile(join(root, 'gallery.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(text);
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/local/ping') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/local/comments') {
    try {
      const text = await readFile(join(root, 'comments.json'), 'utf8');
      send(res, 200, text, MIME['.json']);
    } catch (err) {
      if (err && err.code === 'ENOENT') sendJson(res, 200, {});
      else throw err;
    }
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const body = await readBody(req);

  if (url.pathname === '/api/local/comments') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Comments payload must be an object.');
    }
    await enqueueWrite(() => writeFile(join(root, 'comments.json'), JSON.stringify(body, null, 2) + '\n'));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/local/rename') {
    await enqueueWrite(async () => {
      const oldFile = pdfPath(body.oldPath);
      const newFile = pdfPath(body.newPath);
      if (oldFile.folder !== newFile.folder) throw new Error('Rename must stay in the same folder.');
      await access(oldFile.path, constants.F_OK);
      try {
        await access(newFile.path, constants.F_OK);
        throw new Error('A file with that name already exists.');
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
      await rename(oldFile.path, newFile.path);
      await buildManifest();
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/local/delete') {
    await enqueueWrite(async () => {
      const file = pdfPath(body.path);
      await rm(file.path);
      await buildManifest();
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  send(res, 404, 'Not found');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const rawPath = decodeURIComponent(url.pathname);
  let path = resolve(root, rawPath.replace(/^\/+/, ''));
  if (!isInsideRoot(path)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(root, 'index.html');
  } catch {
    const extension = extname(rawPath);
    path = extension ? join(root, '404.html') : join(root, 'index.html');
  }

  const data = await readFile(path);
  res.writeHead(basename(path) === '404.html' ? 404 : 200, {
    'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/local/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    send(res, 500, err && err.message ? err.message : String(err));
  }
});

server.listen(port, host, () => {
  console.log(`PDF Gallery local editor running at http://${host}:${port}/`);
});
