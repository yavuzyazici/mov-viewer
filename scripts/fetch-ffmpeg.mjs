// Downloads the LGPL ffmpeg build bundled as the app's sidecar (Windows x64) and verifies its checksum.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "autobuild-2026-11-03-12-50";
const ASSET = "ffmpeg-n9.0.2-45-g1e65c6cd5d-win64-lgpl-9.0.zip";
const SHA256 = "b1bae38cca5d84eb0f004f80cfb712d7bb755ef060e5a34207391228793c4406";

const binaries = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));
const target = join(binaries, "ffmpeg-x86_64-pc-windows-msvc.exe");

if (existsSync(target)) {
  console.log("ffmpeg zaten mevcut:", target);
  process.exit(0);
}

const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${ASSET}`;
console.log("İndiriliyor:", url);
const res = await fetch(url);
if (!res.ok) throw new Error(`İndirme başarısız: HTTP ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const hash = createHash("sha256").update(zip).digest("hex");
if (hash !== SHA256) throw new Error(`SHA-256 eşleşmedi: ${hash}`);

const work = mkdtempSync(join(tmpdir(), "ffmpeg-"));
try {
  const zipPath = join(work, ASSET);
  writeFileSync(zipPath, zip);
  // Windows' own bsdtar reads zip files; Git Bash's GNU tar would not.
  const tar = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", zipPath, "-C", work]);
  const root = readdirSync(work, { withFileTypes: true }).find((e) => e.isDirectory());
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(work, root.name, "bin", "ffmpeg.exe"), target);
  copyFileSync(join(work, root.name, "LICENSE.txt"), join(binaries, "ffmpeg-LICENSE.txt"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("ffmpeg hazır:", target);
