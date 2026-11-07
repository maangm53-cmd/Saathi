import { LIVE_SETUP, LIVE_WEBSOCKET_ENDPOINT } from "./live-config";

export type LiveState = "connecting" | "listening" | "translating" | "speaking" | "paused" | "ended";
type Callbacks = {
  onState: (state: LiveState) => void;
  onTranscript: (turn: { source: string; translation: string; final: boolean }) => void;
  onError: (message: string) => void;
};
type LiveEvent = {
  setupComplete?: object;
  error?: unknown;
  goAway?: { timeLeft?: string };
  serverContent?: {
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string };
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
};

function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

/** One direct, short-lived Google audio stream. The saved API key stays on
 * the server; only a single-use, setup-constrained session token reaches here. */
export class LiveConversation {
  private callbacks: Callbacks;
  private generation = 0;
  private running = false;
  private paused = false;
  private ready = false;
  private state: LiveState = "ended";
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private request: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playbackUntil = 0;
  private turnDone = true;
  private outputTurnDone = true;
  private discardTurn = false;
  private transcript = { source: "", translation: "" };
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeReject: ((error: Error) => void) | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(callbacks: Callbacks) { this.callbacks = callbacks; }

  private setState(state: LiveState) {
    if (state !== this.state) { this.state = state; this.callbacks.onState(state); }
  }

  private fail(message: string) {
    if (!this.running) return;
    this.stop();
    this.callbacks.onError(message);
  }

  private onVisibility = () => { if (document.hidden && this.running && !this.paused) this.pause(); };
  private onPageHide = () => this.stop();

  private async keepAwake() {
    if (!navigator.wakeLock || document.hidden || !this.running || this.paused) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!this.running || this.paused) { await lock.release(); return; }
      this.wakeLock = lock;
    } catch { /* The conversation also works without screen wake lock. */ }
  }

  async start(): Promise<void> {
    this.stop();
    const current = ++this.generation;
    this.running = true;
    this.paused = false;
    this.ready = false;
    this.turnDone = true;
    this.outputTurnDone = true;
    this.discardTurn = false;
    this.transcript = { source: "", translation: "" };
    this.setState("connecting");
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
        throw new Error("ਲਾਈਵ ਗੱਲਬਾਤ ਲਈ Safari ਵਿੱਚ ਸਾਥੀ ਖੋਲ੍ਹੋ ਜੀ। / Open Saathi in Safari to use live conversation.");
      }
      // Resume inside the Start button's user gesture, before any network await.
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      const unlocked = context.resume().catch(() => {});
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!this.running || current !== this.generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      this.stream = microphone;
      if (this.paused) microphone.getAudioTracks().forEach(track => { track.enabled = false; });
      microphone.getTracks().forEach(track => { track.onended = () => this.fail("ਮਾਈਕ ਬੰਦ ਹੋ ਗਿਆ। ਗੱਲਬਾਤ ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / The microphone stopped. Tap Start conversation again."); });
      await unlocked;
      await context.audioWorklet.addModule("/saathi-microphone.js");
      if (!this.running || current !== this.generation) return;
      this.input = context.createMediaStreamSource(microphone);
      this.processor = new AudioWorkletNode(context, "saathi-microphone", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.silentSink = context.createGain();
      this.silentSink.gain.value = 0;
      this.input.connect(this.processor);
      this.processor.connect(this.silentSink);
      this.silentSink.connect(context.destination);
      this.processor.port.onmessage = event => { if (current === this.generation) this.sendAudio(event.data as ArrayBuffer); };
      context.onstatechange = () => {
        if (this.running && !this.paused && (context.state === "suspended" || (context.state as string) === "interrupted")) this.pause();
      };
      if (context.state !== "running" && !this.paused) this.pause();
      const controller = new AbortController();
      this.request = controller;
      const timeout = setTimeout(() => controller.abort(), 30000);
      let session: { token: string; model: string; expiresAt: string };
      try {
        const response = await fetch("/api/live-session", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
        const body = await response.json() as { token: string; model: string; expiresAt: string; error?: string };
        if (!response.ok) {
          if (response.status === 401) window.dispatchEvent(new Event("saathi-session-expired"));
          throw new Error("ਲਾਈਵ ਕਨੈਕਸ਼ਨ ਨਹੀਂ ਹੋ ਸਕਿਆ। / " + (body.error || "Could not start the live connection. Please try again."));
        }
        session = body;
      } finally { clearTimeout(timeout); }
      if (!this.running || current !== this.generation) return;
      if (typeof session.token !== "string" || !session.token || session.model !== LIVE_SETUP.model.replace(/^models\//, "")) throw new Error("ਲਾਈਵ ਕਨੈਕਸ਼ਨ ਨਹੀਂ ਬਣਿਆ। ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜੀ। / The live connection could not be prepared. Please try again.");
      const lifetime = Date.parse(session.expiresAt) - Date.now();
      if (!Number.isFinite(lifetime) || lifetime < 5000) throw new Error("ਕਨੈਕਸ਼ਨ ਦਾ ਸਮਾਂ ਮੁੱਕ ਗਿਆ। ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / The connection expired. Tap Start again.");
      const socket = new WebSocket(`${LIVE_WEBSOCKET_ENDPOINT}?access_token=${encodeURIComponent(session.token)}`);
      this.socket = socket;
      let messages = Promise.resolve();
      await new Promise<void>((resolve, reject) => {
        this.handshakeReject = reject;
        this.handshakeTimer = setTimeout(() => reject(new Error("Google ਨਾਲ ਲਾਈਵ ਕਨੈਕਸ਼ਨ ਵਿੱਚ ਸਮਾਂ ਲੱਗ ਰਿਹਾ ਹੈ। ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜੀ। / Google took too long to open the live connection. Please try again.")), 20000);
        socket.onopen = () => { if (this.running && current === this.generation) socket.send(JSON.stringify({ setup: LIVE_SETUP })); };
        socket.onmessage = event => {
          messages = messages.then(async () => {
            if (!this.running || current !== this.generation) return;
            const raw = typeof event.data === "string" ? event.data : event.data instanceof Blob ? await event.data.text() : new TextDecoder().decode(event.data);
            if (!this.running || current !== this.generation) return;
            const data = JSON.parse(raw) as LiveEvent;
            if (data.setupComplete) {
              this.ready = true;
              if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
              this.handshakeTimer = null;
              this.handshakeReject = null;
              this.setState(this.paused ? "paused" : "listening");
              resolve();
            }
            if (data.error) throw new Error("ਲਾਈਵ ਆਵਾਜ਼ ਸੇਵਾ ਨੇ ਕਨੈਕਸ਼ਨ ਨਹੀਂ ਮੰਨਿਆ। / Google could not start live voice. The family organizer can check Live API access in Google AI Studio.");
            this.receive(data);
          }).catch(error => {
            if (!this.running || current !== this.generation) return;
            const safe = error instanceof Error && error.message.includes(" / ") ? error.message : "ਲਾਈਵ ਆਵਾਜ਼ ਵਿੱਚ ਰੁਕਾਵਟ ਆਈ। ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / Live audio was interrupted. Tap Start conversation again.";
            reject(new Error(safe));
            this.fail(safe);
          });
        };
        socket.onerror = () => {
          const error = new Error("ਲਾਈਵ ਕਨੈਕਸ਼ਨ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਇੰਟਰਨੈੱਟ ਚੈੱਕ ਕਰਕੇ ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜੀ। / Could not connect to live voice. Check the internet and try again.");
          reject(error);
          if (this.ready) this.fail(error.message);
        };
        socket.onclose = () => {
          const error = new Error("ਲਾਈਵ ਗੱਲਬਾਤ ਬੰਦ ਹੋ ਗਈ। ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / The live connection ended. Tap Start conversation again.");
          reject(error);
          if (this.running && current === this.generation && this.ready) this.fail(error.message);
        };
      });
      if (!this.running || current !== this.generation) return;
      this.expiryTimer = setTimeout(() => this.fail("ਇਸ ਗੱਲਬਾਤ ਦੇ 10 ਮਿੰਟ ਪੂਰੇ ਹੋ ਗਏ। ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / This conversation has reached 10 minutes. Tap Start conversation to continue."), Math.max(0, Math.min(Date.parse(session.expiresAt) - Date.now() - 2000, 10 * 60 * 1000)));
      void this.keepAwake();
    } catch (error) {
      if (!this.running || current !== this.generation) return;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      const text = denied ? "ਮਾਈਕ ਦੀ ਇਜਾਜ਼ਤ ਦਿਓ ਜੀ। / Allow microphone access in Safari, then tap Start conversation again." : error instanceof Error && error.message.includes(" / ") ? error.message : error instanceof Error && error.name === "AbortError" ? "ਕਨੈਕਸ਼ਨ ਵਿੱਚ ਸਮਾਂ ਲੱਗ ਰਿਹਾ ਹੈ। ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜੀ। / The live connection timed out. Please try again." : "ਲਾਈਵ ਗੱਲਬਾਤ ਸ਼ੁਰੂ ਨਹੀਂ ਹੋ ਸਕੀ। Safari ਵਿੱਚ ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜੀ। / Could not start live conversation. Try again in Safari.";
      this.fail(text);
    }
  }

  private sendAudio(data: ArrayBuffer) {
    if (!this.running || !this.ready || this.paused || !this.context || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 256 * 1024) { this.fail("ਇੰਟਰਨੈੱਟ ਹੌਲੀ ਹੈ। ਨੇੜੇ ਜਾ ਕੇ ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / The connection is too slow for live audio. Try a stronger connection and start again."); return; }
    // Do not translate our own loudspeaker. Continue the stream with silence
    // during playback, then automatically listen for the next speaker.
    const muted = this.discardTurn || (this.playbackUntil > 0 && this.context.currentTime < this.playbackUntil + .2);
    const bytes = muted ? new Uint8Array(data.byteLength) : new Uint8Array(data);
    this.socket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64(bytes) } } }));
  }

  private receive(event: LiveEvent) {
    if (event.goAway && !this.closeTimer) {
      const seconds = parseFloat(event.goAway.timeLeft || "0");
      this.closeTimer = setTimeout(() => this.fail("ਲਾਈਵ ਸੈਸ਼ਨ ਮੁੱਕ ਗਿਆ। ਗੱਲਬਾਤ ਜਾਰੀ ਰੱਖਣ ਲਈ ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / The live session ended. Tap Start conversation to continue."), Math.max(0, (Number.isFinite(seconds) ? seconds - 1 : 0) * 1000));
    }
    const content = event.serverContent;
    if (!content) return;
    if (content.interrupted) this.clearPlayback();
    if (this.paused) this.discardTurn = !content.turnComplete;
    if (!this.paused && !this.discardTurn) {
      if (content.inputTranscription?.text) {
        // Input transcription has no ordering guarantee relative to output.
        // Keep recent speech independently; a delayed input chunk must never
        // erase or be presented as an exact pair with a completed translation.
        this.transcript.source = (this.transcript.source + content.inputTranscription.text).slice(-2000);
        if (!this.sources.size) this.setState("translating");
      }
      if (content.inputTranscription?.finished && !this.transcript.source.endsWith("\n")) this.transcript.source += "\n";
      if (content.outputTranscription?.text) {
        if (this.outputTurnDone) { this.transcript.translation = ""; this.outputTurnDone = false; }
        this.turnDone = false;
        this.transcript.translation = (this.transcript.translation + content.outputTranscription.text).slice(-12000);
      }
      for (const part of content.modelTurn?.parts || []) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/pcm")) { this.turnDone = false; this.playAudio(part.inlineData.data, part.inlineData.mimeType); }
      }
      if (content.inputTranscription?.text || content.outputTranscription?.text || content.turnComplete) this.callbacks.onTranscript({ ...this.transcript, final: !!content.turnComplete });
    }
    if (content.turnComplete) {
      this.turnDone = true;
      this.outputTurnDone = true;
      this.discardTurn = false;
      if (!this.paused && !this.sources.size) this.setState("listening");
    }
  }

  private playAudio(data: string, mimeType: string) {
    const context = this.context;
    if (!context || this.paused) return;
    const binary = atob(data);
    if (!binary.length || binary.length % 2) return;
    const rate = Number(mimeType.match(/rate=(\d+)/)?.[1] || 24000);
    if (rate < 8000 || rate > 48000) return;
    const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    if (this.playbackUntil - context.currentTime > 45) throw new Error("ਆਵਾਜ਼ ਵਿੱਚ ਦੇਰੀ ਹੋ ਰਹੀ ਹੈ। ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / Audio has fallen behind. Tap Start conversation again.");
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const when = Math.max(context.currentTime + .035, this.playbackUntil);
    this.playbackUntil = when + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.running && !this.paused && !this.sources.size) this.setState(this.turnDone ? "listening" : "translating");
    };
    source.start(when);
    this.setState("speaking");
  }

  private clearPlayback() {
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* Already finished. */ } source.disconnect(); }
    this.sources.clear();
    this.playbackUntil = this.context?.currentTime || 0;
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.discardTurn = !this.turnDone;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    if (this.socket?.readyState === WebSocket.OPEN && this.ready) this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    this.clearPlayback();
    void this.context?.suspend().catch(() => {});
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.setState("paused");
  }

  async resume(): Promise<void> {
    if (!this.running || !this.paused) return;
    try {
      await this.context?.resume();
      if (!this.running) return;
      this.paused = false;
      this.stream?.getAudioTracks().forEach(track => { track.enabled = true; });
      this.setState(this.ready ? "listening" : "connecting");
      void this.keepAwake();
    } catch { this.fail("ਆਵਾਜ਼ ਮੁੜ ਨਹੀਂ ਖੁੱਲ੍ਹੀ। ਗੱਲਬਾਤ ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ ਜੀ। / Audio could not resume. Tap Start conversation again."); }
  }

  stop(): void {
    this.generation++;
    this.running = false;
    this.ready = false;
    this.paused = false;
    this.request?.abort(); this.request = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.handshakeTimer = this.expiryTimer = this.closeTimer = null;
    this.handshakeReject?.(new Error("Stopped")); this.handshakeReject = null;
    if (this.socket) {
      this.socket.onmessage = this.socket.onopen = this.socket.onerror = this.socket.onclose = null;
      if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "Conversation ended");
      this.socket = null;
    }
    if (this.processor) { this.processor.port.onmessage = null; this.processor.port.close(); this.processor.disconnect(); this.processor = null; }
    this.input?.disconnect(); this.input = null;
    this.silentSink?.disconnect(); this.silentSink = null;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    this.clearPlayback();
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); this.context = null; }
    void this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.setState("ended");
  }
}
