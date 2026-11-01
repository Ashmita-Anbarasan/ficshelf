# Putting FicShelf online (free, GitHub Pages)

About 15 minutes, once. You need a GitHub account and a Google account.

## 1. Put the site on GitHub Pages

1. Sign in at https://github.com (create a free account if you don't have one).
2. Click **+** (top right) → **New repository**.
   - Name: `ficshelf` (this becomes part of the link).
   - Set it to **Public** (free GitHub Pages needs public).
   - Click **Create repository**.
3. On the new repo page click **uploading an existing file**.
4. Drag in **everything inside this folder** (index.html, app.js, core.js, lib.js, style.css, config.js,
   sw.js, icon.svg, manifest.webmanifest, SETUP.md). Drag the files themselves, not the folder.
   Click **Commit changes**.
5. Go to **Settings → Pages**. Under "Build and deployment":
   Source = **Deploy from a branch**, Branch = **main**, folder **/ (root)** → **Save**.
6. Wait 1–2 minutes. Your site is at **https://YOUR-GITHUB-USERNAME.github.io/ficshelf/**

## 2. Create the Google API key (lets the site read Drive folders)

1. Go to https://console.cloud.google.com and sign in.
2. Top bar → project picker → **New project** → name it `ficshelf` → **Create**, then make sure it's selected.
3. Search bar → **Google Drive API** → **Enable**.
4. Left menu **APIs & Services → Credentials** → **+ Create credentials → API key**. Copy the key.
5. Click the key to edit it and lock it down:
   - **Application restrictions:** Websites → **Add** → `https://YOUR-GITHUB-USERNAME.github.io/*`
   - **API restrictions:** Restrict key → tick **Google Drive API**.
   - **Save.** (Takes up to 5 minutes to apply.)

It's free. Because it's locked to your site and to Drive, it's safe for it to be visible in the site's code.

## 3. Put the key in the site

1. In your GitHub repo, click **config.js** → the pencil icon (Edit).
2. Paste the key between the quotes: `googleApiKey: "AIza..."`
3. **Commit changes.** After a minute the live site can read any "anyone with the link" Drive folder.

## Updating later

Edit or re-upload files in the repo; the site updates in a minute or two.
Visitors get the new version the next time they open it while online.

## Good to know

- Everyone's library, downloads, shelves and progress stay in **their own browser**. Nothing is shared
  between people, and nothing is stored on GitHub except the app itself.
- Clearing site data for the page wipes that browser's library. **Sources → Save backup** keeps a copy.
- Google limits how often one shared file can be downloaded per day. If a scan pauses, continue it later.
- The site never hosts fics itself; it only reads the Drive folders each person adds.
