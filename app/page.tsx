"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveConversation } from "@/lib/live-conversation";
import { ArrowLeft, AudioLines, Camera, Check, ChevronRight, CircleHelp, Home as HomeIcon, LockKeyhole, MailOpen, Mic, Pause, Play, Settings, ShieldCheck, Square, ThumbsDown, ThumbsUp, Volume2, X } from "lucide-react";

type Screen = "home" | "conversation" | "mail" | "settings";
type Direction = "en-pa" | "pa-en";
type LiveState = "connecting" | "listening" | "translating" | "speaking" | "paused" | "ended";
type LiveTranscript = { source: string; translation: string; final: boolean };
type Reading = "explanation" | "translation" | "nextSteps";
type Status = { configured: boolean; authenticated: boolean; isOwner: boolean; needsLogin: boolean };
type Result = { source: string; translation: string; explanation: string; nextSteps: string[]; uncertainties: string[]; speechText: string };
type Media = { data: string; mimeType: string };
type Feedback = { rating: string; mode: string; note?: string; createdAt: number };

function message(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "ਬੇਨਤੀ ਨੂੰ ਸਮਾਂ ਲੱਗ ਰਿਹਾ ਹੈ। ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ। / The request timed out. Please try again.";
  return error instanceof Error ? error.message : "ਕੁਝ ਗਲਤ ਹੋ ਗਿਆ। ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ। / Please try again.";
}

async function jsonRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store", signal });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("saathi-session-expired"));
    throw new Error(data.error || "ਸੇਵਾ ਨਾਲ ਸੰਪਰਕ ਨਹੀਂ ਹੋ ਸਕਿਆ। / Could not reach the service. Please try again.");
  }
  return data as T;
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ਫਾਈਲ ਪੜ੍ਹੀ ਨਹੀਂ ਜਾ ਸਕੀ। / Could not read this file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 2200) {
    const portion = remaining.slice(0, 2200);
    const sentenceEnd = Math.max(portion.lastIndexOf("।"), portion.lastIndexOf(". "), portion.lastIndexOf("? "), portion.lastIndexOf("! "), portion.lastIndexOf("\n"));
    const wordEnd = portion.lastIndexOf(" ");
    const boundary = sentenceEnd > 1100 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : 2200;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function prepareImage(file: File): Promise<Media> {
  if (file.size > 25 * 1024 * 1024) throw new Error("ਫੋਟੋ ਬਹੁਤ ਵੱਡੀ ਹੈ। / Please choose a photo smaller than 25 MB.");
  if (file.type && !file.type.startsWith("image/")) throw new Error("ਕਿਰਪਾ ਕਰਕੇ ਫੋਟੋ ਚੁਣੋ। / Choose a photo, not a document or video.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("ਫੋਟੋ ਖੁੱਲ੍ਹ ਨਹੀਂ ਸਕੀ। / Try taking a new photo or use a JPEG/PNG screenshot.")); image.src = url; });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("ਫੋਟੋ ਤਿਆਰ ਨਹੀਂ ਹੋ ਸਕੀ। / This browser cannot prepare the photo.");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("ਫੋਟੋ ਤਿਆਰ ਨਹੀਂ ਹੋ ਸਕੀ। / Could not prepare the photo.")), "image/jpeg", .88));
    return { data: await blobBase64(blob), mimeType: "image/jpeg" };
  } finally { URL.revokeObjectURL(url); }
}

function Bilingual({ pa, en }: { pa: string; en: string }) { return <span className="bilingual"><span lang="pa">{pa}</span><small lang="en">{en}</small></span>; }

export default function Saathi() {
  const [status, setStatus] = useState<Status | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [direction, setDirection] = useState<Direction>("en-pa");
  const [reading, setReading] = useState<Reading>("explanation");
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<Media | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [liveState, setLiveState] = useState<LiveState>("ended");
  const [liveStarted, setLiveStarted] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscript>({ source: "", translation: "", final: false });
  const [playing, setPlaying] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [code, setCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [setupAcknowledged, setSetupAcknowledged] = useState(false);
  const live = useRef<LiveConversation | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const audioCache = useRef<Map<string, Blob>>(new Map());
  const activeRequest = useRef<AbortController | null>(null);
  const speechRequest = useRef<AbortController | null>(null);
  const speechGeneration = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const photoInput = useRef<HTMLInputElement>(null);
  const resultElement = useRef<HTMLElement>(null);

  const refreshStatus = useCallback(async () => {
    const data = await jsonRequest<Status>("/api/status");
    if (mounted.current) setStatus(data);
    return data;
  }, []);

  const stopPlayback = useCallback(() => {
    speechGeneration.current += 1;
    speechRequest.current?.abort(); speechRequest.current = null;
    if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; }
    setPlaying(false); setLoadingAudio(false);
  }, []);

  const stopLive = useCallback((reset = false) => {
    const session = live.current;
    live.current = null;
    session?.stop();
    if (mounted.current) {
      setLiveState("ended");
      if (reset) { setLiveStarted(false); setLiveTranscript({ source: "", translation: "", final: false }); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshStatus().catch(e => setError(message(e)));
    const sessionExpired = () => {
      stopLive(true); stopPlayback(); generation.current += 1; activeRequest.current?.abort();
      setResult(null); setPhoto(null); setText(""); setBusy("");
      void refreshStatus().catch(() => {});
    };
    const leavePage = () => stopLive();
    const hidePage = () => { if (document.visibilityState === "hidden") live.current?.pause(); };
    window.addEventListener("pagehide", leavePage);
    document.addEventListener("visibilitychange", hidePage);
    window.addEventListener("saathi-session-expired", sessionExpired);
    try { setLargeText(localStorage.getItem("saathi-large-text") === "yes"); } catch { /* Preferences are optional. */ }
    return () => {
      mounted.current = false; generation.current += 1;
      window.removeEventListener("saathi-session-expired", sessionExpired);
      window.removeEventListener("pagehide", leavePage);
      document.removeEventListener("visibilitychange", hidePage);
      activeRequest.current?.abort(); speechRequest.current?.abort();
      stopLive(); audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioCache.current.clear();
    };
  }, [refreshStatus, stopLive, stopPlayback]);

  function clearCurrent() {
    generation.current += 1; activeRequest.current?.abort(); stopPlayback();
    stopLive(true); setBusy(""); setResult(null); setPhoto(null); setText(""); setError(""); setNotice(""); setFeedbackSaved(false); setFeedbackNote("");
    audioCache.current.clear();
    if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; }
  }

  function navigate(next: Screen) { clearCurrent(); setScreen(next); setReading("explanation"); }

  async function playSpeech(content: string, language: "pa" | "en", slow = false, automatic = false) {
    if (!content.trim()) return;
    stopPlayback(); setNotice(""); setLoadingAudio(true);
    const playback = speechGeneration.current;
    const request = new AbortController(); speechRequest.current = request;
    const parts = speechChunks(content);
    try {
      for (const part of parts) {
        if (request.signal.aborted || !mounted.current || speechGeneration.current !== playback) return;
        setLoadingAudio(true);
        const key = language + ":" + part;
        let blob = audioCache.current.get(key);
        if (!blob) {
          const timer = setTimeout(() => request.abort(), 110000);
          try {
            const response = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: part, language }), signal: request.signal, credentials: "same-origin", cache: "no-store" });
            if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; if (response.status === 401) void refreshStatus().catch(() => {}); throw new Error(data.error || "ਆਵਾਜ਼ ਤਿਆਰ ਨਹੀਂ ਹੋ ਸਕੀ। / Could not prepare the audio. Try Listen again."); }
            blob = await response.blob();
            if (!blob.size) throw new Error("ਆਵਾਜ਼ ਨਹੀਂ ਮਿਲੀ। / No audio was returned. Please try again.");
            if (audioCache.current.size >= 12) audioCache.current.clear();
            audioCache.current.set(key, blob);
          } finally { clearTimeout(timer); }
        }
        if (request.signal.aborted || !mounted.current || speechGeneration.current !== playback) return;
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioUrl.current = URL.createObjectURL(blob);
        const player = audio.current || new Audio(); audio.current = player;
        player.src = audioUrl.current; player.playbackRate = slow ? .8 : 1;
        setLoadingAudio(false);
        const finished = await new Promise<boolean>((resolve, reject) => {
          const stop = () => { request.signal.removeEventListener("abort", stop); resolve(false); };
          request.signal.addEventListener("abort", stop, { once: true });
          player.onended = () => { request.signal.removeEventListener("abort", stop); resolve(true); };
          player.onerror = () => { request.signal.removeEventListener("abort", stop); reject(new Error("ਆਵਾਜ਼ ਚੱਲ ਨਹੀਂ ਸਕੀ। / Audio could not play. Please try Listen again.")); };
          player.play().then(() => { if (!request.signal.aborted) setPlaying(true); }).catch(() => {
            request.signal.removeEventListener("abort", stop);
            if (!request.signal.aborted) setNotice(automatic ? "ਸੁਣਨ ਲਈ ਹੇਠਾਂ ‘ਸੁਣੋ’ ਦਬਾਓ। / Tap Listen below to hear the translation." : "ਸੁਣੋ ਦੁਬਾਰਾ ਦਬਾਓ ਅਤੇ ਫੋਨ ਦੀ ਆਵਾਜ਼ ਚੈੱਕ ਕਰੋ। / Tap Listen again and check your phone’s volume.");
            resolve(false);
          });
        });
        if (!finished) return;
      }
    } catch (e) {
      if (!request.signal.aborted && mounted.current) setError(message(e));
      else if (speechRequest.current === request && mounted.current) setNotice("ਆਵਾਜ਼ ਬਣਨ ਵਿੱਚ ਸਮਾਂ ਲੱਗ ਰਿਹਾ ਹੈ। ‘ਸੁਣੋ’ ਦੁਬਾਰਾ ਦਬਾਓ। / Audio timed out. Try Listen again.");
    } finally { if (speechRequest.current === request) { speechRequest.current = null; if (mounted.current) { setLoadingAudio(false); setPlaying(false); } } }
  }

  async function processInput(input: { text?: string; audio?: Media; image?: Media }, mode: "conversation" | "mail" = screen === "conversation" ? "conversation" : "mail", selectedDirection = direction) {
    stopPlayback(); setError(""); setNotice(""); setResult(null); setFeedbackSaved(false); setFeedbackNote(""); setReading("explanation");
    setBusy(mode === "conversation" ? "ਅਨੁਵਾਦ ਕਰ ਰਿਹਾ ਹਾਂ… / Translating…" : "ਪੜ੍ਹ ਕੇ ਸਮਝਾ ਰਿਹਾ ਹਾਂ… / Reading and explaining…");
    const current = ++generation.current;
    activeRequest.current?.abort(); const request = new AbortController(); activeRequest.current = request;
    const timer = setTimeout(() => request.abort(), 110000);
    try {
      const data = await jsonRequest<Result>("/api/process", { kind: mode, direction: selectedDirection, ...input }, request.signal);
      if (!mounted.current || generation.current !== current) return;
      setResult(data); setPhoto(null); setText("");
      requestAnimationFrame(() => resultElement.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      void playSpeech(data.speechText || (mode === "mail" ? data.explanation : data.translation), mode === "conversation" && selectedDirection === "pa-en" ? "en" : "pa", false, true);
    } catch (e) { if (mounted.current && generation.current === current) { setError(message(e)); void refreshStatus().catch(() => {}); } }
    finally { clearTimeout(timer); if (generation.current === current && mounted.current) setBusy(""); }
  }

  async function startLive() {
    stopLive(true); stopPlayback(); generation.current += 1; activeRequest.current?.abort();
    setBusy(""); setError(""); setNotice(""); setResult(null); setText(""); setFeedbackSaved(false); setFeedbackNote("");
    setLiveStarted(true); setLiveState("connecting");
    const session = new LiveConversation({
      onState: (next: LiveState) => { if (mounted.current && live.current === session) setLiveState(next); },
      onTranscript: (transcript: LiveTranscript) => { if (mounted.current && live.current === session) setLiveTranscript(transcript); },
      onError: (detail: string) => {
        if (!mounted.current || live.current !== session) return;
        stopLive(); setError(detail); void refreshStatus().catch(() => {});
      },
    });
    live.current = session;
    try { await session.start(); }
    catch (e) {
      if (mounted.current && live.current === session) { stopLive(); setError(message(e)); void refreshStatus().catch(() => {}); }
    }
  }

  async function resumeLive() {
    const session = live.current;
    if (!session) return;
    setError("");
    try { await session.resume(); }
    catch (e) { if (mounted.current && live.current === session) { stopLive(); setError(message(e)); } }
  }

  async function choosePhoto(file?: File) {
    if (!file) return;
    stopPlayback(); setError(""); setResult(null); setBusy("ਫੋਟੋ ਤਿਆਰ ਕਰ ਰਿਹਾ ਹਾਂ… / Preparing photo…");
    const current = ++generation.current;
    try { const data = await prepareImage(file); if (mounted.current && current === generation.current) { setPhoto(data); setText(""); } }
    catch (e) { if (current === generation.current) setError(message(e)); }
    finally { if (current === generation.current) setBusy(""); if (photoInput.current) photoInput.current.value = ""; }
  }

  async function login(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy("ਖੋਲ੍ਹ ਰਿਹਾ ਹਾਂ… / Opening…");
    try { await jsonRequest("/api/login", { code }); setCode(""); await refreshStatus(); }
    catch (e) { setError(message(e)); void refreshStatus().catch(() => {}); }
    finally { setBusy(""); }
  }

  async function setup(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy("ਅਨੁਵਾਦ ਅਤੇ ਆਵਾਜ਼ ਚੈੱਕ ਕਰ ਰਿਹਾ ਹਾਂ… / Testing translation and Punjabi voice together. Please keep this page open for up to 90 seconds…");
    try { await jsonRequest("/api/setup", { apiKey: apiKey.trim(), accessCode }); setApiKey(""); setAccessCode(""); await refreshStatus(); setNotice("ਸਾਥੀ ਤਿਆਰ ਹੈ। / Saathi is connected. Try a short conversation or a letter."); setScreen("home"); }
    catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  }

  async function sendFeedback(rating: "helpful" | "unclear") {
    setError(""); setBusy("ਰਾਏ ਭੇਜ ਰਿਹਾ ਹਾਂ… / Saving feedback…");
    try { await jsonRequest("/api/feedback", { rating, mode: screen === "conversation" ? liveStarted && !result ? "conversation:live" : "conversation:" + direction : "mail:" + reading, note: feedbackNote.trim() }); setFeedbackSaved(true); setFeedbackNote(""); }
    catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  }

  async function loadFeedback() {
    setError(""); setBusy("ਰਾਏ ਲਿਆ ਰਿਹਾ ਹਾਂ… / Loading feedback…");
    try { const data = await jsonRequest<{ feedback: Feedback[] }>("/api/feedback"); setFeedback(data.feedback); setNotice(data.feedback.length ? "" : "ਅਜੇ ਕੋਈ ਰਾਏ ਨਹੀਂ ਆਈ। / No feedback yet."); }
    catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  }

  const unlocked = Boolean(status?.authenticated && status?.configured);
  const liveActive = liveState !== "ended";
  const liveHasTranscript = Boolean(liveTranscript.source || liveTranscript.translation);
  const liveLabels: Record<LiveState, { pa: string; en: string }> = {
    connecting: { pa: "ਕਨੈਕਸ਼ਨ ਕਰ ਰਿਹਾ ਹਾਂ…", en: "Connecting…" },
    listening: { pa: "ਸੁਣ ਰਿਹਾ ਹਾਂ ਜੀ", en: "Listening — speak naturally" },
    translating: { pa: "ਅਨੁਵਾਦ ਕਰ ਰਿਹਾ ਹਾਂ…", en: "Translating…" },
    speaking: { pa: "ਅਨੁਵਾਦ ਸੁਣੋ ਜੀ", en: "Playing the translation" },
    paused: { pa: "ਗੱਲਬਾਤ ਰੁਕੀ ਹੋਈ ਹੈ", en: "Paused — microphone is off" },
    ended: { pa: "ਗੱਲਬਾਤ ਖ਼ਤਮ ਹੋ ਗਈ", en: "Conversation ended" },
  };
  const resultText = result ? (screen === "conversation" ? result.translation : reading === "nextSteps" ? result.nextSteps.join("\n") : result[reading]) : "";
  const speechLanguage = screen === "conversation" && direction === "pa-en" ? "en" : "pa";
  const readingLabels: Record<Reading, { pa: string; en: string }> = { explanation: { pa: "ਸਮਝਾਓ", en: "Explain" }, translation: { pa: "ਅਨੁਵਾਦ", en: "Translate" }, nextSteps: { pa: "ਕੀ ਕਰਨਾ ਹੈ?", en: "Next steps" } };

  return <main className={`saathi ${largeText ? "larger-text" : ""}`}>
    <header className="app-header"><button className="brand" onClick={() => navigate("home")} aria-label="ਸਾਥੀ ਦਾ ਮੁੱਖ ਪੰਨਾ / Saathi home"><span className="brand-mark"><AudioLines aria-hidden="true" /></span><span><b lang="pa">ਸਾਥੀ</b><small>Saathi</small></span></button><button className="icon-button" onClick={() => navigate("settings")} aria-label="ਸੈਟਿੰਗਾਂ ਅਤੇ ਪਰਿਵਾਰ ਦੀ ਮਦਦ / Settings and family help"><Settings aria-hidden="true" /></button></header>
    <div className="app-content">
      {screen !== "home" && <button className="back-button" onClick={() => navigate("home")}><ArrowLeft size={20} aria-hidden="true" /><span lang="pa">ਵਾਪਸ</span><span className="english">Back</span></button>}
      {error && <div className="error-banner" role="alert"><CircleHelp size={22} aria-hidden="true" /><p>{error}</p><button aria-label="Dismiss error" className="dismiss" onClick={() => setError("")}><X size={18} /></button></div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {!status && <section className="welcome"><h1 lang="pa">ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ਜੀ</h1><p>ਸਾਥੀ ਖੋਲ੍ਹ ਰਿਹਾ ਹਾਂ… / Opening Saathi…</p>{error && <button className="button" onClick={() => { setError(""); void refreshStatus().catch(e => setError(message(e))); }}>ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰੋ / Retry</button>}</section>}
      {status && !status.authenticated && <section className="welcome access-screen">
        <div className="section-symbol"><LockKeyhole size={30} aria-hidden="true" /></div><h1 lang="pa">ਸਾਥੀ ਵਿੱਚ ਜੀ ਆਇਆਂ ਨੂੰ</h1><p>ਆਪਣੇ ਪਰਿਵਾਰ ਦਾ 8 ਅੰਕਾਂ ਵਾਲਾ ਕੋਡ ਭਰੋ।</p><p className="english">Enter your family’s 8-digit access code.</p>
        <form onSubmit={login} className="stack"><label htmlFor="family-code"><Bilingual pa="ਪਰਿਵਾਰ ਦਾ ਕੋਡ" en="Family code" /></label><input id="family-code" type="password" inputMode="numeric" autoComplete="off" value={code} maxLength={8} pattern="[0-9]{8}" minLength={8} required onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••••" className="code-input" /><button className="button primary" disabled={Boolean(busy) || code.length !== 8}><Bilingual pa="ਖੋਲ੍ਹੋ" en="Open Saathi" /><ChevronRight aria-hidden="true" /></button></form>
        {!status.configured && <p className="soft-note">ਸਾਥੀ ਨੂੰ ਪਰਿਵਾਰ ਵੱਲੋਂ ਪਹਿਲਾਂ ਸੈੱਟ ਕਰਨਾ ਹੈ। / A family member needs to connect Saathi first.</p>}
        <a className="quiet-link" href="/signin-with-chatgpt?return_to=/" target="_top">Family setup · Sign in with ChatGPT</a>
      </section>}
      {status?.authenticated && !status.configured && !status.isOwner && <section className="welcome"><h1 lang="pa">ਥੋੜ੍ਹੀ ਉਡੀਕ ਕਰੋ ਜੀ</h1><p>ਪਰਿਵਾਰ ਵੱਲੋਂ ਸਾਥੀ ਦਾ ਕਨੈਕਸ਼ਨ ਕਰਨਾ ਬਾਕੀ ਹੈ।</p><p className="english">Your family is still connecting Saathi. Please ask them to complete setup.</p><button className="button" onClick={() => void refreshStatus().catch(e => setError(message(e)))}>ਫਿਰ ਚੈੱਕ ਕਰੋ / Check again</button></section>}
      {unlocked && screen === "home" && <section className="welcome">
        <p className="eyebrow"><span className="ready-dot" />ਪੰਜਾਬੀ ਵਿੱਚ ਤੁਹਾਡੇ ਨਾਲ</p><h1 lang="pa">ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ਜੀ</h1><p className="welcome-question" lang="pa">ਅੱਜ ਮੈਂ ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰਾਂ?</p><p className="english">How can I help you today?</p>
        <div className="home-choices"><button className="choice primary" onClick={() => navigate("conversation")}><Mic aria-hidden="true" /><Bilingual pa="ਗੱਲਬਾਤ ਕਰੋ" en="Translate a conversation" /><ChevronRight className="choice-arrow" aria-hidden="true" /></button><button className="choice" onClick={() => navigate("mail")}><MailOpen aria-hidden="true" /><Bilingual pa="ਚਿੱਠੀ ਜਾਂ ਈਮੇਲ ਸਮਝੋ" en="Understand a letter or email" /><ChevronRight className="choice-arrow" aria-hidden="true" /></button></div>
        <div className="home-footer"><ShieldCheck size={21} aria-hidden="true" /><p><span lang="pa">ਤੁਹਾਡੀ ਬੋਲੀ, ਤੁਹਾਡਾ ਸਾਥੀ।</span><small>Take your time. We’ll go one step at a time.</small></p></div>
      </section>}
      {unlocked && screen === "conversation" && <section>
        <div className="section-heading"><p className="eyebrow">ENGLISH ↔ ਪੰਜਾਬੀ · AUTOMATIC</p><h1 lang="pa">ਆਓ ਗੱਲ ਕਰੀਏ</h1><p lang="pa" className="conversation-tip">ਇੱਕ ਵਾਰ ਇੱਕ ਜਣਾ ਬੋਲੋ। ਅਨੁਵਾਦ ਪੂਰਾ ਸੁਣ ਕੇ ਜਵਾਬ ਦਿਓ ਜੀ।</p><p className="english">Speak one at a time. Let the translation finish before replying.</p></div>
        <PrivacyNote />
        {!liveActive ? <button className="live-start-button" disabled={Boolean(busy)} onClick={() => void startLive()}><Mic aria-hidden="true" /><Bilingual pa={liveStarted ? "ਨਵੀਂ ਗੱਲਬਾਤ ਸ਼ੁਰੂ ਕਰੋ" : "ਗੱਲਬਾਤ ਸ਼ੁਰੂ ਕਰੋ"} en={liveStarted ? "Start a new conversation" : "Start conversation"} /></button> : <div className="live-session-controls">
          <div className={`live-status live-status-${liveState}`} role="status" aria-live="polite"><span className="live-status-symbol" aria-hidden="true">{liveState === "connecting" || liveState === "translating" ? <span className="spinner" /> : liveState === "speaking" ? <AudioLines /> : liveState === "paused" ? <Pause /> : <Mic />}</span><Bilingual {...liveLabels[liveState]} /></div>
          <div className="button-row"><button className="button live-pause" disabled={liveState === "connecting"} onClick={() => liveState === "paused" ? void resumeLive() : live.current?.pause()}>{liveState === "paused" ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}<Bilingual pa={liveState === "paused" ? "ਫਿਰ ਸ਼ੁਰੂ ਕਰੋ" : "ਥੋੜ੍ਹਾ ਰੋਕੋ"} en={liveState === "paused" ? "Resume" : "Pause"} /></button><button className="button live-end" onClick={() => stopLive()}><Square size={20} aria-hidden="true" fill="currentColor" /><Bilingual pa="ਖ਼ਤਮ ਕਰੋ" en="End conversation" /></button></div>
        </div>}
        <p className="small">ਇਹ ਪੰਨਾ ਖੁੱਲ੍ਹਾ ਰੱਖੋ ਜੀ। / Keep this page open. Each conversation lasts up to 10 minutes.</p>
        {liveStarted && !liveActive && <p className="live-ended-status" role="status"><Check size={18} aria-hidden="true" /><Bilingual {...liveLabels.ended} /></p>}
        {liveStarted && <div className="live-transcript" aria-label="Latest conversation translation">
          {liveHasTranscript ? <>
            <div className="result-card"><p className="result-label">ਹੁਣੇ ਦਾ ਅਨੁਵਾਦ · Latest translation</p><p className="result-text" lang={/[\u0A00-\u0A7F]/.test(liveTranscript.translation) ? "pa" : "en"}>{liveTranscript.translation || "…"}</p></div>
            <details className="live-source"><summary className="result-label">ਜੋ ਕਿਹਾ ਗਿਆ · Recent speech</summary><p lang={/[\u0A00-\u0A7F]/.test(liveTranscript.source) ? "pa" : "en"}>{liveTranscript.source || "…"}</p></details>
            <span className="sr-only" role="status" aria-live="polite">{liveTranscript.final ? liveTranscript.translation : ""}</span>
          </> : <p className="live-empty"><span lang="pa">ਪਹਿਲੀ ਗੱਲ ਦਾ ਅਨੁਵਾਦ ਇੱਥੇ ਆਵੇਗਾ।</span><small>The latest translation will appear here.</small></p>}
          <p className="ai-label">AI ਵੱਲੋਂ ਬਣਾਈ ਆਵਾਜ਼ · AI-generated voice</p>
        </div>}
        {!liveActive && <details className="typed-fallback"><summary>ਲਿਖ ਕੇ ਦੱਸੋ / Type instead</summary><div className="direction-picker" aria-label="Typed translation direction"><button aria-pressed={direction === "en-pa"} disabled={Boolean(busy) || loadingAudio} onClick={() => { clearCurrent(); setDirection("en-pa"); }}><Bilingual pa="ਅੰਗਰੇਜ਼ੀ → ਪੰਜਾਬੀ" en="English to Punjabi" /></button><button aria-pressed={direction === "pa-en"} disabled={Boolean(busy) || loadingAudio} onClick={() => { clearCurrent(); setDirection("pa-en"); }}><Bilingual pa="ਪੰਜਾਬੀ → ਅੰਗਰੇਜ਼ੀ" en="Punjabi to English" /></button></div><label htmlFor="conversation-text" className="sr-only">Text to translate</label><textarea id="conversation-text" rows={3} value={text} maxLength={4000} onChange={e => setText(e.target.value)} placeholder={direction === "en-pa" ? "Type an English sentence…" : "ਇੱਥੇ ਪੰਜਾਬੀ ਵਿੱਚ ਲਿਖੋ…"} disabled={Boolean(busy)} /><button className="button" disabled={!text.trim() || Boolean(busy)} onClick={() => { stopLive(true); void processInput({ text: text.trim() }); }}><Bilingual pa="ਅਨੁਵਾਦ ਕਰੋ" en="Translate" /><ChevronRight aria-hidden="true" /></button></details>}
        {!liveActive && liveStarted && liveHasTranscript && !result && <FeedbackPanel saved={feedbackSaved} busy={Boolean(busy)} note={feedbackNote} onNote={setFeedbackNote} onRate={sendFeedback} />}
      </section>}
      {unlocked && screen === "mail" && <section>
        <div className="section-heading"><p className="eyebrow">LETTERS & EMAILS</p><h1 lang="pa">ਸੌਖੀ ਪੰਜਾਬੀ ਵਿੱਚ ਸਮਝੋ</h1><p className="english">Take a clear photo or paste the English text.</p></div>
        <PrivacyNote />
        <input ref={photoInput} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="ਚਿੱਠੀ ਦੀ ਫੋਟੋ ਚੁਣੋ / Choose a letter photo" onChange={e => void choosePhoto(e.target.files?.[0])} />
        <button className="button photo-button" onClick={() => photoInput.current?.click()} disabled={Boolean(busy)}><Camera size={27} aria-hidden="true" /><Bilingual pa="ਚਿੱਠੀ ਦੀ ਫੋਟੋ ਲਓ" en="Take or choose a photo" /></button>
        {photo ? <div className="photo-review"><img src={`data:${photo.mimeType};base64,${photo.data}`} alt="Your selected letter. Check that all text is visible and sharp." /><p className="small">ਸਾਰੇ ਸ਼ਬਦ ਸਾਫ਼ ਦਿਸ ਰਹੇ ਹਨ? / Check that all text is clear.</p><div className="button-row"><button className="button primary" disabled={Boolean(busy)} onClick={() => void processInput({ image: photo })}><Bilingual pa="ਪੜ੍ਹ ਕੇ ਸਮਝਾਓ" en="Read and explain" /></button><button className="button" disabled={Boolean(busy)} onClick={() => setPhoto(null)} aria-label="Remove photo"><X aria-hidden="true" /></button></div></div> : <div className="email-input"><label htmlFor="mail-text"><Bilingual pa="ਜਾਂ ਈਮੇਲ ਇੱਥੇ ਪਾਓ" en="Or paste your email here" /></label><textarea id="mail-text" rows={5} value={text} maxLength={12000} onChange={e => setText(e.target.value)} placeholder="Paste the English email or letter…" disabled={Boolean(busy)} /><button className="button primary" disabled={!text.trim() || Boolean(busy)} onClick={() => void processInput({ text: text.trim() })}><Bilingual pa="ਪੜ੍ਹ ਕੇ ਸਮਝਾਓ" en="Read and explain" /><ChevronRight aria-hidden="true" /></button><p className="small">ਈਮੇਲ ਐਪ ਵਿੱਚ ਲਿਖਤ ਕਾਪੀ ਕਰਕੇ ਇੱਥੇ ਪਾਓ। / Copy the text from your email app and paste it here.</p></div>}
      </section>}
      {busy && <div className="working" role="status"><span className="spinner" aria-hidden="true" /><p>{busy}</p></div>}
      {unlocked && result && !liveActive && (screen === "conversation" || screen === "mail") && <section ref={resultElement} className="result-section" aria-label="Translation result">
        {screen === "mail" && <div className="reading-picker" aria-label="How to read the letter">{(Object.keys(readingLabels) as Reading[]).map(mode => <button key={mode} aria-pressed={mode === reading} disabled={Boolean(busy)} onClick={() => { stopPlayback(); setReading(mode); setNotice(""); }}><Bilingual {...readingLabels[mode]} /></button>)}</div>}
        <div className="result-card" aria-live="polite"><p className="result-label">{speechLanguage === "en" ? "Your reply in English" : "ਤੁਹਾਡੇ ਲਈ · ਪੰਜਾਬੀ ਵਿੱਚ"}</p>{screen === "mail" && reading === "nextSteps" ? result.nextSteps.length ? <ul className="result-text" lang="pa">{result.nextSteps.map((step, i) => <li key={i}>{step}</li>)}</ul> : <p className="result-text" lang="pa">ਕੋਈ ਅਗਲਾ ਕਦਮ ਸਪਸ਼ਟ ਨਹੀਂ ਦਿੱਤਾ ਗਿਆ।</p> : <p className="result-text" lang={speechLanguage}>{resultText}</p>}
          <div className="audio-actions"><button className="button primary" disabled={Boolean(busy) || !resultText} onClick={() => playing || loadingAudio ? stopPlayback() : void playSpeech(resultText, speechLanguage)}>{playing || loadingAudio ? <Pause aria-hidden="true" /> : <Volume2 aria-hidden="true" />}<Bilingual pa={playing || loadingAudio ? "ਰੋਕੋ" : "ਸੁਣੋ"} en={playing || loadingAudio ? "Stop" : "Listen / repeat"} /></button><button className="button" disabled={loadingAudio || Boolean(busy) || !resultText} onClick={() => void playSpeech(resultText, speechLanguage, true)}><Play size={18} aria-hidden="true" /><Bilingual pa="ਹੌਲੀ ਸੁਣੋ" en="Slower" /></button></div>
          {loadingAudio && <p className="audio-status" role="status">ਆਵਾਜ਼ ਤਿਆਰ ਹੋ ਰਹੀ ਹੈ… / Preparing audio…</p>}<p className="ai-label">AI ਵੱਲੋਂ ਬਣਾਈ ਆਵਾਜ਼ · AI-generated voice</p>
        </div>
        {result.uncertainties.length > 0 && <div className="uncertainty"><CircleHelp size={22} aria-hidden="true" /><div><h2 lang="pa">ਇਹ ਗੱਲ ਚੈੱਕ ਕਰ ਲਓ ਜੀ</h2><ul>{result.uncertainties.map((item, i) => <li key={i}>{item}</li>)}</ul></div></div>}
        <details className="original-text"><summary>ਅਸਲ ਲਿਖਤ ਦੇਖੋ / See original words</summary><p lang={screen === "conversation" && direction === "pa-en" ? "pa" : "en"}>{result.source}</p></details>
        <FeedbackPanel saved={feedbackSaved} busy={Boolean(busy)} note={feedbackNote} onNote={setFeedbackNote} onRate={sendFeedback} />
      </section>}
      {status?.authenticated && (screen === "settings" || (!status.configured && status.isOwner)) && <section className="settings-screen"><h1 lang="pa">ਪਰਿਵਾਰ ਦੀ ਮਦਦ</h1><p className="english">Settings & family setup</p>
        <div className="settings-block"><h2 lang="pa">ਪੜ੍ਹਨ ਵਿੱਚ ਆਸਾਨੀ</h2><label className="toggle-label"><span>ਵੱਡੇ ਅੱਖਰ / Larger reading text</span><input type="checkbox" checked={largeText} onChange={e => { setLargeText(e.target.checked); try { localStorage.setItem("saathi-large-text", e.target.checked ? "yes" : "no"); } catch {} }} /></label></div>
        {status.isOwner && <div className="settings-block"><h2>{status.configured ? "Update the AI connection" : "Connect Saathi once"}</h2><p className="small">Use a billing-enabled Gemini API key for personal letters. Google processes the text, photos and recordings. Saathi keeps the key on the server and does not save those conversations or letters.</p><a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer" className="quiet-link">Get a Gemini API key ↗</a><form onSubmit={setup} className="stack"><label htmlFor="api-key">Gemini API key</label><input id="api-key" aria-describedby="api-key-help" type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} required placeholder="Paste the key here" spellCheck={false} autoCapitalize="none" /><p id="api-key-help" className="small">Google’s newer AQ. keys are supported. Use the Copy button in Google AI Studio to copy the complete key.</p><label htmlFor="new-code">Family access code · 8 digits</label><input id="new-code" type="password" inputMode="numeric" value={accessCode} onChange={e => setAccessCode(e.target.value.replace(/\D/g, ""))} minLength={8} maxLength={8} pattern="[0-9]{8}" required autoComplete="new-password" placeholder="Choose 8 digits" /><p className="small">Share this code privately with your grandparents. Their phone remembers it after they sign in.</p><label className="checkbox-label"><input type="checkbox" required checked={setupAcknowledged} onChange={e => setSetupAcknowledged(e.target.checked)} /><span>I’m using a billing-enabled Gemini project and understand that usage may incur charges.</span></label><button className="button primary" disabled={Boolean(busy) || !apiKey.trim() || accessCode.length !== 8 || !setupAcknowledged}><ShieldCheck aria-hidden="true" /><span>Connect and save</span></button></form></div>}
        {status.isOwner && status.configured && <div className="settings-block"><h2>Try the Punjabi voice</h2><p className="small">Play a short greeting before handing the phone to your grandparents.</p><button className="button" disabled={Boolean(busy)} onClick={() => playing || loadingAudio ? stopPlayback() : void playSpeech("ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ਜੀ। ਮੈਂ ਤੁਹਾਡਾ ਸਾਥੀ ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਗੱਲਬਾਤ ਦਾ ਅਨੁਵਾਦ ਕਰ ਸਕਦਾ ਹਾਂ ਅਤੇ ਚਿੱਠੀ ਸੌਖੀ ਪੰਜਾਬੀ ਵਿੱਚ ਸਮਝਾ ਸਕਦਾ ਹਾਂ।", "pa")}>{playing || loadingAudio ? <Pause aria-hidden="true" /> : <Volume2 aria-hidden="true" />}<span>{playing || loadingAudio ? "Stop voice test" : "Test Punjabi voice"}</span></button>{loadingAudio && <p className="small" role="status">Preparing the greeting…</p>}<p className="ai-label">AI-generated voice</p></div>}
        {status.isOwner && status.configured && <div className="settings-block"><h2>Family feedback</h2><p className="small">Ratings and optional notes only. Letters, transcripts and audio are never included.</p><button className="button" disabled={Boolean(busy)} onClick={() => void loadFeedback()}>Load recent feedback</button>{feedback.length > 0 && <ul className="feedback-list">{feedback.map((item, i) => <li key={i}><strong>{item.rating === "helpful" ? "Helpful" : "Not clear"}</strong><span>{item.mode}</span>{item.note && <p>{item.note}</p>}<small>{new Date(item.createdAt).toLocaleString()}</small></li>)}</ul>}</div>}
        <div className="settings-block"><h2 lang="pa">ਫੋਨ ਦੀ ਸਕ੍ਰੀਨ ਉੱਤੇ ਰੱਖੋ</h2><p>Safari → Share → Add to Home Screen.</p><p className="small">ਇਸ ਨਾਲ ਸਾਥੀ ਫੋਨ ਦੀ ਮੁੱਖ ਸਕ੍ਰੀਨ ਤੋਂ ਖੁੱਲ੍ਹ ਜਾਵੇਗਾ। / This adds an easy-to-find Saathi icon to the home screen.</p></div>
        <div className="settings-block"><h2 lang="pa">ਤੁਹਾਡੀ ਜਾਣਕਾਰੀ</h2><p className="small">Translations use an internet connection and are sent to Google. Saathi does not keep your letters, photos or recordings. Translation can make mistakes; double-check important names, amounts and dates against the original.</p><p className="small" lang="pa">ਜ਼ਰੂਰੀ ਨਾਮ, ਰਕਮਾਂ ਅਤੇ ਤਾਰੀਖਾਂ ਅਸਲ ਚਿੱਠੀ ਨਾਲ ਮਿਲਾ ਲਓ ਜੀ।</p></div>
        {!status.isOwner && <button className="button" disabled={Boolean(busy)} onClick={async () => { clearCurrent(); try { await jsonRequest("/api/logout", {}); await refreshStatus(); setScreen("home"); } catch (e) { setError(message(e)); } }}>ਇਸ ਫੋਨ ਤੋਂ ਲੌਕ ਕਰੋ / Lock this phone</button>}
        {status.isOwner && <a className="quiet-link" href="/signout-with-chatgpt?return_to=/" target="_top">Sign out of family setup</a>}
      </section>}
    </div>
    <footer className="app-footer"><span>ਸਾਥੀ · Family pilot</span>{screen !== "home" && <button onClick={() => navigate("home")}><HomeIcon size={18} aria-hidden="true" /><span>ਮੁੱਖ ਪੰਨਾ / Home</span></button>}</footer>
  </main>;
}

function PrivacyNote() { return <p className="privacy-note"><ShieldCheck size={17} aria-hidden="true" /><span><span lang="pa">ਅਨੁਵਾਦ ਲਈ Google ਨੂੰ ਭੇਜਿਆ ਜਾਵੇਗਾ। ਸਾਥੀ ਇਸਨੂੰ ਸੰਭਾਲਦਾ ਨਹੀਂ।</span><small>Sent to Google for translation. Not saved by Saathi.</small></span></p>; }

function FeedbackPanel({ saved, busy, note, onNote, onRate }: { saved: boolean; busy: boolean; note: string; onNote: (value: string) => void; onRate: (rating: "helpful" | "unclear") => Promise<void> }) {
  return <div className="feedback-box">{saved ? <p className="feedback-thanks" role="status"><Check aria-hidden="true" /><Bilingual pa="ਧੰਨਵਾਦ ਜੀ, ਤੁਹਾਡੀ ਰਾਏ ਮਿਲ ਗਈ।" en="Thank you. Your feedback was saved." /></p> : <><h2 lang="pa">ਸਮਝ ਆ ਗਿਆ ਜੀ?</h2><p className="english">Was this easy to understand?</p><details><summary>ਕੁਝ ਹੋਰ ਦੱਸਣਾ ਹੈ? / Add a note</summary><label className="sr-only" htmlFor="feedback-note">Feedback note</label><textarea id="feedback-note" value={note} onChange={e => onNote(e.target.value)} maxLength={500} rows={2} placeholder="Tell the family what could be better. Avoid private details." /></details><div className="button-row"><button className="button" disabled={busy} onClick={() => void onRate("helpful")}><ThumbsUp size={20} aria-hidden="true" /><Bilingual pa="ਹਾਂ ਜੀ" en="Yes, helpful" /></button><button className="button" disabled={busy} onClick={() => void onRate("unclear")}><ThumbsDown size={20} aria-hidden="true" /><Bilingual pa="ਸਮਝ ਨਹੀਂ ਆਇਆ" en="Not clear" /></button></div><p className="small">ਸਿਰਫ਼ ਤੁਹਾਡੀ ਰਾਏ ਭੇਜੀ ਜਾਵੇਗੀ, ਚਿੱਠੀ ਜਾਂ ਗੱਲਬਾਤ ਨਹੀਂ। / Only feedback is saved, not your letter or conversation.</p></>}</div>;
}
