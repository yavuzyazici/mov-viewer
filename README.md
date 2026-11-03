# MOV Viewer

`.mov` (QuickTime) videoları açan, hafif bir masaüstü oynatıcı. Tauri 2 + Vite + TypeScript.

## Özellikler

- Sürükle-bırak, `Ctrl+O` ya da dosyaya çift tık (kurulumda `.mov` ilişkilendirilir)
- Önizlemeli ilerleme çubuğu, kare kare ilerleme, hız ve döngü
- Kaldığın yerden devam, küçük resimli son açılanlar listesi
- Klasördeki önceki / sonraki video
- Kareyi PNG olarak kaydetme (`Resimler/MOV Viewer`)
- Kısayolların tamamı için uygulamada `?` tuşu

## Geliştirme

```bash
npm install
npm run fetch-ffmpeg
npm run tauri dev
```

`fetch-ffmpeg`, uygulamaya gömülen ffmpeg'i (BtbN LGPL derlemesi, sabit sürüm, SHA-256 doğrulamalı)
`src-tauri/binaries/` altına indirir. Bu klasör git'e girmez.

Kurulum dosyası (`src-tauri/target/release/bundle/nsis/`):

```bash
npm run tauri build
```

## Kodek desteği

Videolar önce sistemin tarayıcı motoruyla (Windows'ta WebView2) oynatılır. Motor görüntüyü çözemezse (ör. kameraların
HEVC 4:2:2 10-bit, ProRes) ffmpeg videoyu arka planda H.264'e (en fazla 1440p) çevirir ve oynatma ilk yarım saniye
hazır olunca başlar; çevrilen kısım ilerleme çubuğunda görünür, içinde anında gezinilir. Baştan sona izlenen video
önbelleğe alınır (en fazla 4 GB, en eskiler silinir) ve bir sonraki açılışta doğrudan oynar.

ffmpeg LGPL lisanslıdır; kaynak kodu: <https://ffmpeg.org> ve <https://github.com/BtbN/FFmpeg-Builds>.
