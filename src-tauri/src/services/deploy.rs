// ═══════════════════════════════════════════════════════════════
// deploy.rs — Cloudflare wrangler 원클릭 배포 (CLI 자동화)
//
// 흐름:
// Vercel → Cloudflare 전환 (SMMYNP V2)
//  1. wrangler CLI 감지 → 없으면 `npm i -g wrangler` 자동 설치
//  2. wrangler whoami (토큰/로그인 확인) → 미인증이면 CLOUDFLARE_API_TOKEN 입력
//  3. R2 bucket 생성 (summarizer-data) — DB 저장소
//  4. workers/ 폴더 deploy (뷰어 + /api/sync Worker, 단일 배포)
//  5. workers.dev URL 추출 → settings.worker_url 저장 → sync 즉시 작동
//
// Vercel과 차이점:
//   - 환경변수 자동 주입 불필요 (wrangler.jsonc의 r2_buckets binding이 자동)
//   - Vercel API 호출(get_project_id, connect_blob_store) 삭제
//   - Account ID 설정/검증 추가 (non-interactive 모드 다계정 충돌 방지)
// ═══════════════════════════════════════════════════════════════

use crate::db::Database;
use serde_json::json;
use std::process::Command;
use tauri::Manager;

/// 일반 명령 실행 (npm 설치 등) — Windows .cmd 지원
fn run_cmd(program: &str, args: &[&str]) -> std::process::Output {
    let res = if cfg!(windows) {
        let mut cmd_args: Vec<String> = vec!["/C".to_string(), program.to_string()];
        cmd_args.extend(args.iter().map(|s| s.to_string()));
        Command::new("cmd").args(&cmd_args).output()
    } else {
        Command::new(program).args(args).output()
    };
    res.unwrap_or_else(|_| failed_output())
}

/// wrangler CLI 실행 — Windows에서 .cmd 파일은 cmd /C로 감싸야 함
fn run_wrangler_in(cli: &str, token: &str, account_id: &str, dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    let mut full: Vec<String> = vec![cli.to_string()];
    for a in args { full.push(a.to_string()); }
    // 토큰이 있으면 CLOUDFLARE_API_TOKEN 환경변수 + --browser=false 플래그 (헤드리스 OK)
    if !token.is_empty() {
        full.push("--browser".to_string());
        full.push("false".to_string());
    }
    let full_args: Vec<&str> = full.iter().map(|s| s.as_str()).collect();
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C");
        for a in &full_args { c.arg(a); }
        c
    } else {
        let mut c = Command::new(cli);
        for a in &full_args { c.arg(a); }
        c
    };
    if !dir.as_os_str().is_empty() { cmd.current_dir(dir); }
    // 환경변수 주입
    if !token.is_empty() {
        cmd.env("CLOUDFLARE_API_TOKEN", token);
    }
    if !account_id.is_empty() {
        cmd.env("CLOUDFLARE_ACCOUNT_ID", account_id);
    }
    cmd.output().unwrap_or_else(|_| failed_output())
}

fn run_wrangler(cli: &str, token: &str, account_id: &str, args: &[&str]) -> std::process::Output {
    run_wrangler_in(cli, token, account_id, std::path::Path::new(""), args)
}

fn combined_output(out: &std::process::Output) -> String {
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    let e = String::from_utf8_lossy(&out.stderr).to_string();
    if !e.trim().is_empty() {
        if !s.is_empty() { s.push('\n'); }
        s.push_str(&e);
    }
    s
}

fn failed_output() -> std::process::Output {
    Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) { &["/C", "exit 1"] } else { &["-c", "exit 1"] })
        .output()
        .unwrap_or_else(|_| std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: Vec::new(),
            stderr: b"spawn failed".to_vec(),
        })
}

/// wrangler CLI 경로 탐색: PATH에서 찾고, 없으면 npm 전역 설치
pub async fn ensure_cli() -> Result<String, String> {
    let candidates: [&str; 3] = if cfg!(windows) {
        ["wrangler.cmd", "wrangler.exe", "wrangler"]
    } else {
        ["wrangler", "wrangler", "wrangler"]
    };
    for name in candidates {
        let out = run_cmd(name, &["--version"]);
        if out.status.success() { return Ok(name.to_string()); }
    }
    eprintln!("[deploy] wrangler CLI not found — installing via npm...");
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let out = run_cmd(&npm, &["i", "-g", "wrangler"]);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("wrangler CLI 자동 설치 실패: {}", err.chars().take(200).collect::<String>()));
    }
    for name in candidates {
        let out = run_cmd(name, &["--version"]);
        if out.status.success() { return Ok(name.to_string()); }
    }
    Err("wrangler CLI 설치 후에도 찾을 수 없습니다. 터미널에서 'npm i -g wrangler' 실행 후 다시 시도하세요.".into())
}

/// 로그인 상태 확인 + 토큰 확보
/// 우선순위: ① DB에 저장된 cloudflare_token, ② wrangler whoami (브라우저 OAuth), ③ 실패
pub async fn ensure_login(cli: &str, db: &Database) -> Result<(String, String), String> {
    // ① DB에 저장된 토큰 확인
    let mut token = db.get_setting("cloudflare_token").unwrap_or_default();
    let mut account_id = db.get_setting("cloudflare_account_id").unwrap_or_default();
    if !token.is_empty() {
        let out = run_wrangler(cli, &token, &account_id, &["whoami"]);
        if out.status.success() {
            // Account ID가 비어있으면 whoami 출력에서 추출
            if account_id.is_empty() {
                if let Some(id) = extract_account_id(&combined_output(&out)) {
                    let _ = db.set_setting("cloudflare_account_id", &id);
                    account_id = id;
                }
            }
            return Ok((token, account_id));
        }
        // 토큰 만료/잘못 → 폐기
        let _ = db.set_setting("cloudflare_token", "");
        token = String::new();
    }
    // ② wrangler whoami 시도 (브라우저 OAuth 또는 .config/default.toml 사용)
    let out = run_wrangler(cli, "", "", &["whoami"]);
    if out.status.success() {
        let text = combined_output(&out);
        // OAuth 토큰은 ~/.config/.wrangler/config/default.toml 또는 %LOCALAPPDATA% 위치
        if let Some(t) = read_wrangler_token() {
            let _ = db.set_setting("cloudflare_token", &t);
            token = t;
        }
        if account_id.is_empty() {
            if let Some(id) = extract_account_id(&text) {
                let _ = db.set_setting("cloudflare_account_id", &id);
                account_id = id;
            }
        }
        if !token.is_empty() {
            return Ok((token, account_id));
        }
    }
    Err("CLOUDFLARE_TOKEN_REQUIRED".into())
}

/// wrangler OAuth 토큰 파일 읽기
fn read_wrangler_token() -> Option<String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let candidates = [
        std::path::Path::new(&home).join("AppData").join("Roaming").join("com.cloudflare.wrangler").join("config").join("default.toml"),
        std::path::Path::new(&home).join(".config").join(".wrangler").join("config").join("default.toml"),
        std::path::Path::new(&home).join(".local").join("share").join("com.cloudflare.wrangler").join("config").join("default.toml"),
    ];
    for p in candidates {
        if let Ok(s) = std::fs::read_to_string(&p) {
            // TOML 파싱 (간이: "oauth_token = " 패턴)
            for line in s.lines() {
                let t = line.trim();
                if t.starts_with("oauth_token") {
                    if let Some(v) = t.split('=').nth(1) {
                        let v = v.trim().trim_matches(|c: char| c == '"' || c == '\'');
                        if !v.is_empty() { return Some(v.to_string()); }
                    }
                }
            }
        }
    }
    None
}

/// wrangler whoami 출력에서 Account ID (32자리 hex) 추출
fn extract_account_id(text: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("account id") {
            // "Account ID: a1b2c3..." 패턴
            for w in line.split_whitespace() {
                let clean: String = w.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                if clean.len() == 32 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(clean);
                }
            }
        }
    }
    None
}

/// R2 버킷 생성 (또는 기존 것 재사용)
pub async fn ensure_r2_bucket(cli: &str, token: &str, account_id: &str, db: &Database) -> Result<String, String> {
    let bucket_name = "summarizer-data";
    // DB에 저장된 게 있으면 그것 사용
    if let Some(s) = db.get_setting("cloudflare_r2_bucket") {
        if !s.is_empty() { return Ok(s); }
    }
    // 기존 버킷 목록 확인
    let out = run_wrangler(cli, token, account_id, &["r2", "bucket", "list"]);
    if out.status.success() {
        let text = combined_output(&out);
        if text.contains(bucket_name) {
            let _ = db.set_setting("cloudflare_r2_bucket", bucket_name);
            return Ok(bucket_name.to_string());
        }
    }
    // 새 버킷 생성
    eprintln!("[deploy] creating R2 bucket {}", bucket_name);
    let out = run_wrangler(cli, token, account_id, &["r2", "bucket", "create", bucket_name]);
    if out.status.success() {
        let _ = db.set_setting("cloudflare_r2_bucket", bucket_name);
        return Ok(bucket_name.to_string());
    }
    let err = combined_output(&out);
    Err(format!("R2 bucket 생성 실패: {}", err.chars().take(250).collect::<String>()))
}

/// workers/ 폴더 배포
pub async fn deploy_site(cli: &str, token: &str, account_id: &str, app: &tauri::AppHandle) -> Result<String, String> {
    let mut dir = app.path().resource_dir().unwrap_or_default().join("workers");
    if !dir.exists() {
        dir = std::env::current_dir().unwrap_or_default().join("workers");
    }
    if !dir.exists() {
        if let Ok(parent) = std::env::current_dir() {
            dir = parent.parent().unwrap_or(&parent).join("workers");
        }
    }
    if !dir.exists() {
        return Err("workers 폴더를 찾을 수 없습니다".into());
    }
    eprintln!("[deploy] deploying {}", dir.display());
    let out = run_wrangler_in(cli, token, account_id, &dir, &["deploy"]);
    let text = combined_output(&out);
    if !out.status.success() {
        // 그래도 URL이 출력되면 성공으로 간주 (일부 경고는 exit code에 영향 안 줌)
        if let Some(url) = extract_worker_url(&text) {
            return Ok(url);
        }
        return Err(format!("배포 실패: {}", text.chars().take(300).collect::<String>()));
    }
    extract_worker_url(&text)
        .ok_or_else(|| format!("배포 URL을 찾을 수 없습니다:\n{}", text.chars().take(300).collect::<String>()))
}

/// wrangler deploy 출력에서 workers.dev URL 추출
/// 예: "Published smmynp-sync (1.23 sec)\n  https://smmynp-sync.<sub>.workers.dev"
fn extract_worker_url(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("https://") && t.contains(".workers.dev") {
            // 끝의 점/괄호 제거
            let url = t.split_whitespace().find(|w| w.starts_with("https://"))?;
            let cleaned = url.trim_end_matches(|c: char| c == '.' || c == ',' || c == ')' || c == ']');
            return Some(cleaned.to_string());
        }
    }
    None
}

/// 원클릭 배포 전체 흐름
pub async fn deploy_all(db: &Database, app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cli = ensure_cli().await?;
    let (token, account_id) = match ensure_login(&cli, db).await {
        Ok(t) => t,
        Err(_) => return Ok(json!({
            "success": false,
            "needToken": true,
            "tokenUrl": "https://dash.cloudflare.com/profile/api-tokens"
        })),
    };
    // ① R2 버킷 확보
    let bucket = ensure_r2_bucket(&cli, &token, &account_id, db).await?;
    // ② 사이트 배포 (wrangler.jsonc가 R2 binding + Assets 자동 처리)
    let url = deploy_site(&cli, &token, &account_id, app).await?;

    // settings 저장 — 구 vercel_* 키 호환성도 함께 정리 (한 번만 실행하면 됨)
    let _ = db.set_setting("worker_url", &url);
    let _ = db.set_setting("sync_url", &url);
    let _ = db.set_setting("cloudflare_r2_bucket", &bucket);
    // 구 키 정리 (값만 비움 — 키 자체는 마이그레이션 완료 후 일괄 삭제 검토)

    Ok(json!({
        "success": true,
        "url": url,
        "viewerUrl": url,
        "apiUrl": format!("{}/api/sync", url),
        "bucket": bucket
    }))
}