import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync, type Action } from "../src/plan.ts";

const m = (o: Record<string, string>) => new Map(Object.entries(o));
const kinds = (actions: Action[]) =>
  Object.fromEntries(actions.map((a) => [a.path, a.kind]));

test("unchanged everywhere -> synced", () => {
  const a = planSync(m({ a: "1" }), m({ a: "1" }), m({ a: "1" }));
  assert.deepEqual(kinds(a), { a: "synced" });
});

test("first sync: local only -> upload, remote only -> download", () => {
  const a = planSync(m({ l: "1" }), m({ r: "2" }), m({}));
  assert.deepEqual(kinds(a), { l: "upload", r: "download" });
});

test("first sync: same content on both sides -> synced, no transfer", () => {
  assert.deepEqual(kinds(planSync(m({ a: "x" }), m({ a: "x" }), m({}))), { a: "synced" });
});

test("first sync: different content on both sides -> conflict", () => {
  assert.deepEqual(kinds(planSync(m({ a: "x" }), m({ a: "y" }), m({}))), { a: "conflict" });
});

test("local edit -> upload; remote edit -> download", () => {
  const a = planSync(m({ a: "2", b: "1" }), m({ a: "1", b: "3" }), m({ a: "1", b: "1" }));
  assert.deepEqual(kinds(a), { a: "upload", b: "download" });
});

test("deleted locally -> delete remote; deleted remotely -> delete local", () => {
  const a = planSync(m({ b: "1" }), m({ a: "1" }), m({ a: "1", b: "1" }));
  assert.deepEqual(kinds(a), { a: "deleteRemote", b: "deleteLocal" });
});

test("deleted on both sides -> forget", () => {
  assert.deepEqual(kinds(planSync(m({}), m({}), m({ a: "1" }))), { a: "forget" });
});

test("edited on both sides differently -> conflict", () => {
  assert.deepEqual(kinds(planSync(m({ a: "2" }), m({ a: "3" }), m({ a: "1" }))), { a: "conflict" });
});

test("edited on both sides identically -> synced", () => {
  assert.deepEqual(kinds(planSync(m({ a: "2" }), m({ a: "2" }), m({ a: "1" }))), { a: "synced" });
});

test("edit wins over delete: deleted locally but edited remotely -> download", () => {
  assert.deepEqual(kinds(planSync(m({}), m({ a: "2" }), m({ a: "1" }))), { a: "download" });
});

test("edit wins over delete: deleted remotely but edited locally -> upload", () => {
  assert.deepEqual(kinds(planSync(m({ a: "2" }), m({}), m({ a: "1" }))), { a: "upload" });
});

test("actions carry the hashes needed to record the new base", () => {
  const [up] = planSync(m({ a: "L" }), m({}), m({}));
  assert.deepEqual(up, { kind: "upload", path: "a", hash: "L" });
  const [down] = planSync(m({}), m({ a: "R" }), m({}));
  assert.deepEqual(down, { kind: "download", path: "a", hash: "R" });
});

test("output is sorted by path for stable runs", () => {
  const a = planSync(m({ c: "1", a: "1", b: "1" }), m({}), m({}));
  assert.deepEqual(a.map((x) => x.path), ["a", "b", "c"]);
});
