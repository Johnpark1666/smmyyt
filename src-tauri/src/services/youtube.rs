use serde_json::Value;
use tauri::Manager;

/// YouTube 자막 가져오기 (timedtext API + yt-dlp fallback)
/// lang: 요약 언어 설정 (youtube_lang) — 자막 트랙 우선순위에 반영
pub async fn fetch_captions(ytdlp: &str, video_id: &str, lang: &str) -> Result<Option<String>, String> {
    // timedtext 스크래핑은 YouTube 측 변경으로 빈 응답 (2026-08 실측:
    // captionTracks 정상 + baseUrl 200이지만 0바이트)
    // → yt-dlp 1차로 직접 (fetch_captions_page는 복구 대비 보존)
    // — 429(속도 제한)는 Err로 전파해 해당 영상 스킵 트리거
    match fetch_captions_ytdlp(ytdlp, video_id, lang).await {
        Ok(Some(text)) => Ok(Some(text)),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    }
}

#[allow(dead_code)] // YouTube timedtext 복구 대비 보존 (2026-08 현재 빈 응답)
async fn fetch_captions_page(video_id: &str, lang: &str) -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://www.youtube.com/watch?v={}", video_id);
    let resp = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send().await.map_err(|e| format!("fetch page: {}", e))?;
    let html = resp.text().await.map_err(|e| format!("read page: {}", e))?;

    // ytInitialPlayerResponse 추출 (depth 기반 brace matching)
    let marker = "var ytInitialPlayerResponse = ";
    let player_json = html.find(marker)
        .and_then(|i| {
            let rest = &html[i + marker.len()..];
            let json_start = rest.find('{')?;
            let mut depth = 0u32;
            for (j, c) in rest[json_start..].char_indices() {
                if c == '{' { depth += 1; }
                else if c == '}' { depth -= 1; if depth == 0 { return Some(&rest[..json_start + j + 1]); } }
            }
            None
        })
        .unwrap_or("");

    if player_json.is_empty() { return Ok(None); }
    let player: Value = serde_json::from_str(player_json).map_err(|e| format!("parse player: {}", e))?;
    let tracks = player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"].as_array();
    let tracks = match tracks { Some(t) => t, None => return Ok(None) };

    // 우선순위: 요약 언어 설정 반영
    //   lang=en → 영어 > 한국어 > 첫 번째 (번역 왜곡 방지)
    //   그 외(ko/auto) → 한국어 > 영어 > 첫 번째
    let prefer_en = lang == "en";
    let mut selected = None;
    let mut ko_track = None;
    let mut en_track = None;
    for t in tracks {
        let code = t["languageCode"].as_str().unwrap_or("");
        let base = t["baseUrl"].as_str().unwrap_or("");
        if prefer_en && code == "en" { selected = Some(base.to_string()); break; }
        if !prefer_en && code == "ko" { selected = Some(base.to_string()); break; }
        if code == "ko" && ko_track.is_none() { ko_track = Some(base.to_string()); }
        if code == "en" && en_track.is_none() { en_track = Some(base.to_string()); }
    }
    if selected.is_none() { selected = if prefer_en { en_track.or(ko_track) } else { ko_track.or(en_track) }; }
    if selected.is_none() { selected = tracks[0]["baseUrl"].as_str().map(|s| s.to_string()); }
    let base_url = match selected { Some(u) => u, None => return Ok(None) };

    let xml_resp = client.get(&base_url).send().await.map_err(|e| format!("fetch xml: {}", e))?;
    let xml = xml_resp.text().await.map_err(|e| format!("read xml: {}", e))?;
    let text = parse_transcript_xml(&xml);
    if text.trim().is_empty() { return Ok(None); }
    Ok(Some(text))
}

fn parse_transcript_xml(xml: &str) -> String {
    let mut result = String::new();
    let mut last_secs = -1;
    for line in xml.lines() {
        let line = line.trim();
        if !line.starts_with("<text ") { continue; }
        let start = extract_attr(line, "start").parse::<f64>().unwrap_or(0.0) as i32;
        let text = extract_inner(line);
        if text.is_empty() { continue; }
        let decoded = text.replace("&amp;", "&").replace("&lt;","<").replace("&gt;",">")
            .replace("&quot;","\"").replace("&#39;","'");
        if last_secs == -1 || (start - last_secs) >= 45 {
            let mins = start / 60;
            let secs = start % 60;
            result.push_str(&format!("\n[{:02}:{:02}] ", mins, secs));
            last_secs = start;
        }
        result.push_str(&decoded);
        result.push(' ');
    }
    result.trim().to_string()
}

fn extract_attr(xml: &str, attr: &str) -> String {
    let pat = format!("{}=\"", attr);
    xml.find(&pat).and_then(|i| {
        let rest = &xml[i + pat.len()..];
        rest.find('"').map(|j| rest[..j].to_string())
    }).unwrap_or_default()
}

fn extract_inner(xml: &str) -> String {
    xml.find('>').and_then(|i| {
        let rest = &xml[i+1..];
        rest.find("</text>").map(|j| rest[..j].to_string())
    }).unwrap_or_default()
}

// ── yt-dlp fallback ──

pub(crate) fn yt_dlp_path(app: &tauri::AppHandle) -> String {
    // 0) 설치판: resource_dir() 정확한 경로 (yt-dlp.exe가 binaries/에 번들됨)
    let res = app.path().resource_dir().unwrap_or_default();
    for sub in ["binaries", "_up_/binaries"] {
        let r = res.join(sub).join("yt-dlp.exe");
        if r.exists() { return r.to_string_lossy().to_string(); }
    }
    // Check relative to CWD (dev mode: project root)
    let dev_path = std::path::Path::new("src-tauri").join("binaries").join("yt-dlp.exe");
    if dev_path.exists() { return dev_path.to_string_lossy().to_string(); }
    // Check relative to executable (bundled mode)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("binaries").join("yt-dlp.exe");
            if bundled.exists() { return bundled.to_string_lossy().to_string(); }
            let bundled2 = dir.join("_root_").join("binaries").join("yt-dlp.exe");
            if bundled2.exists() { return bundled2.to_string_lossy().to_string(); }
            // Tauri 리소스가 exe 옆에 풀리는 경우 (_up_ 스테이징 포함)
            let bundled3 = dir.join("_up_").join("binaries").join("yt-dlp.exe");
            if bundled3.exists() { return bundled3.to_string_lossy().to_string(); }
        }
    }
    // Tauri v2 NSIS 리소스 디렉토리: %LOCALAPPDATA%/<identifier>/ (직접 + _up_)
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for sub in ["", "_up_"] {
            let r = std::path::Path::new(&local).join("com.smmynp.app").join(sub).join("binaries").join("yt-dlp.exe");
            if r.exists() { return r.to_string_lossy().to_string(); }
        }
    }
    // 설치 디렉토리 (currentUser: %LOCALAPPDATA%/SUMMARIZER/)
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for sub in ["", "_up_"] {
            let r = std::path::Path::new(&local).join("SUMMARIZER").join(sub).join("binaries").join("yt-dlp.exe");
            if r.exists() { return r.to_string_lossy().to_string(); }
        }
    }
    "yt-dlp".to_string()
}

/// Windows에서 서브프로세스 콘솔 창 안 뜨게 (CREATE_NO_WINDOW)
fn no_console(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);  // CREATE_NO_WINDOW
    }
    cmd
}

/// 공통 인자 — SMMY 실측 대조 결과:
/// android 클라이언트 강제(player_client=android)가 오히려
/// YouTube 429를 유발 (같은 IP·시간에 web 클라이언트는 정상)
/// → 기본(web) 클라이언트 사용 (SMMY 방식)
fn ytdlp_common_args(_cmd: &mut tokio::process::Command) {
    // 비워둠 — 기본 클라이언트가 가장 안정적
}

/// yt-dlp로 영상 설명 조회 (URL 직접 추가 영상의 챕터 추출용)
/// — stdout은 Windows에서 CP949로 나와 깨지므로(실측: ba d2 = CP949)
///   --print-to-file로 UTF-8 파일 저장 후 읽기
pub(crate) async fn fetch_video_description(ytdlp: &str, video_id: &str) -> String {
    let path = ytdlp;
    if path == "yt-dlp" && !std::path::Path::new("yt-dlp.exe").exists() {
        return String::new();
    }
    let tmpfile = std::env::temp_dir().join(format!("smmyp_desc_{}.txt", video_id));
    let _ = std::fs::remove_file(&tmpfile);
    let mut cmd = tokio::process::Command::new(&path);
    no_console(&mut cmd);
    ytdlp_common_args(&mut cmd);
    let out = cmd
        .args(["--skip-download", "--no-warnings", "--ignore-no-formats-error",
               "--print-to-file", "%(description)s", &tmpfile.to_string_lossy(),
               &format!("https://www.youtube.com/watch?v={}", video_id)])
        .output().await;
    if out.map(|o| o.status.success()).unwrap_or(false) {
        let desc = std::fs::read_to_string(&tmpfile).unwrap_or_default();
        let _ = std::fs::remove_file(&tmpfile);
        desc.trim().to_string()
    } else {
        let _ = std::fs::remove_file(&tmpfile);
        String::new()
    }
}

/// yt-dlp로 영상 발행일 조회 (URL 직접 추가 영상용 — YYYYMMDD → YYYY-MM-DD)
/// stdout이지만 숫자라 CP949 문제 없음
pub(crate) async fn fetch_video_upload_date(ytdlp: &str, video_id: &str) -> String {
    let path = ytdlp;
    if path == "yt-dlp" && !std::path::Path::new("yt-dlp.exe").exists() {
        return String::new();
    }
    let mut cmd = tokio::process::Command::new(&path);
    no_console(&mut cmd);
    ytdlp_common_args(&mut cmd);
    let out = match cmd
        .args(["--skip-download", "--no-warnings", "--ignore-no-formats-error",
               "--print", "%(upload_date)s",
               &format!("https://www.youtube.com/watch?v={}", video_id)])
        .output().await
    {
        Ok(o) if o.status.success() => o,
        _ => return String::new(),
    };
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // YYYYMMDD → YYYY-MM-DD
    if s.len() == 8 && s.chars().all(|ch| ch.is_ascii_digit()) {
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else {
        String::new()
    }
}

/// yt-dlp로 영상 실제 길이 조회 (Google 계정 불필요 — 공개 메타데이터)
/// 성공: Ok(길이초) / 실패: Err(사유) — 프론트 진단용
pub(crate) async fn yt_duration(ytdlp: &str, video_id: &str) -> Result<i32, String> {
    let path = ytdlp;
    if path == "yt-dlp" && !std::path::Path::new("yt-dlp.exe").exists() {
        return Err("바이너리 없음".into());
    }
    // 429(봇/속도 차단) — 백오프 재시도 (2초 → 6초, 최대 2회)
    let mut res = yt_duration_once(&path, video_id).await;
    for (i, delay) in [2u64, 6].iter().enumerate() {
        match &res {
            Err(e) if e.contains("429") || e.contains("bot") => {
                eprintln!("[yt-dlp] {} — 429 → {}초 후 재시도 ({}/2)", video_id, delay, i + 1);
                tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;
                res = yt_duration_once(&path, video_id).await;
            }
            _ => break,
        }
    }
    res
}

/// yt-dlp 길이 1회 조회 (android 클라이언트)
async fn yt_duration_once(path: &str, video_id: &str) -> Result<i32, String> {
    let mut cmd = tokio::process::Command::new(path);
    no_console(&mut cmd);
    ytdlp_common_args(&mut cmd);
    let out = match cmd
        .args(["--skip-download", "--no-warnings", "--ignore-no-formats-error",
               "--print", "%(duration)s",
               &format!("https://www.youtube.com/watch?v={}", video_id)])
        .output().await
    {
        Ok(o) => o,
        Err(e) => { eprintln!("[yt-dlp] {} — 실행 에러: {}", video_id, e); return Err(format!("실행 에러: {}", e)); }
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).chars().take(160).collect::<String>();
        eprintln!("[yt-dlp] {} — exit {:?} stderr: {}", video_id, out.status.code(), err);
        return Err(format!("exit {:?}: {}", out.status.code(), err));
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match s.parse::<i32>() {
        Ok(d) => { eprintln!("[yt-dlp] {} → {}s ({})", video_id, d, path); Ok(d) }
        Err(_) => {
            let err = format!("stdout '{}' / stderr '{}'", s.chars().take(60).collect::<String>(),
                              String::from_utf8_lossy(&out.stderr).chars().take(100).collect::<String>());
            eprintln!("[yt-dlp] {} → 파싱 실패: {}", video_id, err);
            Err(format!("파싱 실패: {}", err))
        }
    }
}

async fn fetch_captions_ytdlp(ytdlp: &str, video_id: &str, lang: &str) -> Result<Option<String>, String> {
    let url = format!("https://www.youtube.com/watch?v={}", video_id);
    let tmpdir = std::env::temp_dir();
    let path = ytdlp;
    if path == "yt-dlp" && !std::path::Path::new("yt-dlp.exe").exists() {
        eprintln!("[yt-dlp] 캡션 {} — 바이너리를 찾을 수 없음 (PATH에도 없음)", video_id);
        return Ok(None);
    }
    #[allow(unused_mut)]
    let mut output = run_captions_once(&path, &url, &tmpdir, video_id).await?;
    // 성공 판정은 exit code가 아니라 "자막 파일 존재" 기준!
    // (yt-dlp는 ko 성공 + en 429여도 exit 1/2 — SMMY는 파일로 판정해 ko 사용)
    let has_subs = |tmp: &std::path::Path, vid: &str| -> bool {
        std::fs::read_dir(tmp).map(|it| it.filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(vid) && e.path().extension().map_or(false, |x| x == "vtt")))
            .unwrap_or(false)
    };
    // 429(속도 차단) — 백오프 재시도 (3초 → 8초 → 15초, 최대 3회)
    let mut rate_limited = false;
    for (i, delay) in [3u64, 8, 15].iter().enumerate() {
        if has_subs(&tmpdir, video_id) || !String::from_utf8_lossy(&output.stderr).contains("429") { break; }
        rate_limited = true;
        eprintln!("[yt-dlp] 캡션 {} — 429 → {}초 후 재시도 ({}/3)", video_id, delay, i + 1);
        tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;
        output = run_captions_once(&path, &url, &tmpdir, video_id).await?;
    }
    if !has_subs(&tmpdir, video_id) {
        let err = String::from_utf8_lossy(&output.stderr).chars().take(150).collect::<String>();
        eprintln!("[yt-dlp] 캡션 {} — 실행 실패: {}", video_id, err);
        // 429로 3회까지 실패 → Err 반환 (작업 전체 중단 트리거)
        if rate_limited && err.contains("429") {
            return Err("YouTube 속도 제한 (429) — 자막을 가져올 수 없습니다. 잠시 후 다시 시도해주세요".into());
        }
        return Ok(None);
    }
    // 자막 선택 우선순위: 요약 언어와 일치하는 자막 우선
    // (ko 요약 → ko → en / en 요약 → en → ko / auto → ko → en)
    let pref: Vec<&str> = if lang == "en" { vec!["en", "ko"] } else { vec!["ko", "en"] };
    let mut found: Option<(String, String)> = None;
    for l in &pref {
        let path2 = tmpdir.join(format!("{}.{}.vtt", video_id, l));
        if let Ok(vtt) = std::fs::read_to_string(&path2) {
            let text = parse_vtt(&vtt);
            if !text.trim().is_empty() { found = Some((l.to_string(), text)); break; }
        }
    }
    if found.is_none() {
        if let Ok(entries) = std::fs::read_dir(&tmpdir) {
            let mut vtts: Vec<_> = entries.filter_map(|e| e.ok()).map(|e| e.path())
                .filter(|p| p.extension().map_or(false, |x| x == "vtt"))
                .filter(|p| p.file_name().map_or(false, |n| n.to_string_lossy().starts_with(video_id)))
                .collect();
            vtts.sort();
            for p in vtts {
                if let Ok(vtt) = std::fs::read_to_string(&p) {
                    let text = parse_vtt(&vtt);
                    if !text.trim().is_empty() {
                        let lang = p.file_name().map(|n| n.to_string_lossy().replace(&format!("{}.", video_id), "").replace(".vtt", "")).unwrap_or_else(|| "?".into());
                        found = Some((lang, text));
                        break;
                    }
                }
            }
        }
    }
    // 임시 VTT 정리 (video_id로 시작하는 것 전부)
    if let Ok(entries) = std::fs::read_dir(&tmpdir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map_or(false, |x| x == "vtt") && p.file_name().map_or(false, |n| n.to_string_lossy().starts_with(video_id)) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    match found {
        Some((lang, text)) => { eprintln!("[yt-dlp] 캡션 {} → {} ({}자)", video_id, lang, text.trim().len()); Ok(Some(text)) }
        None => { eprintln!("[yt-dlp] 캡션 {} → 자막 없음", video_id); Ok(None) }
    }
}

/// 자막 다운로드 1회 실행 (android 클라이언트 + 자막 요청 지연)
/// sub-langs: 요약 언어에 맞춰 최소 요청 (ko → ko만, en → en만, 그 외 → ko,en)
async fn run_captions_once(path: &str, url: &str, tmpdir: &std::path::Path, video_id: &str) -> Result<std::process::Output, String> {
    let mut cmd = tokio::process::Command::new(path);
    no_console(&mut cmd);
    ytdlp_common_args(&mut cmd);
    let out_tmpl = tmpdir.join(format!("{}.%(ext)s", video_id));
    // ko,en 모두 받기 (영어 채널/한국어 채널 전부 커버)
    // — 선택 우선순위는 요약 언어 기준으로 (fetch_captions_ytdlp에서)
    // --ignore-no-formats-error: 한 언어(en)가 429여도 ko가 받아졌으면
    //   전체 실패(exit 1)로 만들지 않음 — SMMY와 동일 (ko 파일 사용)
    cmd.args(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "ko,en",
              "--sleep-subtitles", "2",
              "--ignore-no-formats-error",
              "-o", &out_tmpl.to_string_lossy(),
              "--no-warnings", "--no-progress", url]);
    let out = cmd.output().await.map_err(|e| format!("yt-dlp: {}", e))?;
    Ok(out)
}

fn parse_vtt(vtt: &str) -> String {
    let mut result = String::new();
    for line in vtt.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("WEBVTT") || line.starts_with("Kind:")
           || line.starts_with("Language:") || line.contains("-->") { continue; }
        if line.chars().any(|c| c.is_alphanumeric()) {
            result.push_str(line);
            result.push(' ');
        }
    }
    result.trim().to_string()
}
