import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./live-config") return { url: new URL("../lib/live-config.ts", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { LiveConversation } = await import(new URL("../lib/live-conversation.ts", import.meta.url));
hooks.deregister();

const tick = () => new Promise(resolve => setImmediate(resolve));
const pcm = Buffer.from(new Int16Array([32767, -32768, 1000, -1000]).buffer).toString("base64");

test("continuous browser audio lifecycle (simulated browser and Google)", async suite => {
  const originals = new Map(["window", "document", "navigator", "AudioContext", "AudioWorkletNode", "WebSocket", "fetch"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let contexts, sockets, processors, tracks, calls, microphone;
  let handshake = true;
  class AudioContextMock {
    state = "suspended"; currentTime = 0; destination = {}; onstatechange = null; audioWorklet = { addModule: async () => {} }; outputs = [];
    constructor() { contexts.push(this); }
    async resume() { this.state = "running"; this.onstatechange?.(); }
    async suspend() { this.state = "suspended"; this.onstatechange?.(); }
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); return { duration: length / rate, data, getChannelData: () => data }; }
    createBufferSource() {
      const source = { buffer: null, onended: null, stopped: false, connect() {}, disconnect() {}, start(when) { this.when = when; }, stop() { this.stopped = true; } };
      this.outputs.push(source); return source;
    }
  }
  class WorkletMock {
    port = { onmessage: null, close() {} };
    constructor() { processors.push(this); }
    connect() {} disconnect() {}
  }
  class SocketMock {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; bufferedAmount = 0; sent = []; onopen = null; onmessage = null; onclose = null; onerror = null;
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) { const data = JSON.parse(raw); this.sent.push(data); if (data.setup && handshake) queueMicrotask(() => this.emit({ setupComplete: {} })); }
    emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  function set(name, value) { Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
  function reset() {
    contexts = []; sockets = []; processors = []; tracks = []; calls = []; handshake = true;
    const window = new EventTarget(); Object.assign(window, { AudioContext: AudioContextMock, AudioWorkletNode: WorkletMock });
    const document = new EventTarget(); document.hidden = false;
    microphone = async () => {
      const track = { enabled: true, stopped: false, onended: null, stop() { this.stopped = true; } }; tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };
    set("window", window); set("document", document); set("navigator", { mediaDevices: { getUserMedia: (...args) => microphone(...args) } });
    set("AudioContext", AudioContextMock); set("AudioWorkletNode", WorkletMock); set("WebSocket", SocketMock);
    set("fetch", async (url, init) => {
      calls.push({ url, init });
      return Response.json({ token: "auth_tokens/test-token", model: "gemini-3.8-live", expiresAt: new Date(Date.now() + 600000).toISOString() });
    });
    const states = [], transcripts = [], errors = [];
    const client = new LiveConversation({ onState: value => states.push(value), onTranscript: value => transcripts.push(value), onError: value => errors.push(value) });
    return { client, states, transcripts, errors };
  }
  suite.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

  await suite.test("two alternating turns share one socket and one token; playback cannot feed its own translation into the mic", async () => {
    const { client, states, transcripts, errors } = reset();
    try {
      await client.start();
      assert.equal(states.at(-1), "listening");
      assert.equal(calls.length, 1); assert.equal(sockets.length, 1);
      assert.match(sockets[0].url, /Constrained\?access_token=auth_tokens%2Ftest-token$/);
      const sendMic = () => processors[0].port.onmessage({ data: new Int16Array([1000, -1000]).buffer });
      sendMic();
      assert.notEqual(sockets[0].sent.at(-1).realtimeInput.audio.data, "AAAAAA==", "first words are not muted before playback");
      sockets[0].emit({ serverContent: { inputTranscription: { text: "Hello" }, outputTranscription: { text: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }, { inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } } });
      await tick();
      assert.equal(contexts[0].outputs.length, 2, "all audio parts play");
      assert.equal(contexts[0].outputs[0].buffer.data[1], -1, "little-endian PCM decoded correctly");
      assert.equal(states.at(-1), "speaking");
      sendMic(); assert.equal(sockets[0].sent.at(-1).realtimeInput.audio.data, "AAAAAA==", "own speaker output is gated");
      sockets[0].emit({ serverContent: { turnComplete: true } }); await tick();
      contexts[0].currentTime = 2; contexts[0].outputs.forEach(source => source.onended?.());
      assert.equal(states.at(-1), "listening");
      sendMic(); assert.notEqual(sockets[0].sent.at(-1).realtimeInput.audio.data, "AAAAAA==");
      sockets[0].emit({ serverContent: { inputTranscription: { text: "ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?" }, outputTranscription: { text: "How are you?" }, turnComplete: true } }); await tick();
      assert.deepEqual(transcripts.at(-1), { source: "Helloਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?", translation: "How are you?", final: true });
      assert.equal(calls.length, 1); assert.deepEqual(errors, []);
    } finally { client.stop(); }
    assert.equal(tracks[0].stopped, true); assert.equal(contexts[0].state, "closed"); assert.equal(sockets[0].readyState, 3);
  });

  await suite.test("pause disables capture and playback, resume reuses the connection, backgrounding pauses", async () => {
    const { client, states, errors } = reset();
    try {
      await client.start();
      sockets[0].emit({ serverContent: { inputTranscription: { text: "Hello" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } } }); await tick();
      client.pause();
      assert.equal(tracks[0].enabled, false); assert.equal(contexts[0].outputs[0].stopped, true); assert.equal(states.at(-1), "paused");
      assert.deepEqual(sockets[0].sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
      const before = sockets[0].sent.length;
      processors[0].port.onmessage({ data: new Int16Array([1000]).buffer });
      assert.equal(sockets[0].sent.length, before);
      sockets[0].emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] }, turnComplete: true } }); await tick();
      assert.equal(contexts[0].outputs.length, 1);
      await client.resume();
      assert.equal(tracks[0].enabled, true); assert.equal(states.at(-1), "listening"); assert.equal(calls.length, 1);
      document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
      assert.equal(states.at(-1), "paused"); assert.deepEqual(errors, []);
    } finally { client.stop(); }
  });

  await suite.test("stop while permission is pending releases a late microphone without minting a token", async () => {
    const { client, errors } = reset();
    let grant; microphone = () => new Promise(resolve => { grant = resolve; });
    const pending = client.start();
    client.stop();
    const track = { stopped: false, stop() { this.stopped = true; } };
    grant({ getTracks: () => [track] });
    await pending;
    assert.equal(track.stopped, true); assert.equal(contexts[0].state, "closed"); assert.equal(calls.length, 0); assert.deepEqual(errors, []);
  });

  await suite.test("stop during handshake settles start and stale events cannot restart audio", async () => {
    const { client, errors } = reset(); handshake = false;
    const pending = client.start(); await tick();
    assert.equal(sockets.length, 1);
    client.stop(); await pending;
    sockets[0].emit({ setupComplete: {}, serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }] } } }); await tick();
    assert.equal(contexts[0].outputs.length, 0); assert.equal(tracks[0].stopped, true); assert.deepEqual(errors, []);
  });

  await suite.test("permission denial and expired family session release resources and report useful errors", async () => {
    let state = reset(); microphone = async () => { throw new DOMException("denied", "NotAllowedError"); };
    await state.client.start();
    assert.match(state.errors[0], /Allow microphone/); assert.equal(contexts[0].state, "closed"); assert.equal(calls.length, 0);
    state = reset(); let expired = false; window.addEventListener("saathi-session-expired", () => { expired = true; });
    set("fetch", async () => Response.json({ error: "Please enter your family code to continue." }, { status: 401 }));
    await state.client.start();
    assert.equal(expired, true); assert.match(state.errors[0], /family code/); assert.equal(tracks[0].stopped, true); assert.equal(sockets.length, 0);
  });

  await suite.test("backpressure ends capture rather than growing an unbounded audio queue", async () => {
    const { client, errors } = reset();
    await client.start(); sockets[0].bufferedAmount = 300000;
    processors[0].port.onmessage({ data: new Int16Array([1000]).buffer });
    assert.match(errors[0], /too slow/); assert.equal(tracks[0].stopped, true); assert.equal(sockets[0].readyState, 3);
  });

  await suite.test("late source transcripts never erase a completed translation", async () => {
    const { client, transcripts } = reset();
    try {
      await client.start();
      sockets[0].emit({ serverContent: { outputTranscription: { text: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ" }, turnComplete: true } }); await tick();
      sockets[0].emit({ serverContent: { inputTranscription: { text: "Hello", finished: true } } }); await tick();
      assert.equal(transcripts.at(-1).translation, "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ");
      assert.equal(transcripts.at(-1).source, "Hello\n");
      sockets[0].emit({ serverContent: { inputTranscription: { text: "ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?" } } }); await tick();
      assert.equal(transcripts.at(-1).translation, "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ");
      sockets[0].emit({ serverContent: { outputTranscription: { text: "How are you?" }, turnComplete: true } }); await tick();
      assert.equal(transcripts.at(-1).translation, "How are you?");
      assert.equal(transcripts.at(-1).source, "Hello\nਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?");
    } finally { client.stop(); }
  });

  await suite.test("backgrounding during microphone permission leaves a late grant muted", async () => {
    const { client, states } = reset();
    let grant; microphone = () => new Promise(resolve => { grant = resolve; });
    const pending = client.start();
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    const track = { enabled: true, stop() {}, onended: null };
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    try {
      await pending;
      assert.equal(track.enabled, false); assert.equal(states.at(-1), "paused");
    } finally { client.stop(); }
  });

  await suite.test("failed audio unlock offers Resume instead of falsely showing a listening microphone", async () => {
    const { client, states } = reset();
    const resume = AudioContextMock.prototype.resume;
    AudioContextMock.prototype.resume = async function () { throw new DOMException("blocked", "NotAllowedError"); };
    try {
      await client.start();
      assert.equal(states.at(-1), "paused"); assert.equal(tracks[0].enabled, false);
      AudioContextMock.prototype.resume = resume;
      await client.resume();
      assert.equal(states.at(-1), "listening"); assert.equal(tracks[0].enabled, true);
    } finally { AudioContextMock.prototype.resume = resume; client.stop(); }
  });
});
