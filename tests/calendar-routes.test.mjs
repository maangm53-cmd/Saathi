import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const origin = "https://saathi.example";
const owner = { "oai-authenticated-user-id": "trusted-owner-site-id", "oai-authenticated-user-email": "owner@example.test" };
const apiKey = "PRIVATE_TEST_ONLY_API_KEY";
const environment = { SAATHI_SECRET: randomBytes(32).toString("base64"), OWNER_EMAIL: "owner@example.test", DB: null };
const serverUrl = new URL("../lib/server.ts", import.meta.url).href;
const securityUrl = new URL("../lib/security.ts", import.meta.url).href;
const { encryptKey, createSession, sessionCookie, HttpError } = await import(securityUrl);
const calls = [];
let behavior = {};
let sql;
let familyCookie;
const health = { connected: true, selectedCalendarCount: 1, deviceCount: 1, lastSyncedAt: 1800000000000, lastRunAt: 1800000000000, lastOutcome: "ok", scheduleLinked: false };
const appointment = { id: "appointment-1", title: "Check-up", description: "Bring the appointment letter", location: "Clinic", startAt: Date.parse("2026-11-10T17:00:00Z"), endAt: Date.parse("2026-11-10T17:30:00Z"), allDay: false, timeZone: "America/Los_Angeles" };

class MockCalendarService {
  constructor(db, secret, version) {
    assert.equal(db, environment.DB);
    assert.equal(secret, environment.SAATHI_SECRET);
    assert.equal(version, "current-family-version");
  }
  async invoke(method, args, result) {
    calls.push({ method, args });
    if (behavior[method]) return behavior[method](...args);
    return result;
  }
  status(...args) { return this.invoke("status", args, { connected: true, appointments: [appointment], calendars: [{ id: "calendar-1", name: "Family", selected: true }], backgroundReady: false }); }
  connect(...args) { return this.invoke("connect", args, { ok: true }); }
  save(...args) { return this.invoke("save", args, { ok: true }); }
  disconnect(...args) { return this.invoke("disconnect", args, { ok: true }); }
  sync(...args) { return this.invoke("sync", args, { ok: true }); }
  appointment(...args) { return this.invoke("appointment", args, appointment); }
  pushKey(...args) { return this.invoke("pushKey", args, { publicKey: "PUBLIC_VAPID_KEY" }); }
  subscribe(...args) { return this.invoke("subscribe", args, { deviceId: "device-1" }); }
  unsubscribe(...args) { return this.invoke("unsubscribe", args, { ok: true }); }
  testPush(...args) { return this.invoke("testPush", args, { ok: true }); }
  runnerStatus(...args) { return this.invoke("runnerStatus", args, { ...health }); }
  runReminders(...args) { return this.invoke("runReminders", args, { outcome: "ok", sent: 1, failed: 0 }); }
  confirmSchedule(...args) { return this.invoke("confirmSchedule", args, { ...health, scheduleLinked: true }); }
}
globalThis.__saathiCalendarRouteEnvironment = environment;
globalThis.__saathiCalendarRouteService = MockCalendarService;
globalThis.__saathiCalendarRouteProvider = {
  async processContent(key, input) { calls.push({ method: "processContent", key, input }); return { source: input.text, translation: "ਮੁਲਾਕਾਤ", explanation: "ਮੁਲਾਕਾਤ ਦੇ ਵੇਰਵੇ", nextSteps: [], uncertainties: [], speechText: "ਮੁਲਾਕਾਤ ਦੇ ਵੇਰਵੇ" }; },
  async checkApiKey() { throw new Error("Unexpected provider call"); },
  async synthesizeSpeech() { throw new Error("Unexpected provider call"); },
  async createLiveSession() { throw new Error("Unexpected provider call"); },
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__saathiCalendarRouteEnvironment", shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./security") return { url: securityUrl, shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./calendar-service") return { url: "data:text/javascript,export const CalendarService = globalThis.__saathiCalendarRouteService", shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./gemini") return { url: "data:text/javascript,export const {checkApiKey,processContent,synthesizeSpeech} = globalThis.__saathiCalendarRouteProvider", shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "./gemini-live") return { url: "data:text/javascript,export const {createLiveSession} = globalThis.__saathiCalendarRouteProvider", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { handle, handleMcp } = await import(serverUrl);

test.beforeEach(async () => {
  sql?.close();
  sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE settings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, encrypted_key TEXT NOT NULL, code_hash TEXT NOT NULL, code_salt TEXT NOT NULL, session_version TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);");
  sql.prepare("INSERT INTO settings VALUES (?,?,?,?,?,?,?)").run("family", owner["oai-authenticated-user-id"], await encryptKey(apiKey, environment.SAATHI_SECRET), "TEST_HASH", "TEST_SALT", "current-family-version", Date.now());
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
  familyCookie = sessionCookie(await createSession("current-family-version", environment.SAATHI_SECRET)).split(";")[0];
  calls.length = 0;
  behavior = {};
});
test.after(() => {
  sql.close();
  hooks.deregister();
  delete globalThis.__saathiCalendarRouteEnvironment;
  delete globalThis.__saathiCalendarRouteService;
  delete globalThis.__saathiCalendarRouteProvider;
});

function browser(action, body, headers = {}) {
  return new Request(`${origin}/api/${action}`, body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "192.0.2.25", ...headers }, body: JSON.stringify(body) });
}
function rpc(method, params, headers = owner) {
  return new Request(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) }) });
}
function tool(name, args = {}, headers = owner) { return rpc("tools/call", { name, arguments: args }, headers); }
async function privateJson(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const text = await response.text();
  for (const secret of [apiKey, environment.SAATHI_SECRET, "PRIVATE_ICLOUD_PASSWORD", "PRIVATE_PROVIDER_RESPONSE"]) assert.ok(!text.includes(secret));
  return JSON.parse(text);
}
const calendarActions = ["calendar-connect", "calendar-save", "calendar-disconnect", "calendar-sync", "push-key", "push-subscribe", "push-unsubscribe", "push-test", "appointment-explain"];

test("anonymous users cannot read calendar details or call any calendar/push route", async () => {
  await privateJson(await handle(browser("calendar-status"), "calendar-status"), 401);
  for (const action of calendarActions) await privateJson(await handle(browser(action, {}), action), 401);
  assert.equal(calls.length, 0);
});

test("calendar browser mutations require exact Origin even for owners or valid family sessions", async () => {
  for (const action of calendarActions) {
    for (const headers of [owner, { Cookie: familyCookie }]) {
      await privateJson(await handle(browser(action, {}, { ...headers, Origin: "https://evil.example" }), action), 403);
      const withoutOrigin = browser(action, {}, headers);
      withoutOrigin.headers.delete("origin");
      await privateJson(await handle(withoutOrigin, action), 403);
    }
  }
  assert.equal(calls.length, 0);
});

test("only the established organizer can connect, select, or disconnect calendars", async () => {
  const bodies = { "calendar-connect": { username: "family@example.test", password: "PRIVATE_ICLOUD_PASSWORD", timeZone: "Asia/Kolkata" }, "calendar-save": { calendarIds: ["calendar-1"], timeZone: "Asia/Kolkata", reminderMinutes: 30 }, "calendar-disconnect": {} };
  for (const action of Object.keys(bodies)) {
    for (const headers of [{ Cookie: familyCookie }, { Cookie: familyCookie, ...owner, "oai-authenticated-user-id": "wrong-owner-id" }]) await privateJson(await handle(browser(action, bodies[action], headers), action), 403);
    await privateJson(await handle(browser(action, bodies[action], owner), action));
  }
  assert.deepEqual(calls.map(call => call.method), ["connect", "save", "disconnect"]);
  assert.deepEqual(calls[0].args, [bodies["calendar-connect"]]);
  assert.deepEqual(calls[1].args, [bodies["calendar-save"]]);
});

test("calendar status uses family authorization without granting organizer access", async () => {
  for (const [headers, expectedOwner] of [[{ Cookie: familyCookie }, false], [owner, true]]) {
    const data = await privateJson(await handle(browser("calendar-status", undefined, headers), "calendar-status"));
    assert.equal(data.appointments[0].id, appointment.id);
    assert.deepEqual(calls.at(-1), { method: "status", args: [expectedOwner] });
  }
  sql.prepare("UPDATE settings SET session_version='rotated'").run();
  await privateJson(await handle(browser("calendar-status", undefined, { Cookie: familyCookie }), "calendar-status"), 401);
});

test("authenticated phones can subscribe, test, unsubscribe and refresh without passing credentials", async () => {
  const subscription = { endpoint: "https://web.push.apple.com/test", keys: { p256dh: "PUBLIC_TEST_POINT", auth: "TEST_AUTH_SECRET" } };
  for (const [action, body, method, args] of [
    ["push-key", {}, "pushKey", []], ["push-subscribe", { subscription }, "subscribe", [subscription]],
    ["push-test", { deviceId: "device-1" }, "testPush", ["device-1"]], ["push-unsubscribe", { deviceId: "device-1" }, "unsubscribe", ["device-1"]],
    ["calendar-sync", {}, "sync", [true]],
  ]) {
    await privateJson(await handle(browser(action, body, { Cookie: familyCookie }), action));
    assert.deepEqual(calls.at(-1), { method, args });
  }
});

test("appointment explanations use saved appointment content and the saved key, ignoring caller content", async () => {
  const response = await handle(browser("appointment-explain", { id: appointment.id, text: "UNTRUSTED_OVERRIDE", apiKey: "UNTRUSTED_KEY", title: "UNTRUSTED_TITLE" }, { Cookie: familyCookie }), "appointment-explain");
  await privateJson(response);
  assert.deepEqual(calls[0], { method: "appointment", args: [appointment.id] });
  const generated = calls.find(call => call.method === "processContent");
  assert.equal(generated.key, apiKey);
  assert.equal(generated.input.kind, "mail");
  assert.equal(generated.input.direction, "en-pa");
  assert.match(generated.input.text, /Check-up/);
  assert.match(generated.input.text, /America\/Los_Angeles/);
  assert.doesNotMatch(generated.input.text, /UNTRUSTED_/);
});

test("calendar and push requests enforce body limits and per-action rates before service calls", async () => {
  const oversized = browser("calendar-connect", {}, owner); oversized.headers.set("content-length", "12001");
  await privateJson(await handle(oversized, "calendar-connect"), 413);
  assert.equal(calls.length, 0);
  for (let index = 0; index < 3; index++) await privateJson(await handle(browser("push-test", { deviceId: "device-1" }, { Cookie: familyCookie }), "push-test"));
  await privateJson(await handle(browser("push-test", { deviceId: "device-1" }, { Cookie: familyCookie }), "push-test"), 429);
  assert.equal(calls.filter(call => call.method === "testPush").length, 3);
});

test("failed calendar refresh preserves a safe error and does not invoke translation", async () => {
  behavior.sync = async () => ({ ok: false, reason: "calendar_unavailable" });
  const data = await privateJson(await handle(browser("calendar-sync", {}, { Cookie: familyCookie }), "calendar-sync"), 503);
  assert.match(data.error, /last saved appointments/);
  behavior.status = async () => { throw new Error("PRIVATE_PROVIDER_RESPONSE PRIVATE_ICLOUD_PASSWORD"); };
  await privateJson(await handle(browser("calendar-status", undefined, { Cookie: familyCookie }), "calendar-status"), 500);
  assert.equal(calls.some(call => call.method === "processContent"), false);
});

test("MCP public discovery exposes only tool metadata, never family data", async () => {
  const discovery = await privateJson(await handleMcp(rpc("server/discover", undefined, {})));
  assert.deepEqual(discovery.result.supportedVersions, ["2026-07-28"]);
  const listed = await privateJson(await handleMcp(rpc("tools/list", undefined, {})));
  assert.deepEqual(listed.result.tools.map(item => item.name).sort(), ["saathi_confirm_reminder_schedule", "saathi_reminder_status", "saathi_run_reminders"]);
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(calls.length, 0);
});

test("every MCP tool requires the established organizer identity, not family cookies or matching email", async () => {
  for (const name of ["saathi_reminder_status", "saathi_run_reminders", "saathi_confirm_reminder_schedule"]) {
    for (const headers of [{}, { Cookie: familyCookie }, { "oai-authenticated-user-email": owner["oai-authenticated-user-email"] }, { ...owner, "oai-authenticated-user-id": "another-user" }]) {
      const data = await privateJson(await handleMcp(tool(name, name.includes("confirm") ? { scheduleId: "saved-schedule-123" } : {}, headers)), 403);
      assert.equal(data.error.code, -32001);
    }
  }
  assert.equal(calls.length, 0);
});

test("MCP refuses browser cross-origin calls while allowing authenticated server calls without Origin", async () => {
  await privateJson(await handleMcp(tool("saathi_run_reminders", {}, { ...owner, Origin: "https://evil.example" })), 403);
  assert.equal(calls.length, 0);
  for (const headers of [owner, { ...owner, Origin: origin }]) {
    const data = await privateJson(await handleMcp(tool("saathi_run_reminders", {}, headers)));
    assert.equal(data.result.isError, false);
    assert.deepEqual(data.result.structuredContent, { outcome: "ok", sent: 1, failed: 0 });
    assert.deepEqual(JSON.parse(data.result.content[0].text), data.result.structuredContent);
  }
  assert.deepEqual(calls, [{ method: "runReminders", args: [] }, { method: "runReminders", args: [] }]);
});

test("MCP status and runner reject argument overrides before any service operation", async () => {
  for (const name of ["saathi_reminder_status", "saathi_run_reminders"]) {
    for (const args of [{ force: true }, { apiKey: "PRIVATE_OVERRIDE" }, { credentials: {} }, { subscription: {} }, { endpoint: "https://evil.example" }, ["invalid"], "invalid"]) await privateJson(await handleMcp(tool(name, args)), 400);
  }
  await privateJson(await handleMcp(tool("saathi_confirm_reminder_schedule", { scheduleId: "saved-schedule-123", extra: true })), 400);
  await privateJson(await handleMcp(tool("unknown_tool")), 400);
  assert.equal(calls.length, 0);
});

test("MCP status returns health only and a saved schedule ID is explicitly confirmed", async () => {
  const status = await privateJson(await handleMcp(tool("saathi_reminder_status")));
  assert.deepEqual(status.result.structuredContent, health);
  assert.doesNotMatch(JSON.stringify(status), /Check-up|Bring the appointment letter|Clinic|PRIVATE_/);
  const confirmed = await privateJson(await handleMcp(tool("saathi_confirm_reminder_schedule", { scheduleId: "saved-schedule-123" })));
  assert.equal(confirmed.result.structuredContent.scheduleLinked, true);
  assert.deepEqual(calls.at(-1), { method: "confirmSchedule", args: ["saved-schedule-123"] });
});

test("MCP rejects malformed or oversized requests and never leaks internal failures", async () => {
  await privateJson(await handleMcp(new Request(`${origin}/mcp`)), 405);
  await privateJson(await handleMcp(new Request(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...owner }, body: "[]" })), 400);
  const oversized = tool("saathi_run_reminders"); oversized.headers.set("content-length", "8193");
  await privateJson(await handleMcp(oversized), 413);
  await privateJson(await handleMcp(rpc("unknown/method")), 404);
  assert.equal(calls.length, 0);
  behavior.runReminders = async () => { throw new Error("PRIVATE_PROVIDER_RESPONSE PRIVATE_ICLOUD_PASSWORD"); };
  const failure = await privateJson(await handleMcp(tool("saathi_run_reminders")));
  assert.equal(failure.jsonrpc, "2.0");
  assert.equal(failure.id, 7);
  assert.equal(failure.error, undefined, "An invoked tool failure is not a JSON-RPC transport error");
  assert.equal(failure.result.isError, true);
  assert.deepEqual(failure.result.content, [{ type: "text", text: "The reminder request could not finish. Please try again." }]);
  assert.equal(failure.result.structuredContent, undefined);
  assert.equal(calls.length, 1);
  behavior.runReminders = async () => { throw new HttpError(503, "The reminder check could not finish. Please retry later."); };
  const expectedFailure = await privateJson(await handleMcp(tool("saathi_run_reminders")));
  assert.equal(expectedFailure.result.isError, true);
  assert.deepEqual(expectedFailure.result.content, [{ type: "text", text: "The reminder check could not finish. Please retry later." }]);
  assert.equal(calls.length, 2);
});
