# PDF Gallery

A static PDF gallery hosted on GitHub Pages. Each top-level folder in this repo becomes a gallery available at:

```
https://audiophrases.github.io/pdfgallery/<folder>/
```

The gallery scans the folder for PDFs at runtime (via the GitHub Contents API), renders thumbnails of the first page using PDF.js, and lets the admin attach comments that anyone visiting the page can see.

## Add a new gallery

1. Create a folder at the repo root (e.g. `c/`).
2. Drop one or more `.pdf` files into it.
3. Commit and push. Done — the gallery appears at `/<folder>/` automatically.

No per-folder `index.html` is needed; a SPA fallback (`404.html`) handles routing.

## Admin and comments

- Click **Admin login** in the header. Password is hardcoded in [`assets/app.js`](assets/app.js) (`ADMIN_PASSWORD`).
- After logging in, click **Set GitHub token**. Paste a fine-grained Personal Access Token with **Contents: Read and write** permission for `audiophrases/pdfgallery`. Create one at https://github.com/settings/personal-access-tokens. The token is stored in your browser's `localStorage`.
- Each thumbnail then shows a comment badge. Click it to expand the panel, then post or delete comments. Posts commit changes to `comments.json` in this repo.
- A thumbnail with one or more comments shows the badge to all visitors; visitors without admin access can read comments but not edit them.

## Local dev

```sh
npx http-server . -p 8080
```

Visit `http://localhost:8080/`. The folder list still loads from the public GitHub repo (the API doesn't see your local files), so to test new folders you need to push them first.

## Files

- `index.html`, `404.html` — SPA shell (404.html is the fallback that makes `<folder>/` URLs work without per-folder files).
- `assets/app.js` — routing, GitHub API integration, thumbnail rendering, comment UI.
- `assets/style.css` — styles.
- `comments.json` — comment store. Edited by the app via the GitHub API.
