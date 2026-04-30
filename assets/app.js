(function () {
  'use strict';

  const REPO_OWNER = 'audiophrases';
  const REPO_NAME = 'pdfgallery';
  const REPO_BRANCH = 'main';
  const ADMIN_PASSWORD = '12345';
  const COMMENTS_PATH = 'comments.json';
  const PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const RESERVED_DIRS = new Set(['assets', 'scripts', '.git', '.github', 'node_modules']);

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function ghHeaders(includeAuth) {
    const h = { 'Accept': 'application/vnd.github.v3+json' };
    if (includeAuth && githubToken) h['Authorization'] = 'Bearer ' + githubToken;
    return h;
  }

  function basePath() {
    const href = document.baseURI;
    const a = document.createElement('a');
    a.href = href;
    return a.pathname; // ends with /
  }

  function currentFolder() {
    const path = location.pathname.replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    if (last === REPO_NAME) return null;
    if (RESERVED_DIRS.has(last)) return null;
    return decodeURIComponent(last);
  }

  // ---------- Manifest (built by .github/workflows/build-manifests.yml) ----------
  // Static reads avoid the unauthenticated GitHub API rate limit (60/hr/IP).
  let manifestCache = null;

  async function loadManifest() {
    if (manifestCache) return manifestCache;
    const res = await fetch(basePath() + 'gallery.json?t=' + Date.now(), { cache: 'no-cache' });
    if (!res.ok) throw new Error('gallery.json: HTTP ' + res.status);
    manifestCache = await res.json();
    return manifestCache;
  }

  async function listFolders() {
    const m = await loadManifest();
    return Object.keys(m).filter(k => !RESERVED_DIRS.has(k)).sort();
  }

  async function resolveFolder(folder) {
    const m = await loadManifest();
    if (m[folder]) return folder;
    const lower = folder.toLowerCase();
    const match = Object.keys(m).find(k => k.toLowerCase() === lower);
    return match || null;
  }

  async function listPdfs(folder) {
    const m = await loadManifest();
    const entry = m[folder];
    if (!entry || !Array.isArray(entry.pdfs)) return [];
    return entry.pdfs.slice().sort().map(name => ({
      name,
      downloadUrl: basePath() + encodeURIComponent(folder) + '/' + encodeURIComponent(name),
    }));
  }

  // ---------- Comments store (comments.json in repo) ----------
  // Reads: static fetch of comments.json (served by GH Pages, no API).
  // Writes: GitHub Contents API, authenticated with admin token (5000/hr).
  let commentsCache = null;

  async function loadComments() {
    const res = await fetch(basePath() + COMMENTS_PATH + '?t=' + Date.now(), { cache: 'no-cache' });
    if (res.status === 404) { commentsCache = {}; return commentsCache; }
    if (!res.ok) throw new Error('comments.json: HTTP ' + res.status);
    try { commentsCache = await res.json(); } catch { commentsCache = {}; }
    if (!commentsCache || typeof commentsCache !== 'object') commentsCache = {};
    return commentsCache;
  }

  async function fetchCommentsSha() {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${COMMENTS_PATH}?ref=${REPO_BRANCH}`;
    const res = await fetch(url, { headers: ghHeaders(true) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to fetch comments sha: HTTP ' + res.status);
    const meta = await res.json();
    return meta.sha || null;
  }

  async function saveComments() {
    if (!githubToken) throw new Error('GitHub token required to save comments.');
    const sha = await fetchCommentsSha();
    const json = JSON.stringify(commentsCache, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${COMMENTS_PATH}`;
    const body = { message: 'Update comments', content: encoded, branch: REPO_BRANCH };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(true)),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status}): ${await res.text()}`);
  }

  function getCommentsFor(folder, name) {
    return ((commentsCache || {})[folder] || {})[name] || [];
  }

  function addCommentLocal(folder, name, text) {
    if (!commentsCache[folder]) commentsCache[folder] = {};
    if (!commentsCache[folder][name]) commentsCache[folder][name] = [];
    commentsCache[folder][name].push({ text, date: new Date().toISOString() });
  }

  function removeCommentLocal(folder, name, idx) {
    const arr = commentsCache[folder] && commentsCache[folder][name];
    if (!arr) return;
    arr.splice(idx, 1);
    if (arr.length === 0) delete commentsCache[folder][name];
    if (commentsCache[folder] && Object.keys(commentsCache[folder]).length === 0) delete commentsCache[folder];
  }

  // ---------- File operations (admin) ----------
  async function ghDeleteFile(path, message) {
    const api = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
    const getRes = await fetch(`${api}/contents/${encodeURI(path)}?ref=${REPO_BRANCH}`, { headers: ghHeaders(true) });
    if (!getRes.ok) throw new Error(`Lookup failed: HTTP ${getRes.status}`);
    const meta = await getRes.json();
    const delRes = await fetch(`${api}/contents/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(true)),
      body: JSON.stringify({ message: message || `Delete ${path}`, sha: meta.sha, branch: REPO_BRANCH }),
    });
    if (!delRes.ok) throw new Error(`Delete failed (${delRes.status}): ${await delRes.text()}`);
  }

  // Atomic rename via Git Data API. Works for any file size; the Contents API
  // truncates content for files >1MB so we can't simply re-PUT it under a new path.
  async function ghMoveFile(oldPath, newPath) {
    const api = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(true));

    const refRes = await fetch(`${api}/git/refs/heads/${REPO_BRANCH}`, { headers: ghHeaders(true) });
    if (!refRes.ok) throw new Error(`ref: HTTP ${refRes.status}`);
    const baseCommitSha = (await refRes.json()).object.sha;

    const commitRes = await fetch(`${api}/git/commits/${baseCommitSha}`, { headers: ghHeaders(true) });
    if (!commitRes.ok) throw new Error(`commit: HTTP ${commitRes.status}`);
    const baseTreeSha = (await commitRes.json()).tree.sha;

    const blobMetaRes = await fetch(`${api}/contents/${encodeURI(oldPath)}?ref=${REPO_BRANCH}`, { headers: ghHeaders(true) });
    if (!blobMetaRes.ok) throw new Error(`blob meta: HTTP ${blobMetaRes.status}`);
    const blobSha = (await blobMetaRes.json()).sha;

    const treeRes = await fetch(`${api}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [
          { path: oldPath, mode: '100644', type: 'blob', sha: null },
          { path: newPath, mode: '100644', type: 'blob', sha: blobSha },
        ],
      }),
    });
    if (!treeRes.ok) throw new Error(`tree: HTTP ${treeRes.status} ${await treeRes.text()}`);
    const newTreeSha = (await treeRes.json()).sha;

    const newCommitRes = await fetch(`${api}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: `Rename ${oldPath} -> ${newPath}`,
        tree: newTreeSha,
        parents: [baseCommitSha],
      }),
    });
    if (!newCommitRes.ok) throw new Error(`new commit: HTTP ${newCommitRes.status}`);
    const newCommitSha = (await newCommitRes.json()).sha;

    const updateRes = await fetch(`${api}/git/refs/heads/${REPO_BRANCH}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (!updateRes.ok) throw new Error(`ref update: HTTP ${updateRes.status} ${await updateRes.text()}`);
  }

  function updateManifestRename(folder, oldName, newName) {
    if (!manifestCache || !manifestCache[folder]) return;
    manifestCache[folder].pdfs = manifestCache[folder].pdfs.map(n => n === oldName ? newName : n).sort();
  }

  function updateManifestDelete(folder, name) {
    if (!manifestCache || !manifestCache[folder]) return;
    manifestCache[folder].pdfs = manifestCache[folder].pdfs.filter(n => n !== name);
    if (manifestCache[folder].pdfs.length === 0) delete manifestCache[folder];
  }

  // ---------- PDF thumbnail rendering ----------
  async function renderThumbnail(canvas, pdfUrl) {
    const task = pdfjsLib.getDocument(pdfUrl);
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const targetWidth = canvas.clientWidth || 220;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = (targetWidth * (window.devicePixelRatio || 1)) / baseViewport.width;
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  // ---------- Admin state ----------
  let adminUnlocked = sessionStorage.getItem('pdfgallery_admin') === '1';
  let githubToken = localStorage.getItem('pdfgallery_token') || '';

  function isAdmin() { return adminUnlocked; }

  function promptLogin() {
    const pw = prompt('Admin password:');
    if (pw === null) return;
    if (pw === ADMIN_PASSWORD) {
      adminUnlocked = true;
      sessionStorage.setItem('pdfgallery_admin', '1');
      rerender();
    } else {
      alert('Incorrect password.');
    }
  }

  function promptToken() {
    const t = prompt(
      'Paste a GitHub Personal Access Token with "Contents: Read and write" permission for ' +
      REPO_OWNER + '/' + REPO_NAME + '.\n\nCreate one at: https://github.com/settings/personal-access-tokens'
    );
    if (!t) return;
    githubToken = t.trim();
    localStorage.setItem('pdfgallery_token', githubToken);
    rerender();
  }

  function clearToken() {
    githubToken = '';
    localStorage.removeItem('pdfgallery_token');
    rerender();
  }

  function logout() {
    adminUnlocked = false;
    sessionStorage.removeItem('pdfgallery_admin');
    rerender();
  }

  // ---------- Render: header / admin controls ----------
  function adminControls() {
    const wrap = el('div', { class: 'admin-controls' });
    if (!isAdmin()) {
      wrap.appendChild(el('button', { class: 'admin-btn', onclick: promptLogin }, 'Admin login'));
      return wrap;
    }
    wrap.appendChild(el('span', { class: 'admin-status' }, 'Admin'));
    if (!githubToken) {
      wrap.appendChild(el('button', { class: 'admin-btn', onclick: promptToken }, 'Set GitHub token'));
    } else {
      wrap.appendChild(el('button', { class: 'admin-btn', onclick: promptToken }, 'Update token'));
      wrap.appendChild(el('button', { class: 'admin-btn', onclick: clearToken }, 'Clear token'));
    }
    wrap.appendChild(el('button', { class: 'admin-btn', onclick: logout }, 'Logout'));
    return wrap;
  }

  // ---------- Render: landing ----------
  async function renderLanding(root) {
    root.innerHTML = '';
    root.appendChild(el('header', { class: 'site-header' },
      el('h1', null, 'PDF Gallery'),
      adminControls()
    ));
    const main = el('main', { class: 'landing' });
    root.appendChild(main);

    if (!isAdmin()) {
      main.appendChild(el('p', { class: 'empty' }, 'Open the link you were given to view your gallery.'));
      return;
    }

    main.appendChild(el('p', { class: 'status' }, 'Loading folders…'));

    let folders;
    try {
      folders = await listFolders();
    } catch (e) {
      main.innerHTML = '';
      main.appendChild(el('p', { class: 'error' }, 'Could not load folder list: ' + e.message));
      return;
    }
    main.innerHTML = '';
    if (folders.length === 0) {
      main.appendChild(el('p', { class: 'empty' }, 'No galleries yet. Create a folder in the repo and drop PDFs into it.'));
      return;
    }
    const list = el('ul', { class: 'folder-list' });
    for (const f of folders) {
      list.appendChild(el('li', null, el('a', { href: basePath() + encodeURIComponent(f) + '/' }, f)));
    }
    main.appendChild(list);
  }

  // ---------- Render: gallery ----------
  async function renderGallery(root, folder) {
    root.innerHTML = '';
    const header = el('header', { class: 'site-header' },
      el('h1', null, folder),
      adminControls()
    );
    root.appendChild(header);
    const main = el('main', { class: 'gallery' });
    root.appendChild(main);

    const status = el('p', { class: 'status' }, 'Loading…');
    main.appendChild(status);

    let pdfs, canonical;
    try {
      canonical = await resolveFolder(folder);
      if (!canonical) {
        status.remove();
        main.appendChild(el('p', { class: 'empty' }, 'No PDFs in this folder.'));
        return;
      }
      header.querySelector('h1').textContent = canonical;
      const [p] = await Promise.all([listPdfs(canonical), loadComments()]);
      pdfs = p;
    } catch (e) {
      status.remove();
      main.appendChild(el('p', { class: 'error' }, 'Error: ' + e.message));
      return;
    }
    status.remove();

    if (pdfs.length === 0) {
      main.appendChild(el('p', { class: 'empty' }, 'No PDFs in this folder.'));
      return;
    }

    const grid = el('div', { class: 'grid' });
    main.appendChild(grid);
    for (const pdf of pdfs) grid.appendChild(buildCard(canonical, pdf));
  }

  function buildCard(folder, pdf) {
    const card = el('div', { class: 'card' });
    const canvas = el('canvas', { class: 'thumb' });
    const wrap = el('div', { class: 'thumb-wrap', title: 'Open ' + pdf.name }, canvas);
    wrap.addEventListener('click', () => openViewer(pdf));
    card.appendChild(wrap);
    card.appendChild(el('div', { class: 'name' }, pdf.name));

    const count = getCommentsFor(folder, pdf.name).length;
    if (count > 0 || isAdmin()) {
      const badge = el('button', {
        class: 'badge' + (count === 0 ? ' empty' : ''),
        title: count + ' comment' + (count === 1 ? '' : 's'),
        onclick: (e) => { e.stopPropagation(); toggleCommentsPanel(card, folder, pdf.name); },
      }, String(count));
      card.appendChild(badge);
    }

    if (isAdmin()) {
      card.appendChild(buildCardAdmin(folder, pdf));
    }

    renderThumbnail(canvas, pdf.downloadUrl).catch(() => {
      const fallback = el('div', { class: 'thumb-error' }, 'Preview unavailable');
      canvas.replaceWith(fallback);
    });

    return card;
  }

  function buildCardAdmin(folder, pdf) {
    const tools = el('div', { class: 'card-admin' });
    const renameBtn = el('button', { class: 'card-admin-btn', onclick: () => doRename(folder, pdf, tools) }, 'Rename');
    const deleteBtn = el('button', { class: 'card-admin-btn danger', onclick: () => doDelete(folder, pdf, tools) }, 'Delete');
    tools.appendChild(renameBtn);
    tools.appendChild(deleteBtn);
    return tools;
  }

  function setToolsBusy(tools, msg) {
    tools.querySelectorAll('button').forEach(b => { b.disabled = true; });
    let status = tools.querySelector('.card-admin-status');
    if (!status) {
      status = el('span', { class: 'card-admin-status' });
      tools.appendChild(status);
    }
    status.textContent = msg;
  }

  async function doRename(folder, pdf, tools) {
    if (!githubToken) { promptToken(); if (!githubToken) return; }
    const newName = prompt('Rename PDF:', pdf.name);
    if (!newName || newName === pdf.name) return;
    if (!/\.pdf$/i.test(newName)) { alert('Filename must end in .pdf'); return; }
    if (/[\\/:*?"<>|]/.test(newName)) { alert('Filename contains invalid characters.'); return; }
    setToolsBusy(tools, 'Renaming…');
    try {
      await ghMoveFile(`${folder}/${pdf.name}`, `${folder}/${newName}`);
      if (commentsCache && commentsCache[folder] && commentsCache[folder][pdf.name]) {
        commentsCache[folder][newName] = commentsCache[folder][pdf.name];
        delete commentsCache[folder][pdf.name];
        try { await saveComments(); } catch (e) { console.warn('Comments update failed:', e); }
      }
      updateManifestRename(folder, pdf.name, newName);
      rerender();
    } catch (e) {
      alert('Rename failed: ' + e.message);
      setToolsBusy(tools, '');
      tools.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  async function doDelete(folder, pdf, tools) {
    if (!githubToken) { promptToken(); if (!githubToken) return; }
    if (!confirm(`Delete "${pdf.name}"? This cannot be undone.`)) return;
    setToolsBusy(tools, 'Deleting…');
    try {
      await ghDeleteFile(`${folder}/${pdf.name}`, `Delete ${folder}/${pdf.name}`);
      if (commentsCache && commentsCache[folder] && commentsCache[folder][pdf.name]) {
        delete commentsCache[folder][pdf.name];
        if (Object.keys(commentsCache[folder]).length === 0) delete commentsCache[folder];
        try { await saveComments(); } catch (e) { console.warn('Comments update failed:', e); }
      }
      updateManifestDelete(folder, pdf.name);
      rerender();
    } catch (e) {
      alert('Delete failed: ' + e.message);
      setToolsBusy(tools, '');
      tools.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  function refreshBadge(card, folder, name) {
    const count = getCommentsFor(folder, name).length;
    let badge = card.querySelector('.badge');
    if (!badge && (count > 0 || isAdmin())) {
      badge = el('button', {
        class: 'badge',
        onclick: (e) => { e.stopPropagation(); toggleCommentsPanel(card, folder, name); },
      });
      card.appendChild(badge);
    }
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle('empty', count === 0);
      badge.title = count + ' comment' + (count === 1 ? '' : 's');
      if (count === 0 && !isAdmin()) badge.remove();
    }
  }

  function toggleCommentsPanel(card, folder, name) {
    const existing = card.querySelector('.comments-panel');
    if (existing) { existing.remove(); return; }
    card.appendChild(buildCommentsPanel(card, folder, name));
  }

  function buildCommentsPanel(card, folder, name) {
    const panel = el('div', { class: 'comments-panel' });
    const list = el('ul', { class: 'comments-list' });
    panel.appendChild(list);
    const items = getCommentsFor(folder, name);
    if (items.length === 0) {
      list.appendChild(el('li', { class: 'no-comments' }, 'No comments yet.'));
    } else {
      items.forEach((c, idx) => {
        const li = el('li', { class: 'comment' },
          el('div', { class: 'comment-text' }, c.text),
          el('div', { class: 'comment-date' }, new Date(c.date).toLocaleString())
        );
        if (isAdmin()) {
          li.appendChild(el('button', {
            class: 'delete-btn',
            title: 'Delete comment',
            onclick: async () => {
              if (!confirm('Delete this comment?')) return;
              if (!githubToken) { promptToken(); if (!githubToken) return; }
              const snapshot = JSON.parse(JSON.stringify(commentsCache));
              removeCommentLocal(folder, name, idx);
              try {
                await saveComments();
                panel.remove();
                card.appendChild(buildCommentsPanel(card, folder, name));
                refreshBadge(card, folder, name);
              } catch (err) {
                commentsCache = snapshot;
                alert('Failed to delete: ' + err.message);
              }
            },
          }, '×'));
        }
        list.appendChild(li);
      });
    }

    if (isAdmin()) {
      const form = el('form', { class: 'comment-form' });
      const ta = el('textarea', { placeholder: 'Add a comment…', rows: '2' });
      const submit = el('button', { type: 'submit' }, 'Post');
      form.appendChild(ta);
      form.appendChild(submit);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        if (!githubToken) { promptToken(); if (!githubToken) return; }
        submit.disabled = true;
        submit.textContent = 'Posting…';
        const snapshot = JSON.parse(JSON.stringify(commentsCache));
        addCommentLocal(folder, name, text);
        try {
          await saveComments();
          panel.remove();
          card.appendChild(buildCommentsPanel(card, folder, name));
          refreshBadge(card, folder, name);
        } catch (err) {
          commentsCache = snapshot;
          alert('Failed to post: ' + err.message);
          submit.disabled = false;
          submit.textContent = 'Post';
        }
      });
      panel.appendChild(form);
    }

    return panel;
  }

  // ---------- PDF viewer overlay ----------
  function openViewer(pdf) {
    const overlay = el('div', {
      class: 'viewer-overlay',
      onclick: (e) => { if (e.target === overlay) cleanup(); },
    });
    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(el('button', { class: 'viewer-close', title: 'Close', onclick: cleanup }, '×'));
    overlay.appendChild(el('iframe', { class: 'viewer-frame', src: pdf.downloadUrl }));
    document.body.appendChild(overlay);
  }

  // ---------- Boot ----------
  function rerender() {
    const root = document.getElementById('root');
    const folder = currentFolder();
    if (folder) renderGallery(root, folder);
    else renderLanding(root);
  }

  function init() {
    if (typeof pdfjsLib === 'undefined') {
      const root = document.getElementById('root');
      root.innerHTML = '';
      root.appendChild(el('main', null, el('p', { class: 'error' }, 'Failed to load PDF.js.')));
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    rerender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
