export type Lang = "tr" | "en";

/** Turkish on Turkish Windows, English everywhere else; `mv.lang` in storage forces one (for testing). */
export const lang: Lang = (() => {
  try {
    const forced = localStorage.getItem("mv.lang");
    if (forced === "tr" || forced === "en") return forced;
  } catch {
    /* storage unavailable */
  }
  return navigator.language.toLowerCase().startsWith("tr") ? "tr" : "en";
})();

export const locale = lang === "tr" ? "tr-TR" : "en-US";

const tr = {
  // Window and start screen
  home: "Başlangıç ekranı",
  minimize: "Simge durumuna küçült",
  maximize: "Ekranı kapla",
  close: "Kapat",
  audioOnly: "Görüntü bu sistemde çözülemiyor, yalnızca ses oynatılıyor.",
  emptyTitle: "MOV videolarını hemen izle",
  emptyLead: "Bir videoyu pencereye sürükleyin ya da bilgisayarınızdan seçin.",
  openFile: "Dosya aç",
  recent: "Son açılanlar",
  clearList: "Listeyi temizle",
  removeFromList: "Listeden kaldır",
  shortcuts: "Klavye kısayolları",
  sponsorTitle: "atakdomain.com'u tarayıcıda aç",
  dropTitle: "Bırakın, hemen oynatalım",
  dropFormats: ".mov, .mp4 ve .m4v dosyaları",
  // Controls
  openFileTip: "Dosya aç (Ctrl+O)",
  muteTip: "Sesi kapat (M)",
  volume: "Ses düzeyi",
  prevTip: "Önceki video (Shift+P)",
  backTip: "10 sn geri (J)",
  playTip: "Oynat / duraklat (Boşluk)",
  fwdTip: "10 sn ileri (L)",
  nextTip: "Sonraki video (Shift+N)",
  speedTip: "Oynatma hızı ([ / ])",
  loopTip: "Döngü (R)",
  snapTip: "Kareyi kaydet (S)",
  infoTip: "Dosya bilgisi (I)",
  fullscreenTip: "Tam ekran (F)",
  closeTip: "Kapat (Esc)",
  showRemaining: "Kalan süreyi göster",
  showTotal: "Toplam süreyi göster",
  playbackSpeed: "Oynatma hızı",
  normalSpeed: "Normal",
  // On-screen messages
  seconds: "sn",
  nextFrame: "Sonraki kare",
  prevFrame: "Önceki kare",
  volumeLevel: "Ses %{n}",
  muted: "Ses kapalı",
  speed: "Hız {rate}",
  loopOn: "Döngü açık",
  loopOff: "Döngü kapalı",
  snapFailed: "Bu videodan kare alınamadı.",
  snapSaved: "Kare, Resimler › Atak Viewer klasörüne kaydedildi.",
  show: "Göster",
  resumed: "Kaldığınız yerden devam ediliyor: {time}",
  startOver: "Baştan başla",
  audioOnlyToast: "Görüntü çözülemedi, yalnızca ses oynatılıyor.",
  tooSlow: "Bu video bu cihazda akıcı oynamıyor; izlerken dönüştürülerek oynatılıyor.",
  // Open dialog
  openVideo: "Video aç",
  videos: "Videolar",
  quicktime: "QuickTime film",
  // Info panel
  fileInfo: "Dosya bilgisi",
  showInFolder: "Klasörde göster",
  name: "Ad",
  folder: "Klasör",
  duration: "Süre",
  codec: "Kodek",
  resolution: "Çözünürlük",
  aspect: "En-boy oranı",
  playback: "Oynatma",
  playbackLive: "Bu kodek sistemde çözülemiyor; izlerken H.264'e dönüştürülüyor{quality}",
  playbackCached: "Bu kodek sistemde çözülemiyor; hazır H.264 kopya oynatılıyor{quality}",
  size: "Boyut",
  bitrate: "Ortalama bit hızı",
  mbps: "Mbit/sn",
  modified: "Değiştirilme",
  // Errors
  cantPlay: "Bu video oynatılamıyor",
  backToStart: "Başlangıca dön",
  openAnother: "Başka dosya aç",
  damaged: "Dosya bozuk görünüyor ya da geçerli bir video dosyası değil.",
  unsupported: "Bu dosyanın video biçimi (kodek) bu sistemde açılamıyor.",
  hevcHint: " iPhone ile çekilen (HEVC) videolar için Microsoft Store'dan “HEVC Video Uzantıları”nı kurup tekrar deneyin.",
  linuxHint: " GStreamer'ın libav eklentisini (gstreamer1.0-libav) kurup tekrar deneyin.",
  readError: "Dosya okunurken bir sorun oluştu. Dosyanın taşınmadığından veya silinmediğinden emin olun.",
  unexpected: "Video yüklenirken beklenmeyen bir hata oluştu.",
  openFailed: "Video açılamadı.",
  convertFailed: "Video oynatılabilir hale getirilemedi.",
  // Keyboard shortcuts
  keySpace: "Boşluk",
  scPlay: "Oynat / duraklat",
  sc5: "5 sn geri / ileri",
  sc10: "10 sn geri / ileri",
  scFrame: "Kare kare geri / ileri",
  scVolume: "Sesi aç / kıs",
  scMute: "Sesi kapat",
  scSpeed: "Yavaşlat / hızlandır",
  scPercent: "Videonun %0–90'ına git",
  scFullscreen: "Tam ekran (ya da çift tık)",
  scLoop: "Döngü",
  scSnap: "Kareyi resim olarak kaydet",
  scInfo: "Dosya bilgisi",
  scNext: "Klasördeki sonraki video",
  scPrev: "Klasördeki önceki video",
  scOpen: "Dosya aç",
  scClose: "Kapat / tam ekrandan çık",
  justNow: "az önce",
};

type Key = keyof typeof tr;

const en: Record<Key, string> = {
  home: "Start screen",
  minimize: "Minimize",
  maximize: "Maximize",
  close: "Close",
  audioOnly: "This system can't decode the picture; playing sound only.",
  emptyTitle: "Watch MOV videos instantly",
  emptyLead: "Drag a video into the window or pick one from your computer.",
  openFile: "Open file",
  recent: "Recent",
  clearList: "Clear list",
  removeFromList: "Remove from list",
  shortcuts: "Keyboard shortcuts",
  sponsorTitle: "Open atakdomain.com in your browser",
  dropTitle: "Drop it to play",
  dropFormats: ".mov, .mp4 and .m4v files",
  openFileTip: "Open file (Ctrl+O)",
  muteTip: "Mute (M)",
  volume: "Volume",
  prevTip: "Previous video (Shift+P)",
  backTip: "Back 10 s (J)",
  playTip: "Play / pause (Space)",
  fwdTip: "Forward 10 s (L)",
  nextTip: "Next video (Shift+N)",
  speedTip: "Playback speed ([ / ])",
  loopTip: "Loop (R)",
  snapTip: "Save frame (S)",
  infoTip: "File info (I)",
  fullscreenTip: "Fullscreen (F)",
  closeTip: "Close (Esc)",
  showRemaining: "Show remaining time",
  showTotal: "Show total time",
  playbackSpeed: "Playback speed",
  normalSpeed: "Normal",
  seconds: "s",
  nextFrame: "Next frame",
  prevFrame: "Previous frame",
  volumeLevel: "Volume {n}%",
  muted: "Muted",
  speed: "Speed {rate}",
  loopOn: "Loop on",
  loopOff: "Loop off",
  snapFailed: "Couldn't capture a frame from this video.",
  snapSaved: "Frame saved to Pictures › Atak Viewer.",
  show: "Show",
  resumed: "Resuming where you left off: {time}",
  startOver: "Start over",
  audioOnlyToast: "The picture couldn't be decoded; playing sound only.",
  tooSlow: "This video doesn't play smoothly on this device; converting it while you watch.",
  openVideo: "Open video",
  videos: "Videos",
  quicktime: "QuickTime movie",
  fileInfo: "File info",
  showInFolder: "Show in folder",
  name: "Name",
  folder: "Folder",
  duration: "Duration",
  codec: "Codec",
  resolution: "Resolution",
  aspect: "Aspect ratio",
  playback: "Playback",
  playbackLive: "This system can't decode this codec; converting to H.264 while you watch{quality}",
  playbackCached: "This system can't decode this codec; playing a ready H.264 copy{quality}",
  size: "Size",
  bitrate: "Average bitrate",
  mbps: "Mbit/s",
  modified: "Modified",
  cantPlay: "This video can't be played",
  backToStart: "Back to start",
  openAnother: "Open another file",
  damaged: "The file looks damaged or isn't a valid video file.",
  unsupported: "This system can't open the video format (codec) of this file.",
  hevcHint: " For iPhone (HEVC) videos, install “HEVC Video Extensions” from the Microsoft Store and try again.",
  linuxHint: " Install GStreamer's libav plugin (gstreamer1.0-libav) and try again.",
  readError: "There was a problem reading the file. Make sure it hasn't been moved or deleted.",
  unexpected: "Something unexpected went wrong while loading the video.",
  openFailed: "The video couldn't be opened.",
  convertFailed: "The video couldn't be made playable.",
  keySpace: "Space",
  scPlay: "Play / pause",
  sc5: "Back / forward 5 s",
  sc10: "Back / forward 10 s",
  scFrame: "Previous / next frame",
  scVolume: "Volume up / down",
  scMute: "Mute",
  scSpeed: "Slower / faster",
  scPercent: "Jump to 0–90% of the video",
  scFullscreen: "Fullscreen (or double-click)",
  scLoop: "Loop",
  scSnap: "Save frame as an image",
  scInfo: "File info",
  scNext: "Next video in the folder",
  scPrev: "Previous video in the folder",
  scOpen: "Open file",
  scClose: "Close / exit fullscreen",
  justNow: "just now",
};

const strings: Record<Lang, Record<Key, string>> = { tr, en };

/** The text for `key` in the UI language, with `{name}` placeholders filled from `vars`. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return strings[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

/**
 * Translates the static page: `data-i18n` sets the text, `data-i18n-title` the tooltip and
 * `data-i18n-aria` the accessible name.
 */
export function translatePage() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n as Key);
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle as Key);
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria as Key));
  }
}
