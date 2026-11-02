import { normalizePath, TFile, type App } from "obsidian";
import type { LocalStore } from "./engine.ts";
import { sha256Hex } from "./hash.ts";
import { isSnippetPath, snippetDir } from "./paths.ts";

const BACKUP_KEEP_DAYS = 30;
const pad = (n: number): string => String(n).padStart(2, "0");

function folderStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** The vault's own files (hidden folders like .obsidian are not included). */
export class VaultStore implements LocalStore {
  private readonly app: App;
  private readonly backupRoot: string;
  private readonly backupDir: string;
  /** path -> hash, valid while mtime:size is unchanged; avoids re-reading every file each sync. */
  private hashCache = new Map<string, { key: string; hash: string }>();

  constructor(app: App, backupRoot: string, now: Date = new Date()) {
    this.app = app;
    this.backupRoot = backupRoot;
    this.backupDir = `${backupRoot}/${folderStamp(now)}`;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`Not a file in vault: ${path}`);
    return f;
  }

  async list(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const next = new Map<string, { key: string; hash: string }>();
    for (const f of this.app.vault.getFiles()) {
      const key = `${f.stat.mtime}:${f.stat.size}`;
      const cached = this.hashCache.get(f.path);
      const hash = cached?.key === key ? cached.hash : await sha256Hex(await this.app.vault.readBinary(f));
      next.set(f.path, { key, hash });
      out.set(f.path, hash);
    }
    this.hashCache = next;
    for (const [path, hash] of await this.listSnippets()) out.set(path, hash);
    return out;
  }

  private isSnippet(path: string): boolean {
    return isSnippetPath(path, this.app.vault.configDir);
  }

  /** CSS snippets live in the hidden config folder, so the vault index doesn't list them. */
  private async listSnippets(): Promise<Map<string, string>> {
    const adapter = this.app.vault.adapter;
    const dir = snippetDir(this.app.vault.configDir);
    const out = new Map<string, string>();
    if (!(await adapter.exists(dir))) return out;
    for (const path of (await adapter.list(dir)).files) {
      if (this.isSnippet(path)) out.set(path, await sha256Hex(await adapter.readBinary(path)));
    }
    return out;
  }

  read(path: string): Promise<ArrayBuffer> {
    if (this.isSnippet(path)) return this.app.vault.adapter.readBinary(path);
    return this.app.vault.readBinary(this.file(path));
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    }
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    if (this.isSnippet(path)) {
      const dir = snippetDir(this.app.vault.configDir);
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      await this.app.vault.adapter.writeBinary(path, data);
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }
    await this.ensureParents(path);
    await this.app.vault.createBinary(normalizePath(path), data);
  }

  /** Uses the user's trash setting (system trash or .trash folder). */
  async remove(path: string): Promise<void> {
    if (this.isSnippet(path)) {
      // Backup was already taken by the engine; config files have no vault trash.
      await this.app.vault.adapter.remove(path);
      return;
    }
    await this.app.fileManager.trashFile(this.file(path));
  }

  async backup(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const target = normalizePath(`${this.backupDir}/${path}`);
    const dir = target.slice(0, target.lastIndexOf("/"));
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.writeBinary(target, await this.read(path));
  }

  /** Deletes backup folders older than 30 days. Returns how many were removed. */
  async pruneBackups(now: Date = new Date()): Promise<number> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.backupRoot))) return 0;
    const cutoff = now.getTime() - BACKUP_KEEP_DAYS * 86_400_000;
    let removed = 0;
    for (const dir of (await adapter.list(this.backupRoot)).folders) {
      const m = /(\d{4})-(\d{2})-(\d{2}) \d{6}$/.exec(dir);
      if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) {
        await adapter.rmdir(dir, true);
        removed++;
      }
    }
    return removed;
  }
}
