import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const moduleUrl = new URL("../lib/web-push.ts", import.meta.url).href;
const { generateVapidKeys, sendPush, validateSubscription } = await import(moduleUrl) as typeof import("../lib/web-push");
type Subscription = import("../lib/web-push").PushSubscriptionData;
const origin = "https://saathi-punjabi-family.guri007.chatgpt.site";
const message = { title: "ਸਾਥੀ", body: "PRIVATE_APPOINTMENT_DETAILS", url: "/?screen=appointments", tag: "appointment-1" };

function base64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function device(endpoint = "https://web.push.apple.com/PRIVATE_DEVICE_TOKEN?key=private") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription: Subscription = { endpoint, expirationTime: null, keys: { p256dh: base64(rawPublic), auth: base64(auth) } };
  return { subscription, pair, rawPublic, auth };
}

async function derive(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// Independently decrypt the RFC 8291 wire record using the receiving device key.
async function decrypt(body: Uint8Array<ArrayBuffer>, recipient: Awaited<ReturnType<typeof device>>) {
  assert.equal(body.length, 4096);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
  assert.equal(body[20], 65);
  const senderPublicBytes = body.slice(21, 86);
  const senderPublic = await crypto.subtle.importKey("raw", senderPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderPublic }, recipient.pair.privateKey, 256));
  const encoder = new TextEncoder();
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...recipient.rawPublic, ...senderPublicBytes]);
  const intermediate = await derive(secret, recipient.auth, info, 32);
  const cek = await derive(intermediate, body.slice(0, 16), encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await derive(intermediate, body.slice(0, 16), encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  assert.equal(padded[end], 2, "Final-record delimiter must precede zero padding");
  return JSON.parse(new TextDecoder().decode(padded.slice(0, end)));
}

test("Web Push validates subscriptions and uses encrypted Apple-compatible delivery (no external calls)", async (suite) => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: unknown[] = [];
  console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args); };
  suite.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });
  const recipient = await device();
  const keys = await generateVapidKeys();

  await suite.test("generates P-256 keys without an email address", async () => {
    assert.equal(keys.subject, origin);
    assert.equal(bytes(keys.publicKey).length, 65);
    assert.equal(bytes(keys.publicKey)[0], 4);
    assert.equal(bytes(keys.privateKey).length, 32);
    const another = await generateVapidKeys();
    assert.notEqual(another.publicKey, keys.publicKey);
    assert.notEqual(another.privateKey, keys.privateKey);
  });

  await suite.test("accepts only HTTPS push providers and strips unknown input fields", () => {
    for (const endpoint of [
      "https://web.push.apple.com/abc?device=123",
      "https://web.push.apple.com:443/abc",
      "https://fcm.googleapis.com/fcm/send/abc?key=123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
    ]) {
      const result = validateSubscription({ ...recipient.subscription, endpoint, unrelatedSecret: "MUST_NOT_PERSIST", keys: { ...recipient.subscription.keys, extra: "MUST_NOT_PERSIST" } });
      assert.equal(result.endpoint, new URL(endpoint).href);
      assert.deepEqual(Object.keys(result).sort(), ["endpoint", "expirationTime", "keys"]);
      assert.deepEqual(Object.keys(result.keys).sort(), ["auth", "p256dh"]);
    }
    const { expirationTime: _ignored, ...withoutExpiry } = recipient.subscription;
    assert.deepEqual(validateSubscription(withoutExpiry), withoutExpiry);
  });

  await suite.test("rejects SSRF, redirects disguised as authorities, malformed keys, and oversized subscriptions", () => {
    for (const endpoint of [
      "http://web.push.apple.com/abc", "https://localhost/abc", "https://127.0.0.1/abc", "https://[::1]/abc",
      "https://169.254.169.254/latest/meta-data", "https://fcm.googleapis.com.evil.example/abc",
      "https://push.apple.com.evil.example/abc", "https://evilpush.apple.com/abc", "https://push.apple.com/abc",
      "https://web.push.apple.com@evil.example/abc", "https://private:secret@web.push.apple.com/abc",
      "https://web.push.apple.com:8443/abc", "https://web.push.apple.com/abc#private", "https://web.push.apple.com/",
      "https://web.push.apple.com/abc\n", "data:text/plain,abc", "https://web.push.apple.com/" + "a".repeat(4096),
    ]) assert.throws(() => validateSubscription({ ...recipient.subscription, endpoint }), { name: "PushError" });
    for (const input of [null, [], {}, { ...recipient.subscription, keys: null },
      { ...recipient.subscription, keys: { ...recipient.subscription.keys, auth: "A".repeat(21) } },
      { ...recipient.subscription, keys: { ...recipient.subscription.keys, auth: recipient.subscription.keys.auth + "=" } },
      { ...recipient.subscription, keys: { ...recipient.subscription.keys, p256dh: base64(new Uint8Array(65)) } },
      { ...recipient.subscription, expirationTime: -1 }, { ...recipient.subscription, expirationTime: Infinity },
      { ...recipient.subscription, expirationTime: "tomorrow" },
    ]) assert.throws(() => validateSubscription(input), { name: "PushError" });
  });

  await suite.test("encrypts the actual payload and signs a verifiable audience-bound VAPID JWT", async () => {
    let calls = 0;
    let lastAuthorization = "";
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, recipient.subscription.endpoint);
      assert.equal(init?.method?.toLowerCase(), "post");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("content-encoding"), "aes128gcm");
      assert.equal(headers.get("content-length"), "4096");
      assert.equal(headers.get("ttl"), "300");
      assert.equal(headers.get("urgency"), "high");
      const authorization = headers.get("authorization")!;
      if (lastAuthorization) assert.equal(authorization, lastAuthorization, "Reuse the VAPID JWT during its one-hour cache window");
      lastAuthorization = authorization;
      const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization)!;
      assert.ok(match);
      assert.equal(match[2], keys.publicKey);
      const [header, claims, signature] = match[1].split(".");
      assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "ES256");
      const jwt = JSON.parse(Buffer.from(claims, "base64url").toString());
      assert.equal(jwt.aud, "https://web.push.apple.com");
      assert.equal(jwt.sub, origin);
      assert.ok(jwt.exp > Date.now() / 1000 && jwt.exp < Date.now() / 1000 + 86_400);
      const publicKey = await crypto.subtle.importKey("raw", bytes(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes(signature), new TextEncoder().encode(`${header}.${claims}`)), true);
      const body = init.body as Uint8Array<ArrayBuffer>;
      assert.doesNotMatch(new TextDecoder().decode(body), /PRIVATE_APPOINTMENT_DETAILS/);
      assert.deepEqual(await decrypt(body, recipient), { ...message, url: "/?screen=appointments" });
      return new Response(null, { status: 201 });
    };
    assert.equal(await sendPush(recipient.subscription, keys, { ...message, url: "https://evil.example/steal" }), "sent");
    assert.equal(await sendPush(recipient.subscription, keys, { ...message, url: "javascript:alert(1)" }), "sent");
    assert.equal(calls, 2);
  });

  await suite.test("returns expired/transient outcomes and sanitizes permanent provider errors without retrying", async () => {
    for (const [status, outcome] of [[200, "sent"], [201, "sent"], [404, "expired"], [410, "expired"], [408, "retry"], [425, "retry"], [429, "retry"], [500, "retry"], [503, "retry"]] as const) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response("PRIVATE_PROVIDER_RESPONSE", { status }); };
      assert.equal(await sendPush(recipient.subscription, keys, message), outcome);
      assert.equal(calls, 1);
    }
    for (const status of [301, 302, 307, 400, 401, 403, 413]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response("PRIVATE_PROVIDER_RESPONSE", { status, headers: { Location: "https://evil.example/steal" } }); };
      await assert.rejects(sendPush(recipient.subscription, keys, message), (error: Error) => {
        assert.equal(error.name, "PushError");
        assert.doesNotMatch(error.message, /PRIVATE_|https:|PRIVATE_DEVICE_TOKEN/);
        assert.ok(!error.message.includes(keys.privateKey));
        return true;
      });
      assert.equal(calls, 1);
    }
    globalThis.fetch = async () => { throw new Error("PRIVATE_NETWORK_DIAGNOSTIC"); };
    assert.equal(await sendPush(recipient.subscription, keys, message), "retry");
  });

  await suite.test("does not send expired subscriptions or invalid credentials", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Must not be called"); };
    assert.equal(await sendPush({ ...recipient.subscription, expirationTime: Date.now() - 1 }, keys, message), "expired");
    await assert.rejects(sendPush(recipient.subscription, { ...keys, privateKey: "PRIVATE_INVALID_KEY" }, message), { name: "PushError" });
    await assert.rejects(sendPush(recipient.subscription, { ...keys, subject: "mailto:private@example.com" }, message), { name: "PushError" });
    const invalidPoint = new Uint8Array(65); invalidPoint[0] = 4;
    await assert.rejects(sendPush({ ...recipient.subscription, keys: { ...recipient.subscription.keys, p256dh: base64(invalidPoint) } }, keys, message), { name: "PushError" });
    assert.equal(calls, 0);
  });

  await suite.test("aborts a stalled delivery after 12 seconds and returns retry without logging", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fire: (() => void) | undefined;
    let started!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      assert.equal(delay, 12_000); fire = callback; return 1;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    globalThis.fetch = async (_url, init) => {
      calls++;
      started();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("PRIVATE_TIMEOUT_DIAGNOSTIC")), { once: true }));
    };
    try {
      const result = sendPush(recipient.subscription, keys, message);
      await pending;
      fire!();
      assert.equal(await result, "retry");
      assert.equal(calls, 1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
    assert.deepEqual(logs, [], "No keys, subscriptions, content, or provider diagnostics may be logged");
  });
});

test("Service worker shows visible Punjabi notifications and opens only Saathi appointments", async (suite) => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map<string, (event: any) => void>();
  const shown: Array<{ title: string; options: any }> = [];
  const opened: string[] = [];
  let windows: any[] = [];
  const self = {
    location: { origin },
    addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, listener); },
    registration: { async showNotification(title: string, options: any) { shown.push({ title, options }); } },
    clients: { async matchAll() { return windows; }, async openWindow(url: string) { opened.push(url); return null; } },
  };
  vm.runInNewContext(source, { self, URL });
  assert.deepEqual([...listeners.keys()].sort(), ["notificationclick", "push"], "No fetch caching, timer polling, or automatic audio handlers");

  await suite.test("malformed and empty pushes still display safe Punjabi defaults", async () => {
    for (const data of [undefined, { json() { throw new Error("PRIVATE_BAD_PAYLOAD"); } }, { json() { return null; } }]) {
      let pending!: Promise<unknown>;
      listeners.get("push")!({ data, waitUntil(value: Promise<unknown>) { pending = value; } });
      await pending;
      assert.match(shown.at(-1)!.title, /ਸਾਥੀ/);
      assert.match(shown.at(-1)!.options.body, /ਮੁਲਾਕਾਤ/);
    }
  });

  await suite.test("valid push text is bounded and remote links cannot reach the notification", async () => {
    let pending!: Promise<unknown>;
    listeners.get("push")!({ data: { json() { return { title: "A".repeat(200), body: "B".repeat(900), tag: "C".repeat(150), url: "https://evil.example/steal", extra: "PRIVATE_TOKEN" }; } }, waitUntil(value: Promise<unknown>) { pending = value; } });
    await pending;
    const latest = shown.at(-1)!;
    assert.equal(latest.title.length, 100);
    assert.equal(latest.options.body.length, 600);
    assert.equal(latest.options.tag.length, 100);
    assert.equal(latest.options.data.url, "/?screen=appointments");
    assert.doesNotMatch(JSON.stringify(latest), /evil.example|PRIVATE_TOKEN/);
  });

  await suite.test("clicks navigate and focus an existing same-origin window", async () => {
    let closed = false;
    let focused = false;
    let navigated = "";
    let pending!: Promise<unknown>;
    windows = [
      { url: "https://evil.example/", async navigate() { assert.fail("Must ignore other origins"); } },
      { url: `${origin}/`, async navigate(url: string) { navigated = url; return { async focus() { focused = true; } }; } },
    ];
    listeners.get("notificationclick")!({ notification: { data: { url: "javascript:alert(1)" }, close() { closed = true; } }, waitUntil(value: Promise<unknown>) { pending = value; } });
    await pending;
    assert.equal(closed, true);
    assert.equal(focused, true);
    assert.equal(navigated, `${origin}/?screen=appointments`);
    assert.equal(opened.length, 0);
  });

  await suite.test("a missing or closing window opens the same safe screen", async () => {
    for (const candidates of [[], [{ url: `${origin}/`, async navigate() { throw new Error("Window closed"); } }]]) {
      windows = candidates;
      let pending!: Promise<unknown>;
      listeners.get("notificationclick")!({ notification: { close() {} }, waitUntil(value: Promise<unknown>) { pending = value; } });
      await pending;
      assert.equal(opened.at(-1), `${origin}/?screen=appointments`);
    }
  });
});
