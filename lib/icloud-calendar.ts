import { createDAVClient } from "tsdav";
import ICAL from "ical.js";

export interface ICloudCredentials { username: string; password: string }
export interface CalendarSource { id: string; url: string; name: string }
export interface Appointment {
  id: string; calendarId: string; title: string; description: string; location: string;
  startAt: number; endAt: number; allDay: boolean;
}

export class CalendarError extends Error {
  constructor(message: string) { super(message); this.name = "CalendarError"; }
}
const encoder = new TextEncoder();
const ROOT = "https://caldav.icloud.com";
const DAY = 86_400_000;
const INVALID_DATA = "iCloud returned calendar information Saathi could not safely read. Your previous appointments have been kept.";

function safeUrl(value: string, base?: string): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new CalendarError(INVALID_DATA); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !/^(?:caldav|p\d{1,3}-caldav)\.icloud\.com$/.test(url.hostname) || url.href.length > 2048) {
    throw new CalendarError("iCloud returned an unsupported calendar address. Please reconnect your calendar.");
  }
  return url;
}
function checkedCredentials(input: ICloudCredentials): ICloudCredentials {
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const password = typeof input?.password === "string" ? input.password.trim() : "";
  if (!username || username.length > 254 || /[\s:\x00-\x1f\x7f]/.test(username) ||
      !/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(password)) {
    throw new CalendarError("Enter your Apple Account email and an app-specific password from account.apple.com. Do not use your main Apple password.");
  }
  return { username, password };
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
function inspectXml(text: string, method: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new CalendarError(INVALID_DATA);
  let depth = 0, count = 0;
  for (const match of text.matchAll(/<(?:!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|[^>]*?)>/g)) {
    const tag = match[0];
    if (++count > 20_000) throw new CalendarError(INVALID_DATA);
    if (tag.startsWith("<!") || tag.startsWith("<?")) continue;
    if (tag.startsWith("</")) depth--;
    else if (!tag.endsWith("/>")) depth++;
    if (depth > 32 || depth < 0) throw new CalendarError(INVALID_DATA);
  }
  if (depth !== 0) throw new CalendarError(INVALID_DATA);
  if (method === "REPORT") {
    const markup = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
    if (!/<(?:[\w.-]+:)?multistatus(?:\s|>)/.test(markup)) throw new CalendarError(INVALID_DATA);
    const statuses = [...markup.matchAll(/<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/\d(?:\.\d)?\s+(\d{3})\b/g)];
    if (statuses.some(match => !match[1].startsWith("2"))) throw new CalendarError(INVALID_DATA);
    // A failed collection response must not become a successful empty snapshot
    // when the library filters object hrefs. A truly empty multistatus is valid.
    const responses = [...markup.matchAll(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response\s*>/g)];
    for (const match of responses) if (!/<(?:[\w.-]+:)?calendar-data\b/.test(match[0])) throw new CalendarError(INVALID_DATA);
  }
}

// The library never receives an unbounded response or a transport that can write.
// A sticky failure prevents its discovery fallback from hiding unsafe responses.
function transport(credentials: ICloudCredentials) {
  let requests = 0, totalBytes = 0;
  let failure: CalendarError | undefined;
  const deadline = Date.now() + 45_000;
  const bytes = encoder.encode(`${credentials.username}:${credentials.password}`);
  const authorization = `Basic ${btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""))}`;
  const guardedFetch: typeof fetch = async (input, init = {}) => {
    if (failure) throw failure;
    try {
      let url = safeUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!["PROPFIND", "REPORT", "GET"].includes(method)) throw new CalendarError("Saathi only reads calendars.");
      const headers = new Headers(init.headers);
      headers.set("Authorization", authorization);
      for (let redirects = 0; ; redirects++) {
        const remaining = deadline - Date.now();
        if (++requests > 35 || remaining <= 0) throw new CalendarError("iCloud is taking too long to respond. Please try again shortly.");
        const response = await fetch(url.href, { ...init, method, headers, credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(Math.min(12_000, remaining)) });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects >= 3) throw new CalendarError(INVALID_DATA);
          const target = safeUrl(location, url.href);
          if (init.redirect === "manual") return new Response(null, { status: response.status, headers: { location: target.href } });
          url = target;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new CalendarError("iCloud did not accept that connection. Check your Apple Account email and app-specific password.");
        }
        // Missing or GET-only well-known URLs use normal discovery fallback.
        if ([404, 405].includes(response.status) && url.pathname === "/.well-known/caldav") {
          await response.body?.cancel();
          return new Response(null, { status: response.status });
        }
        if (!response.ok) { await response.body?.cancel(); throw new CalendarError("iCloud could not update your calendars. Please try again shortly."); }
        if (Number(response.headers.get("content-length")) > 2_000_000) {
          await response.body?.cancel(); throw new CalendarError("This calendar has too much information for one update. Please choose fewer calendars.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new CalendarError(INVALID_DATA);
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength; totalBytes += value.byteLength;
          if (size > 2_000_000 || totalBytes > 6_000_000) { await reader.cancel(); throw new CalendarError("This calendar has too much information for one update. Please choose fewer calendars."); }
          chunks.push(value);
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        inspectXml(text, method);
        if (!response.headers.get("content-type")?.toLowerCase().includes("xml")) throw new CalendarError(INVALID_DATA);
        const bounded = new Response(text, { status: response.status, headers: { "content-type": "application/xml; charset=utf-8" } });
        Object.defineProperty(bounded, "url", { value: url.href });
        return bounded;
      }
    } catch (error) {
      failure = error instanceof CalendarError ? error : new CalendarError("iCloud could not finish the update. Please try again shortly.");
      throw failure;
    }
  };
  return guardedFetch;
}

export async function discoverCalendars(input: ICloudCredentials): Promise<CalendarSource[]> {
  try {
    const credentials = checkedCredentials(input);
    const client = await createDAVClient({ serverUrl: ROOT, credentials, authMethod: "Basic", defaultAccountType: "caldav", fetch: transport(credentials) });
    const calendars = await client.fetchCalendars();
    if (calendars.length > 25) throw new CalendarError("This Apple Account has too many calendars for Saathi. Please use an account with fewer calendars.");
    const sources: CalendarSource[] = [];
    for (const calendar of calendars) {
      if (calendar.components?.length && !calendar.components.includes("VEVENT")) continue;
      const url = safeUrl(calendar.url).href;
      const name = typeof calendar.displayName === "string" ? calendar.displayName.trim().slice(0, 200) : "iCloud calendar";
      sources.push({ id: await digest(url), url, name: name || "iCloud calendar" });
    }
    return sources;
  } catch (error) { throw error instanceof CalendarError ? error : new CalendarError(INVALID_DATA); }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { throw new CalendarError("Choose a valid time zone before updating appointments."); }
}
function asWallTime(timestamp: number, format: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}
function floatingTimestamp(time: InstanceType<typeof ICAL.Time>, timeZone: string): number {
  const format = formatter(timeZone);
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const candidates = new Set<number>();
  // Sample both sides of timezone transitions. For a repeated wall time, RFC 5545
  // uses the first occurrence. A nonexistent local time fails rather than shifts.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3_600_000;
    const candidate = wall - (asWallTime(sample, format) - sample);
    if (asWallTime(candidate, format) === wall) candidates.add(candidate);
  }
  if (!candidates.size) throw new CalendarError("An appointment has an invalid local time near a clock change. Please check it in Apple Calendar.");
  return Math.min(...candidates);
}
function timestamp(time: InstanceType<typeof ICAL.Time>, property: InstanceType<typeof ICAL.Property>, component: InstanceType<typeof ICAL.Component>, timeZone: string): number {
  const tzid = property.getParameter("tzid");
  if (time.isDate) return floatingTimestamp(time, timeZone);
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toUnixTime() * 1000;
  if (tzid) {
    if (typeof tzid !== "string" || tzid.length > 200) throw new CalendarError(INVALID_DATA);
    const zone = component.getTimeZoneByID(tzid);
    if (zone) return ICAL.Time.fromData({ year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second, isDate: false }, zone).toUnixTime() * 1000;
    return floatingTimestamp(time, tzid);
  }
  return floatingTimestamp(time, timeZone);
}
function textField(event: InstanceType<typeof ICAL.Component>, key: string, maximum: number): string {
  const value = event.getFirstPropertyValue(key);
  if (value === null) return "";
  if (typeof value !== "string" || value.length > maximum) throw new CalendarError(INVALID_DATA);
  return value.replace(/\x00/g, "").trim();
}
function validateTimezones(root: InstanceType<typeof ICAL.Component>): void {
  const zones = root.getAllSubcomponents("vtimezone");
  if (zones.length > 10) throw new CalendarError(INVALID_DATA);
  for (const zone of zones) {
    const transitions = zone.getAllSubcomponents();
    if (transitions.length > 100) throw new CalendarError(INVALID_DATA);
    for (const transition of transitions) {
      const start = transition.getFirstPropertyValue("dtstart");
      if (!(start instanceof ICAL.Time) || start.year < 1800 || start.year > 2200) throw new CalendarError(INVALID_DATA);
      if (transition.getAllProperties("rdate").reduce((total, property) => total + property.getValues().length, 0) > 500) throw new CalendarError(INVALID_DATA);
      const rules = transition.getAllProperties("rrule");
      if (rules.length > 1) throw new CalendarError(INVALID_DATA);
      for (const property of rules) {
        const rule = property.getFirstValue();
        // Real timezone transitions are annual. Reject high-frequency expansion
        // and BYSECOND/BYMINUTE/BYHOUR products before the library can iterate.
        if (!(rule instanceof ICAL.Recur) || rule.freq !== "YEARLY" || Object.keys(rule.parts).some(key => !["BYMONTH", "BYDAY", "BYMONTHDAY", "BYSETPOS"].includes(key)) || Object.values(rule.parts).some(values => !Array.isArray(values) || values.length > 31)) throw new CalendarError(INVALID_DATA);
      }
    }
  }
}

export async function fetchAppointments(input: ICloudCredentials, selectedSources: CalendarSource[], window: { start: Date; end: Date; timeZone: string }): Promise<Appointment[]> {
  try {
    const credentials = checkedCredentials(input);
    if (!Array.isArray(selectedSources) || selectedSources.length > 5) throw new CalendarError("Choose up to five calendars for Saathi.");
    const start = window.start.getTime(), end = window.end.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * DAY) throw new CalendarError("Choose an appointment window of up to 31 days.");
    formatter(window.timeZone);
    if (!selectedSources.length) return [];
    const sources = await Promise.all(selectedSources.map(async source => {
      const url = safeUrl(source.url).href;
      if (source.id !== await digest(url)) throw new CalendarError(INVALID_DATA);
      return { ...source, url };
    }));
    if (new Set(sources.map(source => source.id)).size !== sources.length) throw new CalendarError(INVALID_DATA);
    // Selected URLs are already server-discovered. No account discovery or other
    // calendar reads are needed during a scheduled update.
    const client = await createDAVClient({ serverUrl: ROOT, credentials, authMethod: "Basic", fetch: transport(credentials) });
    const appointments = new Map<string, Appointment>();
    let objectsRead = 0, eventsRead = 0;
    for (const source of sources) {
      // CalDAV may filter floating/date values using the server calendar zone.
      // Pad the query, then apply the exact configured-zone window below.
      const objects = await client.fetchCalendarObjects({ calendar: { url: source.url }, timeRange: { start: new Date(start - DAY).toISOString(), end: new Date(end + DAY).toISOString() }, expand: true, useMultiGet: false,
        urlFilter: value => { const url = safeUrl(value, source.url), collection = new URL(source.url); const path = collection.pathname.endsWith("/") ? collection.pathname : collection.pathname + "/"; if (url.origin !== collection.origin || (url.href !== source.url && !url.pathname.startsWith(path))) throw new CalendarError(INVALID_DATA); return url.href !== source.url; },
      });
      objectsRead += objects.length;
      if (objectsRead > 500) throw new CalendarError("There are more than 500 appointments in this window. Please choose fewer calendars.");
      for (const object of objects) {
        safeUrl(object.url);
        if (typeof object.data !== "string" || object.data.length > 500_000 || !object.data.trim()) throw new CalendarError(INVALID_DATA);
        const root = new ICAL.Component(ICAL.parse(object.data));
        if (root.name !== "vcalendar") throw new CalendarError(INVALID_DATA);
        validateTimezones(root);
        for (const event of root.getAllSubcomponents("vevent")) {
          if (++eventsRead > 500) throw new CalendarError("There are more than 500 appointments in this window. Please choose fewer calendars.");
          if (String(event.getFirstPropertyValue("status")).toUpperCase() === "CANCELLED") continue;
          if (["rrule", "rdate", "exrule", "exdate"].some(key => event.hasProperty(key))) throw new CalendarError("iCloud did not expand a repeating appointment. Please try the calendar update again.");
          const uid = textField(event, "uid", 1024);
          const startProperty = event.getFirstProperty("dtstart");
          if (!uid || !startProperty) throw new CalendarError(INVALID_DATA);
          const startTime = startProperty.getFirstValue();
          if (!(startTime instanceof ICAL.Time) || startTime.year < 1900 || startTime.year > 2200) throw new CalendarError(INVALID_DATA);
          const startAt = timestamp(startTime, startProperty, root, window.timeZone);
          const endProperty = event.getFirstProperty("dtend");
          let endAt = startAt;
          if (endProperty) {
            const endTime = endProperty.getFirstValue();
            if (!(endTime instanceof ICAL.Time) || endTime.year < 1900 || endTime.year > 2200 || endTime.isDate !== startTime.isDate) throw new CalendarError(INVALID_DATA);
            endAt = timestamp(endTime, endProperty, root, window.timeZone);
          } else {
            const duration = event.getFirstPropertyValue("duration");
            if (duration || startTime.isDate) {
              if (duration && !(duration instanceof ICAL.Duration)) throw new CalendarError(INVALID_DATA);
              const span = duration instanceof ICAL.Duration ? duration : ICAL.Duration.fromSeconds(86400);
              if (span.isNegative || (startTime.isDate && (span.hours || span.minutes || span.seconds))) throw new CalendarError(INVALID_DATA);
              const endTime = startTime.clone();
              // RFC 5545: weeks/days are nominal local-calendar durations;
              // smaller units are exact elapsed time even across DST changes.
              endTime.addDuration(ICAL.Duration.fromData({ days: span.days + span.weeks * 7 }));
              if (endTime.year > 2200) throw new CalendarError(INVALID_DATA);
              endAt = timestamp(endTime, startProperty, root, window.timeZone) + (span.hours * 3600 + span.minutes * 60 + span.seconds) * 1000;
            }
          }
          if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) throw new CalendarError(INVALID_DATA);
          if (startAt >= end || (endAt === startAt ? startAt < start : endAt <= start)) continue;
          const recurrence = event.getFirstPropertyValue("recurrence-id");
          const identity = recurrence instanceof ICAL.Time ? recurrence.toString() : String(startAt);
          const id = await digest(JSON.stringify([source.url, uid, identity]));
          const appointment = { id, calendarId: source.id, title: textField(event, "summary", 1000) || "Appointment", description: textField(event, "description", 12_000), location: textField(event, "location", 2000), startAt, endAt, allDay: startTime.isDate };
          if (appointments.has(id)) throw new CalendarError(INVALID_DATA);
          appointments.set(id, appointment);
        }
      }
    }
    return [...appointments.values()].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  } catch (error) { throw error instanceof CalendarError ? error : new CalendarError(INVALID_DATA); }
}
