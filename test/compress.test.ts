import { test } from "node:test";
import assert from "node:assert/strict";
import { fitWithin, shouldCompress, MAX_SIDE, MIN_BYTES } from "../src/compress.ts";

test("only large lossy photos are compressed", () => {
  assert.ok(shouldCompress("Assets/IMG_001.jpg", MIN_BYTES + 1));
  assert.ok(shouldCompress("Inbox/photo.JPEG", 4_000_000));
  assert.ok(shouldCompress("a.webp", 2_000_000));
  assert.ok(!shouldCompress("a.jpg", MIN_BYTES - 1), "already small");
  assert.ok(!shouldCompress("shot.png", 9_000_000), "png would change format/links");
  assert.ok(!shouldCompress("doc.pdf", 9_000_000));
  assert.ok(!shouldCompress(".obsidian/x.jpg", 9_000_000), "never touch config files");
});

test("fitWithin keeps aspect ratio and never upscales", () => {
  assert.deepEqual(fitWithin(4000, 3000, MAX_SIDE), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000, MAX_SIDE), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600, MAX_SIDE), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(4001, 3, MAX_SIDE), { width: 1600, height: 1 });
});
