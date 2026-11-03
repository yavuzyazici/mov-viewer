import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { aspectLabel, formatBytes, formatDate, formatRate, formatTime, relativeTime } from "./format";
import { loadPrefs, recent, savePrefs } from "./store";
import "./styles.css";

/** Returned by the `open_video` command. */
interface VideoFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  modified: number | null;
  siblings: string[];
}

interface Source {
  url: string;
  name: string;
  size: number;
  modified: number | null;
  /** Only set for files opened from disk through Tauri. */
  file?: VideoFile;
  /** Playing ffmpeg's H.264 copy instead of the original file. */
  compat?: boolean;
}

/** Sent by `make_compatible` while ffmpeg runs. */
interface ConvertProgress {
  ratio: number | null;
  remaining: number | null;
}

const isTauri = "__TAURI_INTERNALS__" in window;
const VIDEO_EXT = /\.(mov|mp4|m4v|webm)$/i;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const HIDE_DELAY = 2200;

const SHORTCUTS: [string[], string][] = [
  [["Boşluk"], "Oynat / duraklat"],
  [["←", "→"], "5 sn geri / ileri"],
  [["J", "L"], "10 sn geri / ileri"],
  [[",", "."], "Kare kare geri / ileri"],
  [["↑", "↓"], "Sesi aç / kıs"],
  [["M"], "Sesi kapat"],
  [["[", "]"], "Yavaşlat / hızlandır"],
  [["0–9"], "Videonun %0–90'ına git"],
  [["F"], "Tam ekran (ya da çift tık)"],
  [["R"], "Döngü"],
  [["S"], "Kareyi resim olarak kaydet"],
  [["I"], "Dosya bilgisi"],
  [["Shift", "N"], "Klasördeki sonraki video"],
  [["Shift", "P"], "Klasördeki önceki video"],
  [["Ctrl", "O"], "Dosya aç"],
  [["Esc"], "Kapat / tam ekrandan çık"],
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const setIcon = (use: Element, id: string) => use.setAttribute("href", `#${id}`);

const app = $("app");
const stage = $("stage");
const video = $<HTMLVideoElement>("video");
const preview = $<HTMLVideoElement>("preview");
const controls = $("controls");
const titlebar = $("titlebar");
const seek = $("seek");
const seekTrack = $("seek-track");
const bubble = $("bubble");
const bubbleTime = $("bubble-time");
const timeCur = $("time-cur");
const timeDur = $("time-dur");
const playIcon = $("play-icon");
const volIcon = $("vol-icon");
const fsIcon = $("fs-icon");
const flashEl = $("flash");
const flashIcon = $("flash-icon");
const osdEl = $("osd");
const osdText = $("osd-text");
const shutter = $("shutter");
const volume = $<HTMLInputElement>("volume");
const speedBtn = $("speed-btn");
const speedMenu = $("speed-menu");
const loopBtn = $("loop-btn");
const infoBtn = $("info-btn");
const infoList = $("info-list");
const revealBtn = $("reveal-btn");
const prevBtn = $<HTMLButtonElement>("prev-btn");
const nextBtn = $<HTMLButtonElement>("next-btn");
const titleEl = $("title");
const errorEl = $("error");
const convertEl = $("convert");
const helpEl = $("help");
const toasts = $("toasts");
const fileInput = $<HTMLInputElement>("file-input");

const state = {
  source: null as Source | null,
  siblings: [] as string[],
  resumeAt: 0,
  showRemaining: false,
  scrubbing: false,
  playAfterScrub: false,
  overUi: false,
  frameDur: 1 / 30,
  frameSampled: false,
  lastMediaTime: -1,
  hideTimer: 0,
  osdTimer: 0,
  raf: 0,
  lastSave: 0,
};

// Same-origin reads (snapshots, thumbnails) need CORS; Tauri's asset protocol sends the header.
video.crossOrigin = "anonymous";

/* ---------- Opening files ---------- */

async function pickFile() {
  if (!isTauri) {
    fileInput.click();
    return;
  }
  const path = await openDialog({
    title: "Video aç",
    multiple: false,
    directory: false,
    filters: [
      { name: "Videolar", extensions: ["mov", "mp4", "m4v", "webm"] },
      { name: "QuickTime film", extensions: ["mov"] },
    ],
  });
  if (typeof path === "string") openPath(path);
}

async function openPath(path: string) {
  try {
    const file = await invoke<VideoFile>("open_video", { path });
    const collator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });
    state.siblings = file.siblings.sort(collator.compare);
    load({ url: convertFileSrc(file.path), name: file.name, size: file.size, modified: file.modified, file });
  } catch (err) {
    toast(String(err), { tone: "error" });
  }
}

function openBlob(file: File) {
  state.siblings = [];
  load({ url: URL.createObjectURL(file), name: file.name, size: file.size, modified: file.lastModified });
}

function load(source: Source) {
  saveProgress();
  stopConverting();
  if (state.source?.url.startsWith("blob:")) URL.revokeObjectURL(state.source.url);

  state.source = source;
  state.frameDur = 1 / 30;
  state.frameSampled = false;
  state.lastMediaTime = -1;
  const saved = source.file && recent.get(source.file.path);
  state.resumeAt = saved && saved.pos > 10 && saved.pos < saved.dur - 10 ? saved.pos : 0;

  app.classList.remove("is-empty", "has-error", "is-audio-only");
  app.classList.add("is-loading");
  app.classList.toggle("has-playlist", state.siblings.length > 1);
  errorEl.hidden = true;
  closeMenu();
  setTitle(source.name);
  updateNav();

  video.src = source.url;
  preview.removeAttribute("src");
  preview.dataset.src = "";
  renderTime();
  renderInfo();
  video.play().catch(() => {});

  if (source.file) {
    recent.touch({ path: source.file.path, name: source.file.name, folder: source.file.folder });
  }
  poke();
}

function closeVideo() {
  saveProgress();
  stopConverting();
  video.pause();
  video.removeAttribute("src");
  video.load();
  preview.removeAttribute("src");
  preview.dataset.src = "";
  if (state.source?.url.startsWith("blob:")) URL.revokeObjectURL(state.source.url);
  state.source = null;
  state.siblings = [];
  app.classList.remove("has-error", "is-playing", "is-audio-only", "info-open", "has-playlist", "is-loading");
  app.classList.add("is-empty", "is-paused");
  infoBtn.classList.remove("is-on");
  errorEl.hidden = true;
  setTitle("");
  renderRecent();
}

function setTitle(name: string) {
  titleEl.textContent = name;
  document.title = name ? `${name} — MOV Viewer` : "MOV Viewer";
  if (isTauri) getCurrentWindow().setTitle(document.title).catch(() => {});
}

function siblingIndex() {
  return state.siblings.indexOf(state.source?.file?.path ?? "");
}

function updateNav() {
  const i = siblingIndex();
  prevBtn.disabled = i <= 0;
  nextBtn.disabled = i < 0 || i >= state.siblings.length - 1;
}

function openSibling(step: 1 | -1) {
  const i = siblingIndex();
  const target = i < 0 ? undefined : state.siblings[i + step];
  if (target) openPath(target);
}

/* ---------- Converting unsupported codecs ---------- */

const isConverting = () => app.classList.contains("is-converting");
const canConvert = () => isTauri && !!state.source?.file && !state.source.compat;

/** Swaps the unplayable original for ffmpeg's cached H.264 copy; progress, siblings and resume stay on the original. */
async function convert() {
  const source = state.source!;
  app.classList.add("is-converting");
  app.classList.remove("is-loading", "is-audio-only", "has-error");
  errorEl.hidden = true;
  video.pause();
  video.removeAttribute("src");
  video.load();
  renderConvert({ ratio: null, remaining: null });
  convertEl.hidden = false;

  const onProgress = new Channel<ConvertProgress>();
  onProgress.onmessage = (p) => state.source === source && renderConvert(p);
  try {
    const path = await invoke<string>("make_compatible", { path: source.file!.path, onProgress });
    if (state.source !== source) return;
    stopConverting();
    load({ ...source, url: convertFileSrc(path), compat: true });
  } catch (err) {
    if (state.source !== source) return;
    stopConverting();
    if (err === "cancelled") closeVideo();
    else showErrorCard("Video oynatılabilir hale getirilemedi.", String(err));
  }
}

function stopConverting() {
  if (!isConverting()) return;
  invoke("cancel_conversion");
  app.classList.remove("is-converting");
  convertEl.hidden = true;
}

function renderConvert({ ratio, remaining }: ConvertProgress) {
  convertEl.classList.toggle("is-indeterminate", ratio === null);
  convertEl.style.setProperty("--r", String(ratio ?? 0));
  $("convert-pct").textContent = ratio === null ? "" : `%${Math.round(ratio * 100)}`;
  $("convert-meta").textContent =
    remaining === null
      ? "Başlatılıyor…"
      : remaining < 1
        ? "Bitiyor…"
        : remaining < 60
          ? `Yaklaşık ${Math.ceil(remaining)} sn kaldı`
          : `Yaklaşık ${Math.ceil(remaining / 60)} dk kaldı`;
}

/* ---------- Playback ---------- */

function togglePlay() {
  if (!state.source || app.classList.contains("has-error") || isConverting()) return;
  const willPlay = video.paused || video.ended;
  flash(willPlay ? "i-play" : "i-pause");
  if (willPlay) video.play().catch(() => {});
  else video.pause();
}

function seekTo(t: number) {
  if (!video.duration) return;
  video.currentTime = clamp(t, 0, video.duration);
  renderTime();
}

function seekBy(delta: number) {
  if (!video.duration) return;
  seekTo(video.currentTime + delta);
  osd(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} sn  ·  ${formatTime(video.currentTime)}`);
}

function stepFrame(dir: 1 | -1) {
  if (!video.paused) video.pause();
  seekTo(video.currentTime + dir * state.frameDur);
  osd(dir > 0 ? "Sonraki kare" : "Önceki kare");
}

function changeVolume(delta: number) {
  const next = clamp((video.muted ? 0 : video.volume) + delta, 0, 1);
  video.volume = Math.round(next * 100) / 100;
  video.muted = video.volume === 0;
  osd(`Ses %${Math.round(video.volume * 100)}`, video.volume);
}

function toggleMute() {
  if (video.muted || video.volume === 0) {
    if (video.volume === 0) video.volume = 0.5;
    video.muted = false;
    osd(`Ses %${Math.round(video.volume * 100)}`, video.volume);
  } else {
    video.muted = true;
    osd("Ses kapalı", 0);
  }
}

function setSpeed(rate: number) {
  video.playbackRate = rate;
  osd(`Hız ${formatRate(rate)}`);
}

function stepSpeed(dir: 1 | -1) {
  const i = SPEEDS.findIndex((s) => s >= video.playbackRate);
  const current = i < 0 ? SPEEDS.length - 1 : i;
  setSpeed(SPEEDS[clamp(current + dir, 0, SPEEDS.length - 1)]);
}

function toggleLoop() {
  video.loop = !video.loop;
  loopBtn.classList.toggle("is-on", video.loop);
  osd(video.loop ? "Döngü açık" : "Döngü kapalı");
}

async function toggleFullscreen(force?: boolean) {
  const on = force ?? !app.classList.contains("is-fullscreen");
  try {
    if (isTauri) await getCurrentWindow().setFullscreen(on);
    else if (on) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    return;
  }
  syncFullscreen(on);
}

function syncFullscreen(on: boolean) {
  app.classList.toggle("is-fullscreen", on);
  setIcon(fsIcon, on ? "i-fs-exit" : "i-fs-enter");
}

async function snapshot() {
  if (!state.source || !video.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);
  let blob: Blob | null = null;
  try {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    /* tainted canvas */
  }
  if (!blob) {
    toast("Bu videodan kare alınamadı.", { tone: "error" });
    return;
  }
  restartAnimation(shutter);

  if (!isTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.source.name.replace(/\.[^.]+$/, "")} ${formatTime(video.currentTime).replace(/:/g, "-")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  try {
    const path = await invoke<string>("save_snapshot", new Uint8Array(await blob.arrayBuffer()), {
      headers: { "x-time": video.currentTime.toFixed(3) },
    });
    toast("Kare, Resimler › MOV Viewer klasörüne kaydedildi.", {
      tone: "ok",
      action: { label: "Göster", run: () => revealItemInDir(path) },
    });
  } catch (err) {
    toast(String(err), { tone: "error" });
  }
}

/* ---------- Progress & recent files ---------- */

function captureThumb(): string | undefined {
  if (!video.videoWidth || video.readyState < 2) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 108;
    const scale = Math.max(192 / video.videoWidth, 108 / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    canvas.getContext("2d")!.drawImage(video, (192 - w) / 2, (108 - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return undefined;
  }
}

function saveProgress() {
  const file = state.source?.file;
  // While converting, the element holds the audio-only original; its position must not overwrite the saved one.
  if (!file || !video.duration || isConverting()) return;
  const thumb = captureThumb();
  recent.update(file.path, {
    pos: video.currentTime,
    dur: video.duration,
    ...(thumb ? { thumb } : {}),
  });
}

function renderRecent() {
  const items = recent.list();
  $("recent").hidden = items.length === 0;
  $("recent-list").replaceChildren(
    ...items.map((item, index) => {
      const li = document.createElement("li");
      li.className = "recent__item";
      li.style.animationDelay = `${index * 40}ms`;
      li.innerHTML = `
        <button class="recent__open">
          <span class="recent__thumb"><svg class="icon"><use href="#i-film"/></svg></span>
          <span class="recent__meta"><span class="recent__name"></span><span class="recent__sub"></span></span>
          <span class="recent__dur"></span>
        </button>
        <button class="recent__remove" title="Listeden kaldır"><svg class="icon"><use href="#i-x"/></svg></button>`;
      const thumb = li.querySelector<HTMLElement>(".recent__thumb")!;
      if (item.thumb) {
        thumb.style.backgroundImage = `url("${item.thumb}")`;
        thumb.replaceChildren();
      }
      thumb.style.setProperty("--p", String(item.dur ? item.pos / item.dur : 0));
      li.querySelector(".recent__name")!.textContent = item.name;
      li.querySelector(".recent__sub")!.textContent = `${relativeTime(item.at)} · ${item.folder}`;
      li.querySelector(".recent__dur")!.textContent = item.dur ? formatTime(item.dur) : "";
      li.querySelector<HTMLElement>(".recent__open")!.title = item.path;
      li.querySelector(".recent__open")!.addEventListener("click", () => openPath(item.path));
      li.querySelector(".recent__remove")!.addEventListener("click", () => {
        recent.remove(item.path);
        renderRecent();
      });
      return li;
    }),
  );
}

/* ---------- Rendering ---------- */

function renderTime() {
  const d = video.duration || 0;
  const t = video.currentTime || 0;
  app.style.setProperty("--p", String(d ? t / d : 0));
  timeCur.textContent = formatTime(t);
  timeDur.textContent = state.showRemaining ? `−${formatTime(d - t)}` : formatTime(d);
}

function tick() {
  renderTime();
  if (!video.paused) state.raf = requestAnimationFrame(tick);
}

function renderBuffered() {
  const d = video.duration;
  if (!d) return;
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
  }
  seek.style.setProperty("--b", String(end / d));
}

function renderVolume() {
  const level = video.muted ? 0 : video.volume;
  volume.value = String(level);
  volume.style.setProperty("--v", String(level));
  setIcon(volIcon, level === 0 ? "i-mute" : level < 0.5 ? "i-vol-low" : "i-vol");
}

function renderSpeed() {
  speedBtn.textContent = formatRate(video.playbackRate);
  speedBtn.classList.toggle("is-on", video.playbackRate !== 1);
  speedMenu.querySelectorAll<HTMLElement>(".menu__item").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.rate) === video.playbackRate);
  });
}

function renderInfo() {
  const s = state.source;
  if (!s) return;
  const rows: [string, string][] = [["Ad", s.name]];
  if (s.file) rows.push(["Klasör", s.file.folder]);
  if (video.duration) rows.push(["Süre", formatTime(video.duration)]);
  if (video.videoWidth) {
    rows.push(["Çözünürlük", `${video.videoWidth} × ${video.videoHeight}`]);
    rows.push(["En-boy oranı", aspectLabel(video.videoWidth, video.videoHeight)]);
  }
  if (s.compat) rows.push(["Oynatma", "Uyumlu kopya (H.264), orijinal kodek bu sistemde çözülemiyor"]);
  rows.push(["Boyut", formatBytes(s.size)]);
  if (video.duration && s.size) {
    const mbps = (s.size * 8) / video.duration / 1e6;
    rows.push(["Ortalama bit hızı", `${mbps.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mbit/sn`]);
  }
  if (s.modified) rows.push(["Değiştirilme", formatDate(s.modified)]);

  infoList.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "info__row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }),
  );
  revealBtn.hidden = !s.file;
}

function toggleInfo(force?: boolean) {
  const on = force ?? !app.classList.contains("info-open");
  app.classList.toggle("info-open", on);
  infoBtn.classList.toggle("is-on", on);
  if (on) renderInfo();
}

function toggleHelp(force?: boolean) {
  helpEl.hidden = !(force ?? helpEl.hidden);
}

function showError() {
  if (!state.source) return;
  const err = video.error;
  // Chromium reports "can't parse the container" and "can't decode the codec" with the same code.
  const damaged = /DEMUXER_ERROR_(COULD_NOT_OPEN|COULD_NOT_PARSE)/.test(err?.message ?? "");
  const unsupported = err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || err?.code === MediaError.MEDIA_ERR_DECODE;
  if (unsupported && !damaged && canConvert()) {
    convert();
    return;
  }
  const hevcHint = navigator.userAgent.includes("Windows")
    ? " iPhone ile çekilen (HEVC) videolar için Microsoft Store'dan “HEVC Video Uzantıları”nı kurup tekrar deneyin."
    : "";
  showErrorCard(
    damaged
      ? "Dosya bozuk görünüyor ya da geçerli bir video dosyası değil."
      : unsupported
        ? `Bu dosyanın video biçimi (kodek) bu sistemde açılamıyor.${hevcHint}`
        : err?.code === MediaError.MEDIA_ERR_NETWORK
          ? "Dosya okunurken bir sorun oluştu. Dosyanın taşınmadığından veya silinmediğinden emin olun."
          : "Video yüklenirken beklenmeyen bir hata oluştu.",
    err?.message ?? "",
  );
}

function showErrorCard(text: string, detail: string) {
  $("error-text").textContent = text;
  $("error-detail").textContent = detail;
  errorEl.hidden = false;
  app.classList.add("has-error");
  app.classList.remove("is-loading");
}

/* ---------- Feedback: OSD, flash, toasts ---------- */

function restartAnimation(el: HTMLElement) {
  el.classList.remove("go");
  void el.offsetWidth;
  el.classList.add("go");
}

function flash(icon: string) {
  setIcon(flashIcon, icon);
  restartAnimation(flashEl);
}

function osd(text: string, level?: number) {
  osdText.textContent = text;
  osdEl.classList.toggle("has-bar", level !== undefined);
  if (level !== undefined) osdEl.style.setProperty("--v", String(level));
  osdEl.classList.add("show");
  clearTimeout(state.osdTimer);
  state.osdTimer = window.setTimeout(() => osdEl.classList.remove("show"), 1000);
}

interface ToastOptions {
  tone?: "error" | "ok";
  action?: { label: string; run: () => void };
  ms?: number;
}

function toast(message: string, { tone, action, ms = 4000 }: ToastOptions = {}) {
  const el = document.createElement("div");
  el.className = tone ? `toast toast--${tone}` : "toast";
  const dot = document.createElement("span");
  dot.className = "toast__dot";
  const text = document.createElement("span");
  text.className = "toast__text";
  text.textContent = message;
  el.append(dot, text);

  const close = () => {
    if (el.classList.contains("out")) return;
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast__action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.run();
      close();
    });
    el.append(btn);
  }
  toasts.append(el);
  while (toasts.children.length > 3) toasts.firstElementChild!.remove();
  setTimeout(close, ms);
}

/* ---------- Auto-hiding UI ---------- */

function poke() {
  app.classList.add("show-ui");
  app.classList.remove("idle");
  clearTimeout(state.hideTimer);
  state.hideTimer = window.setTimeout(hideUi, HIDE_DELAY);
}

function hideUi() {
  if (video.paused || state.overUi || state.scrubbing || speedMenu.classList.contains("open")) return;
  app.classList.remove("show-ui");
  app.classList.add("idle");
}

for (const el of [controls, titlebar]) {
  el.addEventListener("pointerenter", () => (state.overUi = true));
  el.addEventListener("pointerleave", () => {
    state.overUi = false;
    poke();
  });
}
app.addEventListener("pointermove", poke);
app.addEventListener("pointerdown", poke);
document.documentElement.addEventListener("pointerleave", () => {
  state.overUi = false;
  hideUi();
});

/* ---------- Seek bar ---------- */

const ratioAt = (x: number) => {
  const r = seekTrack.getBoundingClientRect();
  return clamp((x - r.left) / r.width, 0, 1);
};

function scrubTo(x: number) {
  const r = ratioAt(x);
  app.style.setProperty("--p", String(r));
  video.currentTime = r * video.duration;
  timeCur.textContent = formatTime(r * video.duration);
}

let previewBusy = false;
let previewTarget = 0;

function hoverAt(x: number) {
  const d = video.duration;
  if (!d || !state.source) return;
  const r = ratioAt(x);
  seek.style.setProperty("--h", String(r));
  bubbleTime.textContent = formatTime(r * d);
  const rect = seek.getBoundingClientRect();
  const half = bubble.offsetWidth / 2;
  bubble.style.setProperty("--x", `${clamp(x - rect.left, half - 12, rect.width - half + 12)}px`);

  // A second, muted <video> seeks along with the pointer to show a frame preview.
  const canPreview = video.videoWidth > 0 && !preview.error;
  bubble.classList.toggle("no-preview", !canPreview);
  if (!canPreview) return;
  previewTarget = r * d;
  if (preview.dataset.src !== state.source.url) {
    preview.dataset.src = state.source.url;
    previewBusy = true;
    preview.src = state.source.url;
  } else if (!previewBusy) {
    previewBusy = true;
    preview.currentTime = previewTarget;
  }
}

preview.addEventListener("loadedmetadata", () => {
  preview.currentTime = previewTarget;
});
preview.addEventListener("seeked", () => {
  if (Math.abs(preview.currentTime - previewTarget) > 0.2) preview.currentTime = previewTarget;
  else previewBusy = false;
});
preview.addEventListener("error", () => {
  previewBusy = false;
});

seek.addEventListener("pointerdown", (e) => {
  if (!video.duration || e.button !== 0) return;
  seek.setPointerCapture(e.pointerId);
  state.scrubbing = true;
  state.playAfterScrub = !video.paused;
  app.classList.add("is-scrubbing");
  video.pause();
  scrubTo(e.clientX);
});
seek.addEventListener("pointermove", (e) => {
  hoverAt(e.clientX);
  if (state.scrubbing) scrubTo(e.clientX);
});
const endScrub = () => {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  app.classList.remove("is-scrubbing");
  if (state.playAfterScrub) video.play().catch(() => {});
  poke();
};
seek.addEventListener("pointerup", endScrub);
seek.addEventListener("pointercancel", endScrub);
seek.addEventListener("lostpointercapture", endScrub);

/* ---------- Video events ---------- */

video.addEventListener("loadedmetadata", () => {
  const audioOnly = video.videoWidth === 0;
  // The webview found a video track it can't decode (e.g. HEVC 4:2:2) and kept only the sound.
  if (audioOnly && canConvert()) {
    convert();
    return;
  }
  app.classList.toggle("is-audio-only", audioOnly);
  if (audioOnly) toast("Görüntü çözülemedi, yalnızca ses oynatılıyor.", { tone: "error", ms: 7000 });

  const scale = Math.min(176 / (video.videoWidth || 16), 99 / (video.videoHeight || 9));
  preview.style.width = `${Math.round((video.videoWidth || 16) * scale)}px`;
  preview.style.height = `${Math.round((video.videoHeight || 9) * scale)}px`;

  if (state.resumeAt) {
    const at = state.resumeAt;
    state.resumeAt = 0;
    video.currentTime = at;
    toast(`Kaldığınız yerden devam ediliyor: ${formatTime(at)}`, {
      action: { label: "Baştan başla", run: () => seekTo(0) },
      ms: 6000,
    });
  }
  renderTime();
  renderInfo();
});

video.addEventListener("play", () => {
  app.classList.add("is-playing");
  app.classList.remove("is-paused");
  setIcon(playIcon, "i-pause");
  poke();
  cancelAnimationFrame(state.raf);
  tick();
});

video.addEventListener("pause", () => {
  app.classList.remove("is-playing");
  app.classList.add("is-paused");
  setIcon(playIcon, "i-play");
  poke();
  renderTime();
  if (!state.scrubbing) saveProgress();
});

video.addEventListener("waiting", () => app.classList.add("is-loading"));
for (const ev of ["playing", "canplay", "seeked", "loadeddata"]) {
  video.addEventListener(ev, () => app.classList.remove("is-loading"));
}

video.addEventListener("timeupdate", () => {
  if (video.paused) renderTime();
  renderBuffered();
  if (performance.now() - state.lastSave > 5000) {
    state.lastSave = performance.now();
    saveProgress();
  }
});
video.addEventListener("progress", renderBuffered);
video.addEventListener("seeking", () => video.paused && renderTime());
video.addEventListener("ended", poke);
video.addEventListener("error", showError);
video.addEventListener("ratechange", renderSpeed);
video.addEventListener("volumechange", () => {
  renderVolume();
  savePrefs({ volume: video.volume, muted: video.muted });
});

// Learn the real frame duration while playing so , and . step exactly one frame.
if ("requestVideoFrameCallback" in video) {
  const onFrame: VideoFrameRequestCallback = (_now, meta) => {
    const delta = meta.mediaTime - state.lastMediaTime;
    if (state.lastMediaTime >= 0 && delta > 0.004 && delta < 0.1) {
      state.frameDur = state.frameSampled ? Math.min(state.frameDur, delta) : delta;
      state.frameSampled = true;
    }
    state.lastMediaTime = meta.mediaTime;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", () => toggleFullscreen());

stage.addEventListener(
  "wheel",
  (e) => {
    if (!state.source || (e.target as Element).closest(".info, .help, .menu, .error")) return;
    e.preventDefault();
    changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
  },
  { passive: false },
);

/* ---------- Buttons ---------- */

const on = (id: string, fn: () => void) => $(id).addEventListener("click", fn);

on("open-btn", pickFile);
on("open-btn-2", pickFile);
on("error-open", pickFile);
on("error-home", closeVideo);
on("convert-cancel", closeVideo);
on("home-btn", closeVideo);
on("help-btn", () => toggleHelp(true));
on("help-close", () => toggleHelp(false));
on("play-btn", togglePlay);
on("back-btn", () => seekBy(-10));
on("fwd-btn", () => seekBy(10));
on("prev-btn", () => openSibling(-1));
on("next-btn", () => openSibling(1));
on("mute-btn", toggleMute);
on("loop-btn", toggleLoop);
on("snap-btn", snapshot);
on("info-btn", () => toggleInfo());
on("info-close", () => toggleInfo(false));
on("fs-btn", () => toggleFullscreen());
on("recent-clear", () => {
  recent.clear();
  renderRecent();
});
on("reveal-btn", () => {
  if (state.source?.file) revealItemInDir(state.source.file.path);
});
on("time-dur", () => {
  state.showRemaining = !state.showRemaining;
  timeDur.title = state.showRemaining ? "Toplam süreyi göster" : "Kalan süreyi göster";
  renderTime();
});

helpEl.addEventListener("click", (e) => e.target === helpEl && toggleHelp(false));

volume.addEventListener("input", () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
});

speedMenu.innerHTML =
  `<div class="menu__title">Oynatma hızı</div>` +
  SPEEDS.map((s) => `<button class="menu__item" data-rate="${s}">${s === 1 ? "Normal" : formatRate(s)}</button>`).join("");
speedMenu.addEventListener("click", (e) => {
  const item = (e.target as Element).closest<HTMLElement>(".menu__item");
  if (!item) return;
  setSpeed(Number(item.dataset.rate));
  closeMenu();
});
speedBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  speedMenu.classList.toggle("open");
});
function closeMenu() {
  speedMenu.classList.remove("open");
}
document.addEventListener("click", (e) => {
  if (!(e.target as Element).closest(".menu-wrap")) closeMenu();
  // Keep keyboard shortcuts working after a click: don't leave focus on buttons.
  const button = (e.target as Element).closest("button");
  if (button && e.detail > 0) button.blur();
});

$("help-grid").innerHTML = SHORTCUTS.map(
  ([keys, label]) =>
    `<div class="help__row"><span>${label}</span><span class="help__keys">${keys.map((k) => `<kbd>${k}</kbd>`).join("")}</span></div>`,
).join("");

/* ---------- Keyboard ---------- */

window.addEventListener("keydown", (e) => {
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "o") {
    e.preventDefault();
    pickFile();
    return;
  }
  if (key === "Escape") {
    if (!helpEl.hidden) toggleHelp(false);
    else if (speedMenu.classList.contains("open")) closeMenu();
    else if (app.classList.contains("info-open")) toggleInfo(false);
    else if (app.classList.contains("is-fullscreen")) toggleFullscreen(false);
    return;
  }
  if (key === "?") {
    toggleHelp();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !state.source) return;

  const actions: Record<string, () => void> = {
    " ": togglePlay,
    k: togglePlay,
    ArrowLeft: () => seekBy(e.shiftKey ? -1 : -5),
    ArrowRight: () => seekBy(e.shiftKey ? 1 : 5),
    j: () => seekBy(-10),
    l: () => seekBy(10),
    ArrowUp: () => changeVolume(0.05),
    ArrowDown: () => changeVolume(-0.05),
    m: toggleMute,
    f: () => toggleFullscreen(),
    r: toggleLoop,
    s: snapshot,
    i: () => toggleInfo(),
    ",": () => stepFrame(-1),
    ".": () => stepFrame(1),
    "[": () => stepSpeed(-1),
    "]": () => stepSpeed(1),
    Home: () => seekTo(0),
    End: () => seekTo(video.duration),
    N: () => openSibling(1),
    P: () => openSibling(-1),
    PageDown: () => openSibling(1),
    PageUp: () => openSibling(-1),
  };
  const action = actions[key] ?? (key.length === 1 && !e.shiftKey ? actions[key.toLowerCase()] : undefined);
  if (action) {
    e.preventDefault();
    action();
    poke();
  } else if (/^[0-9]$/.test(key) && video.duration) {
    e.preventDefault();
    seekTo((video.duration * Number(key)) / 10);
    poke();
  }
});

/* ---------- Drag & drop, window, startup ---------- */

if (isTauri) {
  getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "enter") {
      app.classList.add("is-dragging");
    } else if (payload.type === "leave") {
      app.classList.remove("is-dragging");
    } else if (payload.type === "drop") {
      app.classList.remove("is-dragging");
      const path = payload.paths.find((p) => VIDEO_EXT.test(p)) ?? payload.paths[0];
      if (path) openPath(path);
    }
  });

  listen<string>("open-file", (e) => openPath(e.payload));

  const win = getCurrentWindow();
  const maxIcon = $("win-max-icon");
  const syncMaximized = async () => setIcon(maxIcon, (await win.isMaximized()) ? "i-win-restore" : "i-win-max");
  on("win-min", () => win.minimize());
  on("win-max", () => win.toggleMaximize());
  on("win-close", () => win.close());
  win.onResized(syncMaximized);
  syncMaximized();
  win.onCloseRequested(() => saveProgress());

  invoke<string | null>("take_startup_file").then((path) => {
    if (path) openPath(path);
  });
} else {
  app.classList.add("is-web");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) openBlob(file);
    fileInput.value = "";
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    app.classList.add("is-dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) app.classList.remove("is-dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    app.classList.remove("is-dragging");
    const file = e.dataTransfer?.files[0];
    if (file) openBlob(file);
  });
  document.addEventListener("fullscreenchange", () => syncFullscreen(!!document.fullscreenElement));
}

if (!import.meta.env.DEV) document.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("beforeunload", saveProgress);
document.addEventListener("visibilitychange", () => document.hidden && saveProgress());

const prefs = loadPrefs();
video.volume = prefs.volume;
video.muted = prefs.muted;
renderVolume();
renderSpeed();
renderRecent();

// Lets the UI be exercised in a plain browser during development.
if (import.meta.env.DEV) {
  (window as unknown as { __openUrl: (url: string, name: string) => void }).__openUrl = (url, name) =>
    load({ url, name, size: 0, modified: null });
}
