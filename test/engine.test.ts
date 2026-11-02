import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync, MassDeleteError, type LocalStore, type RemoteStore } from "../src/engine.ts";
import { sha256Hex } from "../src/hash.ts";
import { conflictPath, isSafePath } from "../src/paths.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const NOW = new Date(2026, 10, 2, 14, 30);

class MemLocal implements LocalStore {
  files = new Map<string, string>();
  backups: string[] = [];
  trashed: string[] = [];
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async list() {
    const out = new Map<string, string>();
    for (const [k, v] of this.files) out.set(k, await sha256Hex(buf(v)));
    return out;
  }
  async read(p: string) { return buf(this.files.get(p)!); }
  async write(p: string, d: ArrayBuffer) { this.files.set(p, dec.decode(d)); }
  async remove(p: string) { this.trashed.push(p); this.files.delete(p); }
  async backup(p: string) { this.backups.push(p); }
}

class MemRemote implements RemoteStore {
  files = new Map<string, string>();
  failOn = new Set<string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async list() {
    const out = new Map<string, string>();
    for (const [k, v] of this.files) out.set(k, await sha256Hex(buf(v)));
    return out;
  }
  async read(p: string) { return buf(this.files.get(p)!); }
  async write(p: string, d: ArrayBuffer) {
    if (this.failOn.has(p)) throw new Error("network down");
    this.files.set(p, dec.decode(d));
  }
  async remove(p: string) { this.files.delete(p); }
}

const sync = (l: MemLocal, r: MemRemote, base: Record<string, string> = {}, force = false) =>
  runSync(l, r, base, { now: NOW, force });

test("first sync merges both sides and records base", async () => {
  const l = new MemLocal({ "a.md": "A" });
  const r = new MemRemote({ "b.md": "B" });
  const res = await sync(l, r);
  assert.equal(l.files.get("b.md"), "B");
  assert.equal(r.files.get("a.md"), "A");
  assert.deepEqual(Object.keys(res.base).sort(), ["a.md", "b.md"]);
  assert.deepEqual(res.summary.uploaded, ["a.md"]);
  assert.deepEqual(res.summary.downloaded, ["b.md"]);
});

test("second sync with no changes does nothing", async () => {
  const l = new MemLocal({ "a.md": "A" });
  const r = new MemRemote();
  const first = await sync(l, r);
  const second = await sync(l, r, first.base);
  assert.equal(second.summary.changed, 0);
});

test("downloading over an existing local file backs it up first", async () => {
  const l = new MemLocal({ "a.md": "old" });
  const r = new MemRemote({ "a.md": "old" });
  const { base } = await sync(l, r);
  r.files.set("a.md", "new from phone");
  await sync(l, r, base);
  assert.equal(l.files.get("a.md"), "new from phone");
  assert.deepEqual(l.backups, ["a.md"]);
});

test("remote delete moves the local file to trash, after backup", async () => {
  const l = new MemLocal({ "a.md": "A" });
  const r = new MemRemote({ "a.md": "A" });
  const { base } = await sync(l, r);
  r.files.delete("a.md");
  const res = await sync(l, r, base);
  assert.deepEqual(l.trashed, ["a.md"]);
  assert.deepEqual(l.backups, ["a.md"]);
  assert.equal(res.base["a.md"], undefined);
});

test("conflict keeps both versions: local stays, remote saved as a copy", async () => {
  const l = new MemLocal({ "n.md": "base" });
  const r = new MemRemote({ "n.md": "base" });
  const { base } = await sync(l, r);
  l.files.set("n.md", "edited on mac");
  r.files.set("n.md", "edited on phone");
  const res = await sync(l, r, base);
  const copy = "n (conflict 2026-11-02 1430).md";
  assert.equal(l.files.get("n.md"), "edited on mac");
  assert.equal(l.files.get(copy), "edited on phone");
  assert.equal(r.files.get("n.md"), "edited on mac");
  assert.deepEqual(res.summary.conflicts, ["n.md"]);
  // The copy uploads on the next run, so both devices end up with both versions.
  await sync(l, r, res.base);
  assert.equal(r.files.get(copy), "edited on phone");
});

test("a failed upload is reported and retried next time", async () => {
  const l = new MemLocal({ "a.md": "A", "b.md": "B" });
  const r = new MemRemote();
  r.failOn.add("a.md");
  const res = await sync(l, r);
  assert.deepEqual(res.summary.errors.map((e) => e.path), ["a.md"]);
  assert.equal(res.base["a.md"], undefined);
  assert.equal(r.files.get("b.md"), "B");
  r.failOn.clear();
  await sync(l, r, res.base);
  assert.equal(r.files.get("a.md"), "A");
});

test("refuses to delete many files at once unless forced", async () => {
  const init = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}.md`, `${i}`]));
  const l = new MemLocal(init);
  const r = new MemRemote(init);
  const { base } = await sync(l, r);
  l.files.clear(); // e.g. vault folder emptied by accident
  await assert.rejects(sync(l, r, base), MassDeleteError);
  assert.equal(r.files.size, 20, "nothing deleted remotely");
  await sync(l, r, base, true);
  assert.equal(r.files.size, 0);
});

test("small deletions are allowed without force", async () => {
  const init = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}.md`, `${i}`]));
  const l = new MemLocal(init);
  const r = new MemRemote(init);
  const { base } = await sync(l, r);
  l.files.delete("n1.md");
  l.files.delete("n2.md");
  await sync(l, r, base);
  assert.equal(r.files.size, 18);
});

test("unsafe remote paths are skipped, never written", async () => {
  const l = new MemLocal();
  const r = new MemRemote({ "../evil.md": "x", ".obsidian/plugins/x/main.js": "x", "ok.md": "fine" });
  const res = await sync(l, r);
  assert.deepEqual([...l.files.keys()], ["ok.md"]);
  assert.deepEqual(res.summary.skipped.sort(), ["../evil.md", ".obsidian/plugins/x/main.js"]);
});

test("isSafePath", () => {
  for (const ok of ["a.md", "Notes/Ideas/Sample.md", "img/photo 1.png", "Tasks 📝.md"]) {
    assert.ok(isSafePath(ok, ".obsidian"), ok);
  }
  for (const bad of ["", "/abs.md", "a/../b.md", "..", "./a.md", "a//b.md", ".obsidian/x", "a\\b.md", ".trash/a.md"]) {
    assert.ok(!isSafePath(bad, ".obsidian"), bad);
  }
});

test("isSafePath allows CSS snippets in the config folder, nothing else there", () => {
  for (const ok of [".obsidian/snippets/home.css", ".obsidian/snippets/my style.css"]) {
    assert.ok(isSafePath(ok, ".obsidian"), ok);
  }
  for (const bad of [".obsidian/snippets/x.js", ".obsidian/snippets/a/b.css", ".obsidian/snippets/.hidden.css",
    ".obsidian/app.json", ".obsidian/plugins/gdrive-sync/data.json", "Notes/.obsidian/snippets/a.css"]) {
    assert.ok(!isSafePath(bad, ".obsidian"), bad);
  }
});

test("snippets from Drive are synced like notes", async () => {
  const l = new MemLocal();
  const r = new MemRemote({ ".obsidian/snippets/home.css": ".home{}" });
  await sync(l, r);
  assert.equal(l.files.get(".obsidian/snippets/home.css"), ".home{}");
});

test("conflictPath keeps folder and extension", () => {
  assert.equal(conflictPath("A/B/Note.md", NOW), "A/B/Note (conflict 2026-11-02 1430).md");
  assert.equal(conflictPath("README", NOW), "README (conflict 2026-11-02 1430)");
  assert.equal(conflictPath("a.b/file", NOW), "a.b/file (conflict 2026-11-02 1430)");
});
