import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
// @ts-expect-error Node's TypeScript test runner requires the source extension.
import { COOKIE_NAME, SESSION_SECONDS, HttpError, encryptKey, decryptKey, newSalt, hashCode, constantTimeEqual, createSession, validSession, sessionCookie, requireSameOrigin, boundedJson, privateRateKey, validateContent } from "../lib/security.ts";

const secret = randomBytes(32).toString("base64");
const now = 1_800_000_000_000;
const asCookie = (token: string) => `${COOKIE_NAME}=${token}`;
const jsonRequest = (value: unknown, headers: Record<string, string> = {}) => new Request("https://saathi.example/api/process", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://saathi.example", ...headers },
  body: JSON.stringify(value),
});
function assertHttp(status: number) {
  return (error: unknown) => error instanceof HttpError && error.status === status;
}
function signedClaims(claims: unknown) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

test("sessions accept an authentic current cookie and reject a changed payload or signature", async () => {
  const token = await createSession("current", secret, now);
  assert.equal(await validSession(asCookie(token), "current", secret, now), true);
  const [payload, signature] = token.split(".");
  const alteredPayload = Buffer.from(JSON.stringify({ version: "current", exp: Math.floor(now / 1000) + 60 })).toString("base64url");
  assert.equal(await validSession(asCookie(`${alteredPayload}.${signature}`), "current", secret, now), false);
  const alteredSignature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  assert.equal(await validSession(asCookie(`${payload}.${alteredSignature}`), "current", secret, now), false);
  assert.equal(await validSession(asCookie(token), "rotated", secret, now), false);
  assert.equal(await validSession(asCookie(token), "current", randomBytes(32).toString("base64"), now), false);
});

test("sessions expire and reject implausible or malformed signed claims", async () => {
  const token = await createSession("current", secret, now);
  assert.equal(await validSession(asCookie(token), "current", secret, now + SESSION_SECONDS * 1000), false);
  for (const claims of [
    { version: "current", exp: Math.floor(now / 1000) - 1 },
    { version: "current", exp: Math.floor(now / 1000) + SESSION_SECONDS + 120 },
    { version: "current", exp: "9999999999" },
    { version: "current", exp: 1.5 },
    { exp: Math.floor(now / 1000) + 60 },
    null,
  ]) {
    assert.equal(await validSession(asCookie(signedClaims(claims)), "current", secret, now), false);
  }
  for (const cookie of [null, "unrelated=abc", asCookie("invalid"), asCookie("a.b.c"), asCookie("a".repeat(1001))]) {
    assert.equal(await validSession(cookie, "current", secret, now), false);
  }
});

test("session cookies enforce host scope, secure transport, HTTP-only access and logout expiry", () => {
  const cookie = sessionCookie("token");
  assert.match(cookie, /^__Host-saathi=token;/);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", `Max-Age=${SESSION_SECONDS}`]) assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.toLowerCase().includes("domain="));
  assert.match(sessionCookie("", true), /Max-Age=0(?:;|$)/);
});

test("stored API keys are randomized encrypted envelopes and reject tampering or another key", async () => {
  const plaintext = "not-a-real-api-key-for-test-only";
  const first = await encryptKey(plaintext, secret);
  const second = await encryptKey(plaintext, secret);
  assert.notEqual(first, second);
  assert.ok(!first.includes(plaintext));
  assert.equal(await decryptKey(first, secret), plaintext);
  await assert.rejects(decryptKey(first, randomBytes(32).toString("base64")));
  const [iv, ciphertext] = first.split(".");
  const bytes = Buffer.from(ciphertext, "base64");
  bytes[0] ^= 1;
  await assert.rejects(decryptKey(`${iv}.${bytes.toString("base64")}`, secret));
  await assert.rejects(decryptKey("malformed", secret));
});

test("family-code hashes vary with the code and salt; rate keys hide raw IP addresses", async () => {
  const salt = newSalt();
  const original = await hashCode("48260371", salt);
  assert.equal(original, await hashCode("48260371", salt));
  assert.notEqual(original, await hashCode("48260372", salt));
  assert.notEqual(original, await hashCode("48260371", newSalt()));
  assert.equal(constantTimeEqual(original, original), true);
  assert.equal(constantTimeEqual(original, `${original}a`), false);
  assert.equal(constantTimeEqual(original, original.slice(1)), false);
  const key = await privateRateKey("login", "192.0.2.7", secret);
  assert.ok(!key.includes("192.0.2.7"));
  assert.equal(key, await privateRateKey("login", "192.0.2.7", secret));
  assert.notEqual(key, await privateRateKey("speak", "192.0.2.7", secret));
});

test("mutations require the exact same origin, including scheme and port", () => {
  assert.doesNotThrow(() => requireSameOrigin(jsonRequest({})));
  for (const origin of ["https://evil.example", "http://saathi.example", "https://saathi.example:8443", "null", "https://saathi.example.evil.test"]) {
    assert.throws(() => requireSameOrigin(jsonRequest({}, { Origin: origin })), assertHttp(403));
  }
  assert.throws(() => requireSameOrigin(new Request("https://saathi.example/api/process", { method: "POST" })), assertHttp(403));
});

test("JSON limits are enforced on actual streamed bytes without trusting Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new Uint8Array(1024).fill(65));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://saathi.example/api/process", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream,
    // Node requires duplex for streamed request bodies; browsers do not set it here.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(boundedJson(request, 100), assertHttp(413));
  assert.equal(cancelled, true);
  await assert.rejects(boundedJson(jsonRequest({}, { "Content-Length": "200" }), 100), assertHttp(413));
});

test("JSON parsing rejects missing bodies, invalid JSON, arrays and primitive values", async () => {
  assert.deepEqual(await boundedJson(jsonRequest({ text: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ" })), { text: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ" });
  for (const value of [null, [], "text", 12, true]) await assert.rejects(boundedJson(jsonRequest(value)), assertHttp(400));
  await assert.rejects(boundedJson(new Request("https://saathi.example/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })), assertHttp(400));
  await assert.rejects(boundedJson(new Request("https://saathi.example/api/process", { method: "POST", headers: { "Content-Type": "application/json" } })), assertHttp(400));
  await assert.rejects(boundedJson(jsonRequest({}, { "Content-Type": "text/plain" })), assertHttp(415));
});

test("content validation accepts one expected source and rejects ambiguous or active media", () => {
  assert.deepEqual(validateContent({ kind: "conversation", direction: "pa-en", text: "  ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ  " }), { kind: "conversation", direction: "pa-en", text: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ" });
  const data = Buffer.from("test-media").toString("base64");
  const audio = { data, mimeType: "audio/mp4; codecs=mp4a.40.2" };
  assert.deepEqual(validateContent({ kind: "conversation", direction: "en-pa", audio }).audio, { data, mimeType: "audio/mp4" });
  const image = { data, mimeType: "image/jpeg" };
  assert.deepEqual(validateContent({ kind: "mail", direction: "en-pa", image }).image, image);
  const invalid: Record<string, unknown>[] = [
    { kind: "unknown", direction: "en-pa", text: "hi" },
    { kind: "conversation", direction: "unknown", text: "hi" },
    { kind: "conversation", direction: "en-pa", text: " " },
    { kind: "conversation", direction: "en-pa", text: 123 },
    { kind: "conversation", direction: "en-pa", text: "x".repeat(12001) },
    { kind: "conversation", direction: "en-pa", text: "hi", audio },
    { kind: "conversation", direction: "en-pa", image },
    { kind: "mail", direction: "en-pa", audio },
    { kind: "mail", direction: "en-pa", image: { data, mimeType: "image/svg+xml" } },
    { kind: "mail", direction: "en-pa", image: { data: "not-base64!", mimeType: "image/png" } },
    { kind: "mail", direction: "en-pa", image: null },
    { kind: "mail", direction: "en-pa", image: { data: "A".repeat(8000004), mimeType: "image/png" } },
  ];
  for (const value of invalid) assert.throws(() => validateContent(value), assertHttp(400));
});
