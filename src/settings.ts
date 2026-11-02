import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { pollForRefreshToken, startDeviceFlow } from "./auth.ts";
import type { HttpFn } from "./http.ts";

export interface SyncSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderName: string;
  intervalMinutes: number;
  syncOnStartup: boolean;
  syncAfterEdit: boolean;
  shrinkPhotos: boolean;
  inboxFolder: string;
  attachmentFolder: string;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  folderName: "",
  intervalMinutes: 5,
  syncOnStartup: true,
  syncAfterEdit: true,
  shrinkPhotos: true,
  inboxFolder: "Inbox",
  attachmentFolder: "Assets",
};

/** What the settings tab needs from the plugin. */
export interface SettingsHost {
  settings: SyncSettings;
  lastSync: string;
  http: HttpFn;
  saveSettings(next: SyncSettings): Promise<void>;
  syncNow(manual: boolean): Promise<void>;
}

class ConnectModal extends Modal {
  private cancelled = false;
  private readonly host: SettingsHost;
  private readonly onDone: () => void;

  constructor(app: App, host: SettingsHost, onDone: () => void) {
    super(app);
    this.host = host;
    this.onDone = onDone;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Connect Google Drive" });
    const status = contentEl.createEl("p", { text: "Asking Google for a sign-in code…" });
    const creds = { clientId: this.host.settings.clientId.trim(), clientSecret: this.host.settings.clientSecret.trim() };
    try {
      const dc = await startDeviceFlow(this.host.http, creds);
      status.setText("1. Open the Google page below (on any device).  2. Enter this code.  3. Allow access.");
      contentEl.createEl("div", { text: dc.userCode, attr: { style: "font-size:2em;font-weight:700;letter-spacing:.1em;text-align:center;margin:1em 0;user-select:all" } });
      new Setting(contentEl)
        .addButton((b) => b.setButtonText("Copy code").onClick(() => {
          void navigator.clipboard.writeText(dc.userCode);
          new Notice("Code copied");
        }))
        .addButton((b) => b.setCta().setButtonText("Open Google page").onClick(() => window.open(dc.verificationUrl)));
      const waiting = contentEl.createEl("p", { text: "Waiting for you to approve…", cls: "setting-item-description" });
      const refreshToken = await pollForRefreshToken(this.host.http, creds, dc, {
        sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
        isCancelled: () => this.cancelled,
      });
      await this.host.saveSettings({ ...this.host.settings, refreshToken });
      waiting.setText("✅ Connected.");
      new Notice("Google Drive connected. Syncing…");
      this.close();
      this.onDone();
      await this.host.syncNow(true);
    } catch (err: unknown) {
      if (!this.cancelled) status.setText(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }
}

export class SyncSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, plugin: ConstructorParameters<typeof PluginSettingTab>[1], host: SettingsHost) {
    super(app, plugin);
    this.host = host;
  }

  private patchSettings(patch: Partial<SyncSettings>): Promise<void> {
    return this.host.saveSettings({ ...this.host.settings, ...patch });
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    containerEl.empty();

    const connected = s.refreshToken !== "";
    new Setting(containerEl)
      .setName(connected ? "✅ Connected to Google Drive" : "Not connected")
      .setDesc(connected ? `Last sync: ${this.host.lastSync || "never"}` : "Fill in Client ID and secret below, then connect.")
      .addButton((b) => b.setCta().setButtonText(connected ? "Sync now" : "Connect").onClick(() => {
        if (connected) { void this.host.syncNow(true); return; }
        if (!s.clientId.trim() || !s.clientSecret.trim()) { new Notice("Enter Client ID and Client secret first."); return; }
        new ConnectModal(this.app, this.host, () => this.display()).open();
      }))
      .addExtraButton((b) => b.setIcon("log-out").setTooltip("Disconnect").setDisabled(!connected).onClick(async () => {
        await this.patchSettings({ refreshToken: "" });
        this.display();
      }));

    new Setting(containerEl).setName("Drive folder name")
      .setDesc("Leave empty on a new device: it finds your existing sync folder automatically. Must match on every device.")
      .addText((t) => t.setPlaceholder("auto").setValue(s.folderName).onChange((v) => this.patchSettings({ folderName: v.trim() })));

    new Setting(containerEl).setName("Auto sync every (minutes)").setDesc("0 = off")
      .addText((t) => t.setValue(String(s.intervalMinutes)).onChange((v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 1440) void this.patchSettings({ intervalMinutes: n });
      }));

    new Setting(containerEl).setName("Sync when Obsidian opens")
      .addToggle((t) => t.setValue(s.syncOnStartup).onChange((v) => this.patchSettings({ syncOnStartup: v })));

    new Setting(containerEl).setName("Sync shortly after you edit").setDesc("About 15 seconds after you stop typing.")
      .addToggle((t) => t.setValue(s.syncAfterEdit).onChange((v) => this.patchSettings({ syncAfterEdit: v })));

    new Setting(containerEl).setName("Shrink new photos")
      .setDesc("Photos over 0.5 MB are resized to 1600 px and saved at 80% quality. Keeps sync fast; removes location data.")
      .addToggle((t) => t.setValue(s.shrinkPhotos).onChange((v) => this.patchSettings({ shrinkPhotos: v })));

    containerEl.createEl("h4", { text: "Folders (applied on every device)" });
    new Setting(containerEl).setName("New notes go to")
      .setDesc("Folder for new notes (quick capture). Empty = use Obsidian's own setting.")
      .addText((t) => t.setPlaceholder("Inbox").setValue(s.inboxFolder).onChange((v) => this.patchSettings({ inboxFolder: v.trim() })));
    new Setting(containerEl).setName("Photos and attachments go to")
      .setDesc("Empty = use Obsidian's own setting.")
      .addText((t) => t.setPlaceholder("Assets").setValue(s.attachmentFolder).onChange((v) => this.patchSettings({ attachmentFolder: v.trim() })));

    containerEl.createEl("h4", { text: "Google Cloud client" });
    new Setting(containerEl).setName("Client ID")
      .addText((t) => t.setPlaceholder("xxxx.apps.googleusercontent.com").setValue(s.clientId).onChange((v) => this.patchSettings({ clientId: v.trim() })));
    new Setting(containerEl).setName("Client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.clientSecret).onChange((v) => this.patchSettings({ clientSecret: v.trim() }));
      });
  }
}
