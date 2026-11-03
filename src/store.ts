export interface RecentItem {
  path: string;
  name: string;
  folder: string;
  /** Last playback position and duration, in seconds. */
  pos: number;
  dur: number;
  /** Last opened, unix ms. */
  at: number;
  /** Small JPEG data URL of the last frame seen. */
  thumb?: string;
}

export interface Prefs {
  volume: number;
  muted: boolean;
}

const RECENT_KEY = "mv.recent";
const PREFS_KEY = "mv.prefs";
const MAX_RECENT = 8;

// Storage can be unavailable or full; the app must keep working without it.
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const recent = {
  list(): RecentItem[] {
    return read<RecentItem[]>(RECENT_KEY, []);
  },
  get(path: string): RecentItem | undefined {
    return this.list().find((r) => r.path === path);
  },
  /** Moves the file to the top of the list, keeping its saved position. */
  touch(item: Pick<RecentItem, "path" | "name" | "folder">) {
    const rest = this.list().filter((r) => r.path !== item.path);
    const next: RecentItem = { pos: 0, dur: 0, ...this.get(item.path), ...item, at: Date.now() };
    write(RECENT_KEY, [next, ...rest].slice(0, MAX_RECENT));
  },
  update(path: string, patch: Partial<RecentItem>) {
    write(
      RECENT_KEY,
      this.list().map((r) => (r.path === path ? { ...r, ...patch } : r)),
    );
  },
  remove(path: string) {
    write(
      RECENT_KEY,
      this.list().filter((r) => r.path !== path),
    );
  },
  clear() {
    write(RECENT_KEY, []);
  },
};

export function loadPrefs(): Prefs {
  return { volume: 1, muted: false, ...read<Partial<Prefs>>(PREFS_KEY, {}) };
}

export function savePrefs(prefs: Prefs) {
  write(PREFS_KEY, prefs);
}
