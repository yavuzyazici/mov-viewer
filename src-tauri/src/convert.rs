//! Converts videos the webview can't decode (e.g. HEVC 4:2:2 10-bit from cameras) into a cached
//! H.264 copy with the bundled ffmpeg.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};

/// Cache is trimmed (oldest first) above this size.
const CACHE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

/// Tried in order; the first one that works on this machine is remembered. Bitrate is capped
/// (~24 Mbit/s, peaks 32) so a viewing copy of detailed 4K footage stays far below the original.
const ENCODERS: &[&[&str]] = &[
    &[
        "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", "32M",
        "-bufsize", "64M",
    ],
    &["-c:v", "h264_qsv", "-preset", "faster", "-b:v", "24M", "-maxrate", "32M"],
    &["-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak", "-b:v", "24M", "-maxrate", "32M"],
    &["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", "24M"],
    &["-c:v", "libopenh264", "-b:v", "20M"],
];

#[derive(Default)]
pub struct Converter {
    /// Bumped by every new job and by cancel; a job stops when it no longer owns the latest id.
    job: AtomicU64,
    /// Index into ENCODERS of the last encoder that worked.
    encoder: AtomicUsize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// 0..1, when the duration is known.
    ratio: Option<f64>,
    /// Estimated seconds left.
    remaining: Option<f64>,
}

fn ffmpeg_path() -> PathBuf {
    // Tauri copies the `externalBin` sidecar next to the app executable.
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
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
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
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

/// "Duration: 00:01:02.50," → 62.5
fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.trim_start().strip_prefix("Duration: ")?;
    let mut parts = rest.split(',').next()?.split(':');
    let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?)
}

enum Outcome {
    Done,
    Cancelled,
    Failed(String),
}

fn run_ffmpeg(
    src: &Path,
    out: &Path,
    encoder: &[&str],
    is_current: &dyn Fn() -> bool,
    progress: &Channel<Progress>,
) -> Outcome {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(src)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"])
        .args(encoder)
        .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"])
        .args(["-movflags", "+faststart", "-progress", "pipe:1", "-stats_period", "0.5", "-nostats"])
        .args(["-f", "mp4"])
        .arg(out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Outcome::Failed(format!("ffmpeg başlatılamadı: {e}")),
    };

    // stderr carries the duration and, on failure, the reason; read it on its own thread so
    // neither pipe can fill up and block ffmpeg.
    let duration = Arc::new(Mutex::new(None::<f64>));
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr = child.stderr.take().unwrap();
    let stderr_reader = {
        let (duration, tail) = (duration.clone(), tail.clone());
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(d) = parse_duration(&line) {
                    duration.lock().unwrap().get_or_insert(d);
                }
                let mut tail = tail.lock().unwrap();
                tail.push(line);
                if tail.len() > 8 {
                    tail.remove(0);
                }
            }
        })
    };

    let mut out_time = 0.0;
    let mut speed = 0.0;
    let stdout = child.stdout.take().unwrap();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if !is_current() {
            let _ = child.kill();
            break;
        }
        if let Some(v) = line.strip_prefix("out_time_us=") {
            out_time = v.parse::<f64>().unwrap_or(0.0).max(0.0) / 1e6;
        } else if let Some(v) = line.strip_prefix("speed=") {
            speed = v.trim().trim_end_matches('x').parse().unwrap_or(0.0);
        } else if line.starts_with("progress=") {
            let total = *duration.lock().unwrap();
            let _ = progress.send(Progress {
                ratio: total.map(|d| (out_time / d).clamp(0.0, 1.0)),
                remaining: total
                    .filter(|_| speed > 0.0)
                    .map(|d| ((d - out_time) / speed).max(0.0)),
            });
        }
    }

    let status = child.wait();
    let _ = stderr_reader.join();
    if !is_current() {
        return Outcome::Cancelled;
    }
    match status {
        Ok(s) if s.success() => Outcome::Done,
        _ => Outcome::Failed(tail.lock().unwrap().join("\n")),
    }
}

/// Returns the path of a cached H.264 copy of `path`, creating it first if needed.
#[tauri::command]
pub async fn make_compatible(
    app: AppHandle,
    path: String,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("compat");
    fs::create_dir_all(&dir).map_err(|e| format!("Önbellek klasörü oluşturulamadı: {e}"))?;
    let out = dir.join(format!("{}.mp4", cache_key(&src)?));

    if !out.is_file() {
        let partial = out.with_extension("part");
        let task_app = app.clone();
        let task_out = out.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let converter = task_app.state::<Converter>();
            let id = converter.job.fetch_add(1, Ordering::SeqCst) + 1;
            let is_current = || converter.job.load(Ordering::SeqCst) == id;
            let first = converter.encoder.load(Ordering::SeqCst);

            let mut last_error = String::new();
            for index in (first..ENCODERS.len()).chain(0..first) {
                match run_ffmpeg(&src, &partial, ENCODERS[index], &is_current, &on_progress) {
                    Outcome::Done => {
                        converter.encoder.store(index, Ordering::SeqCst);
                        fs::rename(&partial, &task_out).map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    Outcome::Cancelled => {
                        let _ = fs::remove_file(&partial);
                        return Err("cancelled".to_string());
                    }
                    // Usually "encoder not available on this machine": try the next one.
                    Outcome::Failed(error) => last_error = error,
                }
            }
            let _ = fs::remove_file(&partial);
            Err(format!("Video dönüştürülemedi.\n{last_error}"))
        })
        .await
        .map_err(|e| e.to_string())?;
        result?;
        trim_cache(&dir, &out);
    } else {
        // Mark as recently used so trimming keeps it.
        let _ = fs::File::options()
            .write(true)
            .open(&out)
            .and_then(|f| f.set_modified(SystemTime::now()));
    }

    app.asset_protocol_scope()
        .allow_file(&out)
        .map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cancel_conversion(converter: State<Converter>) {
    converter.job.fetch_add(1, Ordering::SeqCst);
}
