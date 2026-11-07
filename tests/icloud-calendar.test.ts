import assert from "node:assert/strict";
import { test } from "node:test";

const { discoverCalendars, fetchAppointments } = await import(new URL("../lib/icloud-calendar.ts", import.meta.url).href) as typeof import("../lib/icloud-calendar");
const credentials = { username: "family@example.test", password: "aaaa-bbbb-cccc-dddd" };
const origin = "https://p01-caldav.icloud.com";
const calendarUrl = `${origin}/123/calendars/family/`;
const window = { start: new Date("2026-10-31T00:00:00Z"), end: new Date("2026-11-10T00:00:00Z"), timeZone: "America/Los_Angeles" };
const xml = (response: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${response}</d:multistatus>`;
const prop = (href: string, fields: string, status = 200) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${fields}</d:prop><d:status>HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}</d:status></d:propstat></d:response>`;
const response = (body: string) => new Response(body, { status: 207, headers: { "content-type": "application/xml" } });
const event = (fields: string) => `BEGIN:VEVENT\r\n${fields.trim().replace(/\n/g, "\r\n")}\r\nEND:VEVENT`;
const ics = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Saathi tests//EN\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const normalEvent = event("UID:one\nDTSTART:20261106T160000Z\nDTEND:20261106T163000Z\nSUMMARY:Appointment\nLOCATION:Clinic");

test("private iCloud calendar transport and parsing (mocked; no external calls)", async suite => {
  const originalFetch = globalThis.fetch;
  suite.after(() => { globalThis.fetch = originalFetch; });
  let calls: Array<{ url: string; method: string; body: string }> = [];
  let calendarData = ics(normalEvent);
  let override: ((url: string, init: RequestInit) => Response | undefined) | undefined;

  function mockDav() {
    calls = [];
    override = undefined;
    calendarData = ics(normalEvent);
    globalThis.fetch = async (input, init) => {
      assert.ok(init);
      const url = String(input), method = String(init.method), body = String(init.body || "");
      calls.push({ url, method, body });
      assert.match(url, /^https:\/\/(?:caldav|p01-caldav)\.icloud\.com\//);
      assert.ok(["PROPFIND", "REPORT", "GET"].includes(method));
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(new Headers(init.headers).get("authorization"), `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`);
      const custom = override?.(url, init);
      if (custom) return custom;
      if (url === "https://caldav.icloud.com/.well-known/caldav") return new Response(null, { status: 301, headers: { location: `${origin}/` } });
      if (body.includes("current-user-principal")) return response(xml(prop("/", "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>")));
      if (body.includes("calendar-home-set")) return response(xml(prop("/123/principal/", "<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>")));
      if (body.includes("supported-report-set")) return response(xml(prop(calendarUrl, "<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>")));
      if (method === "REPORT") {
        assert.equal(url, calendarUrl);
        assert.match(body, /expand/);
        assert.doesNotMatch(body, /calendar-multiget/);
        assert.match(body, /20261030T000000Z/, "query pads timezone boundaries before exact local filtering");
        return response(xml(prop(`${calendarUrl}one.ics`, `<d:getetag>rev1</d:getetag><c:calendar-data><![CDATA[${calendarData}]]></c:calendar-data>`)));
      }
      if (url === `${origin}/123/calendars/`) return response(xml(prop(calendarUrl, "<d:displayname>Family</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name=\"VEVENT\"/></c:supported-calendar-component-set>")));
      throw new Error("Unexpected mocked DAV operation");
    };
  }
  async function source() { return (await discoverCalendars(credentials))[0]; }

  await suite.test("uses the installed tsdav discovery and bounded expanded REPORT APIs", async () => {
    mockDav();
    const sources = await discoverCalendars(credentials);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].name, "Family");
    assert.equal(sources[0].url, calendarUrl);
    assert.match(sources[0].id, /^[a-f0-9]{64}$/);
    const beforeFetch = calls.length;
    const appointments = await fetchAppointments(credentials, sources, window);
    assert.equal(calls.length, beforeFetch + 1, "scheduled reads do not discover or read unrelated calendars");
    assert.equal(appointments.length, 1);
    assert.equal(appointments[0].startAt, Date.parse("2026-11-06T16:00:00Z"));
    assert.equal(appointments[0].endAt, Date.parse("2026-11-06T16:30:00Z"));
    assert.equal(appointments[0].calendarId, sources[0].id);
    assert.equal(appointments[0].location, "Clinic");
    assert.equal(appointments[0].allDay, false);
    assert.deepEqual(await fetchAppointments(credentials, sources, window), appointments, "stable IDs across repeated updates");
  });

  await suite.test("rejects ordinary passwords before sending any credentials", async () => {
    mockDav();
    await assert.rejects(discoverCalendars({ ...credentials, password: "my-main-password" }), { name: "CalendarError", message: /app-specific password/ });
    await assert.rejects(discoverCalendars({ ...credentials, username: "evil:account" }), { name: "CalendarError" });
    assert.equal(calls.length, 0);
  });

  await suite.test("supports GET-only well-known discovery without broadening the host boundary", async () => {
    mockDav();
    override = (url, init) => url.endsWith("/.well-known/caldav") && init.method === "PROPFIND" ? new Response(null, { status: 405 }) : undefined;
    assert.equal((await discoverCalendars(credentials)).length, 1);
    assert.ok(calls.some(call => call.method === "GET" && call.url.endsWith("/.well-known/caldav")));
  });

  await suite.test("rejects malicious redirects before credentials leave Apple hosts", async () => {
    for (const location of ["https://evil.test/private", "https://caldav.icloud.com.evil.test/", "https://caldav.icloud.com:8443/", "http://caldav.icloud.com/", "https://user@caldav.icloud.com/", "https://www.icloud.com/"]) {
      mockDav();
      override = () => new Response(null, { status: 302, headers: { location } });
      await assert.rejects(discoverCalendars(credentials), { name: "CalendarError" });
      assert.equal(calls.length, 1, "unsafe redirect stops even when tsdav attempts discovery fallbacks");
    }
  });

  await suite.test("validates discovered principal and calendar hrefs before fetching", async () => {
    mockDav();
    override = (_url, init) => String(init.body).includes("current-user-principal") ? response(xml(prop("/", "<d:current-user-principal><d:href>https://evil.test/principal/</d:href></d:current-user-principal>"))) : undefined;
    await assert.rejects(discoverCalendars(credentials), { name: "CalendarError" });
    assert.equal(calls.some(call => call.url.includes("evil.test")), false);
    mockDav();
    override = url => url === `${origin}/123/calendars/` ? response(xml(prop("https://evil.test/calendar/", "<d:resourcetype><c:calendar/></d:resourcetype>"))) : undefined;
    await assert.rejects(discoverCalendars(credentials), { name: "CalendarError" });
    assert.equal(calls.some(call => call.url.includes("evil.test")), false);
  });

  await suite.test("handles expanded recurrence instances and skips cancelled events", async () => {
    mockDav(); const selected = await source();
    calendarData = ics(
      event("UID:repeated\nRECURRENCE-ID:20261102T160000Z\nDTSTART:20261102T180000Z\nDTEND:20261102T183000Z\nSUMMARY:Moved appointment"),
      event("UID:repeated\nRECURRENCE-ID:20261103T160000Z\nDTSTART:20261103T160000Z\nSUMMARY:Next appointment\nTRANSP:TRANSPARENT"),
      event("UID:cancelled\nDTSTART:20261104T160000Z\nSTATUS:CANCELLED"),
      event("UID:outside\nDTSTART:20261204T160000Z")
    );
    const items = await fetchAppointments(credentials, [selected], window);
    assert.equal(items.length, 2);
    assert.notEqual(items[0].id, items[1].id);
    assert.equal(items[0].title, "Moved appointment");
    assert.equal(items[1].title, "Next appointment", "transparent events remain visible");
    const originalId = items[0].id;
    calendarData = calendarData.replace("DTSTART:20261102T180000Z", "DTSTART:20261102T181500Z");
    assert.equal((await fetchAppointments(credentials, [selected], window))[0].id, originalId, "moving an occurrence preserves identity");
  });

  await suite.test("converts floating times and all-day DST boundaries in the configured timezone", async () => {
    mockDav(); const selected = await source();
    calendarData = ics(event("UID:floating\nDTSTART:20261101T013000\nDTEND:20261101T023000"), event("UID:all-day\nDTSTART;VALUE=DATE:20261101\nSUMMARY:Birthday"));
    const items = await fetchAppointments(credentials, [selected], window);
    assert.equal(items[0].allDay, true);
    assert.equal(items[0].startAt, Date.parse("2026-11-01T07:00:00Z"));
    assert.equal(items[0].endAt - items[0].startAt, 25 * 3_600_000);
    assert.equal(items[1].startAt, Date.parse("2026-11-01T08:30:00Z"), "first occurrence of ambiguous fall-back wall time");
    assert.equal(items[1].endAt, Date.parse("2026-11-01T10:30:00Z"));
    calendarData = ics(event("UID:elapsed\nDTSTART:20261101T013000\nDURATION:PT2H"));
    const elapsed = (await fetchAppointments(credentials, [selected], window))[0];
    assert.equal(elapsed.endAt - elapsed.startAt, 2 * 3_600_000, "hour durations measure elapsed time across DST");
  });

  await suite.test("honors embedded VTIMEZONE and rejects unknown timezone identifiers", async () => {
    mockDav(); const selected = await source();
    calendarData = ics("BEGIN:VTIMEZONE\r\nTZID:Custom/India\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE", event("UID:custom\nDTSTART;TZID=Custom/India:20261106T090000\nDTEND;TZID=Custom/India:20261106T100000"));
    assert.equal((await fetchAppointments(credentials, [selected], window))[0].startAt, Date.parse("2026-11-06T03:30:00Z"));
    calendarData = calendarData.replace("TZOFFSETFROM:+0530", "RRULE:FREQ=SECONDLY\r\nTZOFFSETFROM:+0530");
    await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError" }, "timezone recurrence cannot create an unbounded CPU loop");
    calendarData = ics(event("UID:unknown\nDTSTART;TZID=Not/ARealTimezone:20261106T090000"));
    await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError", message: /time zone/ });
  });

  await suite.test("fails the whole snapshot for unexpanded recurrence, malformed events, and duplicates", async () => {
    mockDav(); const selected = await source();
    for (const data of [ics(event("UID:rule\nDTSTART:20261106T090000Z\nRRULE:FREQ=DAILY")), ics(event("UID:no-start")), ics(normalEvent, normalEvent), "not an iCalendar document"]) {
      calendarData = data;
      await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError" });
    }
  });

  await suite.test("bounds response bytes, XML complexity, selected calendars, and appointment count", async () => {
    mockDav(); const selected = await source();
    for (const body of ["<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///private'>]><x/>", "<x>".repeat(40) + "</x>".repeat(40), " ".repeat(2_000_001)]) {
      override = (_url, init) => init.method === "REPORT" ? response(body) : undefined;
      await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError" });
    }
    override = undefined;
    const before = calls.length;
    await assert.rejects(fetchAppointments(credentials, Array(6).fill(selected), window), { name: "CalendarError", message: /five calendars/ });
    assert.equal(calls.length, before);
    calendarData = ics(...Array.from({ length: 501 }, (_, i) => event(`UID:item-${i}\nDTSTART:20261106T090000Z`)));
    await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError", message: /500 appointments/ });
  });

  await suite.test("sanitizes provider failures and prevents partial successful results", async () => {
    mockDav(); const selected = await source();
    override = (_url, init) => init.method === "REPORT" ? new Response("PRIVATE_PASSWORD PRIVATE_CALENDAR", { status: 403 }) : undefined;
    await assert.rejects(fetchAppointments(credentials, [selected], window), (error: Error) => error.name === "CalendarError" && !/PRIVATE|aaaa|example/.test(error.message));
    override = (_url, init) => init.method === "REPORT" ? response(xml(prop(`${calendarUrl}one.ics`, "", 403))) : undefined;
    await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError" });
    override = (_url, init) => init.method === "REPORT" ? response(xml(prop(calendarUrl, "", 500))) : undefined;
    await assert.rejects(fetchAppointments(credentials, [selected], window), { name: "CalendarError" });
    override = (_url, init) => init.method === "REPORT" ? response(xml("")) : undefined;
    assert.deepEqual(await fetchAppointments(credentials, [selected], window), [], "a valid empty report can clear an old snapshot");
    globalThis.fetch = async () => { throw new Error("PRIVATE_NETWORK_DIAGNOSTIC"); };
    await assert.rejects(fetchAppointments(credentials, [selected], window), (error: Error) => error.name === "CalendarError" && !error.message.includes("PRIVATE"));
  });
});
