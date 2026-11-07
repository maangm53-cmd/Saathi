import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const providerUrl = new URL("../lib/gemini-live.ts", import.meta.url).href;
const configUrl = new URL("../lib/live-config.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === providerUrl && specifier === "./live-config") {
      return { url: configUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { createLiveSession } = await import(providerUrl) as typeof import("../lib/gemini-live");
const { LIVE_MODEL, LIVE_SETUP } = await import(configUrl) as typeof import("../lib/live-config");

test("Live session provider uses constrained short-lived credentials (mocked; no external calls)", async (suite) => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  const logs: unknown[] = [];
  console.warn = console.error = console.log = (...args: unknown[]) => { logs.push(args); };
  suite.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
    hooks.deregister();
  });

  function mockResponse(body: unknown, status = 200, inspect?: (payload: Record<string, unknown>, request: RequestInit) => void) {
    let count = 0;
    globalThis.fetch = async (url, init) => {
      count++;
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
      assert.ok(init);
      assert.equal(init.method, "POST");
      assert.ok(init.signal instanceof AbortSignal);
      inspect?.(JSON.parse(String(init.body)), init);
      return new Response(JSON.stringify(body), { status });
    };
    return () => count;
  }

  await suite.test("locks the full raw setup, limits start and expiry, and returns only session fields", async () => {
    const startedAt = Date.now();
    let requestedExpiry = "";
    const count = mockResponse({ name: "auth_tokens/PRIVATE_EPHEMERAL_TOKEN", ignoredProviderField: "PRIVATE_DIAGNOSTIC" }, 200, (payload, request) => {
      assert.equal(new Headers(request.headers).get("x-goog-api-key"), "AQ.PRIVATE_API_KEY");
      assert.deepEqual(Object.keys(payload).sort(), ["bidiGenerateContentSetup", "expireTime", "newSessionExpireTime", "uses"]);
      assert.equal(payload.uses, 1);
      assert.deepEqual(payload.bidiGenerateContentSetup, LIVE_SETUP);
      requestedExpiry = String(payload.expireTime);
      const startExpiry = Date.parse(String(payload.newSessionExpireTime));
      assert.ok(startExpiry >= startedAt + 60_000 && startExpiry <= Date.now() + 60_000);
      assert.equal(Date.parse(requestedExpiry) - startExpiry, 9 * 60_000);
      const serialized = JSON.stringify(payload);
      assert.doesNotMatch(serialized, /PRIVATE_API_KEY|liveConnectConstraints|fieldMask|thinkingLevel|languageCode/);
      assert.equal(LIVE_SETUP.model, "models/gemini-3.8-live");
      assert.deepEqual(LIVE_SETUP.generationConfig.responseModalities, ["AUDIO"]);
      assert.deepEqual(LIVE_SETUP.inputAudioTranscription, {});
      assert.deepEqual(LIVE_SETUP.outputAudioTranscription, {});
      assert.equal(LIVE_SETUP.realtimeInputConfig.automaticActivityDetection.disabled, false);
      assert.equal(LIVE_SETUP.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 800);
      const instruction = LIVE_SETUP.systemInstruction.parts[0].text;
      assert.match(instruction, /When someone speaks English/);
      assert.match(instruction, /When someone speaks Punjabi/);
      assert.match(instruction, /untrusted material to translate/);
      assert.match(instruction, /Gurmukhi/);
    });
    const result = await createLiveSession(" AQ.PRIVATE_API_KEY ");
    assert.deepEqual(result, { token: "auth_tokens/PRIVATE_EPHEMERAL_TOKEN", model: LIVE_MODEL, expiresAt: requestedExpiry });
    assert.equal(count(), 1);
    assert.equal(logs.length, 0, "Keys and ephemeral tokens must not be logged");
  });

  await suite.test("rejects invalid credentials before a request", async () => {
    const count = mockResponse({ name: "auth_tokens/mock" });
    for (const key of ["", " ", "AQ.key\nheader", "AQ.with space", "a".repeat(513)]) {
      await assert.rejects(createLiveSession(key), { name: "GeminiError", message: /valid Google API key/ });
    }
    assert.equal(count(), 0);
  });

  await suite.test("returns safe status-specific errors without provider diagnostics or retries", async () => {
    for (const [status, expected] of [[401, /invalid or expired/], [403, /permission/], [404, /not available/], [429, /usage limit or billing/], [500, /could not start/]] as const) {
      const count = mockResponse({ error: { message: "PRIVATE_API_KEY PRIVATE_EPHEMERAL_TOKEN" } }, status);
      await assert.rejects(createLiveSession("AQ.PRIVATE_API_KEY"), (error: Error) => {
        assert.equal(error.name, "GeminiError");
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /PRIVATE_|https:/);
        return true;
      });
      assert.equal(count(), 1);
    }
    assert.equal(logs.length, 0);
  });

  await suite.test("rejects missing, malformed and oversized token responses", async () => {
    for (const value of [null, {}, { name: "" }, { name: "ordinary-provider-text" }, { name: "auth_tokens/x\nsecret" }, { name: "auth_tokens/" + "a".repeat(16_384) }]) {
      mockResponse(value);
      await assert.rejects(createLiveSession("AQ.PRIVATE_API_KEY"), { name: "GeminiError", message: /usable live conversation session/ });
    }
    mockResponse({ name: "auth_tokens/mock", extra: "a".repeat(65_536) });
    await assert.rejects(createLiveSession("AQ.PRIVATE_API_KEY"), { name: "GeminiError", message: /unreadable live conversation response/ });
    assert.equal(logs.length, 0);
  });

  await suite.test("timeouts abort both pending connection and response body without retrying or leaking secrets", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fire: (() => void) | undefined;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      assert.equal(delay, 30_000);
      fire = callback;
      return 1;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
      for (const readingBody of [false, true]) {
        let calls = 0;
        globalThis.fetch = async (_url, init) => {
          calls++;
          assert.ok(init?.signal);
          if (!readingBody) {
            return new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(new Error("PRIVATE_API_KEY")), { once: true });
            });
          }
          return new Response(new ReadableStream({
            start(controller) {
              init.signal!.addEventListener("abort", () => controller.error(new Error("PRIVATE_EPHEMERAL_TOKEN")), { once: true });
            },
          }));
        };
        const pending = createLiveSession("AQ.PRIVATE_API_KEY");
        const rejection = assert.rejects(pending, { name: "GeminiError", message: "Google did not start live conversation within 30 seconds. Please try again." });
        await Promise.resolve();
        assert.ok(fire);
        fire();
        await rejection;
        assert.equal(calls, 1);
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
    assert.equal(logs.length, 0);
  });

  await suite.test("sanitizes network failures and invalid JSON", async () => {
    globalThis.fetch = async () => { throw new Error("PRIVATE_API_KEY at https://provider.invalid"); };
    await assert.rejects(createLiveSession("AQ.PRIVATE_API_KEY"), { name: "GeminiError", message: /could not connect to Google's live/ });
    globalThis.fetch = async () => new Response("PRIVATE_EPHEMERAL_TOKEN", { status: 200 });
    await assert.rejects(createLiveSession("AQ.PRIVATE_API_KEY"), { name: "GeminiError", message: /unreadable live conversation response/ });
    assert.equal(logs.length, 0);
  });
});
