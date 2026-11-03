# Atak Viewer: Free MOV Viewer for Windows

**Atak Viewer** is a free **MOV viewer** and player for Windows. Double-click a `.mov` file and it plays, including
the MOV files Windows' own apps can't open: iPhone HEVC (H.265), 10-bit 4:2:2 footage from cameras such as Fujifilm,
and Apple ProRes.

![Atak Viewer, a MOV viewer for Windows, playing a 4K video](docs/atak-viewer-mov-player.jpg)

**[Download for Windows](https://github.com/yavuzyazici/mov-viewer/releases/latest)** ·
[Türkçe](#türkçe) · Sponsored by [Atak Domain](https://www.atakdomain.com/)

## Features

- **Opens MOV files Windows can't play.** H.264 plays directly. When the system can't decode the video (HEVC 4:2:2
  10-bit, ProRes), the bundled FFmpeg converts it while you watch: playback starts in about two seconds instead of
  after a full conversion, and the progress bar shows how much is ready.
- **Instant re-opens.** A video watched to the end is cached, so it plays directly next time.
- **Resume where you left off**, with a recent-files list that shows a thumbnail of your last frame.
- **Precise playback tools:** frame-by-frame stepping, 0.25×–2× speed, loop, and PNG frame snapshots.
- **Folder playlist:** jump to the previous or next video in the same folder.
- **Keyboard first:** Space, J/K/L, arrow keys, F for fullscreen. Press `?` in the app for the full list.
- **Light:** built with Tauri (Rust) instead of Electron; the installer is about 42 MB including FFmpeg.

## How to open MOV files on Windows

1. Download the installer from the [Releases page](https://github.com/yavuzyazici/mov-viewer/releases/latest) and run it.
2. Double-click any `.mov` file (the installer associates `.mov` files with Atak Viewer), drag it into the window,
   or press `Ctrl+O`.
3. If Windows can't decode the video, Atak Viewer converts it in the background and starts playing right away.

## Why does my MOV file play only sound, or not at all?

MOV is a container (Apple's QuickTime format); the video inside it can be H.264, HEVC (H.265), ProRes or another
codec. Windows and browser-based players decode HEVC only with the graphics card, and most graphics cards can't
decode the 10-bit 4:2:2 HEVC that recent cameras record. The result is sound with a black screen. Atak Viewer detects
this and decodes the video with FFmpeg instead.

## Supported MOV formats

| Where the file comes from | Video codec inside the .mov | How Atak Viewer plays it |
| --- | --- | --- |
| Most cameras, phones, screen recordings | H.264 | Directly |
| iPhone, iPad | HEVC (H.265), 8 or 10-bit 4:2:0 | Directly when Windows' "HEVC Video Extensions" are installed, otherwise converted while playing |
| Cameras recording 10-bit 4:2:2 (e.g. Fujifilm) | HEVC 4:2:2 10-bit | Converted while playing (up to 1440p) |
| Editing software exports | Apple ProRes | Converted while playing (up to 1440p) |

Atak Viewer also opens `.mp4`, `.m4v` and `.webm` files.

## FAQ

**Is Atak Viewer free?**
Yes.

**Does it upload my videos anywhere?**
No. Everything runs on your computer, and the original file is never changed.

**Where do converted copies go?**
Into the app's cache folder, capped at 4 GB; the oldest copies are removed first.

**Can it replace QuickTime Player on Windows?**
For watching `.mov` files, yes; it also plays the HEVC and ProRes files QuickTime for Windows never supported.

## Build from source

```bash
npm install
npm run fetch-ffmpeg
npm run tauri dev
```

`fetch-ffmpeg` downloads the bundled FFmpeg (BtbN LGPL build, pinned version, SHA-256 verified) into
`src-tauri/binaries/`, which is not committed. Build the Windows installer
(`src-tauri/target/release/bundle/nsis/`) with:

```bash
npm run tauri build
```

FFmpeg is licensed under the LGPL; source code: <https://ffmpeg.org> and <https://github.com/BtbN/FFmpeg-Builds>.

## Sponsor

Atak Viewer is sponsored by [Atak Domain](https://www.atakdomain.com/): domain names, hosting, corporate e-mail and
SSL certificates.

---

## Türkçe

### Atak Viewer: Windows için ücretsiz MOV oynatıcı

**Atak Viewer**, Windows için ücretsiz bir **MOV dosyası açma** ve oynatma programıdır. `.mov` dosyasına çift
tıklayın, video oynasın. Windows'un kendi uygulamalarının açamadığı MOV dosyaları da buna dahil: iPhone HEVC (H.265),
Fujifilm gibi kameraların 10-bit 4:2:2 görüntüleri ve Apple ProRes.

**[Windows için indir](https://github.com/yavuzyazici/mov-viewer/releases/latest)**

### MOV dosyası nasıl açılır?

1. [Releases sayfasından](https://github.com/yavuzyazici/mov-viewer/releases/latest) kurulum dosyasını indirip
   çalıştırın.
2. `.mov` dosyasına çift tıklayın (kurulum `.mov` dosyalarını Atak Viewer ile ilişkilendirir), pencereye sürükleyin
   ya da `Ctrl+O` ile seçin.
3. Windows videoyu çözemiyorsa Atak Viewer arka planda dönüştürür ve hemen oynatmaya başlar.

### MOV dosyası neden sadece ses veriyor?

MOV bir kapsayıcıdır (Apple QuickTime biçimi); içindeki görüntü H.264, HEVC (H.265), ProRes ya da başka bir kodek
olabilir. Windows ve tarayıcı tabanlı oynatıcılar HEVC'yi yalnızca ekran kartıyla çözer; ekran kartlarının çoğu da
yeni kameraların kaydettiği 10-bit 4:2:2 HEVC'yi çözemez. Sonuç: ses gelir, ekran siyah kalır. Atak Viewer bunu
fark eder ve görüntüyü FFmpeg ile çözer.

### Özellikler

- Windows'un oynatamadığı MOV dosyalarını izlerken dönüştürür; oynatma yaklaşık iki saniyede başlar.
- Sonuna kadar izlenen video önbelleğe alınır, sonraki açılışta doğrudan oynar.
- Kaldığınız yerden devam, son karenin küçük resmiyle son açılanlar listesi.
- Kare kare ilerleme, 0,25×–2× hız, döngü ve kareyi PNG olarak kaydetme.
- Klasördeki önceki / sonraki video; uygulamada `?` ile tüm klavye kısayolları.

### Sponsor

Atak Viewer, [Atak Domain](https://www.atakdomain.com/) sponsorluğunda geliştirilmektedir.
