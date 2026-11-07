import { HttpError, encryptPrivate, decryptPrivate } from "./security";
import { discoverCalendars, fetchAppointments, type CalendarSource, type ICloudCredentials, type Appointment } from "./icloud-calendar";
import { generateVapidKeys, validateSubscription, sendPush, type PushSubscriptionData, type VapidKeys } from "./web-push";

type Connection = { credentials: ICloudCredentials; calendars: CalendarSource[] };
type Config = { id: string; encrypted_connection: string; selected_ids: string; revision: string; time_zone: string; reminder_minutes: number; last_synced_at: number | null; last_error: string | null };
type EventRow = { id: string; revision: string; start_at: number; end_at: number; all_day: number; encrypted_details: string };
type Device = { id: string; encrypted_subscription: string; session_version: string };
type Runner = { last_run_at: number | null; last_success_at: number | null; last_outcome: string | null; schedule_id: string | null };
const REMINDER_BODY = "ਤੁਹਾਡੀ ਮੁਲਾਕਾਤ ਨੇੜੇ ਆ ਰਹੀ ਹੈ। ਵੇਰਵਿਆਂ ਲਈ ਸਾਥੀ ਖੋਲ੍ਹੋ ਜੀ।";
const SYNC_ERROR = "iCloud could not refresh. Check the connection in family setup. Reminders wait for a fresh calendar.";

function zone(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) throw new HttpError(400, "Choose the time zone used for appointments.");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { throw new HttpError(400, "Choose a valid time zone, such as Asia/Kolkata or America/Los_Angeles."); }
  return value;
}
function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 160) throw new HttpError(400, "Choose an appointment or this phone again.");
  return value;
}
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class CalendarService {
  constructor(private db: D1Database, private secret: string, private sessionVersion: string) {}
  private config() { return this.db.prepare("SELECT * FROM calendar_config WHERE id = 'family'").first<Config>(); }
  private connection(config: Config) { return decryptPrivate<Connection>(config.encrypted_connection, this.secret, "icloud-connection"); }
  private async devices() { return (await this.db.prepare("SELECT id, encrypted_subscription, session_version FROM push_devices WHERE session_version = ? LIMIT 10").bind(this.sessionVersion).all<Device>()).results; }
  private async event(row: EventRow): Promise<Appointment> {
    const detail = await decryptPrivate<Pick<Appointment, "title" | "description" | "location" | "calendarId">>(row.encrypted_details, this.secret, "appointment-details");
    return { ...detail, id: row.id, startAt: row.start_at, endAt: row.end_at, allDay: !!row.all_day };
  }
  async status(owner: boolean) {
    const config = await this.config();
    const runner = await this.db.prepare("SELECT * FROM reminder_runner WHERE id='family'").first<Runner>();
    const devices = await this.devices();
    const base = { connected: !!config, calendars: [] as { id: string; name: string; selected: boolean }[], timeZone: config?.time_zone || "", reminderMinutes: config?.reminder_minutes || 30, lastSyncedAt: config?.last_synced_at || null, lastError: config?.last_error || null, appointments: [] as Appointment[], deviceIds: devices.map(item => item.id), lastRunAt: runner?.last_run_at || null, backgroundReady: !!runner?.schedule_id && !!runner.last_success_at && Date.now() - runner.last_success_at < 20 * 60000 };
    if (!config) return base;
    const connection = await this.connection(config);
    const selected = JSON.parse(config.selected_ids) as string[];
    base.calendars = connection.calendars.filter(item => owner || selected.includes(item.id)).map(item => ({ id: item.id, name: item.name, selected: selected.includes(item.id) }));
    const rows = await this.db.prepare("SELECT * FROM appointments WHERE revision = ? AND end_at >= ? ORDER BY start_at LIMIT 500").bind(config.revision, Date.now()).all<EventRow>();
    base.appointments = await Promise.all(rows.results.map(row => this.event(row)));
    return base;
  }
  async connect(body: Record<string, unknown>) {
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password.trim().toLowerCase() : "";
    if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new HttpError(400, "Enter the Apple Account email address used for iCloud Calendar.");
    if (!/^[a-z]{4}(?:-[a-z]{4}){3}$/.test(password)) throw new HttpError(400, "Use an Apple app-specific password (four groups of four letters), not the main Apple Account password.");
    const timeZone = zone(body.timeZone);
    const credentials = { username, password };
    const calendars = await discoverCalendars(credentials);
    if (!calendars.length) throw new HttpError(400, "No iCloud calendars were found. Check that Calendar is enabled in iCloud.");
    const encrypted = await encryptPrivate({ credentials, calendars }, this.secret, "icloud-connection");
    await this.db.batch([
      this.db.prepare("INSERT INTO calendar_config (id,encrypted_connection,selected_ids,revision,time_zone,reminder_minutes) VALUES ('family',?,'[]',?,?,30) ON CONFLICT(id) DO UPDATE SET encrypted_connection=excluded.encrypted_connection,selected_ids='[]',revision=excluded.revision,time_zone=excluded.time_zone,last_synced_at=NULL,last_error=NULL,sync_token=NULL,sync_until=NULL").bind(encrypted, crypto.randomUUID(), timeZone),
      this.db.prepare("DELETE FROM appointments"), this.db.prepare("DELETE FROM reminder_deliveries"),
    ]);
    return { ok: true };
  }
  private async snapshotStatements(config: Config, events: Appointment[], now: number, syncToken?: string): Promise<D1PreparedStatement[]> {
    const rows = await Promise.all(events.map(async event => [event.id, config.revision, event.startAt, event.endAt, event.allDay ? 1 : 0, await encryptPrivate({ title: event.title, description: event.description, location: event.location, calendarId: event.calendarId }, this.secret, "appointment-details"), now]));
    const condition = "id='family' AND revision=?" + (syncToken ? " AND sync_token=?" : "");
    const guards = syncToken ? [config.revision, syncToken] : [config.revision];
    const statements = [this.db.prepare(`DELETE FROM appointments WHERE EXISTS (SELECT 1 FROM calendar_config WHERE ${condition})`).bind(...guards)];
    for (let index = 0; index < rows.length; index += 10) {
      const chunk = rows.slice(index, index + 10);
      statements.push(this.db.prepare(`WITH incoming(id,revision,start_at,end_at,all_day,encrypted_details,synced_at) AS (VALUES ${chunk.map(() => "(?,?,?,?,?,?,?)").join(",")}) INSERT OR REPLACE INTO appointments SELECT * FROM incoming WHERE EXISTS(SELECT 1 FROM calendar_config WHERE ${condition})`).bind(...chunk.flat(), ...guards));
    }
    statements.push(this.db.prepare(`UPDATE calendar_config SET last_synced_at=?,last_error=NULL,sync_token=NULL,sync_until=NULL WHERE ${condition}`).bind(now, ...guards));
    return statements;
  }
  private async fetch(config: Config) {
    const connection = await this.connection(config);
    const selected = JSON.parse(config.selected_ids) as string[];
    const sources = connection.calendars.filter(item => selected.includes(item.id));
    if (!sources.length) return [];
    const now = Date.now();
    return fetchAppointments(connection.credentials, sources, { start: new Date(now - 86400000), end: new Date(now + 30 * 86400000), timeZone: config.time_zone });
  }
  async save(body: Record<string, unknown>) {
    const config = await this.config();
    if (!config) throw new HttpError(400, "Connect iCloud Calendar first.");
    const connection = await this.connection(config);
    if (!Array.isArray(body.calendarIds) || !body.calendarIds.length || body.calendarIds.length > 5 || new Set(body.calendarIds).size !== body.calendarIds.length || body.calendarIds.some(id => typeof id !== "string" || !connection.calendars.some(source => source.id === id))) throw new HttpError(400, "Choose between one and five calendars from the list.");
    if (![15,30,60,1440].includes(body.reminderMinutes as number)) throw new HttpError(400, "Choose when to receive reminders.");
    const next: Config = { ...config, selected_ids: JSON.stringify(body.calendarIds), time_zone: zone(body.timeZone), reminder_minutes: body.reminderMinutes as number, revision: crypto.randomUUID() };
    // Validate the entire new selection before replacing a working connection.
    const events = await this.fetch(next);
    const statements = await this.snapshotStatements(next, events, Date.now());
    await this.db.batch([
      this.db.prepare("UPDATE calendar_config SET selected_ids=?,time_zone=?,reminder_minutes=?,revision=? WHERE id='family' AND revision=?").bind(next.selected_ids,next.time_zone,next.reminder_minutes,next.revision,config.revision),
      ...statements,
    ]);
    return { ok: true };
  }
  async disconnect() {
    await this.db.batch([this.db.prepare("DELETE FROM calendar_config"),this.db.prepare("DELETE FROM appointments"),this.db.prepare("DELETE FROM reminder_deliveries")]);
    return { ok: true };
  }
  async sync(force = false): Promise<{ ok: boolean; reason?: string }> {
    const config = await this.config();
    if (!config || JSON.parse(config.selected_ids).length === 0) return { ok: true, reason: "not_configured" };
    if (!force && config.last_synced_at && Date.now() - config.last_synced_at < 10 * 60000 && !config.last_error) return { ok: true, reason: "recent" };
    const now = Date.now(); const token = crypto.randomUUID();
    const lock = await this.db.prepare("UPDATE calendar_config SET sync_token=?,sync_until=? WHERE id='family' AND revision=? AND (sync_until IS NULL OR sync_until <= ?) RETURNING revision").bind(token,now+120000,config.revision,now).first();
    if (!lock) return { ok: false, reason: "sync_in_progress" };
    try {
      const events = await this.fetch(config);
      await this.db.batch(await this.snapshotStatements(config,events,Date.now(),token));
      return { ok: true };
    } catch {
      await this.db.prepare("UPDATE calendar_config SET last_error=?,sync_token=NULL,sync_until=NULL WHERE id='family' AND revision=? AND sync_token=?").bind(SYNC_ERROR,config.revision,token).run();
      return { ok: false, reason: "calendar_unavailable" };
    }
  }
  async appointment(id: unknown) {
    const config = await this.config();
    const row = config && await this.db.prepare("SELECT * FROM appointments WHERE id=? AND revision=? AND end_at >= ?").bind(opaqueId(id),config.revision,Date.now()).first<EventRow>();
    if (!row) throw new HttpError(404, "This appointment has changed or is no longer upcoming. Refresh the calendar.");
    return { ...await this.event(row), timeZone: config!.time_zone };
  }
  private async vapid(): Promise<VapidKeys> {
    let row = await this.db.prepare("SELECT encrypted_keys FROM push_keys WHERE id='family'").first<{ encrypted_keys: string }>();
    if (!row) {
      const keys = await generateVapidKeys();
      await this.db.prepare("INSERT OR IGNORE INTO push_keys(id,encrypted_keys) VALUES ('family',?)").bind(await encryptPrivate(keys,this.secret,"push-vapid")).run();
      row = await this.db.prepare("SELECT encrypted_keys FROM push_keys WHERE id='family'").first<{ encrypted_keys: string }>();
    }
    if (!row) throw new HttpError(503,"Notifications are not ready yet. Please try again.");
    return decryptPrivate<VapidKeys>(row.encrypted_keys,this.secret,"push-vapid");
  }
  async pushKey() { return { publicKey: (await this.vapid()).publicKey }; }
  async subscribe(value: unknown) {
    const subscription = validateSubscription(value);
    const endpointHash = await hash(subscription.endpoint);
    await this.db.prepare("DELETE FROM push_devices WHERE session_version != (SELECT session_version FROM settings WHERE id='family')").run();
    const existing = await this.db.prepare("SELECT id FROM push_devices WHERE endpoint_hash=?").bind(endpointHash).first<{id:string}>();
    const count = await this.db.prepare("SELECT COUNT(*) AS total FROM push_devices").first<{total:number}>();
    if (!existing && (count?.total || 0) >= 10) throw new HttpError(400,"Ten phones already have reminders enabled. Disable one before adding another.");
    const id = existing?.id || crypto.randomUUID();
    const stored = await this.db.prepare("INSERT INTO push_devices(id,endpoint_hash,encrypted_subscription,session_version,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM settings WHERE id='family' AND session_version=?) AND ((SELECT COUNT(*) FROM push_devices) < 10 OR EXISTS (SELECT 1 FROM push_devices WHERE endpoint_hash=?)) ON CONFLICT(endpoint_hash) DO UPDATE SET encrypted_subscription=excluded.encrypted_subscription,session_version=excluded.session_version RETURNING id").bind(id,endpointHash,await encryptPrivate(subscription,this.secret,"push-subscription"),this.sessionVersion,Date.now(),this.sessionVersion,endpointHash).first<{id:string}>();
    if (!stored) {
      const current = await this.db.prepare("SELECT session_version FROM settings WHERE id='family'").first<{session_version:string}>();
      if (current?.session_version !== this.sessionVersion) throw new HttpError(401,"Please enter the current family code before enabling reminders.");
      throw new HttpError(400,"Ten phones already have reminders enabled. Disable one before adding another.");
    }
    return { deviceId: stored.id };
  }
  async unsubscribe(id: unknown) {
    await this.db.prepare("DELETE FROM push_devices WHERE id=? AND session_version=?").bind(opaqueId(id),this.sessionVersion).run();
    return { ok: true };
  }
  private async expireDevice(device: Device) {
    // A delayed 410 describes the subscription sent, not a newer registration
    // which may now occupy the same device row.
    await this.db.prepare("DELETE FROM push_devices WHERE id=? AND encrypted_subscription=? AND session_version=?").bind(device.id,device.encrypted_subscription,device.session_version).run();
  }
  async testPush(id: unknown) {
    const row = await this.db.prepare("SELECT * FROM push_devices WHERE id=? AND session_version=?").bind(opaqueId(id),this.sessionVersion).first<Device>();
    if (!row) throw new HttpError(404,"Enable reminders on this phone first.");
    const result = await sendPush(await decryptPrivate<PushSubscriptionData>(row.encrypted_subscription,this.secret,"push-subscription"),await this.vapid(),{title:"ਸਾਥੀ · ਯਾਦ ਦਿਵਾਉਣਾ",body:"ਇਹ ਇੱਕ ਟੈਸਟ ਹੈ ਜੀ। ਤੁਹਾਡੇ ਫੋਨ ਉੱਤੇ ਯਾਦ ਦਿਵਾਉਣ ਵਾਲਾ ਸੁਨੇਹਾ ਆ ਗਿਆ ਹੈ।",url:"/?screen=appointments",tag:"saathi-test"});
    if (result === "expired") await this.expireDevice(row);
    if (result !== "sent") throw new HttpError(502,"The test could not be sent. Enable reminders on this phone again and retry.");
    return { ok: true };
  }
  async runnerStatus() {
    const config = await this.config();
    const runner = await this.db.prepare("SELECT * FROM reminder_runner WHERE id='family'").first<Runner>();
    return { connected: !!config, selectedCalendarCount: config ? JSON.parse(config.selected_ids).length : 0, deviceCount: (await this.devices()).length, lastSyncedAt: config?.last_synced_at || null, lastRunAt: runner?.last_run_at || null, lastOutcome: runner?.last_outcome || null, scheduleLinked: !!runner?.schedule_id };
  }
  async confirmSchedule(id: unknown) {
    if (typeof id !== "string" || id.length < 8 || id.length > 200 || /[\s\x00-\x1f]/.test(id)) throw new HttpError(400,"A saved schedule ID is required.");
    await this.db.prepare("INSERT INTO reminder_runner(id,schedule_id) VALUES ('family',?) ON CONFLICT(id) DO UPDATE SET schedule_id=excluded.schedule_id").bind(id).run();
    return this.runnerStatus();
  }
  async runReminders() {
    const now = Date.now(); const token = crypto.randomUUID();
    const lock = await this.db.prepare("INSERT INTO reminder_runner(id,token,lease_until) VALUES ('family',?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until WHERE reminder_runner.lease_until <= ? RETURNING token").bind(token,now+240000,now).first<{token:string}>();
    if (!lock) return { outcome: "already_running", sent: 0, failed: 0 };
    let outcome = "ok"; let sent = 0; let failed = 0;
    try {
      const sync = await this.sync();
      const config = await this.config();
      if (!config || JSON.parse(config.selected_ids).length === 0) outcome = "waiting_for_calendar";
      else if (!sync.ok || config.last_error || !config.last_synced_at || Date.now()-config.last_synced_at>15*60000) outcome = "calendar_unavailable";
      else {
        const devices = await this.devices();
        const due = await this.db.prepare("SELECT * FROM appointments WHERE revision=? AND all_day=0 AND start_at>? AND start_at<=? ORDER BY start_at LIMIT 500").bind(config.revision,Date.now(),Date.now()+config.reminder_minutes*60000).all<EventRow>();
        const deliveries = await this.db.prepare("SELECT id,state,lease_until,attempts FROM reminder_deliveries WHERE due_at>=?").bind(Date.now()-2*86400000).all<{id:string;state:string;lease_until:number;attempts:number}>();
        const previous = new Map(deliveries.results.map(delivery => [delivery.id, delivery]));
        const keys = devices.length && due.results.length ? await this.vapid() : null;
        let attempted = 0;
        for (const event of due.results) for (const device of devices) {
          // Leave ample time before the runner lease expires, even if each
          // provider request uses its full timeout. A later run resumes claims.
          if (attempted >= 20 || Date.now()-now > 150000) break;
          const dueAt = event.start_at-config.reminder_minutes*60000;
          const id = await hash(`${event.id}:${event.start_at}:${config.reminder_minutes}:${device.id}`);
          const delivery = previous.get(id);
          if (delivery && (delivery.state === "sent" || delivery.lease_until > Date.now() || delivery.attempts >= 3)) continue;
          const claim = await this.db.prepare("INSERT INTO reminder_deliveries(id,event_id,device_id,due_at,state,lease_until,attempts) VALUES (?,?,?,?,'sending',?,1) ON CONFLICT(id) DO UPDATE SET state='sending',lease_until=excluded.lease_until,attempts=reminder_deliveries.attempts+1 WHERE reminder_deliveries.state != 'sent' AND reminder_deliveries.lease_until <= ? AND reminder_deliveries.attempts < 3 RETURNING id").bind(id,event.id,device.id,dueAt,Date.now()+120000,Date.now()).first();
          if (!claim) continue;
          attempted++;
          // Recheck authorization and the occurrence immediately before sending.
          const current = await this.db.prepare("SELECT d.id,d.encrypted_subscription,d.session_version FROM appointments a JOIN calendar_config c ON c.revision=a.revision JOIN push_devices d ON d.id=? JOIN settings s ON s.id='family' AND s.session_version=d.session_version WHERE a.id=? AND a.revision=? AND a.start_at=? AND a.start_at>? AND c.last_error IS NULL AND c.last_synced_at>=?").bind(device.id,event.id,config.revision,event.start_at,Date.now(),Date.now()-15*60000).first<Device>();
          if (!current) { await this.db.prepare("DELETE FROM reminder_deliveries WHERE id=?").bind(id).run(); continue; }
          try {
            const result = await sendPush(await decryptPrivate<PushSubscriptionData>(current.encrypted_subscription,this.secret,"push-subscription"),keys!,{title:"ਸਾਥੀ · ਮੁਲਾਕਾਤ ਦੀ ਯਾਦ",body:REMINDER_BODY,url:"/?screen=appointments",tag:`saathi-${id.slice(0,32)}`});
            if (result === "expired") await this.expireDevice(current);
            if (result === "sent") { sent++; await this.db.prepare("UPDATE reminder_deliveries SET state='sent',sent_at=?,lease_until=0 WHERE id=?").bind(Date.now(),id).run(); }
            else { failed++; await this.db.prepare("UPDATE reminder_deliveries SET state='retry',lease_until=? WHERE id=?").bind(Date.now()+5*60000,id).run(); }
          } catch { failed++; await this.db.prepare("UPDATE reminder_deliveries SET state='retry',lease_until=? WHERE id=?").bind(Date.now()+5*60000,id).run(); }
        }
        if (failed) outcome = "push_retry";
      }
      await this.db.prepare("DELETE FROM reminder_deliveries WHERE due_at < ?").bind(Date.now()-7*86400000).run();
      await this.db.prepare("DELETE FROM push_devices WHERE session_version != (SELECT session_version FROM settings WHERE id='family')").run();
      return { outcome, sent, failed };
    } catch { outcome="runner_error"; throw new HttpError(503,"The reminder check could not finish. Please retry later."); }
    finally {
      await this.db.prepare("UPDATE reminder_runner SET last_run_at=?,last_success_at=CASE WHEN ? IN ('ok','waiting_for_calendar') THEN ? ELSE last_success_at END,last_outcome=?,token=NULL,lease_until=0 WHERE id='family' AND token=?").bind(Date.now(),outcome,Date.now(),outcome,token).run();
    }
  }
}
