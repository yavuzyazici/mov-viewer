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
npm run tauri dev
```

Kurulum dosyası (`src-tauri/target/release/bundle/nsis/`):

```bash
npm run tauri build
```

## Kodek desteği

Videolar sistemin tarayıcı motoruyla (Windows'ta WebView2) çözülür. H.264 sorunsuz oynar; iPhone'un HEVC videoları için Windows'ta
"HEVC Video Uzantıları" gerekir. ProRes desteklenmez.
