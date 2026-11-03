import { invoke } from "@tauri-apps/api/core";

/** Returned by `probe_video`. */
export interface ProbeInfo {
  duration: number | null;
  hasAudio: boolean;
  /** e.g. "hevc (Rext), yuv422p10le" */
  codec: string | null;
  width: number | null;
  height: number | null;
}

interface StreamStatus {
  converted: number;
  done: boolean;
  written: number;
}

interface Callbacks {
  onError: (message: string) => void;
  /** Called when more of the video has been converted. */
  onProgress: () => void;
}

/** Stop pulling once this many seconds are buffered ahead of the playhead. */
const AHEAD = 30;
/** Media played longer ago than this is dropped to stay under the browser's buffer quota. */
const BEHIND = 30;
/**
 * A seek at most this far past the converted part waits for ffmpeg instead of restarting it.
 * Restarting costs ~2–2.5 s; conversion runs at ~1.2–1.8×, so waiting only wins for short gaps.
 */
const WAIT_AHEAD = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const updated = (sb: SourceBuffer) =>
  new Promise<void>((resolve) => sb.addEventListener("updateend", () => resolve(), { once: true }));

/**
 * Plays a file the webview can't decode: `start_stream` makes ffmpeg write fragmented H.264 MP4 to
 * disk, and this pulls those bytes into a MediaSource while the conversion is still running.
 */
export class LiveStream {
  readonly url: string;
  /** Media time converted so far (for the seek bar). */
  converted: number;

  private readonly media = new MediaSource();
  private buffer?: SourceBuffer;
  private info?: ProbeInfo;
  private readonly firstJob: Promise<number>;
  private job = 0;
  private offset = 0;
  /** Where the current ffmpeg job started. */
  private from: number;
  private ended = false;
  private alive = true;
  /** Bumped whenever the read position jumps, so answers to older reads are dropped. */
  private generation = 0;
  /** A seek or restart in progress; the pump waits for it. */
  private switching: Promise<void> | null = null;
  private seekTimer = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly path: string,
    info: Promise<ProbeInfo>,
    start: number,
    private readonly callbacks: Callbacks,
  ) {
    this.url = URL.createObjectURL(this.media);
    this.from = this.converted = start;
    // ffmpeg starts right away, alongside the probe and the page attaching the MediaSource.
    this.firstJob = invoke<number>("start_stream", { path, start });
    this.media.addEventListener("sourceopen", () => this.open(info, start), { once: true });
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("waiting", this.onWaiting);
  }

  destroy() {
    this.alive = false;
    this.generation++;
    clearTimeout(this.seekTimer);
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("waiting", this.onWaiting);
    // Name the job: a newer stream may already have started its own.
    if (this.job) invoke("stop_stream", { job: this.job });
    else this.firstJob.then((job) => invoke("stop_stream", { job })).catch(() => {});
    URL.revokeObjectURL(this.url);
  }

  private async open(info: Promise<ProbeInfo>, start: number) {
    try {
      const [probe, job] = await Promise.all([info, this.firstJob]);
      if (!this.alive) return;
      this.info = probe;
      const codecs = probe.hasAudio ? "avc1.640033, mp4a.40.2" : "avc1.640033";
      this.buffer = this.media.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
      if (probe.duration) this.media.duration = probe.duration;
      this.useJob(job, start);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.pump();
  }

  /** Starts a new ffmpeg job at `time` (the backend stops the old one). */
  private async restart(time: number) {
    const job = await invoke<number>("start_stream", { path: this.path, start: time });
    if (!this.alive) {
      invoke("stop_stream", { job });
      return;
    }
    await this.reset();
    this.useJob(job, time);
  }

  private useJob(job: number, time: number) {
    // ffmpeg stamps a stream started at `time` from 0; shift it into place.
    this.buffer!.timestampOffset = time;
    this.job = job;
    this.offset = 0;
    this.from = this.converted = time;
    this.ended = false;
    this.generation++;
  }

  /** Lets the next append start at a fresh box boundary. */
  private async reset() {
    const sb = this.buffer!;
    if (sb.updating) await updated(sb);
    if (this.media.readyState === "open") sb.abort();
  }

  private async pump() {
    while (this.alive) {
      if (this.switching) {
        await this.switching;
        continue;
      }
      if (this.ended || this.bufferedAhead() > AHEAD) {
        await sleep(250);
        continue;
      }
      const { generation, job, offset } = this;
      try {
        const chunk = await invoke<ArrayBuffer>("read_stream", { job, offset });
        if (generation !== this.generation || !this.alive) continue;
        if (chunk.byteLength > 0) {
          await this.append(chunk);
          if (generation !== this.generation) continue;
          this.offset += chunk.byteLength;
        }
        await this.checkStatus();
        // Everything read but not ended (a hole is still being refilled): don't spin.
        if (chunk.byteLength === 0 && !this.ended) await sleep(250);
      } catch (err) {
        // Errors from a read that a seek has made obsolete (e.g. "stale" job) are expected.
        if (generation === this.generation) {
          this.fail(err);
          return;
        }
      }
    }
  }

  private async append(chunk: ArrayBuffer) {
    const sb = this.buffer!;
    await this.evict(BEHIND + 15);
    for (;;) {
      try {
        sb.appendBuffer(chunk);
        await updated(sb);
        return;
      } catch (err) {
        if ((err as DOMException).name !== "QuotaExceededError" || !this.alive) throw err;
        // Buffer full: drop what was played, or wait for the playhead to move on.
        if (!(await this.evict(BEHIND))) await sleep(500);
      }
    }
  }

  /** Removes media more than `keep` seconds behind the playhead; true if anything was removed. */
  private async evict(keep: number) {
    const sb = this.buffer!;
    const until = this.video.currentTime - keep;
    if (!sb.buffered.length || sb.buffered.start(0) >= until) return false;
    if (sb.updating) await updated(sb);
    sb.remove(0, until);
    await updated(sb);
    return true;
  }

  private async checkStatus() {
    const { generation, job } = this;
    const status = await invoke<StreamStatus>("stream_status", { job });
    if (generation !== this.generation || !this.alive) return;
    this.converted = Math.min(status.converted, this.info?.duration ?? this.video.duration);
    this.callbacks.onProgress();
    if (status.done && this.offset >= status.written && !this.ended && this.reachesEnd()) {
      const sb = this.buffer!;
      if (sb.updating) await updated(sb);
      if (this.media.readyState === "open") this.media.endOfStream();
      this.ended = true;
    }
  }

  /**
   * Whether the buffer runs without a hole from the playhead to the end. Ending the stream with a
   * hole in between makes the browser treat the hole as the end and jump there.
   */
  private reachesEnd() {
    const b = this.buffer!.buffered;
    const t = this.video.currentTime;
    // The playhead's range must be the last one: nothing beyond a hole.
    const last = b.length - 1;
    return last >= 0 && b.start(last) <= t + 0.5;
  }

  private bufferedAhead() {
    const b = this.buffer!.buffered;
    const t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.3 && t < b.end(i)) return b.end(i) - t;
    }
    return 0;
  }

  private isBuffered(t: number) {
    const b = this.buffer!.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.1 && t < b.end(i) - 0.1) return true;
    }
    return false;
  }

  /**
   * A stall on a hole in data that already arrived is handled like a seek there, so the missing
   * part is read again. Stalls while the first data is still on its way are left alone.
   */
  private onWaiting = () => {
    if (this.video.readyState < HTMLMediaElement.HAVE_METADATA || !this.buffer?.buffered.length) return;
    this.onSeeking();
  };

  // Scrubbing fires many seeks; act on where it settles.
  private onSeeking = () => {
    clearTimeout(this.seekTimer);
    this.seekTimer = window.setTimeout(() => this.handleSeek(), 150);
  };

  private async handleSeek() {
    while (this.switching) await this.switching;
    const t = this.video.currentTime;
    if (!this.alive || !this.buffer || this.isBuffered(t)) return;
    const work = this.jumpTo(t);
    this.switching = work;
    try {
      await work;
    } catch (err) {
      this.fail(err);
    } finally {
      if (this.switching === work) this.switching = null;
    }
  }

  private async jumpTo(t: number) {
    // Converted already (or about to be): continue reading from the fragment that holds `t`.
    if (t >= this.from && t < this.converted + WAIT_AHEAD) {
      const offset = await invoke<number | null>("stream_seek", { job: this.job, time: t });
      if (!this.alive) return;
      // No fragment yet: the job has just started at `from` and delivers `t` in order anyway.
      if (offset === null) return;
      await this.reset();
      this.offset = offset;
      this.ended = false;
      this.generation++;
      return;
    }
    await this.restart(t);
  }

  private fail(err: unknown) {
    if (!this.alive) return;
    this.alive = false;
    this.callbacks.onError(String(err));
  }
}
