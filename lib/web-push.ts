import { buildPushPayload } from "@block65/webcrypto-web-push";

// Standard Web Push, including Safari: https://developer.apple.com/documentation/
// usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
// Library 2.x uses RFC 8291 aes128gcm + RFC 8292 VAPID, including 4096-byte padding.
// https://github.com/block65/webcrypto-web-push/tree/master/packages/web-push
const SITE_ORIGIN = "https://saathi-punjabi-family.guri007.chatgpt.site";
const APPOINTMENTS_URL = "/?screen=appointments";
const SEND_TIMEOUT_MS = 12_000;
const AUTH_CACHE_MS = 60 * 60_000;
const authorizationCache = new Map<string, { value: string; expiresAt: number }>();

export type PushSubscriptionData = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = { subject: string; publicKey: string; privateKey: string };

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushError";
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: unknown, expectedBytes: number): Uint8Array | null {
  if (typeof value !== "string" || value.length !== Math.ceil(expectedBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === expectedBytes && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateSubscription(value: unknown): PushSubscriptionData {
  const fail = () => new PushError("This notification subscription is invalid. Enable notifications again on this device.");
  if (!isRecord(value) || !isRecord(value.keys) || typeof value.endpoint !== "string" || value.endpoint.length > 4096 || /[^\x21-\x7e]/.test(value.endpoint)) throw fail();
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw fail();
  }
  const host = endpoint.hostname;
  const knownService = host === "fcm.googleapis.com" || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.push\.apple\.com$/.test(host) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.push\.services\.mozilla\.com$/.test(host);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || !knownService || endpoint.pathname === "/") throw fail();
  const publicKey = decodeBase64Url(value.keys.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !decodeBase64Url(value.keys.auth, 16)) throw fail();
  const expiry = value.expirationTime;
  if (expiry !== undefined && expiry !== null && (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < 0)) throw fail();
  // Copy only the supported fields; callers must never persist arbitrary client input.
  return {
    endpoint: endpoint.href,
    ...(expiry !== undefined ? { expirationTime: expiry as number | null } : {}),
    keys: { p256dh: value.keys.p256dh as string, auth: value.keys.auth as string },
  };
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  try {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const [rawPublic, privateJwk] = await Promise.all([
      crypto.subtle.exportKey("raw", pair.publicKey),
      crypto.subtle.exportKey("jwk", pair.privateKey),
    ]);
    if (!privateJwk.d) throw new Error();
    return { subject: SITE_ORIGIN, publicKey: encodeBase64Url(new Uint8Array(rawPublic)), privateKey: privateJwk.d };
  } catch {
    throw new PushError("Saathi could not prepare notifications. Please try again.");
  }
}

function safeText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength) || fallback;
}

export async function sendPush(
  subscription: PushSubscriptionData,
  keys: VapidKeys,
  payload: { title: string; body: string; url: string; tag: string },
): Promise<"sent" | "expired" | "retry"> {
  const checked = validateSubscription(subscription);
  const publicBytes = decodeBase64Url(keys?.publicKey, 65);
  if (keys?.subject !== SITE_ORIGIN || !publicBytes || publicBytes[0] !== 4 || !decodeBase64Url(keys?.privateKey, 32)) {
    throw new PushError("Saathi's notification settings need attention. Ask the organizer to check reminders.");
  }
  if (checked.expirationTime != null && checked.expirationTime <= Date.now()) return "expired";
  const message = {
    title: safeText(payload?.title, 100, "ਸਾਥੀ · ਮੁਲਾਕਾਤ ਦੀ ਯਾਦ"),
    body: safeText(payload?.body, 600, "ਤੁਹਾਡੀ ਮੁਲਾਕਾਤ ਆ ਰਹੀ ਹੈ। ਵੇਰਵੇ ਵੇਖਣ ਲਈ ਸਾਥੀ ਖੋਲ੍ਹੋ।"),
    // Notifications are only allowed to open this feature. Do not trust payload links.
    url: APPOINTMENTS_URL,
    tag: safeText(payload?.tag, 100, "saathi-appointment"),
  };
  let request: Awaited<ReturnType<typeof buildPushPayload>>;
  try {
    request = await buildPushPayload({ data: message, options: { ttl: 300, urgency: "high" } }, { ...checked, expirationTime: checked.expirationTime ?? null }, keys);
  } catch {
    // Library exceptions can contain provider/subscription details. Never propagate them.
    throw new PushError("Saathi could not prepare this notification. Enable notifications again on this device.");
  }
  if (request.body.byteLength !== 4096) throw new PushError("Saathi could not prepare this notification. Please try again.");
  // Apple recommends reusing VAPID JWTs for at least an hour. This bounded cache
  // holds signed tokens, never private keys, and is intentionally not persisted.
  const cacheKey = `${keys.publicKey}|${new URL(checked.endpoint).origin}`;
  const now = Date.now();
  const cached = authorizationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    request.headers.authorization = cached.value;
  } else {
    for (const [key, entry] of authorizationCache) if (entry.expiresAt <= now) authorizationCache.delete(key);
    if (authorizationCache.size >= 16) authorizationCache.delete(authorizationCache.keys().next().value!);
    authorizationCache.set(cacheKey, { value: request.headers.authorization, expiresAt: now + AUTH_CACHE_MS });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(checked.endpoint, { ...request, redirect: "manual", signal: controller.signal });
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
  // No response body is useful to this app; it can contain private provider data.
  void response.body?.cancel().catch(() => {});
  if (response.ok) return "sent";
  if (response.status === 404 || response.status === 410) return "expired";
  if ([408, 425, 429].includes(response.status) || response.status >= 500) return "retry";
  if ([400, 401, 403].includes(response.status)) {
    throw new PushError("The notification service rejected Saathi's notification settings. Ask the organizer to check reminders.");
  }
  throw new PushError("The notification service could not accept this reminder. Please try enabling notifications again.");
}
