// StreamCam front end: webcam -> StreamDiffusion server -> canvas, with voice prompts.
const SIZE = 512;
const $ = (id) => document.getElementById(id);

const els = {
  video: $("webcam"), output: $("output"), overlay: $("overlay"),
  prompt: $("prompt"), apply: $("apply"), liveTyping: $("liveTyping"),
  mic: $("mic"), micLabel: $("micLabel"), handsFree: $("handsFree"), level: $("level"), history: $("history"),
  strength: $("strength"), strengthVal: $("strengthVal"), steps: $("steps"), seed: $("seed"), dice: $("dice"),
  cameraSelect: $("cameraSelect"), mirror: $("mirror"), pause: $("pause"),
  statusDot: $("statusDot"), statusText: $("statusText"), fps: $("fps"), latency: $("latency"),
  fullscreen: $("fullscreen"), outWrap: $("outWrap"),
};

const outCtx = els.output.getContext("2d");
const capture = document.createElement("canvas");
capture.width = capture.height = SIZE;
const capCtx = capture.getContext("2d");

let ws = null;
let promptSentWhenReady = false;
let inFlight = false;
let paused = false;
let lastFrameAt = 0;
let fpsEma = 0;

function setStatus(text, kind = "warn") {
  els.statusText.textContent = text;
  els.statusDot.className = "dot " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "");
}

// ---------- server connection ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { inFlight = false; sendPrompt(); sendParams(); pump(); };
  ws.onclose = () => { setStatus("Server disconnected, retrying…", "err"); setTimeout(connect, 1500); };
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== "string") {
      const bmp = await createImageBitmap(new Blob([ev.data], { type: "image/jpeg" }));
      outCtx.drawImage(bmp, 0, 0, SIZE, SIZE);
      bmp.close();
      els.overlay.classList.add("hidden");
      const now = performance.now();
      if (lastFrameAt) fpsEma = fpsEma ? fpsEma * 0.9 + (1000 / (now - lastFrameAt)) * 0.1 : 1000 / (now - lastFrameAt);
      lastFrameAt = now;
      els.fps.textContent = `${fpsEma.toFixed(1)} fps`;
      inFlight = false;
      requestAnimationFrame(pump);
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === "stats") els.latency.textContent = `${msg.ms} ms`;
    if (msg.type === "loading") { inFlight = false; setTimeout(pump, 1000); }
  };
}

function pump() {
  if (paused || inFlight || !ws || ws.readyState !== 1) return;
  const v = els.video;
  if (v.readyState < 2 || !v.videoWidth) { setTimeout(pump, 200); return; }
  // center-crop the camera to a square
  const s = Math.min(v.videoWidth, v.videoHeight);
  const sx = (v.videoWidth - s) / 2, sy = (v.videoHeight - s) / 2;
  capCtx.save();
  if (els.mirror.checked) { capCtx.translate(SIZE, 0); capCtx.scale(-1, 1); }
  capCtx.drawImage(v, sx, sy, s, s, 0, 0, SIZE, SIZE);
  capCtx.restore();
  inFlight = true;
  capture.toBlob((blob) => {
    if (!blob || ws.readyState !== 1) { inFlight = false; return; }
    blob.arrayBuffer().then((buf) => ws.send(buf));
  }, "image/jpeg", 0.85);
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
const DEFAULT_STYLE = "A man of color from the future, Black or Brown or Indigenous, diverse, not white, arms close to the face, spectacular architectural goggles and hats, solid geometries, Mondrian colors only — red, yellow, blue, black, white — Bauhaus and Kandinsky style, Calder-inspired haute couture, Bauhaus-style geometric architectural goggles, very architectural fashion, rich luminous atmospheric background with depth, full environment, no subject extraction, no dark or flat background";
const styleBox = $("style");
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
styleBox.value = store.get("streamcam.style") ?? DEFAULT_STYLE;
function sendPrompt() {
  store.set("streamcam.style", styleBox.value);
  // Style is always part of the picture, from the first frame and while listening.
  send({ type: "prompt", prompt: els.prompt.value, style: styleBox.value });
}
let styleTimer;
styleBox.addEventListener("input", () => {
  if (!els.liveTyping.checked) return;
  clearTimeout(styleTimer);
  styleTimer = setTimeout(sendPrompt, 500);
});
styleBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
function sendParams() {
  send({ type: "params", strength: els.strength.value / 100, steps: +els.steps.value, seed: +els.seed.value || 0 });
}

async function pollHealth() {
  try {
    const h = await (await fetch("/health")).json();
    const d = h.status.diffusion, w = h.status.whisper;
    if (d.startsWith("error")) setStatus(`Diffusion ${d}`, "err");
    else if (!h.ready) { setStatus(`Loading ${h.model} on ${h.device}… (voice: ${w})`); els.overlay.textContent = "Loading model… first launch downloads ~3 GB"; }
    else {
      setStatus(`${h.model} · ${h.device} · voice ${w}`, w.startsWith("error") ? "err" : "ok");
      // The first prompt can arrive before the model is loaded; send it again so it is on from the first frame.
      if (!promptSentWhenReady && ws && ws.readyState === 1) { promptSentWhenReady = true; sendPrompt(); sendParams(); }
    }
    if (!(h.ready && w === "ready")) setTimeout(pollHealth, 1500);
  } catch { setTimeout(pollHealth, 1500); }
}

// ---------- camera ----------
async function startCamera(deviceId) {
  if (els.video.srcObject) els.video.srcObject.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  els.video.srcObject = stream;
  els.video.play().catch(() => {});
  // If the camera is "on" but sends no frames, macOS camera permission is the usual cause.
  const track = stream.getVideoTracks()[0];
  setTimeout(() => {
    if (els.video.srcObject === stream && !els.video.videoWidth) {
      const msg = "The camera is on but not sending any picture. Allow this app in System Settings → Privacy & Security → Camera, then restart Bauhaus Time Traveler.";
      setStatus(msg, "err");
      els.overlay.textContent = msg;
      els.overlay.classList.remove("hidden");
    }
  }, 4000);
  track.onunmute = () => pump();
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = stream.getVideoTracks()[0].getSettings().deviceId;
  els.cameraSelect.innerHTML = cams.map((c, i) =>
    `<option value="${c.deviceId}" ${c.deviceId === current ? "selected" : ""}>${c.label || "Camera " + (i + 1)}</option>`).join("");
}

// ---------- prompt controls ----------
let typingTimer;
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
els.prompt.addEventListener("input", () => {
  if (!els.liveTyping.checked) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(sendPrompt, 350);
});
els.apply.onclick = sendPrompt;

els.strength.oninput = () => { els.strengthVal.textContent = `${els.strength.value}%`; };
els.strength.onchange = sendParams;
els.steps.onchange = sendParams;
els.seed.onchange = sendParams;
els.dice.onclick = () => { els.seed.value = Math.floor(Math.random() * 100000); sendParams(); };
els.cameraSelect.onchange = () => startCamera(els.cameraSelect.value);
const applyMirror = () => els.video.classList.toggle("mirror", els.mirror.checked);
els.mirror.onchange = applyMirror;
els.pause.onclick = () => {
  paused = !paused;
  els.pause.textContent = paused ? "Resume" : "Pause";
  if (!paused) pump();
};
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch((e) => showToast(`Fullscreen: ${e.message}`));
}
// The picture can fill the screen with the controls put away. Escape, or a click, brings them back.
function isImmersive() {
  return !!(document.fullscreenElement || document.body.classList.contains("ui-hidden"));
}
function leaveImmersive() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.body.classList.remove("ui-hidden");
  syncLeaveButton();
}
function syncLeaveButton() {
  const trapped = isImmersive();
  els.fullscreen.textContent = trapped ? "✕" : "⤢";
  els.fullscreen.title = trapped ? "Leave fullscreen (Esc)" : "Fullscreen (F)";
}
els.fullscreen.onclick = (e) => {
  e.currentTarget.blur();
  e.stopPropagation();
  if (isImmersive()) leaveImmersive();
  else toggleFullscreen();
};
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("is-fullscreen", !!document.fullscreenElement);
  syncLeaveButton();
});
document.querySelector(".stage").addEventListener("click", (e) => {
  if (!isImmersive()) return;
  if (e.target.closest("button, a, input, textarea, select, label")) return;
  leaveImmersive();
});
syncLeaveButton();

function toggleChrome() {
  document.body.classList.toggle("ui-hidden");
  if (document.body.classList.contains("ui-hidden") && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  syncLeaveButton();
}

// The preview appears and disappears. The camera itself keeps running.
const showCam = $("showCam");
function setCameraVisible(on) {
  document.body.classList.toggle("cam-hidden", !on);
  if (showCam) showCam.checked = on;
}
function toggleCamera() {
  setCameraVisible(document.body.classList.contains("cam-hidden"));
  showToast(document.body.classList.contains("cam-hidden") ? "Camera off" : "Camera on", 900);
}
showCam.onchange = () => setCameraVisible(showCam.checked);

// ---------- voice: local Whisper via the server ----------
const SR = 16000;
let audioCtx = null, workletNode = null, micStream = null;
let recording = false, recChunks = [], preRoll = [];
let transcribing = false;
// hands-free voice activity detection
let noiseFloor = 0.01, speechMs = 0, silenceMs = 0, recMs = 0;

const workletSrc = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

async function ensureMic() {
  if (audioCtx) { if (audioCtx.state === "suspended") await audioCtx.resume(); return; }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioCtx = new AudioContext({ sampleRate: SR });
  const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
  await audioCtx.audioWorklet.addModule(url);
  workletNode = new AudioWorkletNode(audioCtx, "tap");
  audioCtx.createMediaStreamSource(micStream).connect(workletNode);
  workletNode.port.onmessage = (e) => onAudio(e.data);
}

function onAudio(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / chunk.length);
  els.level.style.width = `${Math.min(100, rms * 400)}%`;
  const ms = (chunk.length / SR) * 1000;

  if (portal.on) { portalAudio(chunk, rms, ms); return; }

  if (recording) { recChunks.push(chunk); recMs += ms; }

  if (els.handsFree.checked && !transcribing) {
    const speaking = rms > Math.max(0.015, noiseFloor * 3);
    if (!speaking && !recording) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    if (!recording) {
      preRoll.push(chunk); if (preRoll.length > 6) preRoll.shift(); // ~380 ms pre-roll
      speechMs = speaking ? speechMs + ms : 0;
      if (speechMs > 120) { startRecording(true); }
    } else {
      silenceMs = speaking ? 0 : silenceMs + ms;
      if (silenceMs > 800 || recMs > 15000) stopRecording();
    }
  }
}

function startRecording(fromVad = false) {
  if (recording) return;
  recording = true; recMs = 0; silenceMs = 0;
  recChunks = fromVad ? preRoll.slice() : [];
  preRoll = [];
  els.mic.classList.add("recording");
  els.micLabel.textContent = "Listening…";
}

async function stopRecording() {
  if (!recording) return;
  recording = false; speechMs = 0;
  els.mic.classList.remove("recording");
  const total = recChunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of recChunks) { pcm.set(c, off); off += c.length; }
  recChunks = [];
  if (total < SR * 0.3) { resetMicLabel(); return; }

  transcribing = true;
  els.mic.classList.add("busy");
  els.micLabel.textContent = "Transcribing…";
  try {
    const res = await fetch("/transcribe", { method: "POST", body: pcm.buffer, headers: { "Content-Type": "application/octet-stream" } });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const text = cleanTranscript(data.text);
    if (text) usePromptFromVoice(text);
  } catch (err) {
    setStatus(`Voice: ${err.message}`, "err");
  } finally {
    transcribing = false;
    els.mic.classList.remove("busy");
    resetMicLabel();
  }
}

// Whisper sometimes "hears" these in silence or noise
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by.*)$/i;
function cleanTranscript(t) {
  t = (t || "").trim();
  return HALLUCINATIONS.test(t) ? "" : t;
}

function usePromptFromVoice(text) {
  const mode = document.querySelector('input[name="voiceMode"]:checked').value;
  els.prompt.value = mode === "append" && els.prompt.value.trim()
    ? `${els.prompt.value.trim().replace(/[.,]$/, "")}, ${text}`
    : text;
  sendPrompt();
  const li = document.createElement("li");
  li.textContent = text;
  li.onclick = () => { els.prompt.value = text; sendPrompt(); };
  els.history.prepend(li);
  while (els.history.children.length > 20) els.history.lastChild.remove();
}

function resetMicLabel() {
  els.micLabel.textContent = els.handsFree.checked ? "Hands-free: just talk" : "Hold to talk";
}

// ---------- WORD PORTAL ----------
// Continuous listening that STREAMS: while you talk, the words so far are transcribed every ~0.6 s
// and applied right away (no waiting for a pause). The prompt is the key words from the last few
// seconds, newest first, so it keeps moving with your speech and holds still when you stop.
// windowMs: every update transcribes the last 2.5 s of voice (Whisper invents words on tiny clips)
const PORTAL = { interimMs: 500, cutSilenceMs: 250, windowMs: 2500, minWindowMs: 900, memoryMs: 4000, maxWords: 8 };
const portal = {
  on: false, btn: $("portalBtn"), label: $("portalLabel"), words: $("portalWords"), show: $("portalShow"),
  ring: [], ringMs: 0, silenceMs: 0, speechMs: 0, sinceSend: 0, active: false, pre: [],
  inFlight: false, pending: null, recent: [], lastPrompt: "", updates: 0, lastLatency: 0,
};

// Filler words that carry no image (English + Spanish). Everything else is kept.
const STOPWORDS = new Set((
  "a an the and or but if then so of to in on at by for with from into onto over under about as through across around near behind between within without upon is are was were be been being " +
  "am do does did done have has had i me my mine we us our you your he him his she her it its they them their this that these " +
  "those there here what which who whom whose when where why how not no yes very just really also too only than like okay ok " +
  "um uh hmm oh well yeah gonna wanna let lets let's can could would should will shall may might must get got go going went " +
  "make made see saw look want need think know say said thing things something some any all more most much many one now again " +
  "el la los las un una unos unas y o pero si sino de del al a en con por para sin sobre entre hasta desde que qué quien " +
  "cual cuál como cómo cuando donde dónde porque es son era fue ser estar está están estoy soy eres somos yo tú tu él ella " +
  "nosotros ellos ellas mi mis su sus le les lo me te se nos este esta esto estos estas ese esa eso aquí ahí allí muy más " +
  "menos ya también no sí bueno pues entonces hay tengo tiene quiero vamos va voy hacer ver algo todo nada eh"
).split(/\s+/));

// Words Whisper tends to invent on short or noisy audio (from YouTube captions in its training data)
const INVENTED = new Set(("subscribe subscribed subscribing welcome thanks thank watching watch video videos channel " +
  "comment comments subtitles subtitle amara www com org applause laughter music bye please suscríbete suscribete gracias").split(" "));

function extractKeywords(text) {
  // Latin-script words and numbers only (drops the odd misdetected-language output)
  const tokens = text.match(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'’-]*/gu) || [];
  const seen = new Set(), out = [];
  for (const t of tokens) {
    const w = t.replace(/['’]s$/i, "");
    const k = w.toLowerCase();
    if (STOPWORDS.has(k) || INVENTED.has(k) || seen.has(k)) continue;
    if (k.length < 3 && !/\d/.test(k)) continue;
    seen.add(k); out.push(w);
  }
  return out.slice(-PORTAL.maxWords); // newest words win
}

function portalAudio(chunk, rms, ms) {
  const speaking = rms > Math.max(0.012, noiseFloor * 3);
  if (!speaking && !portal.active) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
  if (!portal.active) {
    portal.pre.push(chunk); if (portal.pre.length > 4) portal.pre.shift(); // ~250 ms pre-roll
    portal.speechMs = speaking ? portal.speechMs + ms : 0;
    if (portal.speechMs > 50) {
      portal.active = true; portal.ring = portal.pre.slice(); portal.pre = [];
      portal.ringMs = portal.ring.length * ms; portal.silenceMs = 0; portal.sinceSend = 0;
      portal.btn.classList.add("hearing");
    }
    return;
  }
  // rolling window of the last few seconds of voice
  portal.ring.push(chunk); portal.ringMs += ms;
  while (portal.ringMs > PORTAL.windowMs) { portal.ring.shift(); portal.ringMs -= ms; }
  portal.sinceSend += ms;
  portal.silenceMs = speaking ? 0 : portal.silenceMs + ms;
  if (portal.silenceMs >= PORTAL.cutSilenceMs) {
    // you paused: one final, complete read of the window, then wait for the next words
    const pcm = concatAudio(portal.ring);
    portal.ring = []; portal.ringMs = 0; portal.active = false; portal.speechMs = 0; portal.sinceSend = 0;
    portal.btn.classList.remove("hearing");
    if (pcm.length >= SR * 0.3) portalSend(pcm, true);
  } else if (portal.sinceSend >= PORTAL.interimMs && portal.ringMs >= PORTAL.minWindowMs && !portal.inFlight) {
    // still talking: read the window now and apply it right away
    portal.sinceSend = 0;
    portalSend(concatAudio(portal.ring), false);
  }
}

function concatAudio(chunks) {
  const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  return pcm;
}

// One transcription at a time. Interim requests are skipped while one is running; a final one waits
// (only the newest), so the portal never falls behind your voice.
async function portalSend(pcm, final) {
  if (portal.inFlight) { if (final) portal.pending = pcm; return; }
  portal.inFlight = true;
  const t0 = performance.now();
  try {
    const res = await fetch("/transcribe?fast=1", { method: "POST", body: pcm.buffer, headers: { "Content-Type": "application/octet-stream" } });
    const data = await res.json();
    if (portal.on && !data.error) {
      portal.lastLatency = Math.round(performance.now() - t0);
      let words = extractKeywords(cleanTranscript(data.text));
      if (!final && words.length > 1) words = words.slice(0, -1); // last word may be cut mid-way
      if (words.length) addPortalWords(words, data.text, final);
    }
  } catch (err) {
    setStatus(`Portal: ${err.message}`, "err");
  } finally {
    portal.inFlight = false;
    if (portal.pending && portal.on) { const next = portal.pending; portal.pending = null; portalSend(next, true); }
  }
}

function addPortalWords(words, heard, final) {
  const now = performance.now();
  for (const w of words) {
    const k = w.toLowerCase();
    portal.recent = portal.recent.filter((x) => x.k !== k);
    portal.recent.push({ w, k, t: now });
  }
  portal.recent = portal.recent.filter((x) => now - x.t <= PORTAL.memoryMs).slice(-PORTAL.maxWords);
  const promptWords = portal.recent.slice().reverse().map((x) => x.w); // newest first = strongest
  const prompt = promptWords.join(", ");
  if (prompt !== portal.lastPrompt) {
    portal.lastPrompt = prompt;
    portal.updates++;
    els.prompt.value = prompt; // override
    sendPrompt();
    showPortalWords(promptWords, new Set(words.map((w) => w.toLowerCase())));
  }
  portal.label.textContent = `Portal open · ${portal.lastLatency} ms`;
  if (final) {
    const li = document.createElement("li");
    li.textContent = `◎ ${words.join(" · ")}`;
    li.title = heard;
    li.onclick = () => { els.prompt.value = words.join(", "); sendPrompt(); };
    els.history.prepend(li);
    while (els.history.children.length > 20) els.history.lastChild.remove();
  }
}

// words floating over the image (not recorded into the video); just-heard words are highlighted
function showPortalWords(promptWords, fresh) {
  portal.words.innerHTML = "";
  promptWords.forEach((w, i) => {
    const s = document.createElement("span");
    s.textContent = w;
    if (fresh.has(w.toLowerCase())) { s.className = "fresh"; s.style.animationDelay = `${i * 30}ms`; }
    portal.words.appendChild(s);
  });
}

async function togglePortal() {
  if (!portal.on) {
    try { await ensureMic(); } catch (err) { setStatus(`Microphone: ${err.message}`, "err"); return; }
    if (els.handsFree.checked) { els.handsFree.checked = false; resetMicLabel(); }
    if (recording) stopRecording();
    Object.assign(portal, { on: true, ring: [], ringMs: 0, pre: [], active: false, silenceMs: 0, speechMs: 0, sinceSend: 0, pending: null, recent: [], lastPrompt: "" });
    portal.btn.classList.add("open");
    sendPrompt(); // style stays on from the moment listening starts
    portal.label.textContent = "Listening";
    portal.words.classList.toggle("hidden", !portal.show.checked);
  } else {
    portal.on = false;
    portal.btn.classList.remove("open", "hearing");
    sendPrompt();
    portal.label.textContent = "Open word portal";
    portal.words.classList.add("hidden");
  }
}
portal.btn.onclick = (e) => { e.currentTarget.blur(); togglePortal(); };
portal.show.onchange = () => portal.words.classList.toggle("hidden", !(portal.on && portal.show.checked));

async function pressStart(e) {
  e?.preventDefault();
  if (portal.on || els.handsFree.checked || transcribing) return;
  try { await ensureMic(); startRecording(); } catch (err) { setStatus(`Microphone: ${err.message}`, "err"); }
}
function pressEnd() { if (!els.handsFree.checked) stopRecording(); }

els.mic.addEventListener("pointerdown", pressStart);
els.mic.addEventListener("pointerup", pressEnd);
els.mic.addEventListener("pointerleave", () => recording && !els.handsFree.checked && pressEnd());
els.handsFree.onchange = async () => {
  if (els.handsFree.checked && portal.on) togglePortal(); // one listening mode at a time
  if (els.handsFree.checked) {
    try { await ensureMic(); } catch (err) { setStatus(`Microphone: ${err.message}`, "err"); els.handsFree.checked = false; }
  } else if (recording) { stopRecording(); }
  resetMicLabel();
};

const typingInField = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return ["text", "number", "search", "password", ""].includes(el.type);
  return false;
};
// Keys: Esc = leave fullscreen, T = show/hide the text, F = fullscreen, L = listen, P = play/stop the sound, C = camera, R = record, S = stop.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.repeat) {
    if (typingInField()) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    // Do not cancel the key. Chrome and Windows use Escape to leave fullscreen
    // and give the window its close button back. leaveImmersive shows the controls.
    leaveImmersive();
    return;
  }
  if (typingInField() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "KeyF" && !e.repeat) { e.preventDefault(); toggleFullscreen(); }
  if (e.code === "KeyT" && !e.repeat) { e.preventDefault(); toggleChrome(); }
  if (e.code === "KeyL" && !e.repeat) { e.preventDefault(); togglePortal(); }
  if (e.code === "KeyP" && !e.repeat) { e.preventDefault(); toggleMusic(); }
  if (e.code === "KeyC" && !e.repeat) { e.preventDefault(); toggleCamera(); }
  if (e.code === "KeyR" && !e.repeat) { e.preventDefault(); if (!recording_on()) startVideoRecording().catch((err) => { rec.btn.disabled = false; showToast(`Recording failed: ${err.message}`); }); }
  if (e.code === "KeyS" && !e.repeat) { e.preventDefault(); if (recording_on()) stopRecordingVideo(); }
});

// ---------- music player ----------
const music = {
  el: new Audio("media/bauhaus.mp3"),
  play: $("musicPlay"), seek: $("musicSeek"), pos: $("musicPos"), dur: $("musicDur"),
  name: $("trackName"), loop: $("musicLoop"), vol: $("musicVol"), file: $("musicFile"),
  ctx: null, gain: null, seeking: false,
};
music.el.loop = true;
music.el.preload = "auto";
const fmt = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

// Route the music through Web Audio so it can go to the speakers AND into recordings.
function ensureMusicGraph() {
  if (music.ctx) return;
  music.ctx = new AudioContext();
  music.gain = music.ctx.createGain();
  music.gain.gain.value = music.vol.value / 100;
  music.ctx.createMediaElementSource(music.el).connect(music.gain);
  music.gain.connect(music.ctx.destination);
}

// P starts the track from the beginning. The next press stops it and rewinds, so the press after that starts over.
async function toggleMusic() {
  ensureMusicGraph();
  if (music.ctx.state === "suspended") await music.ctx.resume();
  if (!music.el.paused) {
    music.el.pause();
    music.el.currentTime = 0;
    return;
  }
  music.el.currentTime = 0;
  await music.el.play().catch((e) => showToast(`Can't play: ${e.message}`));
}
music.play.onclick = (e) => { e.currentTarget.blur(); toggleMusic(); };
music.el.onplay = () => { music.play.textContent = "■"; music.play.classList.add("playing"); };
music.el.onpause = () => { music.play.textContent = "▶"; music.play.classList.remove("playing"); };
music.el.onloadedmetadata = () => { music.dur.textContent = fmt(music.el.duration); };
music.el.ontimeupdate = () => {
  music.pos.textContent = fmt(music.el.currentTime);
  if (!music.seeking && music.el.duration) music.seek.value = (music.el.currentTime / music.el.duration) * 1000;
};
music.seek.oninput = () => { music.seeking = true; music.pos.textContent = fmt((music.seek.value / 1000) * music.el.duration); };
music.seek.onchange = () => { if (music.el.duration) music.el.currentTime = (music.seek.value / 1000) * music.el.duration; music.seeking = false; };
music.loop.onchange = () => { music.el.loop = music.loop.checked; };
music.vol.oninput = () => { if (music.gain) music.gain.gain.value = music.vol.value / 100; };
music.file.onchange = () => {
  const f = music.file.files[0];
  if (!f) return;
  const wasPlaying = !music.el.paused;
  music.el.src = URL.createObjectURL(f);
  music.name.textContent = f.name;
  if (wasPlaying) music.el.play();
};

// ---------- recording the generated video ----------
const rec = {
  btn: $("record"), label: $("recLabel"),
  badge: $("recBadge"), time: $("recTime"), toast: $("toast"),
  recorder: null, chunks: [], startedAt: 0, timer: null, ext: "webm",
};
const isElectron = navigator.userAgent.includes("Electron");

function pickMime() {
  const options = [
    ["video/mp4;codecs=avc1,mp4a.40.2", "mp4"], ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"], ["video/webm", "webm"],
  ];
  return options.find(([m]) => MediaRecorder.isTypeSupported(m)) || ["", "webm"];
}

let toastTimer;
function showToast(text, ms = 5000) {
  rec.toast.textContent = text;
  rec.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => rec.toast.classList.add("hidden"), ms);
}

async function startVideoRecording() {
  if (recording_on()) return;
  rec.btn.disabled = true; // until the recorder is actually running
  // One file: the generated picture and the app's sound, taken together.
  ensureMusicGraph();
  if (music.ctx.state === "suspended") await music.ctx.resume();
  if (rec.mixDest) { try { music.gain.disconnect(rec.mixDest); } catch {} }
  rec.mixDest = music.ctx.createMediaStreamDestination();
  music.gain.connect(rec.mixDest);
  const picture = els.output.captureStream(30).getVideoTracks()[0];
  const sound = rec.mixDest.stream.getAudioTracks()[0];
  const stream = new MediaStream([picture, sound].filter(Boolean));
  if (!sound) showToast("Recording the picture. No sound track was available.");
  const [mimeType, ext] = pickMime();
  rec.ext = ext;
  rec.chunks = [];
  rec.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = saveRecording;
  rec.recorder.start(1000);
  rec.startedAt = Date.now();
  rec.btn.disabled = false;
  rec.btn.classList.add("on");
  rec.label.textContent = "Stop recording";
  rec.badge.classList.remove("hidden");
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    rec.time.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
}

function stopRecordingVideo() {
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
  clearInterval(rec.timer);
  rec.btn.classList.remove("on");
  rec.label.textContent = "Record video";
  rec.badge.classList.add("hidden");
  rec.time.textContent = "00:00";
}

function saveRecording() {
  if (rec.mixDest) { try { music.gain.disconnect(rec.mixDest); } catch {} rec.mixDest = null; }
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType });
  rec.chunks = [];
  if (!blob.size) { showToast("Nothing was recorded."); return; }
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const name = `BauhausTimeTraveler_${stamp}.${rec.ext}`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast(isElectron ? `Saved to Movies/StreamCam/${name}` : `Downloaded ${name}`, 7000);
}

const recording_on = () => rec.recorder && rec.recorder.state === "recording";
// Recording starts from R or this button, and stops from S or the button again.
rec.btn.onclick = () => (recording_on() ? stopRecordingVideo() : startVideoRecording().catch((e) => { rec.btn.disabled = false; showToast(`Recording failed: ${e.message}`); }));

// ---------- go ----------
applyMirror();
els.strengthVal.textContent = `${els.strength.value}%`;
startCamera().catch((err) => setStatus(`Camera: ${err.message}`, "err"));
connect();
pollHealth();
