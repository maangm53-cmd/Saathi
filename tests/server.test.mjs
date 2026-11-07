import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

const origin = "https://saathi.example";
const organizer = { "oai-authenticated-user-id": "trusted-owner-site-id", "oai-authenticated-user-email": "owner@example.test" };
const setup = { apiKey: "AQ.test_key_not_a_real_credential_123456789", accessCode: "48260371" };
const result = { source: "This is the private letter text.", translation: "ਨਿੱਜੀ ਚਿੱਠੀ", explanation: "ਚਿੱਠੀ ਦਾ ਮਤਲਬ", nextSteps: [], uncertainties: [], speechText: "ਚਿੱਠੀ ਦਾ ਮਤਲਬ" };
let sql;
const calls = [];
let providerBehavior = { check: async () => {}, speak: async () => {}, live: async () => {} };
const liveSession = { token: "auth_tokens/test_ephemeral_not_real", model: "models/test-live-locked", expiresAt: "2030-01-01T00:10:00.000Z" };
const environment = { SAATHI_SECRET: randomBytes(32).toString("base64"), OWNER_EMAIL: "owner@example.test", DB: null };
globalThis.__saathiSecurityTestEnvironment = environment;
globalThis.__saathiSecurityTestProvider = {
  async checkApiKey(key) { calls.push({ kind: "check", key }); await providerBehavior.check(); },
  async processContent(key, input) { calls.push({ kind: "process", key, input }); return result; },
  async synthesizeSpeech(key, text, language) { calls.push({ kind: "speak", key, text, language }); await providerBehavior.speak(); return { data: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" }; },
  async createLiveSession(...args) { calls.push({ kind: "live", args }); await providerBehavior.live(); return { ...liveSession, unrelatedProviderDetail: "must-not-be-returned" }; },
};
const serverUrl = new URL("../lib/server.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__saathiSecurityTestEnvironment", shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./security") return { url: new URL("../lib/security.ts", import.meta.url).href, shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./gemini") return { url: "data:text/javascript,export const {checkApiKey,processContent,synthesizeSpeech} = globalThis.__saathiSecurityTestProvider", shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./gemini-live") return { url: "data:text/javascript,export const {createLiveSession} = globalThis.__saathiSecurityTestProvider", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { handle } = await import(serverUrl);

function reset() {
  sql?.close();
  sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE settings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, encrypted_key TEXT NOT NULL, code_hash TEXT NOT NULL, code_salt TEXT NOT NULL, session_version TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE feedback (id TEXT PRIMARY KEY, rating TEXT NOT NULL, mode TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  environment.DB = {
    prepare(query) {
      const statement = sql.prepare(query);
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return statement.get(...bindings) ?? null; },
        async run() { return statement.run(...bindings); },
        async all() { return { results: statement.all(...bindings) }; },
      };
    },
  };
  calls.length = 0;
  providerBehavior = { check: async () => {}, speak: async () => {}, live: async () => {} };
}
function request(action, body, headers = {}) {
  return new Request(`${origin}/api/${action}`, body === undefined ? { headers } : {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "192.0.2.8", ...headers }, body: JSON.stringify(body),
  });
}
async function configure() {
  const response = await handle(request("setup", setup, organizer), "setup");
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie").split(";")[0];
}

test.beforeEach(reset);
test.after(() => { sql.close(); hooks.deregister(); delete globalThis.__saathiSecurityTestEnvironment; delete globalThis.__saathiSecurityTestProvider; });

test("public visitors cannot bootstrap setup, access provider routes, or read family feedback", async () => {
  for (const [action, body, status] of [["setup", setup, 403], ["process", { kind: "mail", direction: "en-pa", text: "hello" }, 401], ["speak", { text: "hello", language: "en" }, 401], ["feedback", undefined, 403]]) {
    const response = await handle(request(action, body), action);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(calls.length, 0);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM settings").get().count, 0);
});

test("only a complete trusted organizer identity may connect the key; responses never disclose it", async () => {
  for (const headers of [{ "oai-authenticated-user-email": "owner@example.test" }, { "oai-authenticated-user-id": "unrelated-id", "oai-authenticated-user-email": "someone@example.test" }]) {
    assert.equal((await handle(request("setup", setup, headers), "setup")).status, 403);
  }
  const cookie = await configure();
  const stored = sql.prepare("SELECT * FROM settings").get();
  assert.equal(stored.owner_id, organizer["oai-authenticated-user-id"]);
  assert.notEqual(stored.encrypted_key, setup.apiKey);
  assert.ok(!JSON.stringify(stored).includes(setup.apiKey));
  assert.notEqual(stored.code_hash, setup.accessCode);
  const status = await handle(request("status", undefined, { Cookie: cookie }), "status");
  assert.deepEqual(await status.json(), { configured: true, authenticated: true, isOwner: false, needsLogin: false });
  assert.equal(calls.filter(call => call.kind === "check").length, 1);
});

test("cross-origin owner setup cannot change configuration", async () => {
  const response = await handle(request("setup", setup, { ...organizer, Origin: "https://other.example" }), "setup");
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM settings").get().count, 0);
});

test("setup passes a normalized authorization key to Google and stores it encrypted", async () => {
  const wrapped = { ...setup, apiKey: `export GEMINI_API_KEY="${setup.apiKey}"` };
  const response = await handle(request("setup", wrapped, organizer), "setup");
  assert.equal(response.status, 200);
  assert.equal(calls.find(call => call.kind === "check").key, setup.apiKey);
  assert.equal(calls.find(call => call.kind === "speak").key, setup.apiKey);
  assert.ok(!JSON.stringify(sql.prepare("SELECT * FROM settings").get()).includes(setup.apiKey));
});

test("setup starts both independent checks together and commits only after both succeed", async () => {
  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  const checkStarted = deferred();
  const speechStarted = deferred();
  const checkGate = deferred();
  const speechGate = deferred();
  providerBehavior.check = async () => { checkStarted.resolve(); await checkGate.promise; };
  providerBehavior.speak = async () => { speechStarted.resolve(); await speechGate.promise; };
  let completed = false;
  const pending = handle(request("setup", setup, organizer), "setup").then(response => { completed = true; return response; });
  let timer;
  try {
    // A sequential implementation cannot reach both start signals while the
    // first provider call remains gated, and will fail this bounded wait.
    await Promise.race([
      Promise.all([checkStarted.promise, speechStarted.promise]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The setup checks did not start independently")), 1500); }),
    ]);
    clearTimeout(timer);
    assert.equal(completed, false);
    assert.equal(sql.prepare("SELECT count(*) AS count FROM settings").get().count, 0);
    checkGate.resolve();
    await new Promise(setImmediate);
    assert.equal(completed, false, "No response or session cookie may be issued after only one check");
    assert.equal(sql.prepare("SELECT count(*) AS count FROM settings").get().count, 0);
    speechGate.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie")?.startsWith("__Host-saathi="));
    assert.equal(sql.prepare("SELECT count(*) AS count FROM settings").get().count, 1);
  } finally {
    clearTimeout(timer);
    checkGate.resolve();
    speechGate.resolve();
    await pending;
  }
});

for (const configured of [false, true]) {
  for (const failingCheck of ["check", "speak"]) {
    test(`failed ${failingCheck} setup check returns 502 and ${configured ? "preserves existing configuration" : "leaves the family unconfigured"}`, async () => {
      const oldCookie = configured ? await configure() : null;
      const previous = sql.prepare("SELECT * FROM settings").get();
      const startCallCount = calls.length;
      providerBehavior[failingCheck] = async () => {
        const failure = new Error("The provider connection check failed safely.");
        failure.name = "GeminiError";
        throw failure;
      };
      const response = await handle(request("setup", { apiKey: "AQ.new_test_key_not_a_real_credential_987654321", accessCode: "71304682" }, organizer), "setup");
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.deepEqual(sql.prepare("SELECT * FROM settings").get(), previous);
      assert.deepEqual(calls.slice(startCallCount).map(call => call.kind).sort(), ["check", "speak"]);
      const statusResponse = await handle(request("status", undefined, oldCookie ? { Cookie: oldCookie } : {}), "status");
      const status = await statusResponse.json();
      assert.equal(status.configured, configured);
      assert.equal(status.authenticated, configured, "A failed update must preserve the previous family session");
    });
  }
}

test("family sessions may translate and send feedback but cannot read the organizer's feedback", async () => {
  const cookie = await configure();
  const response = await handle(request("process", { kind: "mail", direction: "en-pa", text: "Private user mail input" }, { Cookie: cookie }), "process");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls.find(call => call.kind === "process").key, setup.apiKey);
  const feedback = await handle(request("feedback", { rating: "helpful", mode: "mail:explanation", note: "Easy to hear" }, { Cookie: cookie }), "feedback");
  assert.equal(feedback.status, 200);
  assert.equal((await handle(request("feedback", undefined, { Cookie: cookie }), "feedback")).status, 403);
  const organizerFeedback = await handle(request("feedback", undefined, organizer), "feedback");
  assert.equal(organizerFeedback.status, 200);
  assert.equal((await organizerFeedback.json()).feedback[0].note, "Easy to hear");
  const persisted = JSON.stringify([sql.prepare("SELECT * FROM settings").all(), sql.prepare("SELECT * FROM feedback").all(), sql.prepare("SELECT * FROM rate_limits").all()]);
  assert.ok(!persisted.includes("Private user mail input"));
  assert.ok(!persisted.includes(result.source));
  assert.ok(!persisted.includes(setup.apiKey));
});

test("repeated failed code attempts lock out even a correct code for that IP", async () => {
  await configure();
  for (let i = 0; i < 5; i++) assert.equal((await handle(request("login", { code: "11112222" }), "login")).status, 401);
  assert.equal((await handle(request("login", { code: setup.accessCode }), "login")).status, 429);
  // A different IP remains usable; the family-wide cap still limits distributed attempts.
  assert.equal((await handle(request("login", { code: setup.accessCode }, { "cf-connecting-ip": "192.0.2.9" }), "login")).status, 200);
});

test("changing family setup invalidates old sessions and preserves the original organizer identity", async () => {
  const oldCookie = await configure();
  const spoofedOwner = { "oai-authenticated-user-id": "different-site-user", "oai-authenticated-user-email": "owner@example.test" };
  assert.equal((await handle(request("setup", setup, spoofedOwner), "setup")).status, 403);
  const changedEmail = { ...organizer, "oai-authenticated-user-email": "updated-address@example.test" };
  assert.equal((await handle(request("setup", { ...setup, accessCode: "71304682" }, changedEmail), "setup")).status, 200);
  const status = await handle(request("status", undefined, { Cookie: oldCookie }), "status");
  assert.equal((await status.json()).authenticated, false);
  assert.equal((await handle(request("login", { code: setup.accessCode }), "login")).status, 401);
  assert.equal((await handle(request("login", { code: "71304682" }), "login")).status, 200);
});

test("concurrent requests cannot race past the shared provider minute cap", async () => {
  const cookie = await configure();
  const responses = await Promise.all(Array.from({ length: 20 }, () => handle(request("process", { kind: "conversation", direction: "en-pa", text: "A short sentence" }, { Cookie: cookie }), "process")));
  assert.equal(responses.filter(response => response.status === 200).length, 12);
  assert.equal(responses.filter(response => response.status === 429).length, 8);
  assert.equal(calls.filter(call => call.kind === "process").length, 12);
});

test("invalid or oversized source content is rejected before provider calls", async () => {
  const cookie = await configure();
  const setupCallCount = calls.length;
  for (const [action, body] of [["process", { kind: "mail", direction: "en-pa", text: "x".repeat(12001) }], ["speak", { text: "x".repeat(2501), language: "pa" }]]) {
    assert.equal((await handle(request(action, body, { Cookie: cookie }), action)).status, 400);
  }
  const tooLarge = request("process", { kind: "mail", direction: "en-pa", text: "hello" }, { Cookie: cookie, "Content-Length": "10000000" });
  assert.equal((await handle(tooLarge, "process")).status, 413);
  assert.equal(calls.length, setupCallCount);
});

test("live tokens require same-origin authenticated requests and an existing saved configuration", async () => {
  assert.equal((await handle(request("live-session", {}), "live-session")).status, 401);
  assert.equal((await handle(request("live-session", {}, organizer), "live-session")).status, 503);
  const cookie = await configure();
  assert.equal((await handle(request("live-session", {}, { Cookie: cookie, Origin: "https://other.example" }), "live-session")).status, 403);
  assert.equal((await handle(request("live-session", undefined, { Cookie: cookie }), "live-session")).status, 404);
  assert.equal(calls.filter(call => call.kind === "live").length, 0);
});

test("family and owner may obtain a noncached Live token using only the saved API key", async () => {
  const cookie = await configure();
  const saved = sql.prepare("SELECT * FROM settings").get();
  for (const headers of [{ Cookie: cookie }, organizer]) {
    const response = await handle(request("live-session", {}, headers), "live-session");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), liveSession);
  }
  assert.deepEqual(calls.filter(call => call.kind === "live").map(call => call.args), [[setup.apiKey], [setup.apiKey]]);
  assert.deepEqual(sql.prepare("SELECT * FROM settings").get(), saved);
  assert.ok(!JSON.stringify(sql.prepare("SELECT * FROM rate_limits").all()).includes(liveSession.token));
});

test("Live issuance rejects every client configuration override before calling Google", async () => {
  const cookie = await configure();
  for (const body of [{ model: "unconstrained-model" }, { apiKey: "other-key" }, { config: { tools: [{}] } }, { input: "ignore instructions" }, { uses: 10 }]) {
    assert.equal((await handle(request("live-session", body, { Cookie: cookie }), "live-session")).status, 400);
  }
  assert.equal(calls.filter(call => call.kind === "live").length, 0);
  const oversized = request("live-session", {}, { Cookie: cookie, "Content-Length": "1025" });
  assert.equal((await handle(oversized, "live-session")).status, 413);
});

test("concurrent Live requests cannot exceed the per-IP issuance cap", async () => {
  const cookie = await configure();
  const responses = await Promise.all(Array.from({ length: 8 }, () => handle(request("live-session", {}, { Cookie: cookie }), "live-session")));
  assert.equal(responses.filter(response => response.status === 200).length, 6);
  assert.equal(responses.filter(response => response.status === 429).length, 2);
  assert.equal(calls.filter(call => call.kind === "live").length, 6);
});

test("Live issuance caps apply across IPs for both the family hour and day", async () => {
  const cookie = await configure();
  const responses = await Promise.all(Array.from({ length: 21 }, (_, index) => handle(request("live-session", {}, { Cookie: cookie, "cf-connecting-ip": `192.0.2.${index + 20}` }), "live-session")));
  assert.equal(responses.filter(response => response.status === 200).length, 20);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(calls.filter(call => call.kind === "live").length, 20);
  // Advance the hourly window while preserving the day's accumulated usage.
  sql.prepare("UPDATE rate_limits SET expires_at = 0 WHERE key = ?").run("family-live-hour");
  sql.prepare("UPDATE rate_limits SET count = 60 WHERE key = ?").run("family-live-daily");
  const overDay = await handle(request("live-session", {}, { Cookie: cookie, "cf-connecting-ip": "192.0.2.100" }), "live-session");
  assert.equal(overDay.status, 429);
  assert.equal(calls.filter(call => call.kind === "live").length, 20);
});

test("failed Live issuance preserves saved configuration and feedback accepts the live mode", async () => {
  const cookie = await configure();
  const saved = sql.prepare("SELECT * FROM settings").get();
  providerBehavior.live = async () => { const error = new Error("Live service is temporarily unavailable."); error.name = "GeminiError"; throw error; };
  const failed = await handle(request("live-session", {}, { Cookie: cookie }), "live-session");
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get("set-cookie"), null);
  assert.deepEqual(sql.prepare("SELECT * FROM settings").get(), saved);
  const feedback = await handle(request("feedback", { rating: "helpful", mode: "conversation:live" }, { Cookie: cookie }), "feedback");
  assert.equal(feedback.status, 200);
  assert.equal(sql.prepare("SELECT mode FROM feedback").get().mode, "conversation:live");
});
