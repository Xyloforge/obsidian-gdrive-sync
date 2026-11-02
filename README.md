# Xyloforge Notes Sync (Obsidian ↔ Google Drive)

Personal Obsidian plugin that syncs a vault with a folder in your own Google Drive. Works on desktop and mobile.

- Three-way sync with conflict copies (`Note (conflict 2026-11-02 1430).md`), never silently overwrites
- Backs up any local file before replacing it (kept 30 days); deletions go to trash
- Refuses mass deletions unless you run "Sync now (allow deletions)"
- Uses only the `drive.file` scope — it cannot see the rest of your Drive
- Shrinks new photos (1600 px, 80% JPEG) and syncs files over 5 MB with resumable uploads
- Syncs CSS snippets so your look is the same on every device
- Small non-blocking "Syncing…" indicator

## Install (auto-updating, desktop and mobile)
1. In Obsidian: Settings → Community plugins → Browse → install and enable **BRAT**.
2. BRAT → **Add beta plugin** → `Xyloforge/obsidian-gdrive-sync`.
3. Enable **Xyloforge Notes Sync** in Community plugins.

BRAT checks for new releases when Obsidian starts and updates the plugin automatically.

Manual install: copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/gdrive-sync/`.

## Setup
Create a Google Cloud OAuth client of type **TVs and Limited Input devices**, enable the Google Drive API, and paste the Client ID and secret into the plugin settings. Then press **Connect** and enter the code at google.com/device.

## Develop
```
npm install
npm test        # 41 tests (planner, engine, fake Google Drive)
npm run build
```

[Privacy policy](https://xyloforge.github.io/obsidian-gdrive-sync/privacy.html) · Not affiliated with Obsidian or Google.
