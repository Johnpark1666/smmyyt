pub mod db;
pub mod services;
mod httpd;
use db::Database;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub db: Database,
    pub job_status: Mutex<JobStatus>,
    pub ytdlp: String,  // yt-dlp 바이너리 경로 (GUI: resource_dir / 서버: --ytdlp)
}

#[derive(Clone, serde::Serialize)]
pub struct JobStatus {
    pub total: usize,
    pub current: usize,
    pub status: String,
    pub logs: Vec<String>,
    pub start_time: Option<String>,
    pub cancelled: bool,
    pub current_items: Vec<serde_json::Value>,  // 진행 중인 영상들 {id, title, thumbnail}
}

#[tauri::command]
fn get_status() -> String { "ready".to_string() }

/// tauri.conf.json 버전을 단일 소스로 반환 (프론트 하드코딩 제거)
#[tauri::command]
fn get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

// ── API router ──
#[tauri::command]
async fn api_call(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>, method: String, path: String, body: String, query: String) -> Result<String, String> {
    let b: serde_json::Value = if body.is_empty() { serde_json::json!({}) } else { serde_json::from_str(&body).unwrap_or(serde_json::json!({})) };
    let q: serde_json::Value = if query.is_empty() || query == "{}" { serde_json::json!({}) } else { serde_json::from_str(&query).unwrap_or(serde_json::json!({})) };
    let result = route(state.inner().clone(), Some(&app), &method, &path, &b, &q).await;
    match result { Ok(v) => Ok(v.to_string()), Err(e) => Err(e) }
}

use serde_json::{json, Value};

pub async fn route(state: Arc<AppState>, app: Option<&tauri::AppHandle>, method: &str, path: &str, body: &Value, query: &Value) -> Result<Value, String> {
    let db = &state.db;
    // settings 키 마이그레이션 (Vercel → Cloudflare, 1회만 실행)
    migrate_settings_keys(db);
    match (method, path) {
        ("GET", "/api/settings") => Ok(db.get_all_settings()),
        ("PUT", "/api/settings") => { db.merge_settings(body)?; Ok(json!({"success":true})) }
        ("GET", "/api/settings/export") => {
            let include = query.get("include_sensitive").and_then(|v| v.as_str()).unwrap_or("0") == "1";
            Ok(db.export_config(include))
        }
        ("POST", "/api/settings/import") => {
            let (s, ch) = db.import_config(&body)?;
            Ok(json!({"success": true, "settings": s, "channels": ch}))
        }
        ("GET", "/api/videos") => Ok(json!({"data": db.get_videos(), "error": null})),
        ("DELETE", p) if p.starts_with("/api/videos/") => { let id = p.trim_start_matches("/api/videos/"); db.delete_video(id)?; Ok(json!({"success":true})) }
        ("PATCH", p) if p.starts_with("/api/videos/") => {
            let id = p.trim_start_matches("/api/videos/");
            let mut b = body.clone();
            if let Some(obj) = b.as_object_mut() {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
                obj.insert("updated_at".into(), json!(now.clone()));
                // 상태 필드 변경 시 해당 필드의 ts도 갱신 (필드별 정합성)
                for (f, ts) in [("read","read_ts"),("favorite","favorite_ts"),("deleted","deleted_ts"),("saved","saved_ts")] {
                    if obj.contains_key(f) { obj.insert(ts.into(), json!(now.clone())); }
                }
            }
            db.update_video(id, &b)?; Ok(json!({"success":true}))
        }
        ("GET", "/api/channels") => Ok(json!({"channels": db.get_channels()})),
        ("POST", "/api/channels/import-csv") => {
            if let Some(channels) = body.get("channels").and_then(|c| c.as_array()) { let n = db.import_channels(channels)?; Ok(json!({"imported": n})) }
            else { Err("channels array required".into()) }
        }
        ("DELETE", p) if p.starts_with("/api/channels/") => { let id = p.trim_start_matches("/api/channels/"); db.delete_channel(id)?; Ok(json!({"success":true})) }
        ("GET", "/api/channels/fetch-rss") => {
            let days = query.get("days").and_then(|v| v.as_str()).unwrap_or("3").parse::<i32>().unwrap_or(3);
            let channels = db.get_channels();
            let active: Vec<_> = channels.iter().filter(|c| c.get("active").and_then(|v| v.as_bool()).unwrap_or(true)).collect();
            if active.is_empty() { return Ok(json!({"videos":[], "source":"rss", "error":"등록된 채널이 없습니다"})); }
            let processed = db.get_processed_video_ids();
            let exclude_shorts = query.get("excludeShorts").and_then(|v| v.as_str()).unwrap_or("1") == "1";
            let (videos, meta) = fetch_rss(&state.ytdlp, &active, days, &processed, exclude_shorts).await?;
            Ok(json!({"videos": videos, "source": "rss", "channelCount": active.len(),
                      "ytDlpChecked": meta.checked, "ytDlpFailed": meta.failed, "unknownDuration": meta.unknown, "ytDlpReason": meta.failed_reason}))
        }
        ("POST", "/api/process-videos") => {
            let videos = body.get("videos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let job_id = uuid::Uuid::new_v4().to_string();
            let st = state.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("rt");
                rt.block_on(async { process_videos_bg(st, &videos).await; });
            });
            Ok(json!({"jobId": job_id}))
        }
        ("GET", "/api/status") => {
            let js = state.job_status.lock().unwrap();
            let elapsed = js.start_time.as_ref().and_then(|t| {
                chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S").ok()
                    .map(|start| chrono::Utc::now().naive_utc().signed_duration_since(start).num_seconds())
            }).unwrap_or(0);
            Ok(json!({"total":js.total,"current":js.current,"status":js.status,"logs":js.logs,"elapsedTime":elapsed,"currentItems":js.current_items}))
        }
        ("GET", "/api/health") => {
            // 대시보드 감시용: 웹 동기화 상태(Blob 정지 감지) + Google 인증 상태
            let sync_last = db.get_setting("sync_last_at").unwrap_or_default();
            let mut health = json!({
                "server_ok": true,
                "sync_last_at": sync_last,
            });
            let probe = crate::services::sync::web_probe(db).await;
            if let (Some(h), Some(p)) = (health.as_object_mut(), probe.as_object()) {
                for (k, v) in p { h.insert(k.clone(), v.clone()); }
            }
            let gerr = db.get_setting("google_auth_error").unwrap_or_default();
            health["google_auth_ok"] = json!(gerr.is_empty());
            if !gerr.is_empty() {
                health["google_auth_error"] = json!(gerr);
                health["google_auth_error_at"] = json!(db.get_setting("google_auth_error_at").unwrap_or_default());
            }
            Ok(health)
        }
        ("POST", "/api/oauth/complete") => {
            // 헤드리스 재인증: 브라우저 주소창에서 복사한 localhost 콜백 URL을 붙여넣어 완료
            // (구글이 사설 IP redirect를 거부하므로 auth는 localhost로 하고, 코드만 서버로 전달)
            let pasted = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let code = if !pasted.is_empty() {
                pasted.split('?').nth(1).unwrap_or("")
                    .split('&').find_map(|p| p.strip_prefix("code=")).unwrap_or("")
            } else {
                body.get("code").and_then(|v| v.as_str()).unwrap_or("")
            };
            if code.is_empty() { return Err("URL 또는 code 파라미터 필요".into()); }
            let fake_path = format!("/auth/callback?code={}&pasted=1", code);
            let (status, body_html, _ct) = crate::handle_oauth_callback(&fake_path, &state, "http://localhost:8788/auth/callback");
            let ok = status.starts_with("200");
            let email = db.get_setting("google_email").unwrap_or_default();
            Ok(json!({"success": ok, "status": status, "email": email, "detail": body_html.chars().take(200).collect::<String>()}))
        }
        ("POST", "/api/process-cancel") => { state.job_status.lock().unwrap().cancelled = true; Ok(json!({"success":true})) }
        ("POST", "/api/sync/now") => {
            // pushSettings=true면 설정도 push (Windows에서 수정 시) — 기본은 pull만
            let push_st = body.get("pushSettings").and_then(|v| v.as_bool()).unwrap_or(false);
            let (pulled, pushed) = crate::services::sync::sync_all_with_settings(&db, push_st).await?;
            Ok(json!({"success": true, "pulled": pulled, "pushed": pushed}))
        }
        ("GET", "/api/sync/status") => {
            let url = db.get_setting("sync_url").unwrap_or_default();
            let last = db.get_setting("sync_last_at").unwrap_or_default();
            Ok(json!({"configured": !url.is_empty(), "url": url, "lastSyncAt": last}))
        }
        ("POST", "/api/cloudflare/deploy") => {
            // 원클릭 배포: wrangler CLI → 토큰 확인 → R2 버킷 → deploy
            let result = match app {
                Some(a) => crate::services::deploy::deploy_all(&db, a).await?,
                None => return Err("서버 모드에서는 지원하지 않습니다".into()),
            };
            Ok(result)
        }
        ("GET", "/api/fetch-videos") => {
            let settings = db.get_all_settings();
            let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
            if !access_token.is_empty() {
                let _ = ensure_fresh_token(&db).await;
                let settings = db.get_all_settings();
                let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
                let days = query.get("days").and_then(|v| v.as_str()).unwrap_or("3").parse::<i32>().unwrap_or(3);
                let channels = db.get_channels();
                let active: Vec<_> = channels.iter().filter(|c| c.get("active").and_then(|v| v.as_bool()).unwrap_or(true)).collect();
                if active.is_empty() { return Ok(json!({"videos":[], "error":"등록된 채널이 없습니다"})); }
                let exclude_shorts = query.get("excludeShorts").and_then(|v| v.as_str()).unwrap_or("1") == "1";
                let exclude_processed = query.get("excludeProcessed").and_then(|v| v.as_str()).unwrap_or("0") == "1";
                let processed = if exclude_processed { db.get_processed_video_ids() } else { std::collections::HashSet::new() };
                let videos = fetch_youtube_api(&active, days, access_token, exclude_shorts, &processed).await?;
                if videos.is_empty() {
                    let processed2 = if exclude_processed { db.get_processed_video_ids() } else { std::collections::HashSet::new() };
                    let (rss, meta) = fetch_rss(&state.ytdlp, &active, days, &processed2, exclude_shorts).await?;
                    Ok(json!({"videos": rss, "source": "rss_fallback",
                              "ytDlpChecked": meta.checked, "ytDlpFailed": meta.failed, "unknownDuration": meta.unknown, "ytDlpReason": meta.failed_reason}))
                } else {
                    Ok(json!({"videos": videos, "source": "youtube_api"}))
                }
            } else {
                let days = query.get("days").and_then(|v| v.as_str()).unwrap_or("3").parse::<i32>().unwrap_or(3);
                let channels = db.get_channels();
                let active: Vec<_> = channels.iter().filter(|c| c.get("active").and_then(|v| v.as_bool()).unwrap_or(true)).collect();
                if active.is_empty() { return Ok(json!({"videos":[], "error":"등록된 채널이 없습니다"})); }
                let exclude_processed = query.get("excludeProcessed").and_then(|v| v.as_str()).unwrap_or("0") == "1";
                let processed = if exclude_processed { db.get_processed_video_ids() } else { std::collections::HashSet::new() };
                let exclude_shorts = query.get("excludeShorts").and_then(|v| v.as_str()).unwrap_or("1") == "1";
                let videos = fetch_rss(&state.ytdlp, &active, days, &processed, exclude_shorts).await?;
                Ok(json!({"videos": videos}))
            }
        }
        ("GET", "/api/resolve-channel") => {
            let url = query.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() { return Err("url required".into()); }
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|e| e.to_string())?;
            let resp = client.get(url).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36").send().await.map_err(|e| format!("Fetch: {}", e))?;
            let final_url = resp.url().to_string();
            // 1. Extract UC... from final URL
            if let Some(start) = final_url.find("/channel/UC") {
                let remain = &final_url[start + 9..];
                let id: String = remain.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
                if id.starts_with("UC") { return Ok(json!({"channelId": id, "resolvedFrom": final_url})); }
            }
            let text = resp.text().await.unwrap_or_default();
            // 2. Regex search for UC channel ID in page content
            let re = regex::Regex::new(r#"externalId["\s]*:["\s]*(UC[\w-]+)"#).unwrap();
            if let Some(cap) = re.captures(&text) {
                let id = cap.get(1).unwrap().as_str().to_string();
                // Also extract channel name — search specific patterns first
                let channel_name = {
                    let patterns = [
                        // HTML: itemprop="name" content="채널명"
                        regex::Regex::new(r#"itemprop="name"\s+content="([^"]+)""#).unwrap(),
                        // JSON: "author" : { ... "name" : "채널명" ... }
                        regex::Regex::new(r#""author"[^}]*"name"\s*:\s*"([^"]+)""#).unwrap(),
                        // JSON: "channelName":"채널명"
                        regex::Regex::new(r#""channelName"\s*:\s*"([^"]+)""#).unwrap(),
                    ];
                    let mut found = String::new();
                    for p in &patterns {
                        if let Some(cap) = p.captures(&text) {
                            let val = cap.get(1).unwrap().as_str().to_string();
                            // Skip common non-channel values
                            if !["홈", "Home", "Videos", "Video", "About", "정보", "Playlists", "Community", "커뮤니티", "Search", "검색"].contains(&val.as_str()) {
                                found = val;
                                break;
                            }
                        }
                    }
                    found
                };
                return Ok(json!({"channelId": id, "channelName": channel_name}));
            }
            Err("channel ID not found".into())
        }
        ("GET", "/api/youtube/subscriptions") => {
            let settings = db.get_all_settings();
            let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
            if access_token.is_empty() { return Err("Google account not linked".into()); }
            let _ = ensure_fresh_token(&db).await;
            let (count, total) = sync_google_subscriptions(&db).await?;
            Ok(json!({"imported": count, "total": total}))
        }
        ("GET", "/api/youtube/playlists") => {
            let settings = db.get_all_settings();
            let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
            if access_token.is_empty() { return Err("Google account not linked".into()); }
            let _ = ensure_fresh_token(&db).await;
            let access_token = db.get_setting("google_access_token").unwrap_or_default();
            let client = reqwest::Client::new();
            let mut page_token = String::new();
            let mut playlists = Vec::new();
            loop {
                let url = format!("https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50&pageToken={}", page_token);
                let resp = client.get(&url).header("Authorization", format!("Bearer {}", access_token)).send().await.map_err(|e| format!("API: {}", e))?;
                if !resp.status().is_success() {
                    eprintln!("[playlists] HTTP {}", resp.status().as_u16());
                    return Err(format!("playlists API HTTP {}", resp.status().as_u16()));
                }
                let data: serde_json::Value = resp.json().await.map_err(|e| format!("JSON: {}", e))?;
                if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
                    for item in items {
                        if let Some(pid) = item.get("id").and_then(|v| v.as_str()) {
                            let name = item.get("snippet").and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or("");
                            let count = item.get("contentDetails").and_then(|c| c.get("itemCount")).and_then(|v| v.as_u64()).unwrap_or(0);
                            playlists.push(serde_json::json!({"id": pid, "title": name, "itemCount": count}));
                        }
                    }
                }
                page_token = data.get("nextPageToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if page_token.is_empty() { break; }
            }
            Ok(json!({"playlists": playlists}))
        }
        ("GET", "/api/youtube/playlist-videos") => {
            let settings = db.get_all_settings();
            let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
            if access_token.is_empty() { return Err("Google account not linked".into()); }
            let playlist_id = query.get("playlistId").and_then(|v| v.as_str()).unwrap_or("");
            if playlist_id.is_empty() { return Err("playlistId required".into()); }
            let _ = ensure_fresh_token(&db).await;
            let access_token = db.get_setting("google_access_token").unwrap_or_default();
            let client = reqwest::Client::new();
            let mut page_token = String::new();
            let mut videos = Vec::new();
            loop {
                let url = format!("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId={}&maxResults=50&pageToken={}", playlist_id, page_token);
                let resp = client.get(&url).header("Authorization", format!("Bearer {}", access_token)).send().await.map_err(|e| format!("API: {}", e))?;
                let data: serde_json::Value = resp.json().await.map_err(|e| format!("JSON: {}", e))?;
                if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
                    for item in items {
                        let vid = item.get("snippet").and_then(|s| s.get("resourceId")).and_then(|r| r.get("videoId")).and_then(|v| v.as_str()).unwrap_or("");
                        if vid.is_empty() { continue; }
                        let title = item.get("snippet").and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or("");
                        let published = item.get("snippet").and_then(|s| s.get("publishedAt")).and_then(|v| v.as_str()).unwrap_or("");
                        let thumb = item.get("snippet").and_then(|s| s.get("thumbnails")).and_then(|t| t.get("high")).and_then(|h| h.get("url")).and_then(|v| v.as_str()).unwrap_or("");
                        let ch_name = item.get("snippet").and_then(|s| s.get("videoOwnerChannelTitle")).and_then(|v| v.as_str()).unwrap_or("");
                        videos.push(serde_json::json!({"id": vid, "title": title, "channelName": ch_name, "videoUrl": format!("https://youtube.com/watch?v={}", vid), "publishDate": published, "thumbnail": thumb, "source": "playlist"}));
                    }
                }
                page_token = data.get("nextPageToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if page_token.is_empty() { break; }
            }
            Ok(json!({"videos": videos}))
        }
        ("POST", "/api/youtube/watch-later") => {
            // Add a video to the user's real YouTube Watch Later playlist (WL)
            let settings = db.get_all_settings();
            let access_token = settings.get("google_access_token").and_then(|v| v.as_str()).unwrap_or("");
            if access_token.is_empty() { return Err("Google account not linked".into()); }
            let video_id = body.get("videoId").and_then(|v| v.as_str()).unwrap_or("");
            if video_id.is_empty() { return Err("videoId required".into()); }
            let _ = ensure_fresh_token(&db).await;
            let access_token = db.get_setting("google_access_token").unwrap_or_default();
            let client = reqwest::Client::new();

            // Google blocks API writes to system playlists (WL/LL) since 2023-2024.
            // Instead: find (or auto-create) a user playlist named "나중에 볼 영상" and add to it.
            let mut playlist_id = String::new();
            let mut page_token = String::new();
            'find: loop {
                let list_url = format!("https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50&pageToken={}", page_token);
                let list_resp = client.get(&list_url).header("Authorization", format!("Bearer {}", access_token)).send().await.map_err(|e| format!("API: {}", e))?;
                let list_data: serde_json::Value = list_resp.json().await.map_err(|e| format!("JSON: {}", e))?;
                if let Some(items) = list_data.get("items").and_then(|v| v.as_array()) {
                    for item in items {
                        let name = item.get("snippet").and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or("");
                        if name == "나중에 볼 영상" || name == "Watch Later" {
                            playlist_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            break 'find;
                        }
                    }
                }
                page_token = list_data.get("nextPageToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if page_token.is_empty() { break; }
            }

            // Not found → create it
            if playlist_id.is_empty() {
                let create_payload = json!({
                    "snippet": {"title": "나중에 볼 영상", "description": "SUMMARIZER에서 저장한 나중에 볼 영상"},
                    "status": {"privacyStatus": "private"}
                });
                let create_resp = client.post("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status")
                    .header("Authorization", format!("Bearer {}", access_token))
                    .header("Content-Type", "application/json")
                    .json(&create_payload)
                    .send().await.map_err(|e| format!("API: {}", e))?;
                let create_data: serde_json::Value = create_resp.json().await.map_err(|e| format!("JSON: {}", e))?;
                playlist_id = create_data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if playlist_id.is_empty() {
                    eprintln!("[watch-later] create failed: {:?}", create_data);
                    return Err("나중에 볼 영상 플레이리스트 생성 실패".into());
                }
            }

            let payload = json!({
                "snippet": {
                    "playlistId": playlist_id,
                    "resourceId": {"kind": "youtube#video", "videoId": video_id}
                }
            });
            let resp = client.post("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet")
                .header("Authorization", format!("Bearer {}", access_token))
                .header("Content-Type", "application/json")
                .json(&payload)
                .send().await.map_err(|e| format!("API: {}", e))?;
            let status = resp.status().as_u16();
            let data: serde_json::Value = resp.json().await.map_err(|e| format!("JSON: {}", e))?;
            if status == 200 || status == 201 {
                Ok(json!({"success": true, "watchLater": true, "playlistId": playlist_id}))
            } else {
                eprintln!("[watch-later] HTTP {}: {:?}", status, data);
                let reason = data["error"]["message"].as_str()
                    .unwrap_or(data["error"]["errors"][0]["reason"].as_str().unwrap_or("unknown"));
                Err(format!("Watch Later: {} (HTTP {})", reason, status))
            }
        }
        ("GET", "/api/oauth/url") => {
            let settings = db.get_all_settings();
            let client_id = settings.get("google_client_id").and_then(|v| v.as_str()).unwrap_or("");
            if client_id.is_empty() { return Err("Client ID not configured".into()); }
            use base64::Engine;
            let mut verifier = vec![0u8; 32];
            use std::time::{SystemTime, UNIX_EPOCH};
            let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
            let mut rng = seed;
            for b in &mut verifier {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                *b = (rng >> 32) as u8;
            }
            let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&verifier);
            use sha2::Digest;
            let challenge_hash = sha2::Sha256::digest(code_verifier.as_bytes());
            let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&challenge_hash);
            let _ = db.set_setting("oauth_code_verifier", &code_verifier);
            // redirect 파라미터 (LAN 뷰어: 자신의 origin 전달) — 없으면 기본 21890
            let redirect_uri = query.get("redirect").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("http://127.0.0.1:21890/auth/callback")
                .to_string();
            let params = [
                ("client_id", client_id),
                ("redirect_uri", redirect_uri.as_str()),
                ("response_type", "code"),
                ("scope", "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.email"),
                ("access_type", "offline"),
                ("prompt", "consent"),
                // 비공개 IP(192.168.x.x 등) redirect URI는 Google이 device_id/device_name 필수 요구 (등록 대체)
                ("device_id", "smmynp-lan-server"),
                ("device_name", "SMMYNP LAN Server"),
                ("code_challenge", code_challenge.as_str()),
                ("code_challenge_method", "S256"),
            ];
            let url = params.iter().map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v))).collect::<Vec<_>>().join("&");
            Ok(json!({"url": format!("https://accounts.google.com/o/oauth2/v2/auth?{}", url)}))
        }
        ("GET", "/api/github/fetch") => {
            let days = query.get("days").and_then(|v| v.as_str()).unwrap_or("7").parse::<i32>().unwrap_or(7);
            let token = db.get_setting("github_token").unwrap_or_default();
            let repos = fetch_github_trending(days, &token).await?;
            let processed: std::collections::HashSet<String> = db.get_github_repos().iter()
                .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect();
            let filtered: Vec<_> = repos.into_iter().filter(|r| {
                let id = r.get("id").and_then(|v| v.as_str()).unwrap_or(""); !processed.contains(id)
            }).collect();
            Ok(json!({"repos": filtered, "total": filtered.len(), "source":"github"}))
        }
        ("GET", p) if p.starts_with("/api/models/") => {
            let provider = p.trim_start_matches("/api/models/");
            let settings_map = db.get_all_settings();
            let settings: HashMap<String, String> = settings_map.as_object()
                .map(|o| o.iter().map(|(k,v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                .unwrap_or_default();
            // Prefer the key passed from the frontend form (not-yet-saved),
            // falling back to the saved key.
            let query_key = query.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let api_key = if !query_key.is_empty() { query_key } else { settings.get(&format!("{}_key", provider)).cloned().unwrap_or_default() };
            if api_key.is_empty() && provider != "openrouter" {
                return Err("API key not configured".into());
            }
            let models = fetch_provider_models(provider, &api_key, &settings).await?;
            Ok(json!({"models": models, "provider": provider}))
        }
        ("POST", "/api/github/process") => {
            let r = body.get("repo");
            if let Some(repo) = r {
                let full_name = repo.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let owner = full_name.split('/').next().unwrap_or("").to_string();
                let title = repo.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let description = repo.get("description").and_then(|v| v.as_str()).unwrap_or("");
                let url = repo.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let owner_avatar = repo.get("ownerAvatar").and_then(|v| v.as_str()).unwrap_or("");
                let created_at = repo.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
                let language = repo.get("language").and_then(|v| v.as_str()).unwrap_or("");
                let stars = repo.get("stars").map(|v| v.to_string()).unwrap_or_default();
                let forks = repo.get("forks").map(|v| v.to_string()).unwrap_or_default();
                let settings_map = db.get_all_settings();
                let settings: HashMap<String, String> = settings_map.as_object()
                    .map(|o| o.iter().map(|(k,v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                    .unwrap_or_default();
                let provider = settings.get("ai_provider").cloned().unwrap_or_else(|| "deepseek".into());
                let gh_token = settings.get("github_token").cloned().unwrap_or_default();
                let readme_content = fetch_github_readme(full_name, &gh_token).await.unwrap_or_default();
                let summary = if readme_content.is_empty() {
                    json!({"Summary": "README를 찾을 수 없습니다.", "Insights": "", "Implications": "", "Keywords": "", "Analysis": "", "Category": ""})
                } else {
                    let gh_lang = settings.get("github_lang").cloned().unwrap_or_else(|| "ko".into());
                    if state.job_status.lock().unwrap().cancelled {
                        db.upsert_github_repo(&json!({"id": full_name, "title": title, "channel_name": full_name, "owner": owner, "description": description, "language": language, "stars": stars, "forks": forks, "avatar": owner_avatar, "video_url": url, "publish_date": created_at, "image_url": owner_avatar, "processed_at": chrono::Utc::now().format("%Y-%m-%d").to_string(), "read": "0", "favorite": "0", "summary": "", "insights": "", "applications": "", "implications": "", "analysis": "", "keywords": "", "category": "", "model": provider}))?;
                        return Ok(json!({"success": false, "repo": full_name, "cancelled": true}));
                    }
                    services::llm::summarize_github(&readme_content, full_name, &description, &provider, &settings, &gh_lang)
                        .await
                        .unwrap_or(json!({"Summary": "요약 실패", "Insights": "", "Implications": "", "Keywords": "", "Analysis": "", "Category": ""}))
                };
                let llm_title = summary.get("Title").or(summary.get("title")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&title);
                db.upsert_github_repo(&json!({
                    "id": full_name, "title": llm_title, "channel_name": full_name,
                    "owner": owner, "description": description, "language": language,
                    "stars": stars, "forks": forks, "avatar": owner_avatar,
                    "video_url": url, "publish_date": created_at, "image_url": owner_avatar,
                    "processed_at": chrono::Utc::now().format("%Y-%m-%d").to_string(),
                    "read": "0", "favorite": "0",
                    "summary": summary.get("Summary").or(summary.get("summary")).and_then(|v| v.as_str()).unwrap_or(""),
                    "insights": summary.get("Insights").or(summary.get("insights")).and_then(|v| v.as_str()).unwrap_or(""),
                    "applications": summary.get("Applications").or(summary.get("applications")).and_then(|v| v.as_str()).unwrap_or(""),
                    "implications": summary.get("Implications").or(summary.get("implications")).and_then(|v| v.as_str()).unwrap_or(""),
                    "analysis": summary.get("Analysis").or(summary.get("analysis")).and_then(|v| v.as_str()).unwrap_or(""),
                    "keywords": summary.get("Keywords").or(summary.get("keywords")).and_then(|v| v.as_str()).unwrap_or(""),
                    "category": summary.get("Category").or(summary.get("category")).and_then(|v| v.as_str()).unwrap_or(""),
                    "model": summary.get("usedModel").and_then(|v| v.as_str()).unwrap_or(&provider),
                    "updated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(), "deleted": "0"
                }))?;
                Ok(json!({"success": true, "repo": full_name}))
            } else { Err("repo required".into()) }
        }
        ("POST", "/api/github/process-batch") => {
            let repos = body.get("repos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let count = repos.len();
            let st = state.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("rt");
                rt.block_on(async { process_github_repos_bg(st, &repos).await; });
            });
            Ok(json!({"jobId": uuid::Uuid::new_v4().to_string(), "count": count}))
        }
        ("GET", "/api/github/repos") => Ok(json!({"data": db.get_github_repos(), "error": null})),
        ("POST", "/api/github/repos") => {
            if let Some(repos) = body.get("repos").and_then(|v| v.as_array()) {
                for r in repos { db.upsert_github_repo(r)?; }
                Ok(json!({"success": true, "count": repos.len()}))
            } else { db.upsert_github_repo(body)?; Ok(json!({"success": true, "count": 1})) }
        }
        ("DELETE", p) if p.starts_with("/api/github/repos/") => { let id = p.trim_start_matches("/api/github/repos/"); db.delete_github_repo(id)?; Ok(json!({"success":true})) }
        ("PATCH", p) if p.starts_with("/api/github/repos/") => {
            let id = p.trim_start_matches("/api/github/repos/");
            if let Some(obj) = body.as_object() {
                let mut merged = db.get_sync_record("github_repos", id).unwrap_or(json!({"id": id}));
                if let Some(mobj) = merged.as_object_mut() {
                    for (k, v) in obj {
                        mobj.insert(k.clone(), v.clone());
                    }
                    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
                    mobj.insert("updated_at".into(), json!(now.clone()));
                    for (f, ts) in [("read","read_ts"),("favorite","favorite_ts"),("deleted","deleted_ts"),("saved","saved_ts")] {
                        if mobj.contains_key(f) { mobj.insert(ts.into(), json!(now.clone())); }
                    }
                }
                db.upsert_sync_record("github_repos", &merged)?;
            }
            Ok(json!({"success":true}))
        }
        ("POST", "/api/add-video-url") => {
            let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() { return Err("URL required".into()); }
            let re = regex::Regex::new(r"(?:v=|youtu\.be/|/shorts/)([a-zA-Z0-9_-]{11})").map_err(|e| e.to_string())?;
            let vid = re.captures(url).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or("");
            if vid.is_empty() { return Err("유효한 YouTube URL이 아닙니다".into()); }
            let oembed_url = format!("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={}&format=json", vid);
            let client = reqwest::Client::new();
            let resp = client.get(&oembed_url).send().await.map_err(|e| format!("oEmbed 실패: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("JSON 파싱 실패: {}", e))?;
            let title = data.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let author = data.get("author_name").and_then(|v| v.as_str()).unwrap_or("");
            let thumb = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", vid);
            // yt-dlp로 설명+발행일 가져오기 (oEmbed엔 둘 다 없음)
            let ytdlp = state.ytdlp.clone();
            let description = services::youtube::fetch_video_description(&ytdlp, &vid).await;
            let publish_date = services::youtube::fetch_video_upload_date(&ytdlp, &vid).await;
            Ok(json!({"video": {"id": vid, "title": title, "channelName": author, "thumbnail": thumb, "videoUrl": format!("https://youtube.com/watch?v={}", vid), "description": description, "publishDate": publish_date, "_t": "video"}}))
        }
        _ => Err(format!("Not found: {} {}", method, path)),
    }
}

// ── YouTube Data API fetch ──
/// Refresh the Google access token via refresh_token when it may be expired.
/// Google access tokens last ~1h. We refresh if the last refresh was >45min ago
/// or no refresh timestamp is recorded yet.
async fn ensure_fresh_token(db: &Database) -> Result<(), String> {
    let settings = db.get_all_settings();
    let refresh_token = settings.get("google_refresh_token").and_then(|v| v.as_str()).unwrap_or("");
    let client_id = settings.get("google_client_id").and_then(|v| v.as_str()).unwrap_or("");
    if refresh_token.is_empty() || client_id.is_empty() { return Ok(()); }

    // Skip refresh if done recently
    let last = settings.get("google_token_updated_at").and_then(|v| v.as_str()).unwrap_or("");
    if let Ok(t) = chrono::NaiveDateTime::parse_from_str(last, "%Y-%m-%dT%H:%M:%S") {
        let age = chrono::Utc::now().naive_utc() - t;
        if age.num_seconds() < 45 * 60 { return Ok(()); }
    }

    let client_secret = settings.get("google_client_secret").and_then(|v| v.as_str()).unwrap_or("");
    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if !client_secret.is_empty() { params.push(("client_secret", client_secret.to_string())); }
    let resp = client.post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send().await.map_err(|e| format!("refresh: {}", e))?;
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("refresh parse: {}", e))?;
    if let Some(new_token) = data.get("access_token").and_then(|v| v.as_str()) {
        let _ = db.set_setting("google_access_token", new_token);
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let _ = db.set_setting("google_token_updated_at", &now);
        if let Some(new_refresh) = data.get("refresh_token").and_then(|v| v.as_str()) {
            let _ = db.set_setting("google_refresh_token", new_refresh);
        }
        // 성공 시 인증 오류 플래그 해제
        let _ = db.set_setting("google_auth_error", "");
        Ok(())
    } else {
        eprintln!("[token] refresh failed: {:?}", data);
        // 재인증 필요 감지 — 대시보드 health 알림용 (invalid_grant = refresh token 만료/폐기)
        let err_code = data.get("error").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        if err_code == "invalid_grant" {
            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let _ = db.set_setting("google_auth_error", "재인증 필요 (refresh token 만료)");
            let _ = db.set_setting("google_auth_error_at", &now);
        }
        Ok(())
    }
}

async fn fetch_youtube_api(channels: &[&Value], days: i32, access_token: &str, exclude_shorts: bool, processed: &std::collections::HashSet<String>) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let mut all = Vec::new();
    for ch in channels {
        let cid = ch.get("channelId").and_then(|v| v.as_str()).unwrap_or("");
        if cid.is_empty() { continue; }
        let search_url = format!("https://www.googleapis.com/youtube/v3/search?order=date&part=snippet&channelId={}&maxResults=10&type=video", cid);
        let resp = match client.get(&search_url).header("Authorization", format!("Bearer {}", access_token)).send().await {
            Ok(r) => r, Err(_) => continue
        };
        if !resp.status().is_success() { continue; }
        let data: serde_json::Value = match resp.json().await { Ok(d) => d, Err(_) => continue };
        if let Some(err) = data.get("error") {
            eprintln!("YouTube API error for {}: {:?}", cid, err);
            continue;
        }
        // Check for API error (e.g. expired token, quota exceeded)
        if data.get("error").is_some() { continue; }
        if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            let mut video_ids: Vec<&str> = Vec::new();
            for item in items {
                if let Some(vid) = item.get("id").and_then(|i| i.get("videoId")).and_then(|v| v.as_str()) {
                    video_ids.push(vid);
                }
            }
            // Fetch duration for all videos in batch
            let ids = video_ids.join(",");
            let dur_url = format!("https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id={}", ids);
            let dur_resp = match client.get(&dur_url).header("Authorization", format!("Bearer {}", access_token)).send().await {
                Ok(r) => r, Err(_) => continue
            };
            let dur_data: serde_json::Value = match dur_resp.json().await { Ok(d) => d, Err(_) => continue };
            let mut dur_map: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
            if let Some(dur_items) = dur_data.get("items").and_then(|v| v.as_array()) {
                for d in dur_items {
                    if let (Some(vid), Some(iso)) = (
                        d.get("id").and_then(|v| v.as_str()),
                        d.get("contentDetails").and_then(|c| c.get("duration")).and_then(|v| v.as_str()),
                    ) {
                        // Parse ISO 8601 duration: PT#M#S
                        let secs = iso.replace("PT", "").replace("H", ":").replace("M", ":").replace("S", "");
                        let parts: Vec<&str> = secs.split(':').collect();
                        let mut total = 0i32;
                        if parts.len() == 3 { total += parts[0].parse::<i32>().unwrap_or(0) * 3600; }
                        if parts.len() >= 2 { total += parts[parts.len()-2].parse::<i32>().unwrap_or(0) * 60; }
                        total += parts.last().and_then(|p| p.parse::<i32>().ok()).unwrap_or(0);
                        dur_map.insert(vid.to_string(), total);
                    }
                }
            }
            for item in items {
                let snippet = item.get("snippet");
                let vid = item.get("id").and_then(|i| i.get("videoId")).and_then(|v| v.as_str()).unwrap_or("");
                if vid.is_empty() { continue; }
                let title = decode_html_entities(&snippet.and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or(""));
                let published = snippet.and_then(|s| s.get("publishedAt")).and_then(|v| v.as_str()).unwrap_or("");
                let thumb = snippet.and_then(|s| s.get("thumbnails")).and_then(|t| t.get("high")).and_then(|h| h.get("url")).and_then(|v| v.as_str()).unwrap_or("");
                let ch_name = snippet.and_then(|s| s.get("channelTitle")).and_then(|v| v.as_str()).unwrap_or("");
                let dur = dur_map.get(vid).copied().unwrap_or(0);
                if processed.contains(vid) { continue; }
                if let Ok(date) = chrono::DateTime::parse_from_rfc3339(published) { if date < cutoff { continue; } }
                if exclude_shorts && (dur == 0 || dur < 181) { continue; } // 쇼츠 기준: 3분 1초 이상만 (길이 모름 포함 제외)
                if exclude_shorts && title.to_lowercase().contains("#shorts") { continue; }
                all.push(json!({"id": vid, "title": title, "channelName": ch_name, "channelId": cid, "videoUrl": format!("https://youtube.com/watch?v={}", vid), "publishDate": published, "duration": dur, "thumbnail": thumb, "source": "youtube_api"}));
            }
        }
    }
    Ok(all)
}

// ── YouTube RSS ──
#[derive(Default, Clone, serde::Serialize)]
pub struct RssMeta { pub unknown: usize, pub checked: usize, pub failed: usize, pub excluded: usize, pub failed_reason: String }

pub async fn fetch_rss(ytdlp: &str, channels: &[&Value], days: i32, processed: &std::collections::HashSet<String>, exclude_shorts: bool) -> Result<(Vec<Value>, RssMeta), String> {
    let client = reqwest::Client::new();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let mut all = Vec::new();
    let mut unknown_dur: Vec<(String, serde_json::Value)> = Vec::new();  // 길이 모르는 영상 (yt-dlp 조회 대상)
    for ch in channels {
        let cid = ch.get("channelId").and_then(|v| v.as_str()).unwrap_or("");
        let name = ch.get("channelName").and_then(|v| v.as_str()).unwrap_or("");
        if cid.is_empty() { continue; }
        let url = format!("https://www.youtube.com/feeds/videos.xml?channel_id={}", cid);
        let resp = match client.get(&url).send().await { Ok(r) => r, Err(_) => continue };
        let text = match resp.text().await { Ok(t) => t, Err(_) => continue };
        let entries: Vec<&str> = text.split("<entry>").skip(1).collect();
        for entry in entries {
            let vid = extract_xml(entry, "yt:videoId"); let title = decode_html_entities(&extract_xml(entry, "title"));
            let published = extract_xml(entry, "published"); let dur = extract_xml_attr(entry, "yt:duration", "seconds").parse::<i32>().unwrap_or(0);
            let description = decode_html_entities(&extract_xml(entry, "media:description"));  // 공식 챕터용
            // RSS의 원본 링크 — 쇼츠는 /shorts/ URL로 온다 (F:\SMMY 실측 확인)
            let orig_link = extract_xml_attr(entry, "link", "href");
            let orig_link = if orig_link.is_empty() {
                // link 태그 attribute 순서 fallback: rel="alternate" 뒤의 href
                let mut found = String::new();
                if let Some(i) = entry.find("rel=\"alternate\"") {
                    if let Some(j) = entry[i..].find("href=\"") {
                        let rest = &entry[i + j + 6..];
                        if let Some(k) = rest.find('\"') { found = rest[..k].to_string(); }
                    }
                }
                found
            } else { orig_link };
            if vid.is_empty() || processed.contains(&vid) { continue; }
            // 쇼츠 필터: ① /shorts/ URL (RSS가 쇼츠를 이 형식으로 줌 — F:\SMMY 검증) ② 길이 181초 미만
            if exclude_shorts && orig_link.contains("/shorts/") { continue; }
            if exclude_shorts && dur > 0 && dur < 181 { continue; }  // 길이 아는 것: 3분 1초 미만 제외
            if let Ok(date) = chrono::DateTime::parse_from_rfc3339(&published) { if date < cutoff { continue; } }
            let item = json!({"id": vid, "title": title, "channelName": name, "channelId": cid, "videoUrl": format!("https://youtube.com/watch?v={}", vid), "publishDate": published, "duration": dur, "thumbnail": format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", vid), "source": "rss", "description": description});
            if exclude_shorts && dur == 0 {
                unknown_dur.push((vid, item));  // 길이 모르는 것: yt-dlp로 실제 길이 조회 후 판정
            } else {
                all.push(item);
            }
        }
    }
    // 길이 모르는 영상: yt-dlp 병렬 조회 → 3분 1초 기준 정확 필터
    // (전부 조회 — 상한 없이 20개씩 배치로 순차 처리)
    let mut meta = RssMeta { unknown: unknown_dur.len(), ..Default::default() };
    if exclude_shorts && !unknown_dur.is_empty() {
        let mut durations = std::collections::HashMap::new();
        let mut reasons: Vec<String> = Vec::new();
        // 배치 10개 + 배치 간 1.2초 대기 — YouTube 봇 감지(429) 완화
        for chunk in unknown_dur.chunks(10) {
            let mut set = tokio::task::JoinSet::new();
            for (vid, _) in chunk {
                let v = vid.clone();
                let ytdlp2 = ytdlp.to_string();
                set.spawn(async move { (v.clone(), crate::services::youtube::yt_duration(&ytdlp2, &v).await) });
            }
            while let Some(res) = set.join_next().await {
                if let Ok((vid, Ok(d))) = res { durations.insert(vid, d); }
                else if let Ok((_, Err(reason))) = res {
                    if reasons.len() < 2 { reasons.push(reason); }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        for (vid, mut item) in unknown_dur {
            match durations.get(&vid) {
                Some(d) if *d >= 181 => { item["duration"] = json!(*d); meta.checked += 1; all.push(item); }   // 실제 3분 1초 이상 → 포함 (실제 길이 반영)
                Some(_) => { meta.checked += 1; meta.excluded += 1; }             // 실제 쇼츠 → 제외
                None => { meta.failed += 1; all.push(item); }                     // yt-dlp 실패 → 포함 (일반 영상 보존)
            }
        }
        meta.failed_reason = reasons.join(" / ");
    }
    eprintln!("[fetch_rss] 길이모름 {} / yt-dlp 조회 {} / 제외 {} / 실패 {}", meta.unknown, meta.checked, meta.excluded, meta.failed);
    Ok((all, meta))
}
/// 유튜브 설명에서 공식 챕터 추출 → 타임라인 가이드
/// 두 형식 모두 지원:
///   "0:00 제목"  (유튜브 표준 — 대괄호 없음, 줄 시작)
///   "[00:00] 제목" (대괄호 형식)
/// — 초 단위 타임스탬프(00:10 = 10초)는 제외, 분 단위 이상만 인정
fn extract_chapters(description: &str) -> String {
    if description.is_empty() { return String::new(); }
    // (?m)^ 줄 시작 + 선택적 대괄호 + MM:SS(또는 H:MM:SS) + 제목
    let re = match regex::Regex::new(r"(?m)^\[?(\d{1,2}):(\d{2})(?::\d{2})?\]?\s+([^\n\r]+)") {
        Ok(r) => r, Err(_) => return String::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for cap in re.captures_iter(description) {
        let min: i32 = cap[1].parse().unwrap_or(0);
        let sec: i32 = cap[2].parse().unwrap_or(0);
        // 00:10 같은 초 단위 표기는 챕터가 아님 — 제외 ([00:00] 인트로는 허용)
        if min == 0 && sec > 0 { continue; }
        let t = cap.get(3).map(|m| m.as_str().trim()).unwrap_or("").to_string();
        if !t.is_empty() {
            let ts = cap[1].to_string() + ":" + &cap[2];
            out.push(format!("- [{}] {}", ts, t));
        }
        if out.len() >= 30 { break; }  // 유튜브 챕터 최대 30개까지 지원
    }
    out.join("\n")
}

fn extract_xml(xml: &str, tag: &str) -> String { let start = format!("<{}>", tag); let end = format!("</{}>", tag); xml.find(&start).and_then(|i| { let s = i + start.len(); xml[s..].find(&end).map(|j| xml[s..s+j].to_string()) }).unwrap_or_default() }
// XML 엔티티 디코딩 — YouTube RSS는 '를 &#39;로 이스케이프해서 보냄
fn decode_html_entities(s: &str) -> String {
    s.replace("&#39;", "'").replace("&quot;", "\"").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&#x27;", "'")
}
fn extract_xml_attr(xml: &str, tag: &str, attr: &str) -> String { let prefix = format!("<{} ", tag); xml.find(&prefix).and_then(|i| { let rest = &xml[i..]; let pat = format!("{}='", attr); rest.find(&pat).and_then(|j| { let s = j + pat.len(); rest[s..].find('\'').map(|k| rest[s..s+k].to_string()) }) }).unwrap_or_default() }

// ── Google 구독 목록 전체 동기화 (신규 추가 + 해지 반영) ──
/// YouTube Data API로 구독 전체를 가져와 import_channels(전체 동기화) 실행.
/// (추가된 수, 전체 수) 반환. API 실패/빈 응답 시 Err — 빈 목록으로 전체 비활성화되는 사고 방지.
pub async fn sync_google_subscriptions(db: &Database) -> Result<(usize, usize), String> {
    let _ = ensure_fresh_token(db).await;
    let access_token = db.get_setting("google_access_token").unwrap_or_default();
    if access_token.is_empty() { return Err("Google account not linked".into()); }
    let client = reqwest::Client::new();
    let mut page_token = String::new();
    let mut subs = Vec::new();
    loop {
        let url = format!("https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50&pageToken={}", page_token);
        let resp = client.get(&url).header("Authorization", format!("Bearer {}", access_token)).send().await.map_err(|e| format!("API: {}", e))?;
        if !resp.status().is_success() {
            // 401 = access token 만료(자동 갱신 실패) 또는 refresh token 만료 → 재인증 필요 플래그
            if resp.status().as_u16() == 401 {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
                let _ = db.set_setting("google_auth_error", "재인증 필요 (구독 동기화 401)");
                let _ = db.set_setting("google_auth_error_at", &now);
            }
            return Err(format!("subscriptions API HTTP {}", resp.status().as_u16()));
        }
        let data: Value = resp.json().await.map_err(|e| format!("JSON: {}", e))?;
        if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            for item in items {
                if let Some(cid) = item.get("snippet").and_then(|s| s.get("resourceId")).and_then(|r| r.get("channelId")).and_then(|v| v.as_str()) {
                    let name = item.get("snippet").and_then(|s| s.get("title")).and_then(|v| v.as_str()).unwrap_or("");
                    subs.push(serde_json::json!({"channelId": cid, "channelName": name, "source": "youtube"}));
                }
            }
        }
        page_token = data.get("nextPageToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if page_token.is_empty() { break; }
    }
    if subs.is_empty() { return Err("구독 목록이 비어있음 — 동기화 중단 (해지 오판 방지)".into()); }
    let count = db.import_channels(&subs)?;
    Ok((count, subs.len()))
}

// ── 텔레그램 알림 (요약 완료/오류) ──
/// settings에 telegram_bot_token + telegram_target("chat:thread")이 있으면 sendMessage.
/// 미설정 시 조용히 Ok — 알림 미사용자에게 영향 없음.
pub async fn send_telegram_notify(db: &Database, text: &str) -> Result<(), String> {
    let settings = db.get_all_settings();
    // 명시적 '0'이면 비활성화 (미설정/기본 = 활성)
    if settings.get("telegram_enabled").and_then(|v| v.as_str()).map(|s| s == "0").unwrap_or(false) { return Ok(()); }
    let token = settings.get("telegram_bot_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let target = settings.get("telegram_target").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if token.is_empty() || target.is_empty() { return Ok(()); }
    let (chat_id, thread_id) = match target.split_once(':') {
        Some((c, t)) => (c.to_string(), t.to_string()),
        None => (target.clone(), String::new()),
    };
    let mut body = serde_json::Map::new();
    body.insert("chat_id".into(), json!(chat_id));
    body.insert("text".into(), json!(text));
    if !thread_id.is_empty() { body.insert("message_thread_id".into(), json!(thread_id)); }
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    let resp = client.post(&url).json(&serde_json::Value::Object(body)).send().await
        .map_err(|e| format!("telegram: {}", e))?;
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("telegram parse: {}", e))?;
    if data.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(())
    } else {
        Err(format!("telegram: {}", data.get("description").and_then(|v| v.as_str()).unwrap_or("?")))
    }
}

/// 초 → "X분 Y초" (60초 미만이면 "Y초")
fn fmt_dur(secs: i64) -> String {
    if secs >= 60 { format!("{}분 {}초", secs / 60, secs % 60) } else { format!("{}초", secs) }
}

// ── GitHub Trending ──
pub async fn fetch_github_trending(days: i32, token: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    let since = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let url = format!("https://api.github.com/search/repositories?q=created:>{}&sort=stars&order=desc&per_page=15", since.format("%Y-%m-%d"));
    let mut req = client.get(&url).header("Accept", "application/vnd.github.v3+json").header("User-Agent", "SMMYNP/3.0");
    if !token.is_empty() { req = req.header("Authorization", format!("Bearer {}", token)); }
    let resp = req.send().await.map_err(|e| format!("GitHub API: {}", e))?;
    let data: Value = resp.json().await.map_err(|e| format!("GitHub parse: {}", e))?;
    let items = data.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    Ok(items.iter().map(|r| json!({"id": r.get("full_name").and_then(|v| v.as_str()).unwrap_or(""), "name": r.get("full_name").and_then(|v| v.as_str()).unwrap_or(""), "title": r.get("name").and_then(|v| v.as_str()).unwrap_or(""), "description": r.get("description").and_then(|v| v.as_str()).unwrap_or(""), "url": r.get("html_url").and_then(|v| v.as_str()).unwrap_or(""), "stars": r.get("stargazers_count").unwrap_or(&json!(0)), "language": r.get("language").and_then(|v| v.as_str()).unwrap_or(""), "owner": r.get("owner").and_then(|o| o.get("login")).and_then(|v| v.as_str()).unwrap_or(""), "ownerAvatar": r.get("owner").and_then(|o| o.get("avatar_url")).and_then(|v| v.as_str()).unwrap_or(""), "createdAt": r.get("created_at").and_then(|v| v.as_str()).unwrap_or("")})).collect())
}

// ── Background video processing ──
pub async fn process_videos_bg(state: Arc<AppState>, videos: &[Value]) {
    let db = &state.db;
    eprintln!("[process_videos_bg] started with {} videos", videos.len());
    let settings_map: HashMap<String, String> = db.get_all_settings()
        .as_object().map(|o| o.iter().map(|(k,v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
    let provider = settings_map.get("ai_provider").cloned().unwrap_or_else(|| "deepseek".into());
    {
        let mut js = state.job_status.lock().unwrap();
        js.total = videos.len(); js.current = 0; js.status = "running".into();
        js.start_time = Some(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        js.cancelled = false;
        js.logs.clear();
        js.current_items.clear();
    }
    // 병렬 처리: 설정(process_concurrency, 기본 1) / 로컬 LLM(lmstudio)은 1 강제
    let is_local = provider == "lmstudio";
    let cfg_conc = settings_map.get("process_concurrency").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
    let concurrency = if is_local { 1 } else { cfg_conc.max(1) };
    let mut set = tokio::task::JoinSet::new();
    let mut it = videos.iter();
    for _ in 0..concurrency {
        if let Some(item) = it.next() {
            let st2 = state.clone();
            let sm2 = settings_map.clone();
            let item2 = item.clone();
            set.spawn(async move { process_one(st2, sm2, item2).await });
        }
    }
    while set.join_next().await.is_some() {
        if let Some(item) = it.next() {
            let st2 = state.clone();
            let sm2 = settings_map.clone();
            let item2 = item.clone();
            set.spawn(async move { process_one(st2, sm2, item2).await });
        }
    }
    let mut js = state.job_status.lock().unwrap();
    let cancelled = js.cancelled;
    let total = js.total;
    let cur = js.current;
    let start = js.start_time.clone();
    let err_logs: Vec<String> = js.logs.iter()
        .filter(|l| l.contains("⚠️") || l.contains("❌") || l.contains("Failed") || l.contains("Skipped"))
        .cloned().collect();
    if js.cancelled { js.status = "cancelled".into(); } else { js.status = "completed".into(); }
    js.start_time = None;
    drop(js);
    let dur = start.as_ref().and_then(|t| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S").ok()
        .map(|s| chrono::Utc::now().naive_utc().signed_duration_since(s).num_seconds())).unwrap_or(0);
    let mut msg = format!("📺 YouTube 요약 {} {}/{} ({})", if cancelled { "■ 중단" } else { "✅ 완료" }, cur, total, fmt_dur(dur));
    if !err_logs.is_empty() {
        msg.push_str(&format!("\n⚠️ 오류 {}건:", err_logs.len()));
        for l in err_logs.iter().take(5) { msg.push_str(&format!("\n• {}", l)); }
    }
    if let Err(e) = send_telegram_notify(db, &msg).await { eprintln!("[tg] {}", e); }
}

// ── GitHub 레포 일괄 요약 (자동 루프 + /api/github/process-batch 공용) ──
pub async fn process_github_repos_bg(state: Arc<AppState>, repos: &[Value]) {
    eprintln!("[process_github_repos_bg] started with {} repos", repos.len());
    {
        let mut js = state.job_status.lock().unwrap();
        js.total = repos.len(); js.current = 0; js.status = "running".into();
        js.start_time = Some(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        js.cancelled = false;
        js.logs.clear();
        js.current_items.clear();
    }
    for repo in repos {
        if state.job_status.lock().unwrap().cancelled { break; }
        if let Err(e) = process_github_repo_core(state.clone(), repo).await {
            let name = repo.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            eprintln!("[github] {} 처리 오류: {}", name, e);
            state.job_status.lock().unwrap().logs.push(format!("⚠️ {}: {}", name, e));
        }
    }
    let mut js = state.job_status.lock().unwrap();
    let cancelled = js.cancelled;
    let total = js.total;
    let cur = js.current;
    let start = js.start_time.clone();
    let err_logs: Vec<String> = js.logs.iter()
        .filter(|l| l.contains("⚠️") || l.contains("❌") || l.contains("Failed") || l.contains("Skipped"))
        .cloned().collect();
    if js.cancelled { js.status = "cancelled".into(); } else { js.status = "completed".into(); }
    js.start_time = None;
    drop(js);
    let dur = start.as_ref().and_then(|t| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S").ok()
        .map(|s| chrono::Utc::now().naive_utc().signed_duration_since(s).num_seconds())).unwrap_or(0);
    let mut msg = format!("🐙 GitHub 요약 {} {}/{} ({})", if cancelled { "■ 중단" } else { "✅ 완료" }, cur, total, fmt_dur(dur));
    if !err_logs.is_empty() {
        msg.push_str(&format!("\n⚠️ 오류 {}건:", err_logs.len()));
        for l in err_logs.iter().take(5) { msg.push_str(&format!("\n• {}", l)); }
    }
    if let Err(e) = send_telegram_notify(&state.db, &msg).await { eprintln!("[tg] {}", e); }
}

async fn process_github_repo_core(state: Arc<AppState>, repo: &Value) -> Result<(), String> {
    if state.job_status.lock().unwrap().cancelled { return Ok(()); }
    let db = &state.db;
    let full_name = repo.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let owner = full_name.split('/').next().unwrap_or("").to_string();
    let title = repo.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let description = repo.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let url = repo.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let owner_avatar = repo.get("ownerAvatar").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created_at = repo.get("createdAt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let language = repo.get("language").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stars = repo.get("stars").map(|v| v.to_string()).unwrap_or_default();
    let forks = repo.get("forks").map(|v| v.to_string()).unwrap_or_default();
    let settings_map: HashMap<String, String> = db.get_all_settings()
        .as_object().map(|o| o.iter().map(|(k,v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default();
    let provider = settings_map.get("ai_provider").cloned().unwrap_or_else(|| "deepseek".into());
    let gh_token = settings_map.get("github_token").cloned().unwrap_or_default();
    let gh_lang = settings_map.get("github_lang").cloned().unwrap_or_else(|| "ko".into());
    let label = if title.is_empty() { full_name.to_string() } else { title.clone() };
    {
        let mut js = state.job_status.lock().unwrap();
        js.logs.push(format!("▶ [{}]", label));
        js.current_items.push(json!({"id": full_name, "title": label}));
    }
    let readme_content = fetch_github_readme(full_name, &gh_token).await.unwrap_or_default();
    let summary = if readme_content.is_empty() {
        json!({"Summary": "README를 찾을 수 없습니다.", "Insights": "", "Implications": "", "Keywords": "", "Analysis": "", "Category": ""})
    } else {
        services::llm::summarize_github(&readme_content, full_name, &description, &provider, &settings_map, &gh_lang)
            .await
            .unwrap_or(json!({"Summary": "요약 실패", "Insights": "", "Implications": "", "Keywords": "", "Analysis": "", "Category": ""}))
    };
    let llm_title = summary.get("Title").or(summary.get("title")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&title);
    db.upsert_github_repo(&json!({
        "id": full_name, "title": llm_title, "channel_name": full_name,
        "owner": owner, "description": description, "language": language,
        "stars": stars, "forks": forks, "avatar": owner_avatar,
        "video_url": url, "publish_date": created_at, "image_url": owner_avatar,
        "processed_at": chrono::Utc::now().format("%Y-%m-%d").to_string(),
        "read": "0", "favorite": "0",
        "summary": summary.get("Summary").or(summary.get("summary")).and_then(|v| v.as_str()).unwrap_or(""),
        "insights": summary.get("Insights").or(summary.get("insights")).and_then(|v| v.as_str()).unwrap_or(""),
        "applications": summary.get("Applications").or(summary.get("applications")).and_then(|v| v.as_str()).unwrap_or(""),
        "implications": summary.get("Implications").or(summary.get("implications")).and_then(|v| v.as_str()).unwrap_or(""),
        "analysis": summary.get("Analysis").or(summary.get("analysis")).and_then(|v| v.as_str()).unwrap_or(""),
        "keywords": summary.get("Keywords").or(summary.get("keywords")).and_then(|v| v.as_str()).unwrap_or(""),
        "category": summary.get("Category").or(summary.get("category")).and_then(|v| v.as_str()).unwrap_or(""),
        "model": summary.get("usedModel").and_then(|v| v.as_str()).unwrap_or(&provider),
        "updated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(), "deleted": "0"
    }))?;
    {
        let mut js = state.job_status.lock().unwrap();
        js.current += 1;
        js.current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(full_name));
    }
    Ok(())
}

// ── 영상 1개 처리 (병렬 태스크) ──
async fn process_one(state: Arc<AppState>, settings_map: HashMap<String, String>, item: Value) {
    let db = &state.db;
    let provider = settings_map.get("ai_provider").cloned().unwrap_or_else(|| "deepseek".into());
    let vid = item.get("video").or(Some(&item));
    let video_id = vid.and_then(|v| {
        v.get("id").and_then(|i| i.as_str().map(|s| s.to_string()))
            .or_else(|| v.get("id").and_then(|i| i.get("videoId")).and_then(|i| i.as_str().map(|s| s.to_string())))
            .or_else(|| v.get("videoId").and_then(|i| i.as_str().map(|s| s.to_string())))
    }).unwrap_or_default();
    let title = vid.and_then(|v| v.get("title").or(v.get("snippet").and_then(|s| s.get("title")))).and_then(|v| v.as_str()).unwrap_or("");
    let channel = item.get("channelName").or(item.get("channel_name")).and_then(|v| v.as_str()).unwrap_or("");
    let thumbnail = vid.and_then(|v| v.get("thumbnail").or(v.get("snippet").and_then(|s| s.get("thumbnails").and_then(|t| t.get("high").and_then(|h| h.get("url")))))).and_then(|v| v.as_str()).unwrap_or("");
    let publish_date = item.get("publishDate").or(vid.and_then(|v| v.get("publishedAt"))).and_then(|v| v.as_str()).unwrap_or("");
    let description = item.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let chapters = extract_chapters(description);
    // 썸네일 폴백: 없으면 유튜브 기본 썸네일 URL (URL 직접 추가 영상 등)
    let thumbnail = if thumbnail.is_empty() && !video_id.is_empty() {
        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id)
    } else { thumbnail.to_string() };
    if video_id.is_empty() {
        state.job_status.lock().unwrap().logs.push("Skipped: empty video ID".into());
        state.job_status.lock().unwrap().current += 1;
        return;
    }
    if state.job_status.lock().unwrap().cancelled { return; }
    // 시작 로그 + 진행 중 목록 등록 (병렬 — 완료 순서와 무관)
    {
        let mut js = state.job_status.lock().unwrap();
        let label = if title.is_empty() { video_id.as_str() } else { title };
        js.logs.push(format!("▶ [{}]", label));
        js.current_items.push(json!({"id": video_id, "title": label, "thumbnail": thumbnail}));
    }
    let summary_lang = settings_map.get("youtube_lang").cloned().unwrap_or_else(|| "auto".into());
    let ytdlp = state.ytdlp.clone();
    let captions = match services::youtube::fetch_captions(&ytdlp, &video_id, &summary_lang).await {
        Ok(c) => c,
        Err(e) => {
            // 429 등 에러 — 해당 영상만 스킵하고 나머지는 계속 진행
            let mut js = state.job_status.lock().unwrap();
            js.current += 1;
            js.current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(video_id.as_str()));
            js.logs.push(format!("⚠️ {} (영상: {}) — 건너뜀", e, video_id));
            eprintln!("[process_one] 스킵: {}", e);
            return;
        }
    };
        {
            let mut js = state.job_status.lock().unwrap();
            let cap_len = captions.as_deref().map(|s| s.trim().len()).unwrap_or(0);
            if cap_len > 0 {
                js.logs.push(format!("  → captions: {} chars", cap_len));
            }
        }
        if state.job_status.lock().unwrap().cancelled {
            state.job_status.lock().unwrap().current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(video_id.as_str()));
            return;
        }
        let summary = match services::llm::summarize(captions.as_deref(), &provider, &settings_map, &title, &channel, &thumbnail, &summary_lang, &chapters, &publish_date).await {
            Ok(s) => s, Err(e) => {
                let mut js = state.job_status.lock().unwrap();
                js.logs.push(format!("Failed: {} - {}", video_id, e));
                js.current += 1;
                js.current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(video_id.as_str()));
                return;
            }
        };
        // Cancel check AFTER the LLM call but BEFORE saving — discard this video if cancelled
        if state.job_status.lock().unwrap().cancelled {
            let mut js = state.job_status.lock().unwrap();
            js.logs.push(format!("  cancelled (discarded: {})", video_id));
            js.current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(video_id.as_str()));
            return;
        }
        let record = json!({"id": video_id, "title": title, "channel_name": channel, "video_url": format!("https://youtube.com/watch?v={}", video_id), "publish_date": publish_date, "processed_at": chrono::Utc::now().format("%Y-%m-%d").to_string(), "read": "0", "favorite": "0", "excluded": "0", "summary": summary.get("Summary").or(summary.get("summary")).and_then(|v| v.as_str()).unwrap_or(""), "insights": summary.get("Insights").or(summary.get("insights")).and_then(|v| v.as_str()).unwrap_or(""), "implications": summary.get("Implications").or(summary.get("implications")).and_then(|v| v.as_str()).unwrap_or(""), "analysis": summary.get("Analysis").or(summary.get("analysis")).and_then(|v| v.as_str()).unwrap_or(""), "keywords": summary.get("Keywords").or(summary.get("keywords")).and_then(|v| v.as_str()).unwrap_or(""), "category": summary.get("Category").or(summary.get("category")).and_then(|v| v.as_str()).unwrap_or(""), "timeline": summary.get("Timeline").or(summary.get("timeline")).and_then(|v| v.as_str()).unwrap_or(""), "model": summary.get("usedModel").and_then(|v| v.as_str()).unwrap_or(""), "image_url": thumbnail, "channel_avatar": "", "updated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(), "deleted": "0"});
        let _ = db.upsert_video(&record);
        {
            let mut js = state.job_status.lock().unwrap();
            js.current += 1;
            js.current_items.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(video_id.as_str()));
            js.logs.push("  ✓ saved".to_string());
        }
    }

// ── Fetch Provider Models ──
async fn fetch_provider_models(provider: &str, api_key: &str, settings: &HashMap<String, String>) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    match provider {
        "deepseek" => {
            // v4 models are Responses-API only; /v1/models may not list them
            return Ok(vec![json!({"id": "deepseek-v4-flash"}), json!({"id": "deepseek-v4-pro"}), json!({"id": "deepseek-chat"}), json!({"id": "deepseek-reasoner"})]);
        }
        "openai" | "openai_flex" => {
            let base = "https://api.openai.com";
            let resp = client.get(format!("{}/v1/models", base))
                .header("Authorization", format!("Bearer {}", api_key))
                .send().await.map_err(|e| format!("{}: {}", provider, e))?;
            let data: Value = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
            Ok(data["data"].as_array().cloned().unwrap_or_default()
                .into_iter().filter(|m| {
                    let id = m["id"].as_str().unwrap_or("");
                    !id.contains("instruct") && !id.contains("realtime") && !id.contains("tts") && !id.contains("whisper") && !id.contains("dall-e") && !id.contains("embedding") && !id.contains("moderation") && !id.contains("ptu")
                }).map(|m| json!({"id": m["id"]})).collect())
        }
        "anthropic" => {
            // Anthropic does have GET /v1/models — fetch the live list;
            // fall back to a curated list only if the request fails.
            let resp = client.get("https://api.anthropic.com/v1/models")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let data: Value = r.json().await.map_err(|e| format!("Anthropic parse: {}", e))?;
                    let ids: Vec<Value> = data["data"].as_array().cloned().unwrap_or_default()
                        .into_iter().filter_map(|m| m["id"].as_str().map(|id| json!({"id": id}))).collect();
                    if ids.is_empty() {
                        Ok(vec![json!({"id": "claude-sonnet-4-20250514"}), json!({"id": "claude-3-5-sonnet-20241022"}), json!({"id": "claude-3-5-haiku-20241022"}), json!({"id": "claude-opus-4-20250514"})])
                    } else {
                        Ok(ids)
                    }
                }
                _ => Ok(vec![
                    json!({"id": "claude-sonnet-4-20250514"}),
                    json!({"id": "claude-3-5-sonnet-20241022"}),
                    json!({"id": "claude-3-5-haiku-20241022"}),
                    json!({"id": "claude-opus-4-20250514"}),
                    json!({"id": "claude-3-opus-20240229"}),
                ]),
            }
        }
        "gemini" => {
            let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", api_key);
            let resp = client.get(&url).send().await.map_err(|e| format!("Gemini: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
            Ok(data["models"].as_array().cloned().unwrap_or_default()
                .into_iter().filter_map(|m| {
                    m["name"].as_str().and_then(|n| n.strip_prefix("models/"))
                        .filter(|id| id.contains("gemini"))
                        .map(|id| json!({"id": id}))
                }).collect())
        }
        "openrouter" | "openrouter_flex" => {
            let mut req = client.get("https://openrouter.ai/api/v1/models");
            if !api_key.is_empty() { req = req.header("Authorization", format!("Bearer {}", api_key)); }
            let resp = req.send().await.map_err(|e| format!("OpenRouter: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
            Ok(data["data"].as_array().cloned().unwrap_or_default()
                .into_iter().map(|m| json!({"id": m["id"]})).collect())
        }
        "glm" | "glm_flex" => {
            let resp = client.get("https://open.bigmodel.cn/api/paas/v4/models")
                .header("Authorization", format!("Bearer {}", api_key))
                .send().await.map_err(|e| format!("GLM: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("GLM parse: {}", e))?;
            let ids: Vec<Value> = data["data"].as_array().cloned().unwrap_or_default()
                .into_iter().filter_map(|m| m["id"].as_str().map(|id| json!({"id": id}))).collect();
            if ids.is_empty() {
                Ok(vec![json!({"id": "glm-4.6"}), json!({"id": "glm-4.5"}), json!({"id": "glm-4-air"}), json!({"id": "glm-4-flash"})])
            } else { Ok(ids) }
        }
        "grok" => {
            let resp = client.get("https://api.x.ai/v1/models")
                .header("Authorization", format!("Bearer {}", api_key))
                .send().await.map_err(|e| format!("Grok: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("Grok parse: {}", e))?;
            let ids: Vec<Value> = data["data"].as_array().cloned().unwrap_or_default()
                .into_iter().filter_map(|m| m["id"].as_str().map(|id| json!({"id": id}))).collect();
            if ids.is_empty() {
                Ok(vec![json!({"id": "grok-3"}), json!({"id": "grok-3-mini"}), json!({"id": "grok-3-fast"}), json!({"id": "grok-3-mini-fast"})])
            } else { Ok(ids) }
        }
        "lmstudio" => {
            let base = settings.get("lmstudio_url").cloned().unwrap_or_else(|| "http://127.0.0.1:1234/v1".into());
            let base = base.trim_end_matches('/');
            let api_base = if base.ends_with("/v1") { base.to_string() } else { format!("{}/v1", base) };
            let resp = client.get(format!("{}/models", api_base))
                .send().await.map_err(|e| format!("LM Studio: {}", e))?;
            let data: Value = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
            Ok(data["data"].as_array().cloned().unwrap_or_default()
                .into_iter().map(|m| json!({"id": m["id"]})).collect())
        }
        _ => Err(format!("Unknown provider: {}", provider))
    }
}

// ── Fetch GitHub README ──
async fn fetch_github_readme(full_name: &str, token: &str) -> Result<String, String> {
    if full_name.is_empty() { return Err("empty name".into()); }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/repos/{}/readme", full_name);
    // Use the GitHub token (if configured) to lift the rate limit from 60 to 5000 req/h
    let mut req = client.get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "SMMYNP/3.0");
    if !token.is_empty() { req = req.header("Authorization", format!("Bearer {}", token)); }
    let resp = req.send().await.map_err(|e| format!("GitHub README: {}", e))?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
    let data: Value = resp.json().await.map_err(|e| format!("Parse: {}", e))?;
    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let encoding = data.get("encoding").and_then(|v| v.as_str()).unwrap_or("");
    if encoding != "base64" || content.is_empty() { return Err("no content".into()); }
    use base64::Engine;
    let cleaned: String = content.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(&cleaned)
        .map_err(|e| format!("base64: {}", e))?;
    let text = String::from_utf8(bytes).map_err(|e| format!("utf8: {}", e))?;
    Ok(text.chars().take(40000).collect())
}

// ── YouTube Shorts duration check ──
#[allow(dead_code)]
async fn fetch_video_duration(video_id: &str) -> Result<i32, String> {
    let url = format!("https://www.youtube.com/watch?v={}", video_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let text = client.get(&url).header("User-Agent", "Mozilla/5.0")
        .send().await.map_err(|e| format!("fetch: {}", e))?
        .text().await.map_err(|e| format!("text: {}", e))?;
    // Search for lengthSeconds in ytInitialPlayerResponse JSON
    if let Some(pos) = text.find(r#""lengthSeconds":""#) {
        let s = pos + 16;
        let secs: String = text[s..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = secs.parse::<i32>() { return Ok(n); }
    }
    // Fallback: search for "lengthSeconds":NNN (number, not string)
    let re = regex::Regex::new(r#""lengthSeconds":(\d+)"#).unwrap();
    if let Some(cap) = re.captures(&text) {
        if let Ok(n) = cap.get(1).unwrap().as_str().parse::<i32>() { return Ok(n); }
    }
    Err("duration not found".into())
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        ' ' => "+".to_string(),
        c => format!("%{:02X}", c as u8),
    }).collect()
}

// ── Native notification (Windows toast + taskbar) ──
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    // winrt-notification: Windows toast를 직접 호출 (UTF-8 한글 정상 처리)
    // — tauri-plugin-notification은 Windows toast XML 인코딩 문제로 한글이 깨짐
    #[cfg(windows)]
    {
        use winrt_notification::{Duration, Sound, Toast};
        let _ = Toast::new(Toast::POWERSHELL_APP_ID)
            .title(&title)
            .text1(&body)
            .sound(Some(Sound::Default))
            .duration(Duration::Short)
            .show();
    }
    // Taskbar flash (Critical = flashes until focused)
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/// Registers the app's AUMID in the registry so Windows toasts show our
/// app name/icon instead of "Windows PowerShell" in dev mode.
/// (HKCU\Software\Classes\AppUserModelId\{AUMID} → DisplayName / IconUri)
#[cfg(windows)]
fn register_aumid() {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCreateKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    const AUMID: &str = "com.smmynp.app";
    let key_path = format!("Software\\Classes\\AppUserModelId\\{}", AUMID);

    unsafe {
        let mut hkey = windows::Win32::System::Registry::HKEY::default();
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(&key_path),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        );
        if status.is_ok() && !hkey.is_invalid() {
            let _ = RegSetValueExW(
                hkey,
                &HSTRING::from("DisplayName"),
                None,
                REG_SZ,
                Some("SUMMARIZER\0".as_bytes()),
            );
            // Icon: use the app exe itself (contains embedded icon) as IconUri
            if let Ok(exe) = std::env::current_exe() {
                let icon = format!("{}\0", exe.display());
                let _ = RegSetValueExW(hkey, &HSTRING::from("IconUri"), None, REG_SZ, Some(icon.as_bytes()));
            }
            
        }
    }
    // Also set the process AUMID explicitly
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let id = HSTRING::from(AUMID);
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) };
}

#[cfg(not(windows))]
fn register_aumid() {}

// ── 종료 시 동기화/저장 (CloseRequested 가로채기) ──
// true면 다음 close는 그대로 허용 (동기화 완료 후)
static ALLOW_CLOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn finish_close(window: tauri::Window) {
    ALLOW_CLOSE.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = window.close();
}

// ── Tauri Entry ──
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            register_aumid();
            let data_dir = app.path().app_data_dir().expect("app data dir");
            let db = Database::new(&data_dir).expect("db init");
            let job_status = JobStatus { total: 0, current: 0, status: "idle".into(), logs: vec![], start_time: None, cancelled: false, current_items: vec![] };
            let ytdlp = services::youtube::yt_dlp_path(app.handle());
            let state = Arc::new(AppState { db, job_status: Mutex::new(job_status), ytdlp });
            httpd::start(state.clone());
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 창 닫기 요청 → 프론트에 동기화/저장 기회 부여 후 실제 종료
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !ALLOW_CLOSE.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("sync-before-close", ());
                } else {
                    ALLOW_CLOSE.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_status, get_version, api_call, read_text_file, save_text_file, get_home_dir, pick_save_path, pick_open_path, open_url, notify, finish_close])
        .build(tauri::generate_context!()).expect("build")
        .run(|_, _| {});
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
}

// ── 설정 백업/복원: Rust에서 직접 파일 대화상자 처리 ──
// (JS invoke 콜백 ID 유실 문제 우회 — dev 리로드에도 안전)
#[tauri::command]
fn pick_save_path(app: tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.recv().map_err(|e| format!("dialog error: {}", e))
}

#[tauri::command]
fn pick_open_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.recv().map_err(|e| format!("dialog error: {}", e))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("open failed: {}", e))
}
// ── Google OAuth 콜백 (GUI httpd 21890 + LAN 서버 공용) ──
// redirect_uri: 콜백을 받은 쪽의 주소 (토큰 교환 시 일치 필요)
pub fn handle_oauth_callback(path: &str, state: &Arc<AppState>, redirect_uri: &str) -> (String, String, String) {
    let query = path.split('?').nth(1).unwrap_or("");
    let code = query.split('&').find_map(|p| p.strip_prefix("code=")).unwrap_or("");

    if code.is_empty() {
        return ("400 Bad Request".to_string(), format!("Missing authorization code. Callback path: {}", path), "text/plain".to_string());
    }

    let db = &state.db;
    let settings = db.get_all_settings();
    let client_id = settings.get("google_client_id")
        .and_then(|v| v.as_str()).unwrap_or("")
        .to_string();

    if client_id.is_empty() {
        return ("400 Bad Request".to_string(), "Client ID not configured. Go to YouTube Settings and enter your Client ID first.".to_string(), "text/html".to_string());
    }

    let code_verifier = settings.get("oauth_code_verifier").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let client_secret = settings.get("google_client_secret").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("code", code),
        ("client_id", &client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    if !client_secret.is_empty() {
        params.push(("client_secret", &client_secret));
    }
    if !code_verifier.is_empty() {
        params.push(("code_verifier", &code_verifier));
    }

    let client = reqwest::blocking::Client::new();
    let token_resp = match client.post("https://oauth2.googleapis.com/token").form(&params).send() {
        Ok(r) => r,
        Err(e) => return ("502 Bad Gateway".to_string(), format!("Token exchange failed: {}", e), "text/plain".to_string()),
    };

    let token_data: serde_json::Value = match token_resp.json() {
        Ok(d) => d,
        Err(e) => return ("502 Bad Gateway".to_string(), format!("Token parse failed: {}", e), "text/plain".to_string()),
    };

    let access_token = token_data.get("access_token").and_then(|v| v.as_str()).unwrap_or("");
    let refresh_token = token_data.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");

    if access_token.is_empty() {
        let err = token_data.get("error_description").and_then(|v| v.as_str()).unwrap_or("unknown error");
        return ("400 Bad Request".to_string(), format!("OAuth error: {}", err), "text/html".to_string());
    }

    let _ = db.set_setting("google_access_token", access_token);
    if !refresh_token.is_empty() {
        let _ = db.set_setting("google_refresh_token", refresh_token);
    }
    // 재인증 성공 — 인증 오류 플래그 해제 (대시보드 경고 소멸)
    let _ = db.set_setting("google_auth_error", "");

    let email = match client.get("https://www.googleapis.com/oauth2/v2/userinfo")
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
    {
        Ok(r) => r.json::<serde_json::Value>().ok()
            .and_then(|d| d.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .unwrap_or_default(),
        Err(_) => String::new(),
    };
    let _ = db.set_setting("google_email", &email);

    let html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OAuth 완료</title>
<style>body{{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f6f8}}
.card{{background:#fff;border:2px solid #121212;padding:32px 40px;text-align:center;box-shadow:4px 4px 0 #121212}}
h2{{margin:0 0 8px;font-size:20px;font-weight:800}}p{{margin:0 0 16px;color:#555;font-size:14px}}
.badge{{display:inline-block;padding:4px 12px;background:#10b981;color:#fff;font-weight:700;font-size:12px}}
</style></head><body><div class="card">
<h2>✅ Google 계정 연동 완료</h2>
<p>{}</p>
<div class="badge">{}</div>
<p style="margin-top:20px;font-size:12px;color:#999">이 창을 닫고 앱으로 돌아가세요.</p>
</div></body></html>"#,
        if email.is_empty() { "인증에 성공했습니다.".to_string() } else { format!("{} 계정이 연결되었습니다.", email) },
        if refresh_token.is_empty() { "오프라인 토큰 없음 (재로그인 필요)" } else { "자동 갱신 가능" }
    );

    ("200 OK".to_string(), html, "text/html".to_string())
}


/// settings 키 마이그레이션 (Vercel → Cloudflare, 1회만 실행)
/// 구 키: vercel_token, vercel_blob_id, vercel_url
/// 신 키: cloudflare_token, cloudflare_r2_bucket, worker_url
///
/// 마이그레이션 완료 플래그: settings_migrated_cf = '1'
/// - 이미 마이그레이션됐으면 즉시 return (매 호출마다 검사 비용 최소)
/// - 신 키가 이미 있으면 구 키는 무시 (사용자가 신 토큰을 직접 넣은 경우 보호)
fn migrate_settings_keys(db: &Database) {
    if let Some(flag) = db.get_setting("settings_migrated_cf") {
        if flag == "1" { return; }
    }
    let mut migrated = false;

    // vercel_token → cloudflare_token (값이 비어있지 않을 때만)
    if let Some(v) = db.get_setting("vercel_token") {
        if !v.is_empty() {
            // 신 키가 비어있을 때만 복사 (덮어쓰기 방지)
            let existing = db.get_setting("cloudflare_token").unwrap_or_default();
            if existing.is_empty() {
                let _ = db.set_setting("cloudflare_token", &v);
            }
            let _ = db.set_setting("vercel_token", "");
            migrated = true;
        }
    }
    // vercel_blob_id → cloudflare_r2_bucket
    if let Some(v) = db.get_setting("vercel_blob_id") {
        if !v.is_empty() {
            let existing = db.get_setting("cloudflare_r2_bucket").unwrap_or_default();
            if existing.is_empty() {
                let _ = db.set_setting("cloudflare_r2_bucket", &v);
            }
            let _ = db.set_setting("vercel_blob_id", "");
            migrated = true;
        }
    }
    // vercel_url → worker_url (가장 중요 — sync가 이 키를 봄)
    if let Some(v) = db.get_setting("vercel_url") {
        if !v.is_empty() {
            let existing = db.get_setting("worker_url").unwrap_or_default();
            if existing.is_empty() {
                let _ = db.set_setting("worker_url", &v);
            }
            let _ = db.set_setting("vercel_url", "");
            // sync_last_at도 초기화 → 다음 sync가 full pull (이전 도메인 잔재 제거)
            let _ = db.set_setting("sync_last_at", "");
            migrated = true;
        }
    }

    if migrated {
        let _ = db.set_setting("settings_migrated_cf", "1");
        eprintln!("[migrate] vercel_* 키 → cloudflare_*/worker_url 마이그레이션 완료");
    }
}
