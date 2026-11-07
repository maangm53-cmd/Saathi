/** Server-only ephemeral Live API credentials. Never import into a client component.
 * REST reference: https://ai.google.dev/api/generate-content#method:-auth_tokens.create
 * SDK wire conversion: https://github.com/googleapis/js-genai/blob/main/src/converters/_tokens_converters.ts
 * SDK constraints handling: https://github.com/googleapis/js-genai/blob/main/src/tokens.ts
 * `liveConnectConstraints` is an SDK option; the REST field is
 * `bidiGenerateContentSetup`. Omitting fieldMask locks the entire supplied setup.
 */
import { LIVE_MODEL, LIVE_SESSION_DURATION_MS, LIVE_SETUP } from "./live-config";

const TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const TOKEN_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

class LiveProviderError extends Error {
  constructor(message: string) {
    super(message);
    // The existing API handler recognizes sanitized provider errors by name.
    this.name = "GeminiError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerError(status: number, body: unknown): Error {
  // Classification only: never expose/log the provider's response or a token.
  const detail = JSON.stringify(body ?? {}).slice(0, 16_000).toLowerCase();
  if (status === 401 || /api.key.invalid|api_key_invalid|invalid.api.key|key.expired/.test(detail)) {
    return new LiveProviderError("The Google API key is invalid or expired. Please check Family setup.");
  }
  if (status === 429 || /resource_exhausted|quota|billing/.test(detail)) {
    return new LiveProviderError("Google's live conversation usage limit or billing allowance has been reached. Please check the project's billing and quota.");
  }
  if (status === 403) {
    return new LiveProviderError("This Google key does not have permission for live conversation. Please check its project and API restrictions.");
  }
  if (status === 404 || /model.*(?:not.found|not.supported|unavailable)/.test(detail)) {
    return new LiveProviderError("Google's live conversation model is not available for this project. Typed translation and mail tools are still available.");
  }
  return new LiveProviderError("Google could not start live conversation. Please try again shortly.");
}

async function readTokenResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES || !response.body) {
    throw new LiveProviderError("Google returned an unexpected live conversation response. Please try again.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LiveProviderError("Google returned an unexpected live conversation response. Please try again.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export async function createLiveSession(apiKey: string): Promise<{ token: string; model: string; expiresAt: string }> {
  const key = apiKey.trim();
  if (!key || key.length > 512 || /[^\x21-\x7e]/.test(key)) {
    throw new LiveProviderError("Add a valid Google API key in Family setup first.");
  }
  const now = Date.now();
  const expiresAt = new Date(now + LIVE_SESSION_DURATION_MS).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        bidiGenerateContentSetup: LIVE_SETUP,
      }),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await readTokenResponse(response);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (!response.ok) throw providerError(response.status, null);
      throw new LiveProviderError("Google returned an unreadable live conversation response. Please try again.");
    }
    if (!response.ok) throw providerError(response.status, body);
    // AuthToken.name is the credential itself. Keep it opaque; validate only
    // the documented resource prefix, bounded size and safe visible characters.
    if (!isObject(body) || typeof body.name !== "string" || body.name.length > 16_384 || !/^auth_tokens\/[\x21-\x7e]+$/.test(body.name)) {
      throw new LiveProviderError("Google did not return a usable live conversation session. Please try again.");
    }
    return { token: body.name, model: LIVE_MODEL, expiresAt };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LiveProviderError("Google did not start live conversation within 30 seconds. Please try again.");
    }
    if (error instanceof LiveProviderError) throw error;
    throw new LiveProviderError("Saathi could not connect to Google's live conversation service. Please check the connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
}
