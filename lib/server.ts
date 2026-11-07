import { env } from "cloudflare:workers";
import { HttpError, createSession, validSession, sessionCookie, requireSameOrigin, boundedJson, encryptKey, decryptKey, newSalt, normalizeApiKey, hashCode, constantTimeEqual, privateRateKey, validateContent } from "./security";
import { processContent, synthesizeSpeech, checkApiKey } from "./gemini";
import { createLiveSession } from "./gemini-live";

interface Settings {
  id: string; owner_id: string; encrypted_key: string; code_hash: string; code_salt: string; session_version: string; updated_at: number;
}
function database(): D1Database {
  if (!env.DB) throw new HttpError(503, "Saathi is still being set up. Please try again shortly.");
  return env.DB;
}
function secret(): string {
  if (!env.SAATHI_SECRET) throw new HttpError(503, "Saathi’s private connection is not set up yet.");
  return env.SAATHI_SECRET;
}
function isOwner(request: Request, settings: Settings | null): boolean {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (settings) return !!userId && constantTimeEqual(userId, settings.owner_id);
  const email = request.headers.get("oai-authenticated-user-email");
  return !!(email && env.OWNER_EMAIL && userId && constantTimeEqual(email.trim().toLowerCase(), env.OWNER_EMAIL.trim().toLowerCase()));
}
async function getSettings(): Promise<Settings | null> {
  return database().prepare("SELECT * FROM settings WHERE id = ?").bind("family").first<Settings>();
}
async function permitted(request: Request, settings: Settings | null): Promise<boolean> {
  if (isOwner(request, settings)) return true;
  return !!(settings && await validSession(request.headers.get("cookie"), settings.session_version, secret()));
}
async function consume(key: string, maximum: number, seconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await database().prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END RETURNING count, expires_at").bind(key, now + seconds, now, now, now + seconds).first<{ count: number; expires_at: number }>();
  if (!row || row.count > maximum) throw new HttpError(429, `Please wait ${Math.max(1, Math.ceil(((row?.expires_at || now + 60) - now) / 60))} minutes before trying again.`);
}
async function perIp(request: Request, action: string, maximum: number, seconds: number): Promise<void> {
  // Cloudflare supplies this header; it is never copied into feedback or provider requests.
  const ip = request.headers.get("cf-connecting-ip") || "local";
  await consume(await privateRateKey(action, ip, secret()), maximum, seconds);
}
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
async function providerAllowance(): Promise<void> {
  await consume("family-ai-daily", 200, 86400);
  await consume("family-ai-minute", 12, 60);
}
export async function handle(request: Request, action: string): Promise<Response> {
  try {
    if (request.method === "GET") {
      if (action === "status") {
        const settings = await getSettings();
        const authenticated = await permitted(request, settings);
        return json({ configured: !!settings, authenticated, isOwner: isOwner(request, settings), needsLogin: !authenticated });
      }
      if (action === "feedback") {
        if (!isOwner(request, await getSettings())) throw new HttpError(403, "Only the family organizer can see feedback.");
        const result = await database().prepare("SELECT id, rating, mode, note, created_at AS createdAt FROM feedback ORDER BY created_at DESC LIMIT 100").all();
        return json({ feedback: result.results });
      }
      throw new HttpError(404, "That page was not found.");
    }
    if (request.method !== "POST") return json({ error: "This action is not supported." }, 405);
    requireSameOrigin(request);
    const settings = await getSettings();

    if (action === "setup") {
      if (!isOwner(request, settings)) throw new HttpError(403, "Sign in as the family organizer to set up Saathi.");
      await perIp(request, "setup", 10, 3600);
      const body = await boundedJson(request, 4096);
      const apiKey = normalizeApiKey(body.apiKey);
      if (typeof body.accessCode !== "string" || !/^\d{8}$/.test(body.accessCode)) throw new HttpError(400, "Choose an eight-digit family code.");
      if (/^(\d)\1{7}$/.test(body.accessCode) || ["12345678", "87654321", "01234567"].includes(body.accessCode)) throw new HttpError(400, "Choose a less predictable eight-digit family code.");
      // Independent checks run together; setup still succeeds only when BOTH pass.
      // Use no private content and wait for both outcomes before returning.
      const checks = await Promise.allSettled([
        checkApiKey(apiKey),
        synthesizeSpeech(apiKey, "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ਜੀ।", "pa"),
      ]);
      for (const check of checks) if (check.status === "rejected") throw check.reason;
      const salt = newSalt();
      const version = crypto.randomUUID();
      const ciphertext = await encryptKey(apiKey, secret());
      const codeHash = await hashCode(body.accessCode, salt);
      await database().prepare("INSERT INTO settings (id, owner_id, encrypted_key, code_hash, code_salt, session_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key, code_hash=excluded.code_hash, code_salt=excluded.code_salt, session_version=excluded.session_version, updated_at=excluded.updated_at").bind("family", request.headers.get("oai-authenticated-user-id"), ciphertext, codeHash, salt, version, Date.now()).run();
      await database().prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(Math.floor(Date.now() / 1000)).run();
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await createSession(version, secret())) });
    }
    if (action === "login") {
      await perIp(request, "login", 5, 900);
      await consume("family-login-hour", 40, 3600);
      const body = await boundedJson(request, 1024);
      if (!settings) throw new HttpError(503, "The family organizer needs to connect Saathi first.");
      if (typeof body.code !== "string" || !/^\d{8}$/.test(body.code) || !constantTimeEqual(await hashCode(body.code, settings.code_salt), settings.code_hash)) throw new HttpError(401, "That code did not match. Please try again.");
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await createSession(settings.session_version, secret())) });
    }
    if (action === "logout") return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", true) });
    if (!await permitted(request, settings)) throw new HttpError(401, "Please enter your family code to continue.");
    if (!settings) throw new HttpError(503, "The family organizer needs to connect the Gemini API key first.");

    if (action === "live-session") {
      await perIp(request, "live-session", 6, 600);
      const body = await boundedJson(request, 1024);
      if (Object.keys(body).length !== 0) throw new HttpError(400, "Start the conversation from Saathi without additional settings.");
      // Issuance has separate limits: each token enables one constrained Live
      // connection. Client-supplied model, credentials or config are never used.
      await consume("family-live-hour", 20, 3600);
      await consume("family-live-daily", 60, 86400);
      const session = await createLiveSession(await decryptKey(settings.encrypted_key, secret()));
      return json({ token: session.token, model: session.model, expiresAt: session.expiresAt });
    }
    if (action === "process") {
      await perIp(request, "process", 30, 600);
      const input = validateContent(await boundedJson(request));
      await providerAllowance();
      const output = await processContent(await decryptKey(settings.encrypted_key, secret()), input);
      return json(output);
    }
    if (action === "speak") {
      await perIp(request, "speak", 40, 600);
      const body = await boundedJson(request, 24000);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2500 || !["pa", "en"].includes(String(body.language))) throw new HttpError(400, "Choose a passage of up to 2,500 characters to listen to.");
      await providerAllowance();
      const audio = await synthesizeSpeech(await decryptKey(settings.encrypted_key, secret()), body.text.trim(), body.language as "pa" | "en");
      return new Response(audio.data as unknown as BodyInit, { headers: { "Content-Type": audio.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    }
    if (action === "feedback") {
      await perIp(request, "feedback", 20, 3600);
      const body = await boundedJson(request, 4096);
      if (body.rating !== "helpful" && body.rating !== "unclear") throw new HttpError(400, "Choose helpful or unclear.");
      if (typeof body.mode !== "string" || !["conversation", "mail", "conversation:live", "conversation:en-pa", "conversation:pa-en", "mail:explanation", "mail:translation", "mail:nextSteps"].includes(body.mode)) throw new HttpError(400, "Choose conversation or mail.");
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) throw new HttpError(400, "Please keep feedback under 1,000 characters.");
      await database().prepare("INSERT INTO feedback (id, rating, mode, note, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), body.rating, body.mode, body.note || "", Date.now()).run();
      return json({ ok: true });
    }
    throw new HttpError(404, "That action was not found.");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    // Provider module emits sanitized actionable errors; infrastructure details stay private.
    if (error instanceof Error && error.name === "GeminiError") return json({ error: error.message }, 502);
    return json({ error: "Saathi could not finish that request. Please try again shortly." }, 500);
  }
}
