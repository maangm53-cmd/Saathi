"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, CalendarDays, Check, ChevronRight, Clock, ExternalLink, MapPin, RefreshCw, ShieldCheck, Volume2 } from "lucide-react";
import "./calendar.css";

type Appointment = { id: string; title: string; description?: string; location?: string; startAt: number; endAt: number; allDay: boolean };
type CalendarStatus = {
  connected: boolean;
  calendars: { id: string; name: string; selected: boolean }[];
  timeZone: string;
  reminderMinutes: 15 | 30 | 60 | 1440;
  lastSyncedAt: number | null;
  lastError: string | null;
  appointments: Appointment[];
  lastRunAt: number | null;
  backgroundReady: boolean;
  deviceIds?: string[];
};
type Explanation = { translation: string; explanation: string; speechText: string; nextSteps?: string[]; uncertainties?: string[] };
type PushSupport = { checked: boolean; supported: boolean; appleMobile: boolean; standalone: boolean; permission: NotificationPermission | "unavailable" };
const DEVICE_STORAGE_KEY = "saathi-reminder-device";

async function calendarRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("saathi-session-expired"));
    throw new Error(payload.error || "ਸੇਵਾ ਨਾਲ ਸੰਪਰਕ ਨਹੀਂ ਹੋ ਸਕਿਆ। / Could not reach the service. Please try again.");
  }
  return payload as T;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "ਕੁਝ ਗਲਤ ਹੋ ਗਿਆ। ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ। / Please try again."; }
function browserTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }
function validTimeZone(zone: string) { try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return Boolean(zone.trim()); } catch { return false; } }
function savedDevice() { try { return localStorage.getItem(DEVICE_STORAGE_KEY); } catch { return null; } }
function saveDevice(id: string | null) { try { if (id) localStorage.setItem(DEVICE_STORAGE_KEY, id); else localStorage.removeItem(DEVICE_STORAGE_KEY); } catch { /* The subscription still works when local preferences are unavailable. */ } }
function pushKeyBytes(key: string) {
  const normal = key.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normal + "=".repeat((4 - normal.length % 4) % 4));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
function Labels({ pa, en }: { pa: string; en: string }) { return <span className="calendar-labels"><span lang="pa">{pa}</span><small lang="en">{en}</small></span>; }

export function CalendarPanel({ isOwner, onSpeak }: { isOwner: boolean; onSpeak: (text: string, language: "pa" | "en") => void }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reminderMinutes, setReminderMinutes] = useState<15 | 30 | 60 | 1440>(30);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [pushReady, setPushReady] = useState(false);
  const [pushPreparationError, setPushPreparationError] = useState("");
  const [pushSupport, setPushSupport] = useState<PushSupport>({ checked: false, supported: false, appleMobile: false, standalone: false, permission: "unavailable" });
  const mounted = useRef(true);
  const registration = useRef<Promise<ServiceWorkerRegistration> | null>(null);
  const publicKey = useRef<string | null>(null);
  const statusRef = useRef<CalendarStatus | null>(null);
  const explanationCache = useRef<Map<string, Explanation>>(new Map());

  const refresh = useCallback(async () => {
    const next = await calendarRequest<CalendarStatus>("/api/calendar-status");
    if (mounted.current) {
      statusRef.current = next; setStatus(next);
      setTimeZone(next.timeZone || browserTimeZone());
      setSelectedIds(next.calendars.filter(item => item.selected).map(item => item.id));
      setReminderMinutes(next.reminderMinutes || 30);
      const currentId = savedDevice(); setDeviceId(currentId);
      if (!currentId || !next.deviceIds?.includes(currentId)) setNotificationsEnabled(false);
      else if (registration.current) {
        try {
          const worker = await registration.current;
          const subscription = await worker.pushManager.getSubscription();
          if (mounted.current && statusRef.current === next) setNotificationsEnabled(Boolean(subscription && Notification.permission === "granted"));
        } catch { if (mounted.current) setNotificationsEnabled(false); }
      }
    }
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    setTimeZone(browserTimeZone());
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
    const supported = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setPushSupport({ checked: true, supported, appleMobile, standalone, permission: "Notification" in window ? Notification.permission : "unavailable" });
    setDeviceId(savedDevice());
    if (supported && (!appleMobile || standalone)) {
      registration.current = navigator.serviceWorker.register("/sw.js").then(async worker => {
        if (worker.active) return worker;
        return Promise.race([
          navigator.serviceWorker.ready,
          new Promise<ServiceWorkerRegistration>((_, reject) => setTimeout(() => reject(new Error("Notifications are still getting ready. Please reopen this page.")), 15000)),
        ]);
      });
      void Promise.all([registration.current, calendarRequest<{ publicKey: string }>("/api/push-key", {})]).then(async ([worker, key]) => {
        publicKey.current = key.publicKey;
        const subscription = await worker.pushManager.getSubscription();
        if (!mounted.current) return;
        setPushReady(true);
        const currentId = savedDevice();
        setNotificationsEnabled(Boolean(subscription && currentId && statusRef.current?.deviceIds?.includes(currentId) && Notification.permission === "granted"));
      }).catch(() => { if (mounted.current) setPushPreparationError("ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਦੀ ਤਿਆਰੀ ਨਹੀਂ ਹੋ ਸਕੀ। ਪੰਨਾ ਦੁਬਾਰਾ ਖੋਲ੍ਹੋ। / Reopen this page to prepare notifications."); });
    }
    void refresh().catch(e => { if (mounted.current) setError(errorMessage(e)); });
    return () => { mounted.current = false; explanationCache.current.clear(); };
  }, [refresh]);

  const zone = status?.timeZone && validTimeZone(status.timeZone) ? status.timeZone : browserTimeZone();
  function dateLabel(value: number, withTime = false, locale = "pa-IN") {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "short", day: "numeric", month: "short", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).format(new Date(value));
  }
  function timeLabel(value: number) { return new Intl.DateTimeFormat("pa-IN", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(value)); }

  async function connect(event: React.FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    if (!validTimeZone(timeZone)) { setError("ਸਹੀ ਸਮਾਂ-ਖੇਤਰ ਭਰੋ। / Enter a valid time zone, such as America/Los_Angeles or Asia/Kolkata."); return; }
    setBusy("ਕੈਲੰਡਰ ਨਾਲ ਜੁੜ ਰਿਹਾ ਹਾਂ… / Connecting your calendar…");
    try {
      await calendarRequest("/api/calendar-connect", { username: username.trim(), password: password.trim(), timeZone: timeZone.trim() });
      await refresh(); setNotice("ਕੈਲੰਡਰ ਜੁੜ ਗਿਆ। ਹੁਣ ਹੇਠਾਂ ਕੈਲੰਡਰ ਚੁਣ ਕੇ ਸੰਭਾਲੋ। / Connected. Choose the calendars to share, then save them below.");
    } catch (e) { setError(errorMessage(e)); }
    finally { setUsername(""); setPassword(""); setBusy(""); }
  }

  async function saveCalendars(event: React.FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    if (selectedIds.length < 1 || selectedIds.length > 5) { setError("ਇੱਕ ਤੋਂ ਪੰਜ ਕੈਲੰਡਰ ਚੁਣੋ। / Choose between one and five calendars."); return; }
    if (!validTimeZone(timeZone)) { setError("ਸਹੀ ਸਮਾਂ-ਖੇਤਰ ਭਰੋ। / Enter a valid time zone, such as America/Los_Angeles or Asia/Kolkata."); return; }
    setBusy("ਚੋਣ ਸੰਭਾਲ ਰਿਹਾ ਹਾਂ… / Saving your choices…");
    try {
      await calendarRequest("/api/calendar-save", { calendarIds: selectedIds, timeZone: timeZone.trim(), reminderMinutes });
      explanationCache.current.clear(); setExpandedId(null); setExplanation(null);
      await refresh(); setNotice("ਚੋਣ ਸੰਭਾਲ ਲਈ ਹੈ। / Calendar choices saved.");
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }

  async function sync() {
    setError(""); setNotice(""); setBusy("ਮੁਲਾਕਾਤਾਂ ਚੈੱਕ ਕਰ ਰਿਹਾ ਹਾਂ… / Checking appointments…");
    try { await calendarRequest("/api/calendar-sync", {}); explanationCache.current.clear(); setExpandedId(null); setExplanation(null); await refresh(); setNotice("ਮੁਲਾਕਾਤਾਂ ਦੀ ਸੂਚੀ ਅੱਪਡੇਟ ਹੋ ਗਈ। / Appointment list updated."); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }

  async function disconnect() {
    setError(""); setNotice(""); setBusy("ਕੈਲੰਡਰ ਦਾ ਕਨੈਕਸ਼ਨ ਹਟਾ ਰਿਹਾ ਹਾਂ… / Disconnecting calendar…");
    try { await calendarRequest("/api/calendar-disconnect", {}); explanationCache.current.clear(); setExpandedId(null); setExplanation(null); setConfirmDisconnect(false); await refresh(); setNotice("ਕੈਲੰਡਰ ਦਾ ਕਨੈਕਸ਼ਨ ਹਟਾ ਦਿੱਤਾ ਹੈ। / Calendar disconnected."); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }

  async function explain(appointment: Appointment) {
    setError(""); setNotice(""); setExpandedId(appointment.id);
    const cached = explanationCache.current.get(appointment.id);
    if (cached) { setExplanation(cached); return; }
    setExplanation(null); setBusy("ਪੰਜਾਬੀ ਵਿੱਚ ਸਮਝਾ ਰਿਹਾ ਹਾਂ… / Preparing a Punjabi explanation…");
    try {
      const data = await calendarRequest<Explanation>("/api/appointment-explain", { id: appointment.id });
      if (!mounted.current) return;
      if (explanationCache.current.size >= 8) explanationCache.current.clear();
      explanationCache.current.set(appointment.id, data); setExplanation(data);
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function enableNotifications() {
    if (!pushSupport.supported || (pushSupport.appleMobile && !pushSupport.standalone)) return;
    // This call must precede all awaits: iPhone requires the direct button gesture.
    const permissionRequest = Notification.requestPermission();
    setError(""); setNotice(""); setBusy("ਯਾਦ-ਦਿਹਾਣੀਆਂ ਚਾਲੂ ਕਰ ਰਿਹਾ ਹਾਂ… / Turning on reminders…");
    let newlyCreated: PushSubscription | null = null;
    try {
      const permission = await permissionRequest;
      if (!mounted.current) return;
      setPushSupport(value => ({ ...value, permission }));
      if (permission !== "granted") { setNotice(permission === "denied" ? "ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਦੀ ਇਜਾਜ਼ਤ ਨਹੀਂ ਮਿਲੀ। ਫੋਨ ਦੀਆਂ ਸੈਟਿੰਗਾਂ ਵਿੱਚ ਸਾਥੀ ਲਈ ਇਜਾਜ਼ਤ ਦਿਓ। / Allow Saathi notifications in your phone’s settings." : "ਇਜਾਜ਼ਤ ਨਹੀਂ ਦਿੱਤੀ ਗਈ। ਜਦੋਂ ਤਿਆਰ ਹੋਵੋ, ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ। / Permission was not granted. You can try again later."); return; }
      const worker = await registration.current;
      if (!worker) throw new Error("ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਲਈ ਪੰਨਾ ਦੁਬਾਰਾ ਖੋਲ੍ਹੋ। / Reopen this page to prepare notifications.");
      if (!mounted.current) return;
      const key = publicKey.current || (await calendarRequest<{ publicKey: string }>("/api/push-key", {})).publicKey;
      publicKey.current = key;
      let subscription = await worker.pushManager.getSubscription();
      if (!subscription) { subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(key) }); newlyCreated = subscription; }
      if (!mounted.current) { if (newlyCreated) await newlyCreated.unsubscribe(); return; }
      const data = await calendarRequest<{ deviceId: string }>("/api/push-subscribe", { subscription: subscription.toJSON() });
      saveDevice(data.deviceId); setDeviceId(data.deviceId); setNotificationsEnabled(true);
      newlyCreated = null; // Registration succeeded; a later status error must not undo it.
      await refresh();
      setNotice("ਇਸ ਫੋਨ ਉੱਤੇ ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਦੀ ਇਜਾਜ਼ਤ ਮਿਲ ਗਈ ਹੈ। ਹੇਠਾਂ ਇੱਕ ਟੈਸਟ ਭੇਜੋ। / This phone is registered. Send a test below to check delivery.");
    } catch (e) { if (newlyCreated) await newlyCreated.unsubscribe().catch(() => false); if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function disableNotifications() {
    if (!deviceId) return;
    setError(""); setNotice(""); setBusy("ਇਸ ਫੋਨ ਦੀਆਂ ਯਾਦ-ਦਿਹਾਣੀਆਂ ਬੰਦ ਕਰ ਰਿਹਾ ਹਾਂ… / Turning off this phone’s reminders…");
    try {
      await calendarRequest("/api/push-unsubscribe", { deviceId });
      // Server removal already stops delivery, even if the browser cannot clean up.
      saveDevice(null); setDeviceId(null); setNotificationsEnabled(false);
      try {
        const worker = await registration.current;
        const subscription = await worker?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch { /* The removed server registration can no longer receive reminders. */ }
      await refresh(); setNotice("ਇਸ ਫੋਨ ਦੀਆਂ ਯਾਦ-ਦਿਹਾਣੀਆਂ ਬੰਦ ਹਨ। / Reminders are off on this phone.");
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }

  async function testNotification() {
    if (!deviceId) return;
    setError(""); setNotice(""); setBusy("ਟੈਸਟ ਭੇਜ ਰਿਹਾ ਹਾਂ… / Sending a test…");
    try { await calendarRequest("/api/push-test", { deviceId }); setNotice("ਟੈਸਟ ਦੀ ਬੇਨਤੀ ਭੇਜ ਦਿੱਤੀ ਹੈ। ਫੋਨ ਉੱਤੇ ਪੰਜਾਬੀ ਨੋਟੀਫਿਕੇਸ਼ਨ ਦੇਖੋ। / Test requested. Look for a Punjabi notification on this phone."); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(""); }
  }

  const appointments = [...(status?.appointments || [])].sort((a, b) => a.startAt - b.startAt);
  const backgroundVerified = Boolean(status?.backgroundReady && status.lastRunAt);
  const reminderText = status?.reminderMinutes === 1440 ? "ਲਗਭਗ ਇੱਕ ਦਿਨ ਪਹਿਲਾਂ / about a day before" : `ਲਗਭਗ ${status?.reminderMinutes || 30} ਮਿੰਟ ਪਹਿਲਾਂ / about ${status?.reminderMinutes || 30} minutes before`;

  return <section className="calendar-panel" aria-label="Appointments and reminders">
    <header className="calendar-heading"><p className="eyebrow">APPOINTMENTS & REMINDERS</p><h1 lang="pa">ਤੁਹਾਡੀਆਂ ਮੁਲਾਕਾਤਾਂ</h1><p className="english">Your appointments, explained in Punjabi.</p></header>
    {error && <div className="calendar-error" role="alert">{error}</div>}
    {notice && <div className="calendar-notice" role="status">{notice}</div>}
    {busy && <p className="calendar-working" role="status"><span className="spinner" aria-hidden="true" />{busy}</p>}
    {!status && <div className="calendar-empty"><CalendarDays aria-hidden="true" /><p lang="pa">ਕੈਲੰਡਰ ਖੋਲ੍ਹ ਰਿਹਾ ਹਾਂ…</p><p className="english">Opening your calendar…</p>{error && <button className="button" onClick={() => { setError(""); void refresh().catch(e => setError(errorMessage(e))); }}>ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ / Retry</button>}</div>}
    {status && !status.connected && <div className="calendar-empty"><CalendarDays aria-hidden="true" /><h2 lang="pa">ਕੈਲੰਡਰ ਜੋੜਨਾ ਬਾਕੀ ਹੈ</h2><p className="english">{isOwner ? "Open Family calendar setup below to connect iCloud and choose the calendars to share." : "Ask your family to connect the calendar. Your appointments will appear here."}</p></div>}
    {status?.connected && <>
      <div className="calendar-list-heading"><div><h2 lang="pa">ਆਉਣ ਵਾਲੇ 30 ਦਿਨ</h2><p className="english">Next 30 days · {zone.replaceAll("_", " ")}</p></div><button className="calendar-refresh" onClick={() => void sync()} disabled={Boolean(busy)} aria-label="ਮੁਲਾਕਾਤਾਂ ਦੀ ਸੂਚੀ ਅੱਪਡੇਟ ਕਰੋ / Refresh appointments"><RefreshCw size={21} aria-hidden="true" /><span>ਅੱਪਡੇਟ / Refresh</span></button></div>
      {status.lastError && <p className="calendar-warning" role="status">ਨਵੀਂ ਸੂਚੀ ਨਹੀਂ ਮਿਲ ਸਕੀ। ਪੁਰਾਣੀ ਸੂਚੀ ਦਿਖਾਈ ਜਾ ਰਹੀ ਹੈ। / The last update failed. This list may be out of date.</p>}
      {status.lastSyncedAt && <p className="calendar-updated">ਆਖ਼ਰੀ ਅੱਪਡੇਟ / Last updated: {dateLabel(status.lastSyncedAt, true)}</p>}
      {appointments.length === 0 ? <div className="calendar-empty small-empty"><Check aria-hidden="true" /><p lang="pa">ਫਿਲਹਾਲ ਕੋਈ ਮੁਲਾਕਾਤ ਨਹੀਂ ਦਿਸ ਰਹੀ।</p><p className="english">No appointments in the selected calendars for the next 30 days.</p></div> : <div className="appointment-list">{appointments.map(appointment => <article key={appointment.id} className="appointment-card">
        <p className="appointment-date"><CalendarDays size={18} aria-hidden="true" /><span>{dateLabel(appointment.startAt)}</span></p><h2>{appointment.title || "ਮੁਲਾਕਾਤ / Appointment"}</h2>
        <p className="appointment-time"><Clock size={19} aria-hidden="true" /><span>{appointment.allDay ? "ਸਾਰਾ ਦਿਨ / All day" : `${timeLabel(appointment.startAt)}${appointment.endAt > appointment.startAt ? ` – ${timeLabel(appointment.endAt)}` : ""}`}</span></p>
        {appointment.location && <p className="appointment-location"><MapPin size={18} aria-hidden="true" /><span>{appointment.location}</span></p>}
        {appointment.description && <details className="appointment-details"><summary>ਹੋਰ ਜਾਣਕਾਰੀ / Event details</summary><p>{appointment.description}</p></details>}
        <button className="button calendar-explain" disabled={Boolean(busy)} onClick={() => void explain(appointment)}><Labels pa="ਪੰਜਾਬੀ ਵਿੱਚ ਸਮਝਾਓ" en="Explain in Punjabi" /><ChevronRight size={20} aria-hidden="true" /></button>
        {expandedId === appointment.id && explanation && <div className="appointment-explanation" aria-live="polite"><p lang="pa" className="result-text">{explanation.explanation || explanation.translation}</p>{Boolean(explanation.nextSteps?.length) && <ul lang="pa">{explanation.nextSteps?.map((step, index) => <li key={index}>{step}</li>)}</ul>}{Boolean(explanation.uncertainties?.length) && <p className="calendar-warning">{explanation.uncertainties?.join(" ")}</p>}<button className="button primary" onClick={() => onSpeak(explanation.speechText || explanation.explanation || explanation.translation, "pa")}><Volume2 size={22} aria-hidden="true" /><Labels pa="ਸੁਣੋ" en="Listen in Punjabi" /></button><p className="calendar-small">AI ਵੱਲੋਂ ਬਣਾਈ ਆਵਾਜ਼ · AI-generated voice</p></div>}
      </article>)}</div>}
      <p className="calendar-small">‘ਪੰਜਾਬੀ ਵਿੱਚ ਸਮਝਾਓ’ ਦਬਾਉਣ ਨਾਲ ਉਸ ਮੁਲਾਕਾਤ ਦੀ ਜਾਣਕਾਰੀ Google ਨੂੰ ਜਾਂਦੀ ਹੈ। / Explaining an appointment sends its details to Google.</p>
      <section className="calendar-reminders" aria-label="Phone reminders"><div className="calendar-card-title"><Bell size={25} aria-hidden="true" /><div><h2 lang="pa">ਫੋਨ ਉੱਤੇ ਯਾਦ ਕਰਵਾਓ</h2><p className="english">Reminders on this phone</p></div></div>
        <p lang="pa">ਸਮਾਂ ਦਿੱਤੀਆਂ ਮੁਲਾਕਾਤਾਂ ਲਈ ਯਾਦ-ਦਿਹਾਣੀ: {reminderText.split(" / ")[0]}।</p><p className="english">For timed appointments, {reminderText.split(" / ")[1]}.</p>
        <p className="calendar-small">ਸਾਰੇ ਦਿਨ ਵਾਲੇ ਇਵੈਂਟ ਸੂਚੀ ਵਿੱਚ ਦਿਸਦੇ ਹਨ; ਉਨ੍ਹਾਂ ਲਈ ਨੋਟੀਫਿਕੇਸ਼ਨ ਨਹੀਂ ਆਵੇਗਾ। / All-day events appear in the list; this version sends reminders only for timed events.</p>
        <div className={`calendar-background-status ${backgroundVerified ? "is-ready" : "is-pending"}`} role="status"><span className="calendar-status-dot" aria-hidden="true" /><div><p lang="pa">{backgroundVerified ? "ਆਟੋਮੈਟਿਕ ਚੈੱਕ ਚੱਲ ਰਹੇ ਹਨ।" : "ਆਟੋਮੈਟਿਕ ਚੈੱਕ ਦੀ ਤਿਆਰੀ ਬਾਕੀ ਹੈ।"}</p><p className="english">{backgroundVerified ? "Automatic reminder checks are running." : "Automatic reminder checks are not ready yet. You can still test this phone below."}</p>{status.lastRunAt && <p className="calendar-small">ਆਖ਼ਰੀ ਚੈੱਕ / Last check: {dateLabel(status.lastRunAt, true)}</p>}</div></div>
        {pushSupport.checked && pushSupport.appleMobile && !pushSupport.standalone ? <div className="calendar-install"><h3 lang="pa">ਪਹਿਲਾਂ ਸਾਥੀ ਫੋਨ ਦੀ ਸਕ੍ਰੀਨ ਉੱਤੇ ਰੱਖੋ</h3><p className="english">On iPhone or iPad, add Saathi to the Home Screen first.</p><ol><li>Safari ਵਿੱਚ ਇਹ ਲਿੰਕ ਖੋਲ੍ਹੋ। / Open this link in Safari.</li><li>Share ਦਬਾਓ → Add to Home Screen.</li><li>ਸਾਥੀ ਦੇ ਨਵੇਂ ਆਈਕਨ ਤੋਂ ਖੋਲ੍ਹੋ ਤੇ ਇੱਥੇ ਵਾਪਸ ਆਓ। / Open the new Saathi icon and return here.</li></ol><p className="calendar-small">Requires iOS or iPadOS 16.4 or later.</p></div> : pushSupport.checked && !pushSupport.supported ? <p className="calendar-warning">ਇਸ ਬ੍ਰਾਊਜ਼ਰ ਵਿੱਚ ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਦੀ ਸਹੂਲਤ ਨਹੀਂ ਮਿਲੀ। / This browser does not support these notifications. On iPhone, use an updated iOS version and open Saathi from the Home Screen.</p> : <>
          {pushPreparationError && <p className="calendar-warning">{pushPreparationError}</p>}
          {notificationsEnabled ? <><p className="calendar-device-ready"><Check size={21} aria-hidden="true" /><Labels pa="ਇਹ ਫੋਨ ਤਿਆਰ ਹੈ" en="This phone is registered" /></p><div className="calendar-button-row"><button className="button primary" disabled={Boolean(busy)} onClick={() => void testNotification()}><Bell size={20} aria-hidden="true" /><Labels pa="ਟੈਸਟ ਭੇਜੋ" en="Send a test" /></button><button className="button" disabled={Boolean(busy)} onClick={() => void disableNotifications()}><BellOff size={20} aria-hidden="true" /><Labels pa="ਇਸ ਫੋਨ ਲਈ ਬੰਦ ਕਰੋ" en="Turn off on this phone" /></button></div></> : <button className="button primary calendar-enable" disabled={Boolean(busy) || !pushReady} onClick={() => void enableNotifications()}><Bell size={23} aria-hidden="true" /><Labels pa="ਇਸ ਫੋਨ ਲਈ ਚਾਲੂ ਕਰੋ" en={pushReady ? "Enable on this phone" : "Preparing notifications…"} /></button>}
          {pushSupport.permission === "denied" && <p className="calendar-small">ਫੋਨ ਦੀਆਂ ਸੈਟਿੰਗਾਂ ਵਿੱਚ ਸਾਥੀ ਦੀਆਂ ਨੋਟੀਫਿਕੇਸ਼ਨਾਂ ਨੂੰ ਇਜਾਜ਼ਤ ਦਿਓ। / Allow Saathi notifications in your device settings, then reopen the app.</p>}
        </>}
        <p className="calendar-lockscreen"><ShieldCheck size={17} aria-hidden="true" /><span>ਲੌਕ ਸਕ੍ਰੀਨ ਉੱਤੇ ਸਿਰਫ਼ ਯਾਦ-ਦਿਹਾਣੀ ਦਿਸੇਗੀ। ਮੁਲਾਕਾਤ ਦੀ ਜਾਣਕਾਰੀ ਸਾਥੀ ਵਿੱਚ ਖੋਲ੍ਹੋ। / Lock-screen messages contain a general reminder. Open Saathi for appointment details.</span></p>
      </section>
    </>}
    {isOwner && <details className="calendar-owner-setup"><summary>ਪਰਿਵਾਰ ਵੱਲੋਂ ਕੈਲੰਡਰ ਸੈੱਟ ਕਰੋ / Family calendar setup</summary>
      {status?.connected && <form className="calendar-settings-form" onSubmit={saveCalendars}><h2>Choose calendars to share</h2><p className="calendar-small">Select up to five calendars. Everyone with the family access code can view appointments from these calendars.</p><fieldset className="calendar-choices"><legend className="sr-only">Calendars shared with the family</legend>{status.calendars.map(calendar => <label key={calendar.id}><input type="checkbox" checked={selectedIds.includes(calendar.id)} disabled={Boolean(busy) || (!selectedIds.includes(calendar.id) && selectedIds.length >= 5)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, calendar.id] : current.filter(id => id !== calendar.id))} /><span>{calendar.name || "Untitled calendar"}</span></label>)}</fieldset><p className="calendar-small">{selectedIds.length} of 5 selected</p><label htmlFor="calendar-reminder-time">Remind approximately</label><select id="calendar-reminder-time" value={reminderMinutes} onChange={event => setReminderMinutes(Number(event.target.value) as 15 | 30 | 60 | 1440)}><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option></select><label htmlFor="calendar-zone-save">Calendar time zone</label><input id="calendar-zone-save" value={timeZone} onChange={event => setTimeZone(event.target.value)} required spellCheck={false} autoCapitalize="none" placeholder="America/Los_Angeles" /><p className="calendar-small">Use the time zone where your grandparents attend appointments, for example America/Los_Angeles or Asia/Kolkata.</p><button className="button primary" disabled={Boolean(busy) || selectedIds.length < 1 || selectedIds.length > 5}><Check size={20} aria-hidden="true" /><span>Save calendar choices</span></button></form>}
      <details className="calendar-connect-details" open={!status?.connected}><summary>{status?.connected ? "Reconnect or change the iCloud account" : "Connect iCloud privately"}</summary><p className="calendar-small">Use an Apple app-specific password created for Saathi. Do not enter your normal Apple Account password. The password is kept on the server, and these fields are cleared after the connection attempt.</p><div className="calendar-help-links"><a href="https://account.apple.com" target="_blank" rel="noreferrer">Create an app-specific password <ExternalLink size={14} aria-hidden="true" /></a><a href="https://support.apple.com/en-us/102654" target="_blank" rel="noreferrer">Apple’s setup instructions <ExternalLink size={14} aria-hidden="true" /></a></div><form onSubmit={connect} className="calendar-settings-form"><label htmlFor="icloud-email">Apple Account email</label><input id="icloud-email" type="email" required autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} placeholder="you@example.com" /><label htmlFor="icloud-app-password">App-specific password for Saathi</label><input id="icloud-app-password" type="password" required autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" /><label htmlFor="calendar-zone-connect">Calendar time zone</label><input id="calendar-zone-connect" value={timeZone} onChange={event => setTimeZone(event.target.value)} required autoCapitalize="none" spellCheck={false} placeholder="America/Los_Angeles" /><button className="button primary" disabled={Boolean(busy) || !username.trim() || !password.trim()}><ShieldCheck size={21} aria-hidden="true" /><span>Connect iCloud</span></button></form></details>
      {status?.connected && <div className="calendar-disconnect">{confirmDisconnect ? <><p>Disconnecting stops calendar syncing and appointment reminders. Your events in iCloud remain there.</p><div className="calendar-button-row"><button className="button" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(false)}>Keep connected</button><button className="button calendar-danger" disabled={Boolean(busy)} onClick={() => void disconnect()}>Disconnect iCloud</button></div></> : <button className="calendar-disconnect-link" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}>Disconnect iCloud</button>}</div>}
    </details>}
  </section>;
}
