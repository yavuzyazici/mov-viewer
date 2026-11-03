//! Linux: WebKitGTK's media engine (GStreamer) can't load video from Tauri's `asset://` scheme, so
//! video files are served from a loopback HTTP server with Range support instead. Every URL carries
//! a random token and an id the app registered for a file it opened; nothing else is served.

use std::{
    collections::{hash_map::RandomState, HashMap},
    fs::File,
    hash::{BuildHasher, Hasher},
    io::{self, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime},
};

type Files = Arc<Mutex<HashMap<String, PathBuf>>>;

pub struct MediaServer {
    port: u16,
    token: String,
    files: Files,
}

/// 64 unpredictable bits from the standard library's per-process random hasher keys.
fn random_hex() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos());
    format!("{:016x}", hasher.finish())
}

impl MediaServer {
    pub fn start() -> Option<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        let token = format!("{}{}", random_hex(), random_hex());
        let files: Files = Arc::default();
        let (thread_token, thread_files) = (token.clone(), files.clone());
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (token, files) = (thread_token.clone(), thread_files.clone());
                thread::spawn(move || {
                    let _ = handle(stream, &token, &files);
                });
            }
        });
        Some(Self { port, token, files })
    }

    /// Registers `path` and returns the URL the page can play it from.
    pub fn url(&self, path: &Path) -> String {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write(path.as_os_str().as_encoded_bytes());
        let id = format!("{:016x}", hasher.finish());
        self.files.lock().unwrap().insert(id.clone(), path.to_path_buf());
        format!("http://127.0.0.1:{}/{}/{}", self.port, self.token, id)
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("webm") => "video/webm",
        _ => "video/mp4",
    }
}

/// "bytes=a-b" / "bytes=a-" / "bytes=-n" → inclusive (start, end) within `len`.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (a, "") => (a.parse().ok()?, len.checked_sub(1)?),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && end < len).then_some((start, end))
}

fn handle(mut stream: TcpStream, token: &str, files: &Files) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk)?;
        if n == 0 || head.len() > 16 * 1024 {
            return Ok(());
        }
        head.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (request.next().unwrap_or_default(), request.next().unwrap_or_default());
    let range = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("range"))
        .map(|(_, value)| value.to_string());

    const COMMON: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\n\
        Access-Control-Expose-Headers: Content-Range, Content-Length\r\nCache-Control: no-store\r\nConnection: close";
    let reply = |stream: &mut TcpStream, status: &str| {
        write!(stream, "HTTP/1.1 {status}\r\n{COMMON}\r\nContent-Length: 0\r\n\r\n")
    };

    if method == "OPTIONS" {
        return reply(&mut stream, "204 No Content");
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed");
    }
    let mut segments = target.trim_start_matches('/').split('/');
    let path = match (segments.next(), segments.next()) {
        (Some(t), Some(id)) if t == token => files.lock().unwrap().get(id).cloned(),
        _ => None,
    };
    let Some(path) = path else { return reply(&mut stream, "404 Not Found") };
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return reply(&mut stream, "404 Not Found"),
    };
    let len = file.metadata()?.len();

    let (status, start, end) = match range.as_deref() {
        None => ("200 OK", 0, len.saturating_sub(1)),
        Some(value) => match parse_range(value, len) {
            Some((start, end)) => ("206 Partial Content", start, end),
            None => {
                return write!(
                    stream,
                    "HTTP/1.1 416 Range Not Satisfiable\r\n{COMMON}\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n"
                )
            }
        },
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut headers = format!(
        "HTTP/1.1 {status}\r\n{COMMON}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {count}\r\n",
        content_type(&path)
    );
    if status.starts_with("206") {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    if method == "GET" && count > 0 {
        file.seek(SeekFrom::Start(start))?;
        io::copy(&mut file.take(count), &mut stream)?;
    }
    stream.flush()
}
