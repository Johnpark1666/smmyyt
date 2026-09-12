// SMMYNP 헤드리스 LAN 서버 (미니 PC용) — Tauri GUI 없이 동작
// 사용법: cargo run --bin smmynp-server -- --db ./data --ytdlp yt-dlp --port 8788 --www ./workers/public
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use app_lib::db::Database;
use app_lib::{route, AppState, JobStatus};
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut data_dir = PathBuf::from("./data");
    let mut ytdlp = "yt-dlp".to_string();
    let mut port: u16 = 8787;
    let mut www = PathBuf::from("./workers/public");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--db" => { i += 1; if i < args.len() { data_dir = PathBuf::from(&args[i]); } }
            "--ytdlp" => { i += 1; if i < args.len() { ytdlp = args[i].clone(); } }
            "--port" => { i += 1; if i < args.len() { port = args[i].parse().unwrap_or(8787); } }
            "--www" => { i += 1; if i < args.len() { www = PathBuf::from(&args[i]); } }
            _ => {}
        }
        i += 1;
    }

    std::fs::create_dir_all(&data_dir).expect("데이터 디렉토리 생성 실패");
    let db = Database::new(&data_dir).expect("DB 열기 실패");
    let state = Arc::new(AppState {
        db,
        job_status: Mutex::new(JobStatus {
            total: 0,
            current: 0,
            status: "idle".into(),
            logs: Vec::new(),
            start_time: None,
            cancelled: false,
            current_items: Vec::new(),
        }),
        ytdlp,
    });

    // 자동 요약 루프 (설정의 auto_summary_* 읽기) — 상시 서버 모드
    start_auto_summary(state.clone());
    // 경량 pull 루프 — 웹 뷰어 읽음/별표/삭제를 15분마다 로컬로 반영
    start_light_pull(state.clone());

    // LAN IP 표시 (접속 주소 안내)
    println!("[server] LAN 서버 시작");
    for ip in local_ips() {
        println!("[server] 접속 주소: http://{}:{}", ip, port);
    }
    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).expect("포트 바인딩 실패");
    println!("[server] DB: {} | yt-dlp: {} | www: {}", data_dir.display(), state.ytdlp, www.display());

    for stream in listener.incoming() {
        if let Ok(s) = stream {
            let st = state.clone();
            let w = www.clone();
            std::thread::spawn(move || handle(s, st, w));
        }
    }
}

fn handle(mut stream: TcpStream, state: Arc<AppState>, www: PathBuf) {
    let mut buf = [0u8; 65536];
    let n = stream.read(&mut buf).unwrap_or(0);
    if n == 0 { return; }
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let first = req.lines().next().unwrap_or("").to_string();
    let parts: Vec<&str> = first.split_whitespace().collect();
    if parts.len() < 2 { return; }
    let method = parts[0].to_string();
    let path = parts[1].to_string();

    // 요청 Host 헤더 (OAuth redirect_uri 구성용)
    let host = req.lines().find_map(|l| l.to_lowercase().strip_prefix("host:").map(|h| h.trim().to_string()))
        .unwrap_or_else(|| format!("127.0.0.1:8787"));

    let (status, body, ct): (String, Vec<u8>, String) = if path.starts_with("/auth/callback") {
        let redirect_uri = format!("http://{}/auth/callback", host);
        let (st, b, ct2) = app_lib::handle_oauth_callback(&path, &state, &redirect_uri);
        (st, b.into_bytes(), ct2)
    } else if path == "/" || path.starts_with("/index.html") {
        // 서버 전용 콘솔 (요약 뷰어는 Cloudflare Worker 배포본 전용 — server-console.html 사용)
        let p = www.join("server-console.html");
        match std::fs::read(&p) {
            Ok(b) => ("200 OK".to_string(), b, "text/html; charset=utf-8".to_string()),
            Err(_) => ("404 Not Found".to_string(), b"server-console.html not found (--www)".to_vec(), "text/plain".to_string()),
        }
    } else if path.starts_with("/server-console.html") {
        let p = www.join("server-console.html");
        match std::fs::read(&p) {
            Ok(b) => ("200 OK".to_string(), b, "text/html; charset=utf-8".to_string()),
            Err(_) => ("404 Not Found".to_string(), b"server-console.html not found (--www)".to_vec(), "text/plain".to_string()),
        }
    } else if path.starts_with("/api/") {
        let (route_path, qs) = match path.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (path.clone(), String::new()),
        };
        let body_str = req.split("\r\n\r\n").nth(1).unwrap_or("");
        let body: Value = serde_json::from_str(body_str).unwrap_or(Value::Null);
        let query: Value = if qs.is_empty() {
            Value::Null
        } else {
            let mut map = serde_json::Map::new();
            for pair in qs.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    map.insert(k.to_string(), Value::String(url_decode(v)));
                }
            }
            Value::Object(map)
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(route(state.clone(), None, &method, &route_path, &body, &query)) {
            Ok(v) => ("200 OK".to_string(), v.to_string().into_bytes(), "application/json".to_string()),
            Err(e) => (
                "500 Internal Server Error".to_string(),
                format!("{{\"error\":\"{}\"}}", e.replace('\\', "\\\\").replace('"', "\\\"")).into_bytes(),
                "application/json".to_string(),
            ),
        }
    } else {
        let p = www.join(path.trim_start_matches('/'));
        match std::fs::read(&p) {
            Ok(b) => ("200 OK".to_string(), b, mime_of(&path)),
            Err(_) => ("404 Not Found".to_string(), b"not found".to_vec(), "text/plain".to_string()),
        }
    };

    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status, ct, body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.write_all(&body);
    let _ = stream.flush();
}

/// URL 퍼센트 디코딩 (%XX, + → 공백) — 쿼리 파라미터용
fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let h = (b[i+1] as char).to_digit(16);
                let l = (b[i+2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (h, l) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b[i]); i += 1;
            }
            b'+' => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_of(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
    .to_string()
}


// ── 자동 요약 루프 — 설정(auto_summary_*)을 읽어 주기적으로 fetch+process+sync ──
fn start_auto_summary(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        loop {
            let mut hours: u64 = 6;
            let settings = state.db.get_all_settings();
            let sget = |k: &str| settings.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let enabled = sget("auto_summary_enabled") == "1";
            if enabled {
                let interval = sget("auto_summary_interval");
                hours = match interval.as_str() { "3h" => 3, "12h" => 12, "24h" => 24, "daily" => 0, _ => 6 };
                let sel = sget("auto_summary_channels");
                let max_min: i64 = sget("auto_summary_max_minutes").parse().unwrap_or(0);
                let exclude_shorts = sget("exclude_shorts") == "1";
                eprintln!("[auto] 시작 (interval={}h, 채널제한={}, 최대분={})", hours, if sel.is_empty() { "전체" } else { &sel }, max_min);
                let res: Result<(), String> = rt.block_on(async {
                    // Google 구독 목록 동기화 (신규 추가 + 해지 반영) — 실패해도 요약 진행
                    let gacc = sget("google_access_token");
                    if !gacc.is_empty() {
                        eprintln!("[auto] 구독 목록 동기화...");
                        match app_lib::sync_google_subscriptions(&state.db).await {
                            Ok((imp, total)) => eprintln!("[auto] 구독 동기화 완료 (신규 {} / 전체 {})", imp, total),
                            Err(e) => eprintln!("[auto] 구독 동기화 실패: {}", e),
                        }
                    }
                    // 활성 채널만 대상 (구독 해지된 채널 제외)
                    let all: Vec<serde_json::Value> = state.db.get_channels().into_iter()
                        .filter(|c| c.get("active").and_then(|v| v.as_bool()).unwrap_or(true)).collect();
                    let selected: Vec<serde_json::Value> = if sel.trim().is_empty() {
                        all
                    } else {
                        let ids: std::collections::HashSet<String> = sel.split(',').map(|s| s.trim().to_string()).collect();
                        all.into_iter().filter(|ch| ch.get("channelId").and_then(|v| v.as_str()).map(|s| ids.contains(s)).unwrap_or(false)).collect()
                    };
                    if selected.is_empty() { eprintln!("[auto] 대상 채널 없음"); return Ok(()); }
                    let ch_refs: Vec<&serde_json::Value> = selected.iter().collect();
                    let processed = state.db.get_processed_video_ids();
                    let (videos, _meta) = app_lib::fetch_rss(&state.ytdlp, &ch_refs, 1, &processed, exclude_shorts).await?;
                    let videos: Vec<serde_json::Value> = videos.into_iter().filter(|v| {
                        // duration은 JSON 숫자(i32)로 옴 — 문자열 파싱하면 항상 0이 되어 필터가 무력화됐었음
                        let dur: i64 = v.get("duration").and_then(|d| d.as_i64().or_else(|| d.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
                        max_min == 0 || dur <= 0 || dur <= max_min * 60
                    }).collect();
                    eprintln!("[auto] fetch {}개 (길이필터 후)", videos.len());
                    if !videos.is_empty() {
                        app_lib::process_videos_bg(state.clone(), &videos).await;
                    }
                    // GitHub 트렌딩 자동 요약 (설정: auto_summary_include_github)
                    if sget("auto_summary_include_github") == "1" {
                        let gh_days: i32 = sget("auto_summary_github_days").parse().unwrap_or(7);
                        let gh_token = sget("github_token");
                        eprintln!("[auto] GitHub 트렌딩 수집 ({}일)", gh_days);
                        match app_lib::fetch_github_trending(gh_days, &gh_token).await {
                            Ok(repos) => {
                                let processed: std::collections::HashSet<String> = state.db.get_github_repos().iter()
                                    .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect();
                                let new_repos: Vec<serde_json::Value> = repos.into_iter()
                                    .filter(|r| !processed.contains(r.get("id").and_then(|v| v.as_str()).unwrap_or("")))
                                    .collect();
                                eprintln!("[auto] GitHub 신규 {}개", new_repos.len());
                                if !new_repos.is_empty() {
                                    app_lib::process_github_repos_bg(state.clone(), &new_repos).await;
                                }
                            }
                            Err(e) => {
                                eprintln!("[auto] GitHub fetch 오류: {}", e);
                                let _ = app_lib::send_telegram_notify(&state.db, &format!("❌ 자동 요약 오류 (GitHub 트렌딩): {}", e)).await;
                            }
                        }
                    }
                    if let Err(e) = app_lib::services::sync::sync_all(&state.db).await {
                        eprintln!("[auto] 웹 동기화 실패: {}", e);
                        let _ = app_lib::send_telegram_notify(&state.db, &format!("⚠️ 자동 요약 후 웹 동기화 실패: {}", e)).await;
                    }
                    Ok(())
                });
                if let Err(e) = res {
                    eprintln!("[auto] 오류: {}", e);
                    let _ = rt.block_on(app_lib::send_telegram_notify(&state.db, &format!("❌ 자동 요약 오류: {}", e)));
                }
            }
            // 다음 실행까지 대기 (daily = 특정 시각까지)
            let sleep_secs: u64 = if hours == 0 {
                let t = sget("auto_summary_time");
                let (hh, mm): (u32, u32) = match t.split_once(':') {
                    Some((h, m)) => (h.trim().parse().unwrap_or(8), m.trim().parse().unwrap_or(0)),
                    None => (8, 0),
                };
                let now = chrono::Local::now();
                let mut next = now.date_naive().and_hms_opt(hh.min(23), mm.min(59), 0)
                    .map(|d| d.and_local_timezone(chrono::Local).single()).flatten().unwrap_or(now);
                if next <= now { next = next + chrono::Duration::hours(24); }
                ((next - now).num_seconds().max(60)) as u64
            } else {
                hours * 3600
            };
            eprintln!("[auto] 다음 실행까지 {}초", sleep_secs);
            std::thread::sleep(std::time::Duration::from_secs(sleep_secs));
        }
    });
}


/// 경량 pull 루프 — 15분마다 웹 변경분(읽음/별표/삭제)만 당겨옴
/// 요약 사이클과 별개로 동작. 실패해도 조용히 다음 주기에 재시도 (로그만).
fn start_light_pull(state: Arc<AppState>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // 시작 90초 후 첫 실행 (부팅 직전 네트워크 미준비 회피)
        std::thread::sleep(std::time::Duration::from_secs(90));
        loop {
            let res = rt.block_on(app_lib::services::sync::pull_only(&state.db));
            match res {
                Ok(n) if n > 0 => eprintln!("[light-pull] 웹 변경분 {}건 반영", n),
                Ok(_) => eprintln!("[light-pull] 확인 (변경 없음)"),
                Err(e) => eprintln!("[light-pull] 실패: {}", e),
            }
            std::thread::sleep(std::time::Duration::from_secs(15 * 60));
        }
    });
}


/// 로컬 LAN IPv4 목록 (접속 주소 안내용)
fn local_ips() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(host) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        if let Ok(addr) = std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), 0)) {
            for a in addr {
                let ip = a.ip().to_string();
                if ip.starts_with("192.168.") || ip.starts_with("10.") || ip.starts_with("172.") {
                    out.push(ip);
                }
            }
        }
    }
    // 리눅스: hostname -I 폴백
    if out.is_empty() {
        if let Ok(r) = std::process::Command::new("hostname").arg("-I").output() {
            let s = String::from_utf8_lossy(&r.stdout);
            for tok in s.split_whitespace() {
                let t = tok.trim();
                if t.starts_with("192.168.") || t.starts_with("10.") || t.starts_with("172.") {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}
