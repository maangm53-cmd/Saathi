import assert from "node:assert/strict";

const target = new URL(process.argv[2] || "https://saathi-punjabi-family.guri007.chatgpt.site");
if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
  throw new Error("Supply an HTTPS site origin without credentials, path, query, or fragment.");
}
async function request(path, method = "GET") {
  return fetch(new URL(path, target), {
    method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: method === "POST" ? { "Content-Type": "application/json", Origin: target.origin } : {},
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
const checks = [
  ["public page", async () => { const r = await request("/"); assert.equal(r.status, 200); assert.match(await r.text(), /ਸਾਥੀ|Saathi/); }],
  ["microphone asset", async () => { const r = await request("/saathi-microphone.js"); assert.equal(r.status, 200); assert.match(await r.text(), /registerProcessor\("saathi-microphone"/); }],
  ["configured and locked for visitors", async () => {
    const r = await request("/api/status"); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control") || "", /no-store/);
    assert.deepEqual(await r.json(), { configured: true, authenticated: false, isOwner: false, needsLogin: true });
  }],
  ["live sessions require family access", async () => { const r = await request("/api/live-session", "POST"); assert.equal(r.status, 401); assert.match(r.headers.get("cache-control") || "", /no-store/); }],
  ["translations require family access", async () => { const r = await request("/api/process", "POST"); assert.equal(r.status, 401); }],
  ["feedback stays organizer-only", async () => { const r = await request("/api/feedback"); assert.equal(r.status, 403); }],
];
const results = await Promise.allSettled(checks.map(async ([name, run]) => { await run(); return name; }));
let failed = false;
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  if (result.status === "fulfilled") console.log(`PASS ${result.value}`);
  else { failed = true; console.error(`FAIL ${checks[i][0]}: ${result.reason instanceof Error ? result.reason.message : "check failed"}`); }
}
if (failed) process.exitCode = 1;
else console.log("Production checks passed without credentials or AI calls.");
