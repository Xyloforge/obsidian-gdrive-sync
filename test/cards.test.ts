import { test } from "node:test";
import assert from "node:assert/strict";
import { coverFileName, nextPin } from "../src/cards.ts";

test("nextPin puts a newly pinned note last", () => {
  assert.equal(nextPin([]), 1);
  assert.equal(nextPin([1, 2, 3]), 4);
  assert.equal(nextPin([4, 1]), 5);
  assert.equal(nextPin([undefined, "x", 2, null]), 3, "ignores non-numbers");
});

test("coverFileName is safe, unique and keeps the extension", () => {
  const now = new Date(2026, 10, 2, 15, 30, 5);
  assert.equal(coverFileName("Workout Plan 🏋️‍♀️", "JPG", now), "card-workout-plan-20261102-153005.jpg");
  assert.equal(coverFileName("a/b:c*?", "png", now), "card-a-b-c-20261102-153005.png");
  assert.equal(coverFileName("🔥🔥", "jpeg", now), "card-note-20261102-153005.jpeg");
});
