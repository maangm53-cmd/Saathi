const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const COOKIE_NAME = "__Host-saathi";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function urlEncode(bytes: Uint8Array): string {
  return base64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function urlDecode(value: string): Uint8Array<ArrayBuffer> {
  return unbase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = unbase64(secret);
  if (bytes.length !== 32) throw new HttpError(503, "The app’s private connection is not configured yet.");
  return bytes;
}
async function aesKey(secret: string) {
  return crypto.subtle.importKey("raw", secretBytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function signingKey(secret: string) {
  return crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function encryptKey(apiKey: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode("saathi-gemini-key-v1") }, await aesKey(secret), encoder.encode(apiKey));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decryptKey(value: string, secret: string): Promise<string> {
  const [iv, body] = value.split(".");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: encoder.encode("saathi-gemini-key-v1") }, await aesKey(secret), unbase64(body));
  return decoder.decode(decrypted);
}
export type PrivatePurpose = "icloud-connection" | "appointment-details" | "push-subscription" | "push-vapid";
export async function encryptPrivate(value: unknown, secret: string, purpose: PrivatePurpose): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`saathi:${purpose}:v1`) }, await aesKey(secret), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decryptPrivate<T>(value: string, secret: string, purpose: PrivatePurpose): Promise<T> {
  const [iv, body] = value.split(".");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: encoder.encode(`saathi:${purpose}:v1`) }, await aesKey(secret), unbase64(body));
  return JSON.parse(decoder.decode(plaintext)) as T;
}
export function newSalt(): string { return base64(crypto.getRandomValues(new Uint8Array(16))); }
export function normalizeApiKey(input: unknown): string {
  const invalid = () => new HttpError(400, "Copy the complete Gemini API key from Google AI Studio and paste it here. The key must not contain spaces or extra text.");
  if (typeof input !== "string" || input.length > 1024) throw invalid();
  let key = input.trim();
  // Accept common copy-and-paste wrappers without interpreting them as code.
  const assignment = key.match(/^(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*([\s\S]+)$/);
  if (assignment) key = assignment[1].trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1).trim();
  // Google authorization keys can contain punctuation (including the AQ. prefix).
  // Treat credentials as opaque; Google, not a legacy character regex, validates them.
  if (key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw invalid();
  return key;
}
export async function hashCode(code: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: unbase64(salt) }, key, 256);
  return base64(new Uint8Array(bits));
}
export function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export async function createSession(version: string, secret: string, now = Date.now()): Promise<string> {
  const payload = urlEncode(encoder.encode(JSON.stringify({ version, exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${urlEncode(new Uint8Array(signature))}`;
}
export async function validSession(cookie: string | null, version: string, secret: string, now = Date.now()): Promise<boolean> {
  try {
    const token = cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + "="))?.slice(COOKIE_NAME.length + 1);
    if (!token || token.length > 1000) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), urlDecode(signature), encoder.encode(payload));
    if (!valid) return false;
    const parsed = JSON.parse(decoder.decode(urlDecode(payload)));
    return parsed.version === version && Number.isSafeInteger(parsed.exp) && parsed.exp > now / 1000 && parsed.exp <= now / 1000 + SESSION_SECONDS + 60;
  } catch { return false; }
}
export function sessionCookie(value: string, clear = false): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}`;
}
export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(403, "Please open Saathi directly and try again.");
}
export async function boundedJson(request: Request, maximum = 9_000_000): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Please send the information again from Saathi.");
  const length = request.headers.get("content-length");
  if (length && Number(length) > maximum) throw new HttpError(413, "That recording or photo is too large. Please try a shorter recording or smaller photo.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "No information was received.");
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new HttpError(413, "That recording or photo is too large. Please try a shorter recording or smaller photo."); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result = JSON.parse(decoder.decode(all));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HttpError(400, "The information could not be read. Please try again."); }
}
export async function privateRateKey(label: string, ip: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(`${label}:${ip}`));
  return label + ":" + urlEncode(new Uint8Array(signature));
}

export interface ContentInput {
  kind: "conversation" | "mail";
  direction: "en-pa" | "pa-en";
  text?: string;
  audio?: { data: string; mimeType: string };
  image?: { data: string; mimeType: string };
}
export function validateContent(value: Record<string, unknown>): ContentInput {
  if (value.kind !== "conversation" && value.kind !== "mail") throw new HttpError(400, "Choose conversation or mail first.");
  if (value.direction !== "en-pa" && value.direction !== "pa-en") throw new HttpError(400, "Choose the translation direction.");
  const result: ContentInput = { kind: value.kind, direction: value.kind === "mail" ? "en-pa" : value.direction };
  if (value.text !== undefined) {
    if (typeof value.text !== "string" || value.text.length > 12000) throw new HttpError(400, "Please use up to 12,000 characters at a time.");
    if (value.text.trim()) result.text = value.text.trim();
  }
  for (const type of ["audio", "image"] as const) {
    if (value[type] === undefined) continue;
    const media = value[type] as Record<string, unknown> | null;
    if (!media || typeof media !== "object" || typeof media.data !== "string" || typeof media.mimeType !== "string") throw new HttpError(400, "The photo or recording could not be read.");
    const mimeType = media.mimeType.split(";")[0].trim().toLowerCase();
    const allowed = type === "audio" ? ["audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/aac", "audio/flac"] : ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(mimeType) || media.data.length > 8_000_000 || media.data.length < 8 || media.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(media.data)) throw new HttpError(400, "Please try a different photo or record a shorter message.");
    result[type] = { data: media.data, mimeType };
  }
  const count = [result.text, result.audio, result.image].filter(Boolean).length;
  if (count !== 1) throw new HttpError(400, "Please send one text, recording, or photo at a time.");
  if (result.kind === "conversation" && result.image || result.kind === "mail" && result.audio) throw new HttpError(400, "Use the conversation button for speech, or the mail button for text and photos.");
  return result;
}
