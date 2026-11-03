// Downloads the LGPL ffmpeg build bundled as the app's sidecar and verifies its checksum.
// Usage: node scripts/fetch-ffmpeg.mjs [windows|linux]   (default: the platform it runs on)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "autobuild-2026-11-03-12-50";
const BUILD = "ffmpeg-n9.0.2-45-g1e65c6cd5d";
const TARGETS = {
  windows: {
    asset: `${BUILD}-win64-lgpl-9.0.zip`,
    sha256: "b1bae38cca5d84eb0f004f80cfb712d7bb755ef060e5a34207391228793c4406",
    exe: "ffmpeg.exe",
    sidecar: "atak-ffmpeg-x86_64-pc-windows-msvc.exe",
  },
  linux: {
    asset: `${BUILD}-linux64-lgpl-9.0.tar.xz`,
    sha256: "272469ca2a974222653abbc8a515e276c64fe859e061978d0c44d2c70b82c4da",
    exe: "ffmpeg",
    sidecar: "atak-ffmpeg-x86_64-unknown-linux-gnu",
  },
};

const name = process.argv[2] ?? (process.platform === "win32" ? "windows" : "linux");
const spec = TARGETS[name];
if (!spec) throw new Error(`Bilinmeyen hedef: ${name} (windows ya da linux)`);

const binaries = fileURLToPath(new URL("../src-tauri/binaries/", import.meta.url));
const target = join(binaries, spec.sidecar);

if (existsSync(target)) {
  console.log("ffmpeg zaten mevcut:", target);
  process.exit(0);
}

const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${spec.asset}`;
console.log("İndiriliyor:", url);
const res = await fetch(url);
if (!res.ok) throw new Error(`İndirme başarısız: HTTP ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const hash = createHash("sha256").update(archive).digest("hex");
if (hash !== spec.sha256) throw new Error(`SHA-256 eşleşmedi: ${hash}`);

const work = mkdtempSync(join(tmpdir(), "ffmpeg-"));
try {
  const archivePath = join(work, spec.asset);
  writeFileSync(archivePath, archive);
  // Windows' own bsdtar reads zip files; Git Bash's GNU tar would not.
  const tar = process.platform === "win32" && process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archivePath, "-C", work]);
  const root = readdirSync(work, { withFileTypes: true }).find((e) => e.isDirectory());
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(work, root.name, "bin", spec.exe), target);
  chmodSync(target, 0o755);
  copyFileSync(join(work, root.name, "LICENSE.txt"), join(binaries, "ffmpeg-LICENSE.txt"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("ffmpeg hazır:", target);
