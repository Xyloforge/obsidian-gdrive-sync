import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGoogle } from "./fakeGoogle.ts";
import { AuthExpiredError, pollForRefreshToken, startDeviceFlow, TokenProvider } from "../src/auth.ts";
import { GoogleDriveStore } from "../src/drive.ts";
import { runSync, type LocalStore } from "../src/engine.ts";
import { sha256Hex } from "../src/hash.ts";

const creds = { clientId: "cid", clientSecret: "secret" };
const noSleep = async () => {};
const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

function store(g: FakeGoogle, folder = "Obsidian note") {
  return new GoogleDriveStore(g.http, new TokenProvider(g.http, creds, "REFRESH"), folder, { sleep: noSleep });
}

class Device implements LocalStore {
  files = new Map<string, Uint8Array>();
  async list() {
    const out = new Map<string, string>();
    for (const [k, v] of this.files) out.set(k, await sha256Hex(v.slice().buffer as ArrayBuffer));
    return out;
  }
  async read(p: string) { return this.files.get(p)!.slice().buffer as ArrayBuffer; }
  async write(p: string, d: ArrayBuffer) { this.files.set(p, new Uint8Array(d)); }
  async modifiedTime() { return undefined; }
  async remove(p: string) { this.files.delete(p); }
  async backup() {}
  text(p: string) { return dec.decode(this.files.get(p)); }
  put(p: string, s: string) { this.files.set(p, enc.encode(s)); }
}

test("device sign-in: shows code, waits for approval, returns refresh token", async () => {
  const g = new FakeGoogle();
  g.pendingPolls = 2;
  const dc = await startDeviceFlow(g.http, creds);
  assert.equal(dc.userCode, "ABCD-EFGH");
  assert.equal(dc.verificationUrl, "https://www.google.com/device");
  const token = await pollForRefreshToken(g.http, creds, dc, { sleep: noSleep, isCancelled: () => false });
  assert.equal(token, "REFRESH");
});

// On Android the user approves in the browser, so Obsidian is in the
// background and the phone may cut its network ("Unable to resolve host").
// Polling must keep going until the user comes back.
test("device sign-in survives network errors while the app is in the background", async () => {
  const g = new FakeGoogle();
  g.pendingPolls = 1;
  const dc = await startDeviceFlow(g.http, creds);
  let offline = 3;
  const flaky: typeof g.http = async (req) => {
    if (req.url.includes("/token") && offline-- > 0) throw new Error("Unable to resolve host oauth2.googleapis.com");
    return g.http(req);
  };
  const token = await pollForRefreshToken(flaky, creds, dc, { sleep: noSleep, isCancelled: () => false });
  assert.equal(token, "REFRESH");
});

test("device sign-in can be cancelled", async () => {
  const g = new FakeGoogle();
  g.pendingPolls = 100;
  const dc = await startDeviceFlow(g.http, creds);
  let n = 0;
  await assert.rejects(
    pollForRefreshToken(g.http, creds, dc, { sleep: noSleep, isCancelled: () => ++n > 3 }),
    /cancelled/,
  );
});

test("token is cached until near expiry", async () => {
  const g = new FakeGoogle();
  let now = 0;
  const tp = new TokenProvider(g.http, creds, "REFRESH", () => now);
  const a = await tp.get();
  assert.equal(await tp.get(), a);
  now = 3600_000;
  assert.notEqual(await tp.get(), a);
});

test("revoked sign-in gives a clear AuthExpiredError", async () => {
  const g = new FakeGoogle();
  g.revoked = true;
  await assert.rejects(new TokenProvider(g.http, creds, "REFRESH").get(), AuthExpiredError);
});

test("drive store: creates folder once, uploads, lists hashes, updates, reads, trashes", async () => {
  const g = new FakeGoogle();
  const s = store(g);
  assert.equal((await s.list()).size, 0);
  await s.write("A/n.md", buf("one"), "h1");
  assert.deepEqual([...(await s.list())], [["A/n.md", "h1"]]);
  await s.write("A/n.md", buf("two"), "h2");
  assert.deepEqual([...(await s.list())], [["A/n.md", "h2"]]);
  assert.equal(dec.decode(await s.read("A/n.md")), "two");
  await s.remove("A/n.md");
  assert.equal((await s.list()).size, 0);
  const folders = [...g.files.values()].filter((f) => f.mimeType.endsWith("folder"));
  assert.equal(folders.length, 1, "only one sync folder created");
});

test("drive store keeps the note's last-edited time (new and updated files)", async () => {
  const g = new FakeGoogle();
  const edited = Date.UTC(2022, 6, 14, 10, 30, 20);
  await store(g).write("old.md", buf("v1"), "h1", edited);
  const other = store(g);
  await other.list();
  assert.equal(other.modifiedTime("old.md"), edited);
  await other.write("old.md", buf("v2"), "h2", edited + 60_000);
  await other.list();
  assert.equal(other.modifiedTime("old.md"), edited + 60_000);
});

test("drive store reuses an existing folder (second device)", async () => {
  const g = new FakeGoogle();
  await store(g).write("x.md", buf("x"), "hx");
  const other = store(g);
  assert.deepEqual([...(await other.list()).keys()], ["x.md"]);
});

test("binary files survive the round trip byte-for-byte", async () => {
  const g = new FakeGoogle();
  const s = store(g);
  await s.list();
  const bytes = new Uint8Array(256).map((_, i) => i);
  await s.write("img/p.png", bytes.buffer, "hp");
  await s.list();
  assert.deepEqual(new Uint8Array(await s.read("img/p.png")), bytes);
});

test("retries on 429/500 and refreshes on 401", async () => {
  const g = new FakeGoogle();
  const s = store(g);
  await s.list();
  g.failNext = { status: 429, count: 2 };
  await s.write("a.md", buf("a"), "ha");
  g.failNext = { status: 503, count: 1 };
  assert.equal((await s.list()).size, 1);
  g.validTokens.clear(); // all access tokens expire server-side
  assert.equal((await s.list()).size, 1);
});

test("files over 5 MB use a resumable upload, and round-trip intact", async () => {
  const g = new FakeGoogle();
  const s = store(g);
  await s.list();
  const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => i % 251);
  await s.write("Assets/big.jpg", big.buffer, "hbig");
  assert.ok(g.requests.some((r) => r.startsWith("PUT ")), "used resumable PUT");
  await s.list();
  assert.deepEqual(new Uint8Array(await s.read("Assets/big.jpg")), big);
  // update path
  big[0] = 7;
  await s.write("Assets/big.jpg", big.buffer, "hbig2");
  assert.deepEqual([...(await s.list())], [["Assets/big.jpg", "hbig2"]]);
  assert.equal(new Uint8Array(await s.read("Assets/big.jpg"))[0], 7);
});

test("gives up after repeated server errors with a readable message", async () => {
  const g = new FakeGoogle();
  const s = store(g);
  await s.list();
  g.failNext = { status: 500, count: 10 };
  await assert.rejects(s.write("a.md", buf("a"), "ha"), /Upload a\.md: fake failure/);
});

test("listSyncFolders finds the folders this app created, for auto-setup on a new device", async () => {
  const g = new FakeGoogle();
  assert.deepEqual(await store(g, "").listSyncFolders(), []);
  await store(g, "Obsidian - note").write("a.md", buf("a"), "ha");
  assert.deepEqual(await store(g, "").listSyncFolders(), ["Obsidian - note"]);
  await store(g, "Other").write("b.md", buf("b"), "hb");
  assert.deepEqual((await store(g, "").listSyncFolders()).sort(), ["Obsidian - note", "Other"]);
});

test("folder names with quotes are escaped in queries", async () => {
  const g = new FakeGoogle();
  const s = store(g, "Rong's vault");
  await s.write("a.md", buf("a"), "ha");
  assert.deepEqual([...(await store(g, "Rong's vault").list()).keys()], ["a.md"]);
});

test("end to end: Mac and phone stay in sync through Drive", async () => {
  const g = new FakeGoogle();
  const mac = new Device();
  const phone = new Device();
  const opts = { now: new Date(2026, 10, 2, 9, 0) };
  mac.put("Todo.md", "- [ ] buy gloves");
  mac.put("Notes/Sample.md", "sample text");

  let macBase = (await runSync(mac, store(g), {}, opts)).base;
  let phoneBase = (await runSync(phone, store(g), {}, opts)).base;
  assert.equal(phone.text("Todo.md"), "- [ ] buy gloves");

  // Phone ticks the todo and adds a note; Mac deletes a note.
  phone.put("Todo.md", "- [x] buy gloves");
  phone.put("Inbox/idea.md", "train footwork");
  mac.files.delete("Notes/Sample.md");
  phoneBase = (await runSync(phone, store(g), phoneBase, opts)).base;
  macBase = (await runSync(mac, store(g), macBase, opts)).base;
  phoneBase = (await runSync(phone, store(g), phoneBase, opts)).base;

  for (const d of [mac, phone]) {
    assert.deepEqual([...d.files.keys()].sort(), ["Inbox/idea.md", "Todo.md"]);
    assert.equal(d.text("Todo.md"), "- [x] buy gloves");
  }
  assert.deepEqual(Object.keys(g.contents("Obsidian note")).sort(), ["Inbox/idea.md", "Todo.md"]);

  // Nothing changed -> no uploads or downloads.
  const quiet = await runSync(mac, store(g), macBase, opts);
  assert.equal(quiet.summary.changed, 0);
});
