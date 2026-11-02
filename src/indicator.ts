import { setIcon } from "obsidian";

type PillState = "syncing" | "done" | "error";

const SHOW_DELAY_MS = 500;
const DONE_MS = 1_500;
const ERROR_MS = 4_000;

const LOOK: Record<PillState, { icon: string; text: string }> = {
  syncing: { icon: "refresh-cw", text: "Syncing…" },
  done: { icon: "check", text: "Synced" },
  error: { icon: "alert-triangle", text: "Sync failed" },
};

/** Floating pill in the corner. Never blocks taps (pointer-events: none). */
export class SyncIndicator {
  private readonly el: HTMLElement;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;

  constructor() {
    this.el = document.body.createDiv({ cls: "gds-pill", attr: { "aria-live": "polite", role: "status" } });
  }

  private clearTimers(): void {
    if (this.showTimer !== null) window.clearTimeout(this.showTimer);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.showTimer = this.hideTimer = null;
  }

  private render(state: PillState): void {
    this.el.empty();
    this.el.className = `gds-pill is-visible is-${state}`;
    setIcon(this.el.createSpan(), LOOK[state].icon);
    this.el.createSpan({ text: LOOK[state].text });
  }

  private hide(): void {
    this.el.removeClass("is-visible");
  }

  /** Shows "Syncing…" only if the sync is still running after a short delay (no flicker). */
  start(): void {
    this.clearTimers();
    this.showTimer = window.setTimeout(() => this.render("syncing"), SHOW_DELAY_MS);
  }

  /** changed: anything uploaded/downloaded. failed: show the error state. */
  finish(changed: boolean, failed: boolean): void {
    const wasVisible = this.el.hasClass("is-visible");
    this.clearTimers();
    if (failed) {
      this.render("error");
      this.hideTimer = window.setTimeout(() => this.hide(), ERROR_MS);
    } else if (changed || wasVisible) {
      this.render("done");
      this.hideTimer = window.setTimeout(() => this.hide(), DONE_MS);
    } else {
      this.hide();
    }
  }

  destroy(): void {
    this.clearTimers();
    this.el.remove();
  }
}
