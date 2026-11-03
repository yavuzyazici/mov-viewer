const LOCALE = "tr-TR";

/** 75 → "1:15", 3725 → "1:02:05" */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(LOCALE, { dateStyle: "long", timeStyle: "short" });
}

export function formatRate(rate: number): string {
  return `${rate.toLocaleString(LOCALE)}×`;
}

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

export function relativeTime(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (minutes > -1) return "az önce";
  if (minutes > -60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

/** 1920×1080 → "16:9", 1080×1920 → "9:16" */
export function aspectLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const known: [number, string][] = [
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [21 / 9, "21:9"],
    [2.39, "2.39:1"],
    [1, "1:1"],
  ];
  const ratio = width / height;
  const match = known.find(([r]) => Math.abs(r - ratio) < 0.02);
  if (match) return match[1];
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}
