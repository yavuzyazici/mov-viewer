mod stream;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, State,
};

const VIDEO_EXTS: &[&str] = &["mov", "mp4", "m4v", "webm"];

/// Set by the page at startup (`set_language`); Turkish until then.
static ENGLISH: AtomicBool = AtomicBool::new(false);

/// A user-facing message in the UI's language.
pub(crate) fn msg(tr: &str, en: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) { en } else { tr }.to_string()
}

#[tauri::command]
fn set_language(lang: String) {
    ENGLISH.store(lang != "tr", Ordering::Relaxed);
}

#[derive(Default)]
struct AppState {
    /// File passed on the command line (e.g. "Open with" / double click), consumed once by the UI.
    startup_file: Mutex<Option<String>>,
    /// The video currently on screen; used to name snapshots.
    current: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoFile {
    path: String,
    name: String,
    folder: String,
    size: u64,
    /// Unix time in milliseconds.
    modified: Option<u64>,
    /// Every video in the same folder, including this one (unsorted).
    siblings: Vec<String>,
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn file_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| Path::new(a).is_file()).cloned()
}

/// Validates the file, lets the webview stream it through the asset protocol and returns its details.
#[tauri::command]
fn open_video(app: AppHandle, state: State<AppState>, path: String) -> Result<VideoFile, String> {
    let path = std::path::absolute(&path).map_err(|e| format!("{}: {e}", msg("Geçersiz yol", "Invalid path")))?;
    let meta = fs::metadata(&path)
        .map_err(|e| format!("{}: {e}", msg("Dosya açılamadı", "Couldn't open the file")))?;
    if !meta.is_file() {
        return Err(msg("Seçilen öğe bir dosya değil.", "The selected item isn't a file."));
    }
    let (Some(folder), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(msg("Geçersiz dosya yolu.", "Invalid file path."));
    };
    // Rebuild the path the same way read_dir does so the UI can find it among the siblings.
    let path = folder.join(name);

    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;

    let siblings = fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_file() && is_video(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    *state.current.lock().unwrap() = Some(path.clone());

    Ok(VideoFile {
        path: path.to_string_lossy().into_owned(),
        name: name.to_string_lossy().into_owned(),
        folder: folder.to_string_lossy().into_owned(),
        size: meta.len(),
        modified,
        siblings,
    })
}

#[tauri::command]
fn take_startup_file(state: State<AppState>) -> Option<String> {
    state.startup_file.lock().unwrap().take()
}

/// Saves a PNG frame (raw request body) to Pictures/Atak Viewer and returns its path.
#[tauri::command]
fn save_snapshot(app: AppHandle, state: State<AppState>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(msg("Kare verisi alınamadı.", "No frame data received."));
    };
    let secs: f64 = request
        .headers()
        .get("x-time")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    let stem = state
        .current
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|p| p.file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "kare".into());

    let dir = app
        .path()
        .picture_dir()
        .map_err(|e| e.to_string())?
        .join("Atak Viewer");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("{}: {e}", msg("Klasör oluşturulamadı", "Couldn't create the folder")))?;

    let total = secs.max(0.0);
    let whole = total as u64;
    let millis = ((total - whole as f64) * 1000.0) as u64;
    let name = format!(
        "{stem} {:02}-{:02}-{:02}.{millis:03}.png",
        whole / 3600,
        whole / 60 % 60,
        whole % 60
    );
    let target = dir.join(name);
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", msg("Kare kaydedilemedi", "Couldn't save the frame")))?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut builder = tauri::Builder::default();

    // A second launch (e.g. double clicking another .mov) hands its file to the running window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(file) = file_from_args(&args) {
                let _ = app.emit("open-file", file);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            startup_file: Mutex::new(file_from_args(&args)),
            ..Default::default()
        })
        .manage(stream::Streamer::default())
        .setup(|app| {
            stream::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_language,
            open_video,
            take_startup_file,
            save_snapshot,
            stream::cached_copy,
            stream::probe_video,
            stream::start_stream,
            stream::read_stream,
            stream::stream_status,
            stream::stream_seek,
            stream::stop_stream
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Windows doesn't end child processes with their parent: stop ffmpeg ourselves.
            if let tauri::RunEvent::Exit = event {
                app.state::<stream::Streamer>().stop();
            }
        });
}
