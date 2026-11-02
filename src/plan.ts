/**
 * Pure three-way sync planner.
 *
 * Compares each path's content hash on this device (local), in Drive (remote)
 * and at the end of the last successful sync on this device (base), and
 * decides what to do. No I/O happens here.
 */

export type HashMap = ReadonlyMap<string, string>;

export type Action =
  | { kind: "synced"; path: string; hash: string }
  | { kind: "upload"; path: string; hash: string }
  | { kind: "download"; path: string; hash: string }
  | { kind: "deleteRemote"; path: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "conflict"; path: string; hash: string }
  | { kind: "forget"; path: string };

function decide(path: string, l?: string, r?: string, b?: string): Action {
  if (l === r) {
    return l === undefined ? { kind: "forget", path } : { kind: "synced", path, hash: l };
  }
  if (l === b) {
    // Only the remote side changed since last sync.
    return r === undefined ? { kind: "deleteLocal", path } : { kind: "download", path, hash: r };
  }
  if (r === b) {
    // Only the local side changed since last sync.
    return l === undefined ? { kind: "deleteRemote", path } : { kind: "upload", path, hash: l };
  }
  // Both sides changed, differently. An edit always beats a delete.
  if (l === undefined) return { kind: "download", path, hash: r as string };
  if (r === undefined) return { kind: "upload", path, hash: l };
  return { kind: "conflict", path, hash: l };
}

export function planSync(local: HashMap, remote: HashMap, base: HashMap): Action[] {
  const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  return [...paths]
    .sort()
    .map((p) => decide(p, local.get(p), remote.get(p), base.get(p)));
}
