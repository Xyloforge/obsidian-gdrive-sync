import { Notice, TFile, type App, type Menu, type Plugin } from "obsidian";
import { coverFileName, nextPin } from "./cards.ts";
import { compressImage, shouldCompress } from "./compress.ts";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

/** Opens the system picker (on phones: camera or gallery). Resolves null if cancelled. */
function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
}

async function setCardPhoto(app: App, note: TFile, folder: string): Promise<void> {
  const picked = await pickImage();
  if (!picked) return;
  const ext = IMAGE_EXT.exec(picked.name)?.[1] ?? "jpg";
  const name = coverFileName(note.basename, ext, new Date());
  const original = await picked.arrayBuffer();
  const data = shouldCompress(name, original.byteLength) ? (await compressImage(name, original)) ?? original : original;
  await ensureFolder(app, folder);
  const image = await app.vault.createBinary(folder ? `${folder}/${name}` : name, data);
  await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
    fm.cover = `[[${image.name}]]`;
  });
  new Notice("Card photo set ✓");
}

function hasProp(app: App, file: TFile, key: string): boolean {
  return app.metadataCache.getFileCache(file)?.frontmatter?.[key] !== undefined;
}

async function pin(app: App, note: TFile): Promise<void> {
  const pins = app.vault.getMarkdownFiles().map((f) => app.metadataCache.getFileCache(f)?.frontmatter?.pin);
  const value = nextPin(pins);
  await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
    fm.pin = value;
  });
  new Notice("📌 Pinned to Home");
}

async function removeProp(app: App, note: TFile, key: string, message: string): Promise<void> {
  await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
    delete fm[key];
  });
  new Notice(message);
}

function run(task: () => Promise<void>): void {
  task().catch((err: unknown) => new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`));
}

function addItems(app: App, menu: Menu, note: TFile, folder: () => string): void {
  const pinned = hasProp(app, note, "pin");
  menu.addItem((i) => i.setTitle(pinned ? "Unpin from Home" : "Pin to Home").setIcon(pinned ? "pin-off" : "pin")
    .onClick(() => run(() => (pinned ? removeProp(app, note, "pin", "Unpinned from Home") : pin(app, note)))));
  menu.addItem((i) => i.setTitle("Set card photo…").setIcon("image")
    .onClick(() => run(() => setCardPhoto(app, note, folder()))));
  if (hasProp(app, note, "cover")) {
    menu.addItem((i) => i.setTitle("Remove card photo").setIcon("image-off")
      .onClick(() => run(() => removeProp(app, note, "cover", "Card photo removed"))));
  }
}

/** Long-press / right-click a note (also a Home card) → Pin to Home, Set card photo. */
export function registerCardActions(plugin: Plugin, attachmentFolder: () => string): void {
  const { app } = plugin;
  plugin.registerEvent(app.workspace.on("file-menu", (menu, file) => {
    if (file instanceof TFile && file.extension === "md") addItems(app, menu, file, attachmentFolder);
  }));
  const withActive = (fn: (f: TFile) => Promise<void>) => (checking: boolean): boolean => {
    const f = app.workspace.getActiveFile();
    if (!f || f.extension !== "md") return false;
    if (!checking) run(() => fn(f));
    return true;
  };
  plugin.addCommand({ id: "set-card-photo", name: "Set card photo for this note", checkCallback: withActive((f) => setCardPhoto(app, f, attachmentFolder())) });
  plugin.addCommand({ id: "toggle-pin", name: "Pin / unpin this note on Home", checkCallback: withActive((f) =>
    hasProp(app, f, "pin") ? removeProp(app, f, "pin", "Unpinned from Home") : pin(app, f)) });
}
