import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore Node's test runner loads erasable TypeScript directly.
import { normalizeApiKey } from "../lib/security.ts";

test("setup accepts opaque authorization keys including the current AQ. prefix", () => {
  const key = "AQ.fake-test-authorization.key_with+punctuation/only==";
  assert.equal(normalizeApiKey(key), key);
  assert.equal(normalizeApiKey("  " + key + "\n"), key);
});
test("setup safely unwraps quoted keys and known environment assignments", () => {
  const key = "AQ.fake-test-key-value-only";
  for (const value of [`"${key}"`, `'${key}'`, `GEMINI_API_KEY=${key}`, `export GEMINI_API_KEY="${key}"`, `GOOGLE_API_KEY = '${key}'`]) assert.equal(normalizeApiKey(value), key);
});
test("setup rejects missing keys, excessive input and header-injection characters", () => {
  for (const input of [null, 123, "", "too-short", "AQ.fake value with spaces", "AQ.fake-test-key\r\nx-header: value", "x".repeat(513), "AQ.fake-test-key-💛"]) assert.throws(() => normalizeApiKey(input));
});
