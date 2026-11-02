import { planSync, type Action } from "./plan.ts";
import { conflictPath, isSafePath } from "./paths.ts";

/** This device's files. Hashes are SHA-256 hex of the file bytes. */
export interface LocalStore {
  list(): Promise<Map<string, string>>;
  read(path: string): Promise<ArrayBuffer>;
  /** `modified` (ms since epoch) is the file's real last-edited time, kept so a synced note doesn't look freshly edited. */
  write(path: string, data: ArrayBuffer, modified?: number): Promise<void>;
  /** Last-edited time (ms since epoch) of a local file, if known. */
  modifiedTime(path: string): Promise<number | undefined>;
  /** Move to trash (recoverable), never hard-delete. */
  remove(path: string): Promise<void>;
  /** Save a copy of the current local version before it is overwritten or removed. */
  backup(path: string): Promise<void>;
}

/** The files in the Drive folder. */
export interface RemoteStore {
  list(): Promise<Map<string, string>>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer, hash: string, modified?: number): Promise<void>;
  remove(path: string): Promise<void>;
  /** Last-edited time (ms since epoch) of a remote file as of the last list(), if known. */
  modifiedTime(path: string): number | undefined;
}

export interface SyncSummary {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
  skipped: string[];
  errors: { path: string; message: string }[];
  changed: number;
}

export interface SyncResult {
  base: Record<string, string>;
  summary: SyncSummary;
}

export interface SyncOptions {
  now: Date;
  /** Skip the mass-delete guard (user confirmed). */
  force?: boolean;
  configDir?: string;
}

export class MassDeleteError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`Sync stopped: it would delete ${count} files. Run "Sync now (allow deletions)" if this is intended.`);
    this.name = "MassDeleteError";
    this.count = count;
  }
}

const MIN_GUARDED_DELETES = 5;
const MAX_DELETE_FRACTION = 0.3;

function checkMassDelete(actions: Action[], baseSize: number): void {
  const deletes = actions.filter((a) => a.kind === "deleteLocal" || a.kind === "deleteRemote").length;
  if (deletes > MIN_GUARDED_DELETES && deletes > baseSize * MAX_DELETE_FRACTION) {
    throw new MassDeleteError(deletes);
  }
}

function emptySummary(): SyncSummary {
  return { uploaded: [], downloaded: [], deletedLocal: [], deletedRemote: [], conflicts: [], skipped: [], errors: [], changed: 0 };
}

interface Ctx {
  local: LocalStore;
  remote: RemoteStore;
  localHashes: Map<string, string>;
  now: Date;
}

/** Runs one action. Returns the new base hash for the path, or undefined to drop it. */
async function apply(a: Action, ctx: Ctx, s: SyncSummary): Promise<string | undefined> {
  const { local, remote } = ctx;
  switch (a.kind) {
    case "synced":
      return a.hash;
    case "forget":
      return undefined;
    case "upload":
      await remote.write(a.path, await local.read(a.path), a.hash, await local.modifiedTime(a.path));
      s.uploaded.push(a.path);
      return a.hash;
    case "download":
      if (ctx.localHashes.has(a.path)) await local.backup(a.path);
      await local.write(a.path, await remote.read(a.path), remote.modifiedTime(a.path));
      s.downloaded.push(a.path);
      return a.hash;
    case "deleteRemote":
      await remote.remove(a.path);
      s.deletedRemote.push(a.path);
      return undefined;
    case "deleteLocal":
      await local.backup(a.path);
      await local.remove(a.path);
      s.deletedLocal.push(a.path);
      return undefined;
    case "conflict":
      // Keep both: remote version goes to a "(conflict …)" copy, local version wins the path.
      await local.write(conflictPath(a.path, ctx.now), await remote.read(a.path), remote.modifiedTime(a.path));
      await remote.write(a.path, await local.read(a.path), a.hash, await local.modifiedTime(a.path));
      s.conflicts.push(a.path);
      return a.hash;
  }
}

export async function runSync(
  local: LocalStore,
  remote: RemoteStore,
  base: Readonly<Record<string, string>>,
  opts: SyncOptions,
): Promise<SyncResult> {
  const configDir = opts.configDir ?? ".obsidian";
  const summary = emptySummary();
  const [localHashes, remoteAll] = await Promise.all([local.list(), remote.list()]);

  const remoteHashes = new Map<string, string>();
  for (const [path, hash] of remoteAll) {
    if (isSafePath(path, configDir)) remoteHashes.set(path, hash);
    else summary.skipped.push(path);
  }

  const baseMap = new Map(Object.entries(base));
  const actions = planSync(localHashes, remoteHashes, baseMap);
  if (!opts.force) checkMassDelete(actions, baseMap.size);

  const ctx: Ctx = { local, remote, localHashes, now: opts.now };
  const nextBase: Record<string, string> = {};
  for (const a of actions) {
    try {
      const hash = await apply(a, ctx, summary);
      if (hash !== undefined) nextBase[a.path] = hash;
    } catch (err: unknown) {
      summary.errors.push({ path: a.path, message: err instanceof Error ? err.message : String(err) });
      // Keep the old base entry so the same decision is retried next run.
      const prev = baseMap.get(a.path);
      if (prev !== undefined) nextBase[a.path] = prev;
    }
  }

  summary.changed =
    summary.uploaded.length + summary.downloaded.length + summary.deletedLocal.length +
    summary.deletedRemote.length + summary.conflicts.length;
  return { base: nextBase, summary };
}
