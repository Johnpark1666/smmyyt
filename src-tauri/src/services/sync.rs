// ═══════════════════════════════════════════════════════════════
// sync.rs — Cloudflare Worker 웹 동기화 (pull / push / 병합)
//
// 설계:
//  - DB는 Cloudflare R2 (JSON 파일) — Cloudflare Worker /api/sync가 CRUD 담당
//  - 상태 필드(read/favorite/deleted/saved): 양방향, 필드별 시각(ts) 비교 → "마지막 행동 승리"
//  - 요약 필드(summary 등): 앱이 유일한 생성자 → 앱 → 웹 단방향 (앱 값 우선, pull 제외)
//  - deleted: 소프트 플래그 — 웹에서 삭제해도 push 시 되살아나지 않음 (deleted_ts 비교)
//  - 시계 불일치 완화: 15분 이내 차이는 웹 우선 (브라우저 시계가 대체로 정확)
// ═══════════════════════════════════════════════════════════════

use crate::db::Database;
use serde_json::{json, Value};

/// 상태 필드 → 해당 필드의 시각(ts) 컬럼 매핑
const STATUS_TS: [(&str, &str); 4] = [
    ("read", "read_ts"),
    ("favorite", "favorite_ts"),
    ("deleted", "deleted_ts"),
    ("saved", "saved_ts"),
];

/// 시계 불일치 허용 오프셋 (15분)
const CLOCK_SKEW: i64 = 900;

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// 설정에서 worker URL 읽기 (배포 시 저장된 뷰어/API 주소)
fn get_sync_url(db: &Database) -> String {
    db.get_setting("worker_url").unwrap_or_default()
}

/// Cloudflare Worker 호출 헬퍼
async fn vercel_request(
    client: &reqwest::Client,
    base_url: &str,
    method: reqwest::Method,
    table: &str,
    id: Option<&str>,
    since: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut path = format!("{}/api/sync?table={}", base_url.trim_end_matches('/'), table);
    if let Some(i) = id { path.push_str(&format!("&id={}", i)); }
    if let Some(s) = since { path.push_str(&format!("&since={}", s)); }
    let mut req = client.request(method, &path);
    if let Some(b) = body { req = req.json(&b); }
    let resp = req.send().await.map_err(|e| format!("vercel req: {}", e))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status >= 200 && status < 300 {
        if text.trim().is_empty() { Ok(json!({})) } else {
            serde_json::from_str(&text).map_err(|e| format!("vercel parse: {}", e))
        }
    } else {
        Err(format!("vercel HTTP {}: {}", status, text.chars().take(150).collect::<String>()))
    }
}

/// 필드별 병합: 각 상태 필드의 ts를 비교해 "마지막 행동"이 승리
/// (레코드 단위가 아니라 필드 단위 — 한 필드 변경이 다른 필드를 되돌리지 않음)
fn merge_web_into_local(
    local: &mut Value,
    web: &Value,
    _local_updated: &str,
    _web_updated: &str,
) -> bool {
    let mut changed = false;
    if let Some(obj) = local.as_object_mut() {
        for (field, ts_col) in STATUS_TS {
            let local_ts = obj.get(ts_col).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let web_ts = web.get(ts_col).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let web_val = web.get(field).and_then(|v| v.as_str()).unwrap_or("");
            let local_val = obj.get(field).and_then(|v| v.as_str()).unwrap_or("");
            // 웹 ts가 로컬 ts보다 최신이면 웹 값 승리 (시계 오프셋 완화 포함)
            let web_newer = is_newer(&web_ts, &local_ts);
            if web_newer && web_val != local_val {
                obj.insert(field.to_string(), json!(web_val));
                obj.insert(ts_col.to_string(), json!(web_ts));
                changed = true;
            }
        }
        if changed { obj.insert("updated_at".into(), json!(iso_now())); }
    }
    changed
}

/// ts 비교 — 웹 ts가 로컬 ts보다 "실질적으로 최신"인지
/// (15분 이내 차이는 웹 우선: 브라우저 시계가 대체로 정확)
fn is_newer(web_ts: &str, local_ts: &str) -> bool {
    if web_ts.is_empty() { return false; }
    if local_ts.is_empty() { return true; }
    parse_ts(web_ts) > parse_ts(local_ts) - CLOCK_SKEW
}

/// ISO 8601 → epoch 초 (파싱 실패 시 0)
fn parse_ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

/// PULL: 웹에서 since 이후 변경된 레코드 조회 → 로컬 상태 병합
async fn pull(
    client: &reqwest::Client,
    db: &Database,
    base_url: &str,
    last_sync_at: &str,
) -> Result<usize, String> {
    let mut merged = 0;
    for table in ["videos", "github_repos"] {
        let since = if last_sync_at.is_empty() { None } else { Some(last_sync_at) };
        let data = vercel_request(client, base_url, reqwest::Method::GET, table, None, since, None).await?;
        let rows = data.as_array().cloned().unwrap_or_default();
        for row in rows {
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let web_updated = row.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if web_updated.is_empty() { continue; }

            let local = db.get_sync_record(table, &id);
            let mut local_val = local.clone().unwrap_or_else(|| json!({"id": id}));
            // 재연결(full pull — last_sync_at 없음) 시:
            // 로컬에 없는 웹 레코드는 요약/메타 포함 전체 복원 (웹 양식 재활용)
            if local.is_none() && last_sync_at.is_empty() {
                local_val = row.clone();
                local_val["id"] = json!(id);
                // 복원 레코드는 merge 판정("변경 없음")과 무관하게 즉시 저장
                // — merge_web_into_local은 상태 필드 ts만 비교하므로
                //   ts가 동일한 복원본은 "변경 없음"으로 스킵되는 버그 방지
                let _ = db.upsert_sync_record(table, &local_val);
                merged += 1;
                continue;
            }
            let local_updated = local_val.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string();

            if merge_web_into_local(&mut local_val, &row, &local_updated, &web_updated) {
                let _ = db.upsert_sync_record(table, &local_val);
                merged += 1;
            }
        }
    }
    Ok(merged)
}

/// PUSH: 로컬 전체 레코드를 웹으로 벌크 upsert (1회 POST — 속도 최적화)
async fn push(
    client: &reqwest::Client,
    db: &Database,
    base_url: &str,
    _last_sync_at: &str,
) -> Result<usize, String> {
    let mut pushed = 0;
    // 로컬 DB가 기준 — 동기화 시 전체 레코드를 웹에 upsert
    // (벌크: 레코드 배열을 한 번에 전송 — N회 왕복 → 1회)
    for table in ["videos", "github_repos"] {
        let rows = db.get_sync_records_since(table, "");
        let mut batch: Vec<Value> = Vec::new();
        for mut row in rows {
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() { continue; }
            if row.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                row["updated_at"] = json!(iso_now());
            }
            batch.push(row);
        }
        if batch.is_empty() { continue; }
        let n = batch.len();
        vercel_request(client, base_url, reqwest::Method::POST, table, None, None, Some(Value::Array(batch))).await?;
        pushed += n;
    }
    Ok(pushed)
}

/// 전체 동기화 실행
pub async fn sync_all(db: &Database) -> Result<(usize, usize), String> {
    sync_all_with_settings(db, true).await
}

/// 경량 pull — 웹에서 변경분만 당겨와 로컬에 병합 (push/설정 동기화 없음)
/// 웹 뷰어(폰/PC)에서 누른 읽음·별표·삭제를 짧은 주기로 반영하기 위한 전용 루프용.
/// since 이후 updated_at이 갱신된 레코드만 전송되므로 통신량·Blob 작업 수가 최소화된다.
pub async fn pull_only(db: &Database) -> Result<usize, String> {
    let base_url = get_sync_url(db);
    if base_url.is_empty() {
        return Err("웹 동기화가 설정되지 않았습니다 (worker_url 미설정)".into());
    }
    let client = reqwest::Client::new();
    let last_sync_at = db.get_setting("sync_last_at").unwrap_or_default();
    pull(&client, db, &base_url, &last_sync_at).await
}

/// 웹 동기화 상태 probe — 연결/정지(suspended) 등 감지용
/// 읽기 1회만 수행하므로 주기 감시에 안전.
/// 주의: Blob 정지 중에도 Vercel Function이 200 + 빈 응답을 줄 수 있어
/// "settings 객체에 키가 있어야 정상"으로 판정한다.
pub async fn web_probe(db: &Database) -> Value {
    let base_url = get_sync_url(db);
    if base_url.is_empty() {
        return json!({"web_ok": false, "web_error": "not_configured"});
    }
    let client = reqwest::Client::new();
    match vercel_request(&client, &base_url, reqwest::Method::GET, "settings", None, None, None).await {
        Ok(v) => {
            let keys = v.as_object().map(|o| o.len()).unwrap_or(0);
            if keys >= 5 {
                json!({"web_ok": true, "web_keys": keys})
            } else {
                // 200이지만 빈 객체/배열 — Blob 정지(suspended) 의심
                json!({"web_ok": false, "web_keys": keys,
                       "web_error": format!("웹 DB 응답 비정상 (키 {}개) — Blob 정지 의심", keys)})
            }
        }
        Err(e) => json!({"web_ok": false, "web_error": e}),
    }
}

/// push_settings 여부 지정 — Windows GUI는 pull만(서버 설정 표시),
/// 서버(미니 PC)는 push 포함(설정 원천), Windows에서 수정 시에만 push
pub async fn sync_all_with_settings(db: &Database, push_st: bool) -> Result<(usize, usize), String> {
    let base_url = get_sync_url(db);
    if base_url.is_empty() {
        return Err("웹 동기화가 설정되지 않았습니다 (환경설정 → 웹 동기화)".into());
    }
    let client = reqwest::Client::new();
    let last_sync_at = db.get_setting("sync_last_at").unwrap_or_default();

    // 7일 경과 deleted 레코드 물리 삭제 (로컬) — 웹은 sync.js에서 자동 purge
    let purged = db.purge_deleted("videos", 7) + db.purge_deleted("github_repos", 7);
    if purged > 0 { eprintln!("[sync] purged {}개 (7일 경과 삭제 레코드)", purged); }

    // 읽음 자동 정리 (설정에서 활성화 시): 읽었고(read=1) 별표 안 한(favorite=0) 레코드 중
    // read_ts가 기준일 이상 지난 것 물리 삭제. 삭제된 ID를 모아 push 후 웹에도 명시적으로 삭제.
    let mut purged_read_ids: Vec<String> = Vec::new();
    if db.get_setting("auto_purge_read").unwrap_or_default() == "1" {
        let days: i64 = db.get_setting("auto_purge_read_days").unwrap_or_default().parse().unwrap_or(7);
        for t in ["videos", "github_repos"] {
            purged_read_ids.extend(db.purge_read_unfavorite(t, days));
        }
        if !purged_read_ids.is_empty() {
            eprintln!("[sync] 읽음 자동 정리 {}개 ({}일 경과, 별표 미표시)", purged_read_ids.len(), days);
        }
    }

    let pulled = pull(&client, db, &base_url, &last_sync_at).await?;
    let pushed = push(&client, db, &base_url, &last_sync_at).await?;

    // 읽음 자동 정리로 삭제된 레코드를 웹 DB에서도 명시적으로 제거 (전체 sweep 아님 — 정확한 ID만)
    if !purged_read_ids.is_empty() {
        for t in ["videos", "github_repos"] {
            let ids: Vec<&str> = purged_read_ids.iter().map(|s| s.as_str()).collect();
            let _ = vercel_request(&client, &base_url, reqwest::Method::POST, t, None, None,
                Some(json!({ "__delete": ids }))).await;
        }
    }

    // settings (비민감) 동기화 — 서버가 원천(push), Windows는 표시(pull)
    if push_st {
        push_settings(&client, db, &base_url).await?;
    }
    pull_settings(&client, db, &base_url).await?;

    let _ = db.set_setting("sync_last_at", &iso_now());
    Ok((pulled, pushed))
}


/// 웹에 비민감 설정 업로드 (자동 요약 주기/채널 등이 미니 PC 서버에 전파되도록)
async fn push_settings(client: &reqwest::Client, db: &Database, base_url: &str) -> Result<(), String> {
    let all = db.get_all_settings();
    let sensitive = [
        "openai_key", "openai_flex_key", "anthropic_key", "deepseek_key", "gemini_key", "openrouter_key",
        "ocr_key", "cloudflare_token", "google_client_id",
        "google_client_secret", "google_access_token", "google_refresh_token",
        "oauth_code_verifier", "glm_key", "glm_flex_key", "grok_key", "telegram_bot_token",
    ];
    let mut m = serde_json::Map::new();
    if let Some(obj) = all.as_object() {
        for (k, v) in obj {
            if k != "sync_last_at" && !sensitive.contains(&k.as_str()) {
                m.insert(k.clone(), v.clone());
            }
        }
    }
    vercel_request(client, base_url, reqwest::Method::POST, "settings", None, None, Some(json!(m))).await?;
    Ok(())
}

/// 웹 설정을 로컬에 반영 (비민감 — 서버에서 온 자동 요약 설정 등)
async fn pull_settings(client: &reqwest::Client, db: &Database, base_url: &str) -> Result<(), String> {
    let data = vercel_request(client, base_url, reqwest::Method::GET, "settings", None, None, None).await?;
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                let _ = db.set_setting(k, s);
            }
        }
    }
    Ok(())
}
