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

  // ---------- GitHub API ----------
  async function ghContents(folder) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${folder ? encodeURIComponent(folder) : ''}?ref=${REPO_BRANCH}`;
    const res = await fetch(url, { headers: ghHeaders(true) });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function listFolders() {
    const items = await ghContents('');
    return items
      .filter(i => i.type === 'dir' && !i.name.startsWith('.') && !RESERVED_DIRS.has(i.name))
      .map(i => i.name)
      .sort();
  }

  async function listPdfs(folder) {
    const items = await ghContents(folder);
    return items
      .filter(i => i.type === 'file' && i.name.toLowerCase().endsWith('.pdf'))
      .map(i => ({ name: i.name, downloadUrl: i.download_url, path: i.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- Comments store (comments.json in repo) ----------
  let commentsCache = null;
  let commentsSha = null;

  async function loadComments() {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${COMMENTS_PATH}?ref=${REPO_BRANCH}`;
    const res = await fetch(url, { headers: ghHeaders(true) });
    if (res.status === 404) {
      commentsCache = {};
      commentsSha = null;
      return commentsCache;
    }
    if (!res.ok) throw new Error(`Failed to load comments (${res.status})`);
    const meta = await res.json();
    commentsSha = meta.sha;
    try {
      const decoded = atob((meta.content || '').replace(/\n/g, ''));
      commentsCache = JSON.parse(decodeURIComponent(escape(decoded))) || {};
    } catch (e) {
      commentsCache = {};
    }
    return commentsCache;
  }

  async function saveComments() {
    if (!githubToken) throw new Error('GitHub token required to save comments.');
    const json = JSON.stringify(commentsCache, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${COMMENTS_PATH}`;
    const body = { message: 'Update comments', content: encoded, branch: REPO_BRANCH };
    if (commentsSha) body.sha = commentsSha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(true)),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status}): ${await res.text()}`);
    const out = await res.json();
    commentsSha = out.content && out.content.sha;
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
    root.appendChild(el('header', { class: 'site-header' },
      el('a', { class: 'back', href: basePath() }, '← All galleries'),
      el('h1', null, folder),
      adminControls()
    ));
    const main = el('main', { class: 'gallery' });
    root.appendChild(main);

    const status = el('p', { class: 'status' }, 'Loading…');
    main.appendChild(status);

    let pdfs;
    try {
      const [p] = await Promise.all([listPdfs(folder), loadComments()]);
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
    for (const pdf of pdfs) grid.appendChild(buildCard(folder, pdf));
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

    renderThumbnail(canvas, pdf.downloadUrl).catch(() => {
      const fallback = el('div', { class: 'thumb-error' }, 'Preview unavailable');
      canvas.replaceWith(fallback);
    });

    return card;
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
  // raw.githubusercontent.com serves PDFs with Content-Disposition: attachment,
  // which makes browsers download instead of display. Fetch as a blob and re-serve
  // with application/pdf so the iframe renders it inline.
  async function openViewer(pdf) {
    const overlay = el('div', {
      class: 'viewer-overlay',
      onclick: (e) => { if (e.target === overlay) cleanup(); },
    });
    const close = el('button', { class: 'viewer-close', title: 'Close', onclick: () => cleanup() }, '×');
    const frame = el('iframe', { class: 'viewer-frame' });
    overlay.appendChild(close);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    let blobUrl = null;
    function cleanup() {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', onKey);

    try {
      const res = await fetch(pdf.downloadUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      blobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
      frame.src = blobUrl;
    } catch (err) {
      frame.replaceWith(el('p', { class: 'error', style: 'color:white;padding:24px;' }, 'Failed to load PDF: ' + err.message));
    }
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
