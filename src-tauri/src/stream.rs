//! Plays videos the webview can't decode (e.g. HEVC 4:2:2 10-bit from cameras): the bundled ffmpeg
//! converts them to fragmented H.264 MP4 on disk while the page pulls the bytes into a MediaSource,
//! so playback starts after the first second instead of after the whole conversion. A stream that
//! ran from the start to the end is remuxed into a cached plain MP4 for instant later opens.

use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Manager, State};

/// Cached copies are trimmed (oldest first) above this size.
const CACHE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
/// Largest chunk handed to the page per read.
const MAX_READ: u64 = 4 * 1024 * 1024;

/// Decoding 4:2:2 HEVC is CPU bound; capping the short side at 1440 px keeps conversion clearly
/// faster than playback (measured 1.4–1.8× vs 1.2–1.6× at 4K) and looks the same on 1080p screens.
const SCALE: &str = "scale=w='if(gte(iw,ih),-2,min(1440,iw))':h='if(gte(iw,ih),min(1440,ih),-2)'";

/// Tried in order; bitrate is capped (~16 Mbit/s, peaks 24) to keep copies small.
const ENCODERS: &[&[&str]] = &[
    &[
        "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", "24M",
        "-bufsize", "48M",
    ],
    &["-c:v", "h264_qsv", "-preset", "faster", "-b:v", "16M", "-maxrate", "24M"],
    &["-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak", "-b:v", "16M", "-maxrate", "24M"],
    &["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", "16M"],
    &["-c:v", "libopenh264", "-b:v", "12M"],
];

fn ffmpeg() -> Command {
    // Tauri copies the `externalBin` sidecar next to the app executable.
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(name));
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Index into ENCODERS of the encoder to try first; usize::MAX until known.
static ENCODER: AtomicUsize = AtomicUsize::new(usize::MAX);
static DETECTING: Mutex<()> = Mutex::new(());

/// First encoder in ENCODERS that works on this machine (e.g. NVENC needs a recent driver).
/// Each failed try launches ffmpeg, so this takes a few seconds. Callers hold DETECTING.
fn detect_encoder() -> usize {
    ENCODERS
        .iter()
        .position(|args| {
            ffmpeg()
                .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
                .arg("color=c=black:s=1280x720:r=30:d=0.3")
                .args(*args)
                .args(["-pix_fmt", "yuv420p", "-f", "null", "-"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .unwrap_or(ENCODERS.len() - 1)
}

fn encoder() -> usize {
    let known = ENCODER.load(Ordering::SeqCst);
    if known != usize::MAX {
        return known;
    }
    // Startup may be detecting already: wait for it rather than detecting twice.
    let _detecting = DETECTING.lock().unwrap();
    let known = ENCODER.load(Ordering::SeqCst);
    if known != usize::MAX {
        return known;
    }
    let found = detect_encoder();
    ENCODER.store(found, Ordering::SeqCst);
    found
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("compat");
    fs::create_dir_all(&dir).map_err(|e| format!("Önbellek klasörü oluşturulamadı: {e}"))?;
    Ok(dir)
}

fn cache_key(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    (path, meta.len(), modified).hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

/// Deletes the oldest cached copies until the cache fits CACHE_LIMIT, never touching `keep`.
fn trim_cache(dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "mp4"))
        .filter_map(|p| {
            let meta = fs::metadata(&p).ok()?;
            Some((meta.modified().ok()?, meta.len(), p))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if path != keep && fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// Runs once at startup: removes leftovers of streams interrupted by a crash or a forced close, and
/// settles the encoder. The one that worked last time is used right away, so a video opened by
/// double click doesn't wait for detection; detection still reruns in the background, a bit later,
/// to pick up a faster encoder after e.g. a driver update.
pub fn init(app: &AppHandle) {
    let Ok(dir) = cache_dir(app) else { return };
    let remembered_file = dir.join("encoder.txt");
    let remembered = fs::read_to_string(&remembered_file)
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&i| i < ENCODERS.len());
    if let Some(index) = remembered {
        ENCODER.store(index, Ordering::SeqCst);
    }
    thread::spawn(move || {
        if let Ok(entries) = fs::read_dir(&dir) {
            for path in entries.filter_map(Result::ok).map(|e| e.path()) {
                if path.extension().is_some_and(|e| e == "frag" || e == "part") {
                    let _ = fs::remove_file(path);
                }
            }
        }
        if remembered == Some(0) {
            return; // Already the fastest; a failure falls back per stream.
        }
        if remembered.is_some() {
            // Don't compete with a video the user has just opened.
            thread::sleep(Duration::from_secs(8));
        }
        let _detecting = DETECTING.lock().unwrap();
        let known = ENCODER.load(Ordering::SeqCst);
        // First launch: a video opened right away may have detected while we waited.
        let found = if remembered.is_none() && known != usize::MAX { known } else { detect_encoder() };
        ENCODER.store(found, Ordering::SeqCst);
        let _ = fs::write(&remembered_file, found.to_string());
    });
}

/* ---------- Probing ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    duration: Option<f64>,
    has_audio: bool,
    /// e.g. "hevc (Rext), yuv422p10le"
    codec: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

/// The finished H.264 copy from an earlier full playback, if any, ready for native playback.
/// Only a file check, so it doesn't delay the start like launching ffmpeg would.
#[tauri::command]
pub fn cached_copy(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let cached = cache_dir(&app)?.join(format!("{}.mp4", cache_key(Path::new(&path))?));
    if !cached.is_file() {
        return Ok(None);
    }
    // Mark as recently used so trimming keeps it.
    let _ = File::options()
        .write(true)
        .open(&cached)
        .and_then(|f| f.set_modified(SystemTime::now()));
    app.asset_protocol_scope()
        .allow_file(&cached)
        .map_err(|e| e.to_string())?;
    Ok(Some(cached.to_string_lossy().into_owned()))
}

/// "Duration: 00:01:02.50," → 62.5
fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration: ")?;
    let mut parts = rest.split(',').next()?.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?)
}

/// Splits on commas that are not inside parentheses: "a (x, y), b" → ["a (x, y)", "b"].
fn split_top_level(s: &str) -> Vec<&str> {
    let (mut parts, mut depth, mut start) = (Vec::new(), 0i32, 0);
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(s[start..].trim());
    parts
}

#[tauri::command]
pub async fn probe_video(path: String) -> Result<ProbeInfo, String> {
    let src = PathBuf::from(&path);
    let output = tauri::async_runtime::spawn_blocking(move || ffmpeg().args(["-hide_banner", "-i"]).arg(&src).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("ffmpeg başlatılamadı: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut info = ProbeInfo {
        duration: stderr.lines().find_map(parse_duration),
        has_audio: stderr.lines().any(|l| l.contains("Stream #0:") && l.contains(": Audio: ")),
        codec: None,
        width: None,
        height: None,
    };
    if let Some(video) = stderr
        .lines()
        .filter(|l| l.contains("Stream #0:"))
        .find_map(|l| l.split_once(": Video: ").map(|(_, v)| v))
    {
        // "hevc (Rext) (hvc1 / 0x31637668)", "yuv422p10le(tv, bt709)", "3840x2160 [SAR 1:1]", …
        let parts = split_top_level(video);
        let codec = parts[0]
            .split(" (")
            .filter(|s| !s.contains(" / 0x"))
            .collect::<Vec<_>>()
            .join(" (");
        let pix = parts.get(1).map(|p| p.split('(').next().unwrap_or(p).trim());
        info.codec = Some(match pix {
            Some(pix) => format!("{codec}, {pix}"),
            None => codec,
        });
        if let Some((w, h)) = parts
            .iter()
            .filter_map(|p| p.split_whitespace().next()?.split_once('x'))
            .find_map(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
        {
            info.width = Some(w);
            info.height = Some(h);
        }
    }
    Ok(info)
}

/* ---------- Fragmented MP4 index ---------- */

/// Top-level child boxes of an MP4 box body: (type, body).
fn boxes(buf: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut p = 0;
    while p + 8 <= buf.len() {
        let size = u32::from_be_bytes(buf[p..p + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = buf[p + 4..p + 8].try_into().unwrap();
        if size < 8 || p + size > buf.len() {
            break;
        }
        out.push((kind, &buf[p + 8..p + size]));
        p += size;
    }
    out
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// (track id, timescale) of the video track in a moov body.
fn video_track(moov: &[u8]) -> Option<(u32, u32)> {
    boxes(moov).into_iter().filter(|(k, _)| k == b"trak").find_map(|(_, trak)| {
        let (mut id, mut timescale, mut video) = (None, None, false);
        for (kind, body) in boxes(trak) {
            match &kind {
                b"tkhd" => id = be32(body, if body.first() == Some(&1) { 20 } else { 12 }),
                b"mdia" => {
                    for (kind, body) in boxes(body) {
                        match &kind {
                            b"mdhd" => timescale = be32(body, if body.first() == Some(&1) { 20 } else { 12 }),
                            b"hdlr" => video = body.get(8..12) == Some(b"vide"),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        if video {
            Some((id?, timescale?))
        } else {
            None
        }
    })
}

/// Start time (s) of the video track in a moof body.
fn fragment_time(moof: &[u8], track: u32, timescale: u32) -> Option<f64> {
    boxes(moof).into_iter().filter(|(k, _)| k == b"traf").find_map(|(_, traf)| {
        let (mut id, mut base) = (None, None);
        for (kind, body) in boxes(traf) {
            match &kind {
                b"tfhd" => id = be32(body, 4),
                b"tfdt" if body.first() == Some(&1) => base = be64(body, 4),
                b"tfdt" => base = be32(body, 4).map(u64::from),
                _ => {}
            }
        }
        (id == Some(track)).then_some(base? as f64 / timescale as f64)
    })
}

/* ---------- Streaming jobs ---------- */

#[derive(Default)]
struct Progress {
    written: u64,
    /// (start time in s, byte offset) of every fragment; each begins with a keyframe.
    fragments: Vec<(f64, u64)>,
    /// Media time up to which complete fragments are on disk.
    converted: f64,
    done: bool,
    error: Option<String>,
}

struct Job {
    id: u64,
    /// Fragmented MP4 being written by ffmpeg.
    file: PathBuf,
    /// Set when the stream starts at 0: once finished it becomes this cached plain MP4.
    cache_target: Option<PathBuf>,
    progress: Mutex<Progress>,
    changed: Condvar,
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Job {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
        self.changed.notify_all();
    }

    fn update(&self, f: impl FnOnce(&mut Progress)) {
        f(&mut self.progress.lock().unwrap());
        self.changed.notify_all();
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
    }
}

#[derive(Default)]
pub struct Streamer {
    next_id: AtomicU64,
    current: Mutex<Option<Arc<Job>>>,
}

impl Streamer {
    fn job(&self, id: u64) -> Result<Arc<Job>, String> {
        match self.current.lock().unwrap().as_ref() {
            Some(job) if job.id == id => Ok(job.clone()),
            _ => Err("stale".into()),
        }
    }

    pub fn stop(&self) {
        if let Some(job) = self.current.lock().unwrap().take() {
            job.cancel();
        }
    }
}

enum Outcome {
    Done,
    Cancelled,
    /// Failed before producing any output, e.g. the encoder is unavailable: worth another encoder.
    FailedEarly(String),
    Failed(String),
}

fn run_ffmpeg(job: &Job, src: &Path, start: f64, encoder: &[&str]) -> Outcome {
    let mut cmd = ffmpeg();
    cmd.args(["-hide_banner", "-nostdin", "-y"]);
    if start > 0.0 {
        cmd.args(["-ss", &format!("{start:.3}")]);
    }
    cmd.arg("-i")
        .arg(src)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", SCALE])
        .args(encoder)
        // A keyframe (and so a fragment) every 0.5 s: the first frame shows sooner, seeks land closer.
        .args(["-force_key_frames", "expr:gte(t,n_forced*0.5)", "-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac", "-b:a", "160k"]);
    // Fragment timestamps always start at 0 (the muxer ignores -output_ts_offset); the index adds
    // `start` and the page shifts them with SourceBuffer.timestampOffset.
    cmd.args(["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"])
        .args(["-flush_packets", "1", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Outcome::Failed(format!("ffmpeg başlatılamadı: {e}")),
    };
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *job.child.lock().unwrap() = Some(child);
    if job.cancelled.load(Ordering::SeqCst) {
        job.cancel();
    }

    // Keep the last stderr lines for error messages; reading also stops the pipe from filling up.
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_reader = {
        let tail = tail.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = tail.lock().unwrap();
                tail.push(line);
                if tail.len() > 6 {
                    tail.remove(0);
                }
            }
        })
    };

    let result = (|| -> std::io::Result<()> {
        let mut out = File::create(&job.file)?;
        let mut reader = File::open(&job.file)?;
        let mut buf = vec![0u8; 256 * 1024];
        let (mut written, mut pos) = (0u64, 0u64);
        let mut track = None;
        loop {
            let n = stdout.read(&mut buf)?;
            if n == 0 || job.cancelled.load(Ordering::SeqCst) {
                return Ok(());
            }
            out.write_all(&buf[..n])?;
            written += n as u64;

            // Index every complete top-level box: moov tells the video track, each moof starts a fragment.
            let mut found = Vec::new();
            while pos + 8 <= written {
                let mut header = [0u8; 16];
                reader.seek(SeekFrom::Start(pos))?;
                reader.read_exact(&mut header[..8])?;
                let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
                let kind: [u8; 4] = header[4..8].try_into().unwrap();
                let mut header_len = 8;
                if size == 1 {
                    if pos + 16 > written {
                        break;
                    }
                    reader.read_exact(&mut header[8..16])?;
                    size = u64::from_be_bytes(header[8..16].try_into().unwrap());
                    header_len = 16;
                }
                if size < header_len || pos + size > written {
                    break;
                }
                if &kind == b"moov" || &kind == b"moof" {
                    let mut body = vec![0u8; (size - header_len) as usize];
                    reader.read_exact(&mut body)?;
                    if &kind == b"moov" {
                        track = video_track(&body);
                    } else if let Some(t) = track.and_then(|(id, ts)| fragment_time(&body, id, ts)) {
                        found.push((start + t, pos));
                    }
                }
                pos += size;
            }
            job.update(|p| {
                p.written = written;
                if let Some(&(t, _)) = found.last() {
                    // A new fragment header means everything before it is complete.
                    p.converted = p.converted.max(t);
                }
                p.fragments.extend(found);
            });
        }
    })();

    // Close our end first so a still-running ffmpeg can't block on a full pipe while we wait.
    drop(stdout);
    if result.is_err() {
        if let Some(child) = job.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
    let status = job.child.lock().unwrap().take().map(|mut c| c.wait());
    let _ = stderr_reader.join();
    if job.cancelled.load(Ordering::SeqCst) {
        return Outcome::Cancelled;
    }
    let error = tail.lock().unwrap().join("\n");
    match (result, status) {
        (Ok(()), Some(Ok(s))) if s.success() => Outcome::Done,
        (Err(e), _) => Outcome::Failed(e.to_string()),
        _ if job.progress.lock().unwrap().written == 0 => Outcome::FailedEarly(error),
        _ => Outcome::Failed(error),
    }
}

fn run_job(job: Arc<Job>, src: PathBuf, start: f64) {
    let mut error = String::new();
    let first = encoder();
    for index in (first..ENCODERS.len()).chain(0..first) {
        match run_ffmpeg(&job, &src, start, ENCODERS[index]) {
            Outcome::Done => {
                job.update(|p| {
                    p.done = true;
                    p.converted = f64::MAX;
                });
                if let Some(target) = &job.cache_target {
                    let part = target.with_extension("part");
                    let remuxed = ffmpeg()
                        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
                        .arg(&job.file)
                        .args(["-c", "copy", "-movflags", "+faststart", "-f", "mp4"])
                        .arg(&part)
                        .status()
                        .is_ok_and(|s| s.success());
                    if remuxed && fs::rename(&part, target).is_ok() {
                        if let Some(dir) = target.parent() {
                            trim_cache(dir, target);
                        }
                    } else {
                        let _ = fs::remove_file(&part);
                    }
                }
                return;
            }
            Outcome::Cancelled => return,
            Outcome::FailedEarly(e) => error = e,
            Outcome::Failed(e) => {
                error = e;
                break;
            }
        }
    }
    job.update(|p| p.error = Some(format!("Video dönüştürülemedi.\n{error}")));
}

/// Starts converting `path` from `start` seconds, replacing any running stream.
#[tauri::command]
pub fn start_stream(app: AppHandle, streamer: State<Streamer>, path: String, start: f64) -> Result<u64, String> {
    streamer.stop();
    let src = PathBuf::from(&path);
    let dir = cache_dir(&app)?;
    let key = cache_key(&src)?;
    let id = streamer.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let job = Arc::new(Job {
        id,
        file: dir.join(format!("{key}.{id}.frag")),
        cache_target: (start <= 0.0).then(|| dir.join(format!("{key}.mp4"))),
        progress: Mutex::new(Progress {
            converted: start.max(0.0),
            ..Default::default()
        }),
        changed: Condvar::new(),
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    });
    *streamer.current.lock().unwrap() = Some(job.clone());
    thread::spawn(move || run_job(job, src, start.max(0.0)));
    Ok(id)
}

/// Returns the converted bytes from `offset` on (up to MAX_READ), waiting up to a second for new
/// ones. An empty answer means "nothing new yet" or, once `stream_status` says done, the end.
#[tauri::command]
pub async fn read_stream(streamer: State<'_, Streamer>, job: u64, offset: u64) -> Result<Response, String> {
    let job = streamer.job(job)?;
    tauri::async_runtime::spawn_blocking(move || {
        let available = {
            let progress = job.progress.lock().unwrap();
            let (progress, _) = job
                .changed
                .wait_timeout_while(progress, Duration::from_secs(1), |p| {
                    p.written <= offset && !p.done && p.error.is_none() && !job.cancelled.load(Ordering::SeqCst)
                })
                .unwrap();
            if let Some(error) = &progress.error {
                return Err(error.clone());
            }
            progress.written.saturating_sub(offset).min(MAX_READ)
        };
        let mut bytes = vec![0u8; available as usize];
        if available > 0 {
            let mut file = File::open(&job.file).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    converted: f64,
    done: bool,
    written: u64,
}

#[tauri::command]
pub fn stream_status(streamer: State<Streamer>, job: u64) -> Result<StreamStatus, String> {
    let job = streamer.job(job)?;
    let p = job.progress.lock().unwrap();
    Ok(StreamStatus {
        converted: p.converted,
        done: p.done,
        written: p.written,
    })
}

/// Byte offset of the fragment that holds `time` (the last one starting at or before it).
#[tauri::command]
pub fn stream_seek(streamer: State<Streamer>, job: u64, time: f64) -> Result<Option<u64>, String> {
    let job = streamer.job(job)?;
    let p = job.progress.lock().unwrap();
    Ok(p.fragments.iter().rev().find(|(t, _)| *t <= time + 0.001).map(|&(_, offset)| offset))
}

/// Stops conversion `job`, unless a newer one has replaced it already.
#[tauri::command]
pub fn stop_stream(streamer: State<Streamer>, job: u64) {
    if streamer.job(job).is_ok() {
        streamer.stop();
    }
}
