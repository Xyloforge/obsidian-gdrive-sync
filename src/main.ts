import { debounce, Notice, Plugin, requestUrl, TFile, type TAbstractFile } from "obsidian";
import { compressImage, shouldCompress } from "./compress.ts";
import { SyncIndicator } from "./indicator.ts";
import { AuthExpiredError, TokenProvider } from "./auth.ts";
import { GoogleDriveStore } from "./drive.ts";
import { MassDeleteError, runSync, type SyncSummary } from "./engine.ts";
import type { HttpFn } from "./http.ts";
import { VaultStore } from "./local.ts";
import { DEFAULT_SETTINGS, SyncSettingTab, type SettingsHost, type SyncSettings } from "./settings.ts";

interface PluginData {
  settings: SyncSettings;
  /** path -> hash at the end of the last sync on this device. */
  base: Record<string, string>;
  lastSync: string;
  /** Which device the base belongs to. A copied data.json on another device must not reuse it. */
  deviceId: string;
}

const DEVICE_KEY = "gdrive-sync-device-id";

const EDIT_DEBOUNCE_MS = 15_000;

/** Obsidian's vault config accessors exist at runtime but are not in the public typings. */
interface VaultConfigApi {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}
const PHOTO_SETTLE_MS = 1_500;

const obsidianHttp: HttpFn = async (req) => {
  const r = await requestUrl({ ...req, throw: false });
  return {
    status: r.status,
    headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    get text() { return r.text; },
    get json() { return r.json as unknown; },
    get arrayBuffer() { return r.arrayBuffer; },
  };
};

function describe(s: SyncSummary): string {
  const parts = [
    s.uploaded.length && `↑ ${s.uploaded.length} uploaded`,
    s.downloaded.length && `↓ ${s.downloaded.length} downloaded`,
    s.deletedLocal.length + s.deletedRemote.length && `🗑 ${s.deletedLocal.length + s.deletedRemote.length} deleted`,
    s.conflicts.length && `⚠️ ${s.conflicts.length} conflict copy made: ${s.conflicts.join(", ")}`,
    s.errors.length && `❌ ${s.errors.length} failed: ${s.errors.map((e) => `${e.path} (${e.message})`).join("; ")}`,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : "Everything up to date";
}

export default class GDriveSyncPlugin extends Plugin implements SettingsHost {
  settings: SyncSettings = DEFAULT_SETTINGS;
  lastSync = "";
  http: HttpFn = obsidianHttp;
  private base: Record<string, string> = {};
  private syncing = false;
  private intervalId: number | null = null;
  private statusEl: HTMLElement | null = null;
  private local: VaultStore | null = null;
  private deviceId = "";
  private remote: GoogleDriveStore | null = null;
  indicator: SyncIndicator | null = null;
  private readonly editTrigger = debounce(() => void this.syncNow(false), EDIT_DEBOUNCE_MS, true);

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data.settings,
    };
    this.deviceId = this.ensureDeviceId();
    this.base = data.deviceId === this.deviceId ? data.base ?? {} : {};
    this.lastSync = data.lastSync ?? "";
    this.local = new VaultStore(this.app, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/backups`);

    this.addSettingTab(new SyncSettingTab(this.app, this, this));
    this.indicator = new SyncIndicator();
    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.lastSync ? `Drive: synced ${this.lastSync}` : "Drive: not synced");
    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.syncNow(true));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow(true) });
    this.addCommand({
      id: "sync-force", name: "Sync now (allow deletions)",
      callback: () => void this.syncNow(true, true),
    });

    const onChange = (_f: TAbstractFile) => {
      if (!this.syncing && this.settings.syncAfterEdit) this.editTrigger();
    };
    this.app.workspace.onLayoutReady(() => {
      for (const ev of ["create", "modify", "delete", "rename"] as const) {
        this.registerEvent(this.app.vault.on(ev as "modify", onChange));
      }
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof TFile && !this.syncing && this.settings.shrinkPhotos && shouldCompress(f.path, f.stat.size)) {
          // Give the camera/attachment write a moment to finish before reading it.
          window.setTimeout(() => void this.shrinkPhoto(f), PHOTO_SETTLE_MS);
        }
      }));
      void this.applyFolderDefaults();
      void this.local?.pruneBackups();
      if (this.settings.syncOnStartup) void this.syncNow(false);
    });
    this.resetInterval();
  }

  /** Random id kept in this device's local storage (never synced or copied with the vault). */
  private ensureDeviceId(): string {
    const existing: unknown = this.app.loadLocalStorage(DEVICE_KEY);
    if (typeof existing === "string" && existing) return existing;
    const id = crypto.randomUUID();
    this.app.saveLocalStorage(DEVICE_KEY, id);
    return id;
  }

  /** One Drive client per settings combination, so tokens and folder id are reused between syncs. */
  private getRemote(): GoogleDriveStore {
    if (!this.remote) {
      const s = this.settings;
      const tokens = new TokenProvider(this.http, { clientId: s.clientId, clientSecret: s.clientSecret }, s.refreshToken);
      this.remote = new GoogleDriveStore(this.http, tokens, s.folderName);
    }
    return this.remote;
  }

  onunload(): void {
    this.editTrigger.cancel();
    this.indicator?.destroy();
  }

  private resetInterval(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.settings.intervalMinutes > 0) {
      this.intervalId = this.registerInterval(
        window.setInterval(() => void this.syncNow(false), this.settings.intervalMinutes * 60_000),
      );
    }
  }

  async saveSettings(next: SyncSettings): Promise<void> {
    const intervalChanged = next.intervalMinutes !== this.settings.intervalMinutes;
    const folderChanged = next.folderName !== this.settings.folderName;
    this.settings = next;
    this.remote = null;
    // A different Drive folder is a different remote: forget what we knew about the old one.
    if (folderChanged) this.base = {};
    await this.persist();
    void this.applyFolderDefaults();
    if (intervalChanged) this.resetInterval();
  }

  private persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, base: this.base, lastSync: this.lastSync, deviceId: this.deviceId };
    return this.saveData(data);
  }

  /**
   * First sync on a new device: reuse the sync folder that already exists in Drive
   * instead of guessing a name from the vault name (which may differ per device).
   */
  private async resolveFolderName(): Promise<boolean> {
    const s = this.settings;
    if (s.folderName) return true;
    const tokens = new TokenProvider(this.http, { clientId: s.clientId, clientSecret: s.clientSecret }, s.refreshToken);
    const found = await new GoogleDriveStore(this.http, tokens, "").listSyncFolders();
    if (found.length > 1) {
      new Notice(`Google Drive Sync: found several sync folders (${found.join(", ")}). Type the one to use in the plugin settings.`, 15_000);
      return false;
    }
    await this.saveSettings({ ...s, folderName: found[0] ?? `Obsidian - ${this.app.vault.getName()}` });
    return true;
  }

  /**
   * Makes every device put new notes in the Inbox and photos in Assets, so quick
   * capture works without changing Obsidian settings on each phone by hand.
   */
  private async applyFolderDefaults(): Promise<void> {
    const vault = this.app.vault as unknown as VaultConfigApi;
    const ensure = async (folder: string): Promise<void> => {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    };
    try {
      const { inboxFolder, attachmentFolder } = this.settings;
      if (inboxFolder) {
        await ensure(inboxFolder);
        if (vault.getConfig("newFileLocation") !== "folder") vault.setConfig("newFileLocation", "folder");
        if (vault.getConfig("newFileFolderPath") !== inboxFolder) vault.setConfig("newFileFolderPath", inboxFolder);
      }
      if (attachmentFolder) {
        await ensure(attachmentFolder);
        if (vault.getConfig("attachmentFolderPath") !== attachmentFolder) vault.setConfig("attachmentFolderPath", attachmentFolder);
      }
    } catch (err: unknown) {
      new Notice(`Google Drive Sync: could not set Inbox/Assets folders: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Replaces a newly added large photo with a smaller copy (same name, so links keep working). */
  private async shrinkPhoto(file: TFile): Promise<void> {
    try {
      const data = await this.app.vault.readBinary(file);
      if (!shouldCompress(file.path, data.byteLength)) return;
      const smaller = await compressImage(file.path, data);
      if (smaller) await this.app.vault.modifyBinary(file, smaller);
    } catch (err: unknown) {
      new Notice(`Could not shrink ${file.name}: ${err instanceof Error ? err.message : String(err)}. The original is kept.`);
    }
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  async syncNow(manual: boolean, force = false): Promise<void> {
    const s = this.settings;
    if (!s.refreshToken) {
      if (manual) new Notice("Google Drive Sync: open the plugin settings and connect first.");
      return;
    }
    if (this.syncing || !this.local) {
      if (manual) new Notice("Sync already running…");
      return;
    }
    this.syncing = true;
    this.setStatus("Drive: syncing…");
    this.indicator?.start();
    let changed = false;
    let failed = false;
    try {
      if (!(await this.resolveFolderName())) {
        this.setStatus("Drive: pick a folder in settings");
        return;
      }
      const { base, summary } = await runSync(this.local, this.getRemote(), this.base, {
        now: new Date(), force, configDir: this.app.vault.configDir,
      });
      this.base = base;
      this.lastSync = new Date().toLocaleString();
      await this.persist();
      this.setStatus(summary.errors.length ? "Drive: sync had errors" : `Drive: synced ${this.lastSync}`);
      changed = summary.changed > 0;
      failed = summary.errors.length > 0;
      if (manual || summary.changed > 0 || summary.errors.length > 0) {
        new Notice(`Google Drive Sync\n${describe(summary)}`, summary.errors.length ? 15_000 : 5_000);
      }
    } catch (err: unknown) {
      this.setStatus("Drive: sync failed");
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      // Background failures (e.g. offline on the phone) stay quiet unless they need user action.
      this.remote = null;
      if (manual || err instanceof AuthExpiredError || err instanceof MassDeleteError) {
        new Notice(`Google Drive Sync failed\n${msg}`, 15_000);
      }
    } finally {
      this.syncing = false;
      this.indicator?.finish(changed, failed);
    }
  }
}
