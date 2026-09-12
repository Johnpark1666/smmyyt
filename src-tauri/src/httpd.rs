use crate::AppState;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

pub fn start(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:21890") {
            Ok(l) => l,
            Err(e) => { eprintln!("[http] bind failed: {}", e); return; }
        };
        println!("[http] serving on http://127.0.0.1:21890");
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let st = state.clone();
                std::thread::spawn(move || handle(stream, st));
            }
        }
    });
}

fn handle(mut stream: TcpStream, state: Arc<AppState>) {
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    if n == 0 { return; }
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 { return; }
    let method = parts[0];
    let path = parts[1];

    let (status, body, content_type) = match (method, path) {
        ("GET", p) if p.starts_with("/auth/callback") => crate::handle_oauth_callback(p, &state, "http://127.0.0.1:21890/auth/callback"),
        ("GET", "/api/export/data") => {
            let db = &state.db;
            let data = serde_json::json!({
                "exportedAt": chrono::Utc::now().to_rfc3339(),
                "videos": db.get_videos(),
                "channels": db.get_channels(),
            });
            ("200 OK".to_string(), serde_json::to_string_pretty(&data).unwrap_or_default(), "application/json".to_string())
        }
        ("GET", "/api/videos") => {
            let db = &state.db;
            let data = serde_json::json!({ "data": db.get_videos() });
            ("200 OK".to_string(), data.to_string(), "application/json".to_string())
        }
        ("GET", "/health") => ("200 OK".to_string(), "ok".to_string(), "text/plain".to_string()),
        _ => ("404 Not Found".to_string(), r#"{"error":"not found"}"#.to_string(), "application/json".to_string()),
    };

    let body = if body.is_empty() { "{}".to_string() } else { body };
    let resp = format!(
        "HTTP/1.0 {}\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status, content_type, body.len(), body
    );
    let _ = stream.write_all(resp.as_bytes());
}

