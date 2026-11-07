import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const serviceUrl = new URL("../lib/calendar-service.ts", import.meta.url).href;
const securityUrl = new URL("../lib/security.ts", import.meta.url).href;
const originalNow = Date.now;
let now, sql, db, service, behavior, calls;
const secret = randomBytes(32).toString("base64");
const source = { id: "calendar-one", url: "https://p01-caldav.icloud.com/123/one/", name: "Private appointments" };
const second = { id: "calendar-two", url: "https://p01-caldav.icloud.com/123/two/", name: "Unselected calendar" };
const connectInput = { username: "family@example.test", password: "aaaa-bbbb-cccc-dddd", timeZone: "America/Los_Angeles" };
const selection = { calendarIds: [source.id], timeZone: "America/Los_Angeles", reminderMinutes: 30 };
const subscription = id => ({ endpoint: `https://web.push.apple.com/private-${id}`, keys: { p256dh: "mock-p256dh", auth: "mock-auth" } });
const appointment = (id = "occurrence-one", overrides = {}) => ({ id, calendarId: source.id, title: "Private medical visit", description: "Private appointment details", location: "Private clinic", startAt: now + 20 * 60000, endAt: now + 50 * 60000, allDay: false, ...overrides });
globalThis.__saathiCalendarProviders = {
  async discoverCalendars(...args) { calls.push({ kind: "discover", args }); return behavior.discover(...args); },
  async fetchAppointments(...args) { calls.push({ kind: "fetch", args }); return behavior.fetch(...args); },
  async generateVapidKeys() { calls.push({ kind: "keys" }); return { subject: "https://saathi.example", publicKey: "PUBLIC_VAPID", privateKey: "PRIVATE_VAPID" }; },
  validateSubscription(value) { return structuredClone(value); },
  async sendPush(...args) { calls.push({ kind: "push", args }); return behavior.push(...args); },
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === serviceUrl && specifier === "./security") return { url: securityUrl, shortCircuit: true };
  if (context.parentURL === serviceUrl && specifier === "./icloud-calendar") return { url: "data:text/javascript,export const {discoverCalendars,fetchAppointments} = globalThis.__saathiCalendarProviders", shortCircuit: true };
  if (context.parentURL === serviceUrl && specifier === "./web-push") return { url: "data:text/javascript,export const {generateVapidKeys,validateSubscription,sendPush} = globalThis.__saathiCalendarProviders", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { CalendarService } = await import(serviceUrl);
const { decryptPrivate } = await import(securityUrl);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function row(table) { return sql.prepare(`SELECT * FROM ${table}`).get(); }
function rows(table) { return sql.prepare(`SELECT * FROM ${table}`).all(); }
async function configured() { await service.connect(connectInput); await service.save(selection); }
async function device(id = "one") { return (await service.subscribe(subscription(id))).deviceId; }

test.beforeEach(() => {
  sql?.close(); sql = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDirectory).filter(name => name.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(name, migrationDirectory), "utf8"));
  now = Date.parse("2026-11-06T16:00:00Z"); Date.now = () => now;
  sql.prepare("INSERT INTO settings(id,owner_id,encrypted_key,code_hash,code_salt,session_version,updated_at) VALUES (?,?,?,?,?,?,?)").run("family", "owner-id", "encrypted-gemini", "code-hash", "salt", "version-one", now);
  db = {
    prepare(query) {
      const statement = sql.prepare(query); let bindings = [];
      return { bind(...values) { bindings = values; return this; }, async first() { return statement.get(...bindings) ?? null; }, async all() { return { results: statement.all(...bindings) }; }, async run() { return statement.run(...bindings); }, execute() { return statement.run(...bindings); } };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try { const result = statements.map(statement => statement.execute()); sql.exec("COMMIT"); return result; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  calls = []; behavior = { discover: async () => [source, second], fetch: async () => [appointment()], push: async () => "sent" };
  service = new CalendarService(db, secret, "version-one");
});
test.after(() => { sql.close(); Date.now = originalNow; hooks.deregister(); delete globalThis.__saathiCalendarProviders; });

test("connection validation completes before persistence and never auto-selects private calendars", async () => {
  const entered = deferred(), gate = deferred();
  behavior.discover = async () => { entered.resolve(); await gate.promise; return [source, second]; };
  const pending = service.connect(connectInput); await entered.promise;
  assert.equal(row("calendar_config"), undefined);
  gate.resolve(); await pending;
  assert.equal(row("calendar_config").selected_ids, "[]");
  assert.equal(calls.filter(call => call.kind === "fetch").length, 0);
  assert.equal((await service.status(false)).calendars.length, 0);
  assert.equal((await service.status(true)).calendars.length, 2);
  const before = row("calendar_config");
  behavior.discover = async () => { throw Object.assign(new Error("sanitized failure"), { name: "CalendarError" }); };
  await assert.rejects(service.connect(connectInput), { name: "CalendarError" });
  assert.deepEqual(row("calendar_config"), before);
});

test("only explicit discovered selections are fetched, and credentials/details use distinct encryption purposes", async () => {
  await configured();
  const fetchCall = calls.find(call => call.kind === "fetch");
  assert.deepEqual(fetchCall.args[1], [source]);
  assert.equal(fetchCall.args[2].end - fetchCall.args[2].start, 31 * 86400000);
  const config = row("calendar_config"), event = row("appointments");
  assert.doesNotMatch(JSON.stringify(config), /aaaa|family@example|icloud\.com|Private appointments/);
  assert.doesNotMatch(JSON.stringify(event), /medical|clinic|appointment details/);
  assert.equal((await decryptPrivate(config.encrypted_connection, secret, "icloud-connection")).credentials.password, connectInput.password);
  await assert.rejects(decryptPrivate(config.encrypted_connection, secret, "appointment-details"));
  assert.equal((await service.appointment(event.id)).title, "Private medical visit");
  for (const calendarIds of [[], ["not-discovered"], [source.id, source.id], Array(6).fill(source.id)]) await assert.rejects(service.save({ ...selection, calendarIds }), { status: 400 });
});

test("failed selection and partial sync preserve last good appointments; successful replacement removes cancellations", async () => {
  await configured(); const before = rows("appointments"), config = row("calendar_config");
  behavior.fetch = async () => { throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC"); };
  await assert.rejects(service.save({ ...selection, calendarIds: [second.id] }));
  assert.deepEqual(row("calendar_config"), config);
  assert.deepEqual(await service.sync(true), { ok: false, reason: "calendar_unavailable" });
  assert.deepEqual(rows("appointments"), before);
  assert.doesNotMatch(row("calendar_config").last_error, /PRIVATE/);
  behavior.fetch = async () => [appointment("replacement", { title: "Updated appointment" })];
  await service.sync(true);
  assert.equal(rows("appointments").length, 1);
  assert.equal(row("appointments").id, "replacement");
  await assert.rejects(service.appointment("occurrence-one"), { status: 404 });
});

test("an older sync cannot overwrite a newly selected revision or a newer acquired sync lease", async () => {
  await configured();
  for (const change of ["revision", "lease"]) {
    const entered = deferred(), gate = deferred();
    behavior.fetch = async () => { entered.resolve(); await gate.promise; return [appointment("obsolete")]; };
    const oldSync = service.sync(true); await entered.promise;
    behavior.fetch = async () => [appointment(`new-${change}`)];
    if (change === "revision") await service.save(selection);
    else { now += 121000; await service.sync(true); }
    gate.resolve(); await oldSync;
    assert.equal(row("appointments").id, `new-${change}`);
    assert.equal(rows("appointments").length, 1);
  }
});

test("a disconnect during sync cannot restore removed private calendar data", async () => {
  await configured(); const entered = deferred(), gate = deferred();
  behavior.fetch = async () => { entered.resolve(); await gate.promise; return [appointment()]; };
  const pending = service.sync(true); await entered.promise;
  await service.disconnect(); gate.resolve(); await pending;
  assert.equal(row("calendar_config"), undefined);
  assert.equal(rows("appointments").length, 0);
});

test("VAPID and device subscription secrets remain encrypted and reuse stable keys", async () => {
  const first = await service.pushKey(), secondKey = await service.pushKey();
  assert.deepEqual(first, { publicKey: "PUBLIC_VAPID" }); assert.deepEqual(secondKey, first);
  assert.equal(calls.filter(call => call.kind === "keys").length, 1);
  const id = await device();
  assert.equal((await service.subscribe(subscription("one"))).deviceId, id);
  assert.doesNotMatch(JSON.stringify(rows("push_keys")), /PRIVATE_VAPID/);
  assert.doesNotMatch(JSON.stringify(rows("push_devices")), /web\.push|mock-auth/);
  await assert.rejects(decryptPrivate(row("push_devices").encrypted_subscription, secret, "push-vapid"));
});

test("concurrent reminder jobs claim once, and subsequent runs do not resend completed deliveries", async () => {
  await configured(); await device();
  const entered = deferred(), gate = deferred();
  behavior.push = async () => { entered.resolve(); await gate.promise; return "sent"; };
  const pending = service.runReminders(); await entered.promise;
  assert.deepEqual(await service.runReminders(), { outcome: "already_running", sent: 0, failed: 0 });
  gate.resolve(); assert.equal((await pending).sent, 1);
  assert.equal((await service.runReminders()).sent, 0);
  assert.equal(calls.filter(call => call.kind === "push").length, 1);
  assert.equal(row("reminder_deliveries").state, "sent");
  const payload = calls.find(call => call.kind === "push").args[2];
  assert.doesNotMatch(JSON.stringify(payload), /medical|Private|clinic/);
  assert.equal(payload.url, "/?screen=appointments");
});

test("device registration atomically enforces capacity and returns the actual shared endpoint ID", async () => {
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => service.subscribe(subscription("same"))));
  assert.equal(new Set(duplicates.map(item => item.deviceId)).size, 1);
  assert.equal(rows("push_devices").length, 1);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => service.subscribe(subscription(`extra-${i}`))));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 9);
  assert.equal(rows("push_devices").length, 10);
});

test("later due appointments are not starved by already delivered earlier events", async () => {
  behavior.fetch = async () => Array.from({ length: 60 }, (_, i) => appointment(`event-${i}`, { startAt: now + 20 * 60000 + i * 1000 }));
  await configured(); await device();
  for (let run = 0; run < 3; run++) assert.equal((await service.runReminders()).sent, 20);
  assert.equal((await service.runReminders()).sent, 0);
  assert.equal(calls.filter(call => call.kind === "push").length, 60);
});

test("a concurrent refresh failure stops subsequent sends in an existing reminder run", async () => {
  behavior.fetch = async () => [appointment("first"), appointment("second")];
  await configured(); await device();
  behavior.push = async () => { sql.prepare("UPDATE calendar_config SET last_error='refresh failed'").run(); return "sent"; };
  assert.equal((await service.runReminders()).sent, 1);
  assert.equal(calls.filter(call => call.kind === "push").length, 1);
});

test("expired devices are removed and temporary errors retry only after the backoff", async () => {
  await configured(); await device(); behavior.push = async () => "expired";
  assert.equal((await service.runReminders()).failed, 1);
  assert.equal(rows("push_devices").length, 0);
  await device("two"); behavior.push = async () => "retry";
  await service.runReminders(); const attempts = calls.filter(call => call.kind === "push").length;
  await service.runReminders(); assert.equal(calls.filter(call => call.kind === "push").length, attempts);
  now += 6 * 60000; behavior.push = async () => "sent";
  assert.equal((await service.runReminders()).sent, 1);
  assert.equal(rows("reminder_deliveries").find(item => item.state === "sent").attempts, 2);
});

test("a delayed expired response cannot remove a refreshed subscription on the same device", async () => {
  const id = await device();
  const entered = deferred(), gate = deferred();
  behavior.push = async () => { entered.resolve(); await gate.promise; return "expired"; };
  const pending = service.testPush(id);
  const failure = assert.rejects(pending, { status: 502 });
  await entered.promise;
  const renewed = { ...subscription("one"), keys: { p256dh: "new-p256dh", auth: "new-auth" } };
  assert.equal((await service.subscribe(renewed)).deviceId, id);
  gate.resolve(); await failure;
  assert.equal(row("push_devices").id, id);
  assert.equal((await decryptPrivate(row("push_devices").encrypted_subscription, secret, "push-subscription")).keys.auth, "new-auth");
});

test("stale or failed calendar refresh suppresses reminders; all-day events do not generate time alarms", async () => {
  await configured(); await device(); now += 16 * 60000;
  behavior.fetch = async () => { throw new Error("iCloud unavailable"); };
  assert.equal((await service.runReminders()).outcome, "calendar_unavailable");
  assert.equal(calls.filter(call => call.kind === "push").length, 0);
  behavior.fetch = async () => [appointment("birthday", { allDay: true })];
  await service.sync(true); await service.runReminders();
  assert.equal(calls.filter(call => call.kind === "push").length, 0);
});

test("family-code rotation revokes old devices without deleting newly authorized devices mid-run", async () => {
  await configured(); await device();
  const entered = deferred(), gate = deferred();
  behavior.push = async () => { entered.resolve(); await gate.promise; return "sent"; };
  const pending = service.runReminders(); await entered.promise;
  sql.prepare("UPDATE settings SET session_version='version-two'").run();
  const current = new CalendarService(db, secret, "version-two");
  const newId = (await current.subscribe(subscription("new-phone"))).deviceId;
  gate.resolve(); await pending;
  assert.deepEqual(rows("push_devices").map(item => item.id), [newId]);
  await assert.rejects(service.subscribe(subscription("stale-phone")), { status: 401 });
  assert.deepEqual(rows("push_devices").map(item => item.id), [newId]);
  assert.deepEqual((await service.status(false)).deviceIds, []);
});

test("background readiness requires both a recorded schedule and a recent successful runner check", async () => {
  await configured();
  assert.equal((await service.status(true)).backgroundReady, false);
  await service.confirmSchedule("saved-schedule-id");
  assert.equal((await service.status(true)).backgroundReady, false);
  await service.runReminders();
  assert.equal((await service.status(true)).backgroundReady, true);
  now += 21 * 60000;
  assert.equal((await service.status(true)).backgroundReady, false);
});
