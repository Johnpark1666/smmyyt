use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;

pub async fn summarize(
    transcript: Option<&str>,
    provider: &str,
    settings: &HashMap<String, String>,
    title: &str,
    _channel: &str,
    thumbnail_url: &str,
    lang: &str,
    chapters: &str,
    publish_date: &str,
) -> Result<Value, String> {
    let raw_text = transcript.unwrap_or("").to_string();
    let has_captions = !raw_text.trim().is_empty();
    let text = if has_captions { raw_text } else { "No transcript available".to_string() };
    // auto → detect from caption language (fall back to title language when no captions)
    let effective_lang = if lang == "auto" {
        if has_captions { detect_lang(&text) } else { detect_lang(title) }
    } else { lang }.to_string();
    let ocr_provider = settings.get("ocr_provider").cloned().filter(|p| !p.is_empty())
        .unwrap_or_else(|| provider.to_string());
    let ocr_key = settings.get(&format!("{}_key", ocr_provider)).cloned().filter(|k| !k.is_empty())
        .or_else(|| settings.get("ocr_key").cloned().filter(|k| !k.is_empty()))
        .or_else(|| settings.get("gemini_key").cloned().filter(|k| !k.is_empty()))
        .unwrap_or_default();
    let ocr_model = settings.get("ocr_model").cloned().filter(|m| !m.is_empty())
        .unwrap_or_else(|| {
            if ocr_provider == "anthropic" { "claude-sonnet-4-20250514".into() }
            else if ocr_provider == "openai" { "gpt-4o".into() }
            else { "gemini-2.5-flash".into() }
        });
    let thumbnail_text = extract_thumbnail_text(thumbnail_url, &ocr_provider, &ocr_key, &ocr_model).await;
    let (model, api_key, url, api_type) = get_provider_config(provider, settings);
    // Per-tab token limits (set in the tab filter menu; defaults here)
    let input_limit = settings.get("youtube_input_limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(400_000);
    let output_tokens = settings.get("youtube_output_tokens").and_then(|v| v.parse::<u32>().ok()).unwrap_or(8000);

    async fn try_summarize(limit: usize, max_tokens: u32, text: &str, title: &str, thumbnail_text: &str, provider: &str, api_key: &str, model: &str, url: &str, api_type: &str, lang: &str, settings: &HashMap<String, String>, chapters: &str, publish_date: &str) -> Result<String, String> {
        let sliced: String = text.chars().take(limit).collect();
        let prompt = build_prompt(&sliced, title, thumbnail_text, lang, settings, chapters, publish_date);
        call_provider(provider, &prompt, api_key, model, url, api_type, max_tokens).await
    }

    // ── 하이브리드: 자막이 입력 제한 초과 시 청크 분할 요약 → 병합 ──
    if text.chars().count() > input_limit {
        eprintln!("[LLM] 하이브리드: 자막 {}자 > 제한 {}자 → 청크 분할", text.chars().count(), input_limit);
        let chars: Vec<char> = text.chars().collect();
        let mut merged: Value = json!({});
        let mut ok_count = 0;
        let total_chunks = chars.len().div_ceil(input_limit);
        for (i, chunk) in chars.chunks(input_limit).enumerate() {
            let part: String = chunk.iter().collect();
            match try_summarize(input_limit, output_tokens, &part, title, &thumbnail_text, provider, &api_key, &model, &url, &api_type, &effective_lang, settings, chapters, publish_date).await {
                Ok(t) => {
                    let v = parse_and_process(&t, &model);
                    merge_chunk(&mut merged, &v, i, total_chunks, &model);
                    ok_count += 1;
                }
                Err(e) => eprintln!("[LLM] 청크 {}/{} 실패: {}", i + 1, total_chunks, e),
            }
        }
        if ok_count > 0 {
            if !chapters.trim().is_empty() {
                merged["Timeline"] = json!(chapters_to_timeline(chapters));
            }
            return Ok(merged);
        }
        // 전부 실패 → 기존 경로로 폴백
        eprintln!("[LLM] 청크 요약 전부 실패 — 폴백");
    }

    // ── Cascade: try full context, shrink on context-limit errors ──
    let mut text_response = String::new();
    let first = try_summarize(input_limit, output_tokens, &text, title, &thumbnail_text, provider, &api_key, &model, &url, &api_type, &effective_lang, settings, chapters, publish_date).await;
    match first {
        Ok(t) => text_response = t,
        Err(e) if is_context_error(&e) && provider == "lmstudio" => {
            let step = (input_limit / 3).max(8_000);
            for (lim, tok) in [(step, output_tokens.min(6000)), (step - (input_limit / 6).max(4_000), output_tokens.min(5000)), (10_000, output_tokens.min(4000))] {
                eprintln!("[LLM] cascade retry: {} chars, {} tokens", lim, tok);
                match try_summarize(lim, tok, &text, title, &thumbnail_text, provider, &api_key, &model, &url, &api_type, &effective_lang, settings, chapters, publish_date).await {
                    Ok(t) => { text_response = t; break; }
                    Err(_) => continue,
                }
            }
        }
        Err(e) => return Err(e),
    }

    // ── Empty/short response retry ──
    if text_response.trim().len() < 10 {
        eprintln!("[LLM] empty response, retry with reduced context");
        if let Ok(t) = try_summarize((input_limit / 2).min(30_000), output_tokens.min(4000), &text, title, &thumbnail_text, provider, &api_key, &model, &url, &api_type, &effective_lang, settings, chapters, publish_date).await { text_response = t; }
    }
    if text_response.trim().len() < 10 {
        return Ok(json!({"Summary": format!("No response ({})", provider), "Insights": "", "Implications": "", "Keywords": "", "Analysis": "Empty response", "usedModel": model}));
    }

    let mut result = parse_and_process(&text_response, &model);
    // 공식 챕터가 있으면 타임라인을 챕터 전체로 직접 표시 (LLM 생성보다 정확)
    if !chapters.trim().is_empty() {
        result["Timeline"] = json!(chapters_to_timeline(chapters));
    }
    Ok(result)
}

/// "- [0:00] 제목" 챕터 목록 → "• [0:00] 제목" 타임라인 형식
fn chapters_to_timeline(chapters: &str) -> String {
    chapters.lines()
        .map(|l| l.trim().trim_start_matches("- "))
        .filter(|l| !l.is_empty())
        .map(|l| format!("• {}", l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 청크 요약 병합: Summary/Insights/Analysis 이어붙이기, Timeline 이어붙이기,
/// Keywords 병합, Category 첫 청크
fn merge_chunk(acc: &mut Value, chunk: &Value, _idx: usize, _total: usize, model: &str) {
    let Some(acc_obj) = acc.as_object_mut() else { return };
    for k in ["Summary", "Insights", "Implications", "Analysis"] {
        let cv = chunk.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if cv.is_empty() { continue; }
        let cur = acc_obj.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        // [1구간] 라벨 없이 자연스럽게 이어붙이기 (구간 구분 없음)
        let joined = if cur.is_empty() { cv } else { format!("{}\n{}", cur, cv) };
        acc_obj.insert(k.to_string(), json!(joined));
    }
    let tv = chunk.get("Timeline").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !tv.is_empty() {
        let cur = acc_obj.get("Timeline").and_then(|v| v.as_str()).unwrap_or("").to_string();
        acc_obj.insert("Timeline".to_string(), json!(if cur.is_empty() { tv } else { format!("{}\n{}", cur, tv) }));
    }
    let kv = chunk.get("Keywords").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let cur_kw = acc_obj.get("Keywords").and_then(|v| v.as_str()).unwrap_or("").to_string();
    acc_obj.insert("Keywords".to_string(), json!(if cur_kw.is_empty() { kv } else if kv.is_empty() { cur_kw } else { format!("{}, {}", cur_kw, kv) }));
    if !acc_obj.contains_key("Category") {
        if let Some(cv) = chunk.get("Category").and_then(|v| v.as_str()) {
            acc_obj.insert("Category".to_string(), json!(cv));
        }
    }
    acc_obj.insert("usedModel".to_string(), json!(model));
}

pub async fn summarize_github(
    readme: &str,
    repo_name: &str,
    description: &str,
    provider: &str,
    settings: &HashMap<String, String>,
    lang: &str,
) -> Result<Value, String> {
    let (model, api_key, url, api_type) = get_provider_config(provider, settings);
    let input_limit = settings.get("github_input_limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(40_000);
    let output_tokens = settings.get("github_output_tokens").and_then(|v| v.parse::<u32>().ok()).unwrap_or(8000);

    async fn try_summarize(limit: usize, max_tokens: u32, readme: &str, repo_name: &str, description: &str, provider: &str, api_key: &str, model: &str, url: &str, api_type: &str, lang: &str, settings: &HashMap<String, String>) -> Result<String, String> {
        let sliced: String = readme.chars().take(limit).collect();
        let prompt = build_github_prompt(&sliced, repo_name, description, lang, settings);
        call_provider(provider, &prompt, api_key, model, url, api_type, max_tokens).await
    }

    let mut text_response = String::new();
    let first = try_summarize(input_limit, output_tokens, readme, repo_name, description, provider, &api_key, &model, &url, &api_type, lang, settings).await;
    match first {
        Ok(t) => text_response = t,
        Err(e) if is_context_error(&e) && provider == "lmstudio" => {
            let step = (input_limit / 3).max(8_000);
            for (lim, tok) in [(step, output_tokens.min(6000)), (step - (input_limit / 6).max(4_000), output_tokens.min(5000)), (10_000, output_tokens.min(4000))] {
                if let Ok(t) = try_summarize(lim, tok, readme, repo_name, description, provider, &api_key, &model, &url, &api_type, lang, settings).await { text_response = t; break; }
            }
        }
        Err(e) => return Err(e),
    }

    if text_response.trim().len() < 10 {
        return Ok(json!({"Title": repo_name.split('/').last().unwrap_or(repo_name), "Summary": format!("No response ({})", provider), "Analysis": "Empty response", "Insights": "", "Applications": "", "Keywords": "", "usedModel": model}));
    }

    Ok(parse_and_process(&text_response, &model))
}

fn is_context_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    msg.contains("400") || m.contains("context") || m.contains("token") || m.contains("limit") || m.contains("length")
}

fn get_provider_config(provider: &str, s: &HashMap<String, String>) -> (String, String, String, String) {
    match provider {
        "gemini" => (s.get("gemini_model").cloned().unwrap_or_else(|| "gemini-2.5-flash".into()),
                     s.get("gemini_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "deepseek" => (s.get("deepseek_model").cloned().unwrap_or_else(|| "deepseek-chat".into()),
                        s.get("deepseek_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "openrouter" => (s.get("openrouter_model").cloned().unwrap_or_else(|| "google/gemini-2.5-flash".into()),
                         s.get("openrouter_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "openrouter_flex" => (s.get("openrouter_flex_model").cloned().unwrap_or_else(|| "openai/gpt-5.6-luna".into()),
                         s.get("openrouter_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "openai" => (s.get("openai_model").cloned().unwrap_or_else(|| "gpt-4o".into()),
                     s.get("openai_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "openai_flex" => (s.get("openai_flex_model").cloned().unwrap_or_else(|| "gpt-5.6-luna".into()),
                     s.get("openai_flex_key").cloned().filter(|k| !k.is_empty())
                      .or_else(|| s.get("openai_key").cloned()).unwrap_or_default(), String::new(), String::new()),
        "anthropic" => (s.get("anthropic_model").cloned().unwrap_or_else(|| "claude-sonnet-4-20250514".into()),
                        s.get("anthropic_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "lmstudio" => (s.get("lmstudio_model").cloned().unwrap_or_else(|| "local-model".into()),
                        String::new(),
                        s.get("lmstudio_url").cloned().unwrap_or_else(|| "http://127.0.0.1:1234/v1".into()),
                        s.get("lmstudio_api_type").cloned().unwrap_or_else(|| "generic".into())),
        "glm" => (s.get("glm_model").cloned().unwrap_or_else(|| "glm-4.6".into()),
                  s.get("glm_key").cloned().unwrap_or_default(), String::new(), String::new()),
        "glm_flex" => (s.get("glm_flex_model").cloned().unwrap_or_else(|| "glm-4.6".into()),
                  s.get("glm_flex_key").cloned().filter(|k| !k.is_empty())
                   .or_else(|| s.get("glm_key").cloned()).unwrap_or_default(), String::new(), String::new()),
        "grok" => (s.get("grok_model").cloned().unwrap_or_else(|| "grok-3".into()),
                   s.get("grok_key").cloned().unwrap_or_default(), String::new(), String::new()),
        _ => (String::new(), String::new(), String::new(), String::new()),
    }
}

async fn call_provider(provider: &str, prompt: &str, api_key: &str, model: &str, url: &str, api_type: &str, max_tokens: u32) -> Result<String, String> {
    match provider {
        "gemini" => call_gemini(prompt, api_key, model).await,
        "deepseek" => call_deepseek_responses(api_key, model, prompt, max_tokens).await,
        "openrouter" => call_openai_compat("https://openrouter.ai/api/v1/chat/completions", api_key, model, prompt, max_tokens.saturating_mul(2), "OpenRouter", false, false).await,
        "openrouter_flex" => call_openai_compat("https://openrouter.ai/api/v1/chat/completions", api_key, model, prompt, max_tokens.saturating_mul(2), "OpenRouter Flex", false, true).await,
        "openai" => call_openai_compat("https://api.openai.com/v1/chat/completions", api_key, model, prompt, max_tokens, "OpenAI", false, false).await,
        "openai_flex" => call_openai_compat("https://api.openai.com/v1/chat/completions", api_key, model, prompt, max_tokens, "OpenAI Flex", false, true).await,
        "anthropic" => call_anthropic(prompt, api_key, model, max_tokens).await,
        "lmstudio" => call_lmstudio(prompt, url, model, api_type, max_tokens).await,
        "glm" => call_openai_compat("https://open.bigmodel.cn/api/paas/v4/chat/completions", api_key, model, prompt, max_tokens, "GLM", false, false).await,
        "glm_flex" => call_openai_compat("https://open.bigmodel.cn/api/paas/v4/chat/completions", api_key, model, prompt, max_tokens, "GLM Flex", false, true).await,
        "grok" => call_openai_compat("https://api.x.ai/v1/chat/completions", api_key, model, prompt, max_tokens, "Grok", false, false).await,
        _ => call_gemini(prompt, api_key, model).await,
    }
}

/// Language directive for the prompt body. Category/Keywords stay language-neutral.
fn lang_directive(lang: &str) -> (String, String, String) {
    match lang {
        "en" => (
            "3. **MUST ANSWER IN ENGLISH ONLY.** (All responses must be written in English.)".to_string(),
            "5. Use proper English technical terminology.".to_string(),
            "English".to_string()
        ),
        "ja" => (
            "3. **MUST ANSWER IN JAPANESE ONLY.** (すべての回答は必ず日本語で記述してください。)".to_string(),
            "5. 漢字は適切に使用してください。".to_string(),
            "Japanese".to_string()
        ),
        "zh" => (
            "3. **MUST ANSWER IN CHINESE ONLY.** (所有回答必须使用简体中文书写。)".to_string(),
            "5. 请使用规范的中文表达。".to_string(),
            "Chinese".to_string()
        ),
        _ => (
            "3. **MUST ANSWER IN KOREAN LANGUAGE ONLY.** (모든 답변은 반드시 한국어로 작성하십시오.)".to_string(),
            "5. **CRITICAL: 한자(중국어 한자, 漢字)를 절대 사용하지 마십시오. 모든 내용은 한글(한국어)로만 작성해야 합니다. 단, 숫자·퍼센트·날짜는 반드시 아라비아 숫자(0-9)로 표기하십시오. (예: '오십사점오사 퍼센트' 금지 → '54.54%' 로 작성)**".to_string(),
            "Korean".to_string()
        ),
    }
}

/// Detect caption language heuristically (for auto mode)
fn detect_lang(text: &str) -> &'static str {
    let sample: String = text.chars().take(3000).collect();
    let sample = sample.as_str();
    let (mut ko, mut ja, mut zh, mut en_alpha) = (0usize, 0usize, 0usize, 0usize);
    for ch in sample.chars() {
        let c = ch as u32;
        if (0xAC00..=0xD7AF).contains(&c) { ko += 1; }
        else if (0x3040..=0x30FF).contains(&c) { ja += 1; }
        else if (0x4E00..=0x9FFF).contains(&c) { zh += 1; }
        else if ch.is_ascii_alphabetic() { en_alpha += 1; }
    }
    let total = ko + ja + zh + en_alpha;
    if total == 0 { return "ko"; }
    if ja > 0 && ja * 2 > zh { return "ja"; }
    if zh > en_alpha && zh > ko { return "zh"; }
    // Korean captions often mix in English terms/numbers — ko wins if at least 8%
    if ko > 0 && ko * 12 >= total { return "ko"; }
    if en_alpha > ko && en_alpha > zh && en_alpha > ja { return "en"; }
    "ko"
}

fn build_prompt(text: &str, title: &str, thumbnail_text: &str, lang: &str, settings: &HashMap<String, String>, chapters: &str, publish_date: &str) -> String {
    let thumb = if thumbnail_text.is_empty() {
        String::new()
    } else {
        format!("\nThumbnail Text (OCR): \"{}\"\n(분석(Analysis) 파트에서 제목과 함께 이 썸네일 문구를 적극 참고하여 분석을 풍부하게 해 주세요.)\n", thumbnail_text)
    };
    let (lang_rule, lang_rule2, lang_name) = lang_directive(lang);
    // ── 커스텀 프롬프트 (설정에서 편집) ──
    // 모드: append(기본 — 추가 지시문 보강) / replace(전체 교체)
    let prompt_mode = settings.get("prompt_mode").map(|s| s.as_str()).unwrap_or("append");
    if let Some(custom) = settings.get("prompt_youtube").filter(|s| !s.trim().is_empty()) {
        let filled = custom
            .replace("{title}", title)
            .replace("{lang}", &lang_name)
            .replace("{lang_rule}", &lang_rule)
            .replace("{lang_rule2}", &lang_rule2)
            .replace("{thumb}", &thumb)
            .replace("{text}", text);
        if prompt_mode == "replace" {
            return filled;  // 대체: 입력한 것만 사용
        }
        // 보강: 기본 프롬프트 뒤에 추가 지시문 덧붙임
        let base = build_default_youtube_prompt(text, title, &thumb, &lang_rule, &lang_rule2, &lang_name, chapters, publish_date);
        return format!("{}\n\n=== 사용자 추가 지시 ===\n{}", base, filled);
    }
    build_default_youtube_prompt(text, title, &thumb, &lang_rule, &lang_rule2, &lang_name, chapters, publish_date)
}

/// 기본 YouTube 프롬프트 (하드코딩 — 보강 모드의 베이스)
fn build_default_youtube_prompt(text: &str, title: &str, thumb: &str, lang_rule: &str, lang_rule2: &str, lang_name: &str, chapters: &str, publish_date: &str) -> String {
    // 공식 챕터 힌트 (유튜브 설명에서 추출 — 타임라인 가이드)
    let chapters_hint = if chapters.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\nOfficial Video Chapters (Use these as a guide for timestamps and timeline segments):\n{}\n\n",
            chapters
        )
    };
    // 시간 컨텍스트: 오늘 날짜 + 영상 발행일 (LLM 지식 컷오프 보정)
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let date_hint = if publish_date.trim().is_empty() {
        format!("Today's date is {}.\n", today)
    } else {
        format!("Today's date is {}. This video was published on {}.\n", today, publish_date)
    };
    format!(
        "The actual title of this video is: \"{}\"\n{}\n{}\n\
         Analyze the following video transcript and provide an extremely detailed, rich, and structured response in {}.\n\
         Ensure you answer based on the REAL video title provided above.\n\
         DO NOT summarize generally or write generic/vague statements. Extract concrete facts: people, numbers, dates, examples, comparisons, and specific details mentioned in the transcript.\n\
    Ensure you analyze from the video's publication date perspective - events mentioned in the transcript happened at or before that date. Do NOT treat them as future events. Do NOT speculate about events after the publication date, and if you lack knowledge of recent events, base your analysis strictly on the transcript.\n\
         \n\
         **카테고리 분류**: 반드시 아래 10개 카테고리 중 하나를 선택하여 \"Category\" 필드에 포함시키십시오:\n\
         [Technology, Science, News/Politics, Entertainment, Education, Business/Finance, Gaming, Music, Lifestyle, Sports]\n\
         \n\
         CRITICAL INSTRUCTION:\n\
         1. Output ONLY valid JSON. Do not add markdown formatting, code blocks, or introductory text around the JSON.\n\
         2. The output must be parseable by JSON.parse().\n\
         {}\n\
         4. 가장 중요한 핵심 수치와 핵심 용어만 제한적으로 강조(볼드 처리)해 주십시오. (한 문단당 2~3개를 넘지 말 것 — 전부 강조하면 아무것도 강조되지 않습니다.) 강조 시 마크다운(**)을 절대 쓰지 말고, 반드시 HTML 태그인 <b>강조할내용</b> 형태로 작성하십시오.\n\
         {}\n\
         6. 가독성을 위해 Summary, Insights, Timeline 등의 여러 문장/불렛포인트 사이에는 반드시 줄바꿈 문자(\\n)를 삽입하십시오. 각 불렛포인트(•)는 반드시 \\n• 형태로 각각 새 줄에서 시작해야 합니다. 각 단락의 소제목은 반드시 <h3>소제목이름</h3> 형태로 감싸 주십시오. **CRITICAL: <h3>소제목</h3> 닫는 태그 바로 뒤에는 반드시 줄바꿈 문자(\\n)를 넣어 소제목과 첫 번째 내용이 절대 같은 줄에 붙지 않게 하십시오. 각 문단(서술형 단락) 사이에도 줄바꿈 문자 1개를 넣어 단락이 서로 붙지 않게 하십시오.**\n\
         7. 'Timeline' 필드는 절대로 비워두거나 누락해서는 안 되며, 자막의 타임라인을 기반으로 5개 이상 반드시 생성해야 합니다.\n\
         8. 'Timeline' 필드의 값은 반드시 단일 문자열(String)이어야 합니다. (예: \"Timeline\": \"• [00:00] ...\\n• [01:30] ...\")\n\
         9. **CRITICAL: 'Timeline' 필드를 제외한 'Summary', 'Insights', 'Implications', 'Analysis' 필드 내에서는 [00:00] 또는 [MM:SS] 형태의 시간 표시(타임스탬프)를 절대로 적지 마십시오.**\n\
         10. **TABLE RULE (적극 활용): 수치 비교, 일정, 역할 분담, 장단점 비교, 기능 목록, 버전/스택 나열 등 표로 표현 가능한 정보는 HTML Table 태그(<table>, <tr>, <th>, <td>)를 우선 사용하십시오. 불렛포인트로 나열하는 대신 표가 가독성을 높이면 반드시 표를 사용하십시오. 단, <table>의 시작부터 끝(</table>)까지 내부에 줄바꿈(\\n)을 절대 넣지 말고 한 줄로 이어 쓰십시오.**\n\
         11. **CRITICAL - 고유명사 및 전문 용어 정확도:** 사람 이름, 장소, 브랜드명, 기술 용어 등 모든 고유명사와 전문 용어는 반드시 자막(Transcript)에 나온 그대로 정확한 철자로 작성하십시오. Keywords 필드는 자막에서 실제로 언급된 용어만 사용하십시오. LLM이 임의로 생성하거나 유추한 단어는 키워드로 사용하지 마십시오.\n\
         12. **QUOTE RULE: 화자가 한 핵심 발언/명언이 자막에 있다면 <blockquote>\"내용\"</blockquote> 형태로 인용하십시오. 단, 정확히 자막에 나온 그대로 인용해야 하며 2~3개를 넘지 마십시오.**\n\
         13. **NUMBER HIGHLIGHT RULE: 영상에서 언급된 중요 수치/통계/비율(예: 매출 3배, 사용자 100만, 수익률 12.4%)은 <b>볼드 태그</b>로 강조하고, 비교 가능한 수치가 2개 이상이면 HTML <table>로 정리하십시오.**\n\
         14. **용어 설명: 전문 용어나 약어가 처음 등장하면 뒤에 짧게 괄호 정의를 덧붙이십시오. (예: 배당률(Dividend Yield, 주가 대비 배당 비율))**\n\
         \n\
         Format the output strictly as a JSON object with the following keys:\n\
         {{\n\
           \"Summary\": \"3~4개의 <h3>소제목</h3>으로 나누고 (소제목에는 번호를 붙이지 마십시오), 각 소제목 아래에 3~4문장으로 구성된 서술형 문단으로 작성하십시오. 문장은 서로 자연스럽게 연결되어 흐름이 있어야 하며(마치 사람이 설명하듯), 구체적인 사실(수치, 인물, 사례)을 문장 안에 포함하십시오. 나열이 꼭 필요한 핵심 요소에만 • 불렛포인트를 소수(2~3개 이하)로 사용하십시오. 절대 시간 표시 [00:00]를 사용하지 마십시오.\",\n\
           \"Insights\": \"영상에서 도출할 수 있는 핵심 통찰과 시사점(잠재적 영향, 미래 함의, 이 내용이 중요한 이유)을 2~3개의 <h3>소제목</h3> 아래에 2~3문장의 서술형 문단으로 작성하십시오. 문장이 연결되어 흐름이 있어야 하며, 구체적인 근거(수치, 사례)를 문장 안에 포함하십시오.\",\n\
           \"Keywords\": \"자막(Transcript)에서 실제로 언급된 핵심 키워드만 선택하여 최대 12개를 쉼표로 구분한 리스트. 각 키워드는 반드시 해시태그로 시작 (예: #Keyword). 주제·개념·인물·브랜드·용어 위주로 고르고, 단순 숫자(#300명), 수량 표현(#65가지), 일반 명사 나열(#수면위생 등 너무 흔한 단어)은 키워드로 선택하지 마십시오.\",\n\
           \"Analysis\": \"영상 제목(\\\"{}\\\")의 주제를 영상 내용을 바탕으로 심층 분석하십시오. 2~3개의 <h3>소제목</h3>과 각 소제목당 3~4개의 • 불렛포인트로 구조화하고, 언급된 수치/통계/인물/사례를 반드시 포함하며 핵심 단어는 <b>볼드</b>로 강조하십시오. 비교 분석이나 수치가 필요하면 HTML <table>을 사용하십시오.\",\n\
           \"Category\": \"반드시 다음 중 하나를 선택: Technology, Science, News/Politics, Entertainment, Education, Business/Finance, Gaming, Music, Lifestyle, Sports\",\n\
           \"Timeline\": \"자막의 시간 표시([MM:SS] 등)를 기반으로 작성한 주요 흐름 타임라인 요약. 5~10개의 구간으로 나누어 반드시 다음과 같은 형식의 불렛포인트 목록 텍스트로 작성하십시오 (각 타임라인 항목 사이에는 반드시 \\\\n을 넣어 구분하십시오):\\n• [00:00] 영상의 인트로 및 전체 흐름 개요 소개\\\\n• [01:30] 핵심 주제 1 상세 분석\\\\n• [05:20] 향후 전망과 리스크 관리 방안\"\n\
         }}\n\
         {}\n\
         Transcript:\n\
         {}", title, lang_name, lang_rule, lang_rule2, title, thumb, text, chapters_hint, date_hint)
}

fn build_github_prompt(readme: &str, repo_name: &str, description: &str, lang: &str, settings: &HashMap<String, String>) -> String {
    let (lang_rule, lang_rule2, lang_name) = lang_directive(lang);
    // ── 커스텀 프롬프트 (설정에서 편집) ──
    // 모드: append(기본 — 추가 지시문 보강) / replace(전체 교체)
    let prompt_mode = settings.get("prompt_mode").map(|s| s.as_str()).unwrap_or("append");
    if let Some(custom) = settings.get("prompt_github").filter(|s| !s.trim().is_empty()) {
        let filled = custom
            .replace("{repo}", repo_name)
            .replace("{description}", description)
            .replace("{lang}", &lang_name)
            .replace("{lang_rule}", &lang_rule)
            .replace("{lang_rule2}", &lang_rule2)
            .replace("{readme}", readme);
        if prompt_mode == "replace" {
            return filled;  // 대체: 입력한 것만 사용
        }
        // 보강: 기본 프롬프트 뒤에 추가 지시문 덧붙임
        let base = build_default_github_prompt(readme, repo_name, description, &lang_rule, &lang_rule2, &lang_name);
        return format!("{}\n\n=== 사용자 추가 지시 ===\n{}", base, filled);
    }
    build_default_github_prompt(readme, repo_name, description, &lang_rule, &lang_rule2, &lang_name)
}

/// 기본 GitHub 프롬프트 (하드코딩 — 보강 모드의 베이스)
fn build_default_github_prompt(readme: &str, repo_name: &str, description: &str, lang_rule: &str, lang_rule2: &str, lang_name: &str) -> String {
    format!(
        "The GitHub Repository name is: \"{}\"\n\
         Description: \"{}\"\n\
         \n\
         Analyze the following GitHub Repository raw README text and provide an extremely detailed, rich, and technical structured analysis in {}.\n\
         \n\
         CRITICAL INSTRUCTIONS FOR QUALITY:\n\
         - DO NOT summarize generally or write generic/vague/obvious statements.\n\
         - Extract concrete technical specifications, architectures, key libraries, APIs, configuration settings, installation scripts, command examples, and implementation files mentioned in the README.\n\
         - Translate technical concepts accurately into the target language, keeping code terms or specific commands/parameters in English or code format.\n\
         - Ensure all sections are deeply informative, rich, and technical.\n\
         \n\
         CRITICAL JSON INSTRUCTIONS:\n\
         1. Output ONLY valid JSON. Do not add markdown formatting, code blocks, or introductory text around the JSON.\n\
         2. The output must be parseable by JSON.parse().\n\
         {}\n\
         {}\n\
         4. 가장 중요한 핵심 수치와 핵심 용어만 제한적으로 강조(볼드 처리)해 주십시오. (한 문단당 2~3개를 넘지 말 것 — 전부 강조하면 아무것도 강조되지 않습니다.) 강조 시 마크다운(**)을 절대 쓰지 말고, 반드시 HTML 태그인 <b>강조할내용</b> 형태로 작성하십시오.\n\
         5. JSON 값(Value) 내부에서는 큰따옴표(\")를 절대로 사용하지 마십시오. 강조나 따옴표 표현이 필요한 경우 반드시 작은따옴표(') 또는 HTML <b> 태그만을 사용하십시오.\n\
         6. **TABLE RULE (적극 활용): 다음 상황에서 반드시 HTML Table 태그(<table>, <tr>, <th>, <td>)를 사용하십시오 — 기술 스택/버전 나열, 지원 기능 목록, 구조 비교, 장단점 비교, 수치/통계 비교, 설치 요구사항, 패키지/의존성 목록, 가격/요금제 비교. 불렛포인트로 나열하는 대신 표로 표현할 수 있으면 표를 우선 사용하십시오. 단, <table>의 시작부터 끝(</table>)까지 내부에 줄바꿈(\\n)을 절대 넣지 말고 한 줄로 이어 쓰십시오.**\n\
         7. **CODE BLOCK RULE (적극 활용): 설치 명령, API 호출 예시, 설정 파일 내용, CLI 사용법, 실행 명령 등 코드/명령어가 필요한 내용은 반드시 <pre><code>...</code></pre> 블록으로 감싸 출력하십시오. 코드 블록 내부에는 줄바꿈을 그대로 유지하고 • 불렛포인트나 <b> 태그를 넣지 마십시오. 코드 블록 앞에는 어떤 명령인지 한 줄 설명을 붙이십시오.**\n\
         8. **WARNING BOX RULE: 보안 주의(기본 비밀번호, API 키 노출), 호환성 제약, 라이선스 주의, 데이터 손실 위험 등 중요한 경고/주의 사항은 <blockquote>⚠️ 내용</blockquote> 형태로 감싸 출력하십시오.**\n\
         9. **용어 설명: 기술 약어나 전문 용어(ORM, SSR, WASM 등)가 처음 등장하면 뒤에 짧게 괄호 정의를 덧붙이십시오. (예: ORM(Object-Relational Mapping, 객체-관계 매핑))**\n\
         \n\
         Format the output strictly as a JSON object with this exact structure (all values must be flat strings, DO NOT use nested JSON objects/arrays inside the values):\n\
         {{\n\
           \"Title\": \"이 저장소의 명확하고 직관적인 한글 요약 제목 (예: 'MoneyPrinterTurbo - AI 기반 숏폼 비디오 원클릭 생성기'). 영문 원래 프로젝트명 뒤에 프로젝트의 핵심 역할이나 한글 한 문장 요약명을 덧붙여 작성하십시오.\",\n\
           \"Summary\": \"이 레포가 구체적으로 무엇인지(What it is)에 집중하십시오: ① 이 프로젝트가 해결하는 문제/목적, ② 핵심 기능 및 사용자 가치, ③ 사용 기술 스택(언어/프레임워크/DB/주요 라이브러리), ④ 배포/실행 방식 순으로 최소 7개 이상의 • 불렛포인트로 작성하십시오. 구조만 나열하지 말고 '이 레포가 뭘 하는 도구인지' 첫 불렛부터 명확히 설명하십시오.\",\n\
           \"Analysis\": \"<h3>시스템 아키텍처 및 데이터 흐름</h3>\\\\n• 아키텍처 및 세부 데이터 흐름 설명...\\\\n\\\\n<h3>핵심 디렉토리 및 소스 파일 구성</h3>\\\\n• 주요 폴더 및 핵심 소스 파일들의 역할 (표로 표현 가능하면 <table> 사용)...\\\\n\\\\n<h3>핵심 구현 기술 및 라이브러리/의존성</h3>\\\\n• 기술 스택을 <table>로 정리 (기술명 | 용도 | 버전)...\",\n\
           \"Insights\": \"<h3>트렌딩 요인 및 업계 배경</h3>\\\\n• 최근 트렌딩 배경 설명...\\\\n\\\\n<h3>타 유사 솔루션 대비 차별점</h3>\\\\n• 장단점 및 기술 차별점 비교 (비교 항목이 3개 이상이면 반드시 <table>로 표현)...\\\\n\\\\n<h3>도입 시 제약 사항 및 고려 과제</h3>\\\\n• 기술적 제약 및 극복 과제 설명...\",\n\
           \"Applications\": \"이 레포를 실제 사용자가 자신의 프로젝트나 업무에 어떻게 활용(적용)할 수 있는지에 초점을 맞춰 • 불렛포인트로 3~5개 작성하십시오. (레포 자체의 설치법/CLI 사용법을 나열하는 것이 아니라, 이 기술을 내 상황에 어떻게 써먹을 수 있는지 실용적인 활용 방안을 제시하십시오.)\",\n\
           \"Keywords\": \"#Python, #WebScraping, #Cheerio (README에서 실제로 언급된 용어만 쉼표로 구분한 해시태그 키워드 리스트. LLM이 임의로 생성한 단어 금지)\"\n\
         }}\n\
         \n\
         README text:\n\
         {}", repo_name, description, lang_name, lang_rule, lang_rule2, readme)
}

async fn call_gemini(prompt: &str, api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key);
    let body = json!({"contents":[{"parts":[{"text":prompt}]}]});
    let resp = client.post(&url).json(&body).send().await.map_err(|e| format!("Gemini: {}", e))?;
    if !resp.status().is_success() { return Err(format!("Gemini HTTP {}", resp.status().as_u16())); }
    let data: Value = resp.json().await.map_err(|e| format!("Gemini parse: {}", e))?;
    let text = data["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or("");
    Ok(text.to_string())
}

/// DeepSeek v4 models use the Responses API (POST /responses), not chat/completions.
async fn call_deepseek_responses(api_key: &str, model: &str, prompt: &str, max_tokens: u32) -> Result<String, String> {
    let client = reqwest::Client::new();
    let (sys, usr) = split_system_user(prompt);
    let mut body = json!({
        "model": model,
        "input": usr,
        "max_output_tokens": max_tokens,
        "temperature": 0.1,
        // v4-flash is a thinking model — low effort keeps reasoning tokens low
        "reasoning": {"effort": "low"},
    });
    if !sys.is_empty() { body["instructions"] = json!(sys); }
    let resp = client.post("https://api.deepseek.com/responses")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body).send().await.map_err(|e| format!("DeepSeek: {}", e))?;
    if !resp.status().is_success() { return Err(format!("DeepSeek HTTP {}", resp.status().as_u16())); }
    let data: Value = resp.json().await.map_err(|e| format!("DeepSeek parse: {}", e))?;
    // Responses API has no output_text field — find the message item in output[]
    let mut text = String::new();
    if let Some(items) = data["output"].as_array() {
        for item in items {
            if item["type"].as_str() == Some("message") {
                if let Some(parts) = item["content"].as_array() {
                    for part in parts {
                        if let Some(t) = part["text"].as_str() {
                            text.push_str(t);
                        }
                    }
                }
                break;
            }
        }
    }
    Ok(text)
}

async fn call_openai_compat(url: &str, api_key: &str, model: &str, prompt: &str, max_tokens: u32, label: &str, split_sys: bool, flex: bool) -> Result<String, String> {
    let client = reqwest::Client::new();
    let (sys, usr) = if split_sys { split_system_user(prompt) } else { (String::new(), prompt.to_string()) };
    let mut msgs = vec![];
    if !sys.is_empty() { msgs.push(json!({"role":"system","content":sys})); }
    msgs.push(json!({"role":"user","content":usr}));
    let mut body = json!({"model":model,"messages":msgs,"temperature":0.1,"max_tokens":max_tokens});
    // Thinking models (deepseek-v4 etc.) burn tokens on reasoning — cap it so the
    // answer isn't cut off (finish=length). OpenRouter/DeepSeek accept reasoning.effort.
    if label == "OpenRouter" || label == "DeepSeek" {
        body["reasoning"] = json!({"effort": "low"});
    }
    // Flex processing (OpenAI/GLM): batch-level pricing, slower, occasional 429 Resource Unavailable
    if flex {
        body["service_tier"] = json!("flex");
    }
    // ── Flex 전용 재시도: 429(Resource Unavailable) → backoff 재시도 → standard 폴백 ──
    let mut attempt = 0;
    loop {
        let resp = client.post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body).send().await.map_err(|e| format!("{}: {}", label, e))?;
        if resp.status().is_success() {
            let data: Value = resp.json().await.map_err(|e| format!("{} parse: {}", label, e))?;
            let choice = &data["choices"][0];
            let text = choice["message"]["content"].as_str().unwrap_or("");
            if text.trim().is_empty() {
                let reason = choice["finish_reason"].as_str().unwrap_or("unknown");
                let reasoning = choice["message"]["reasoning_content"].as_str().unwrap_or("")
                    .chars().take(200).collect::<String>();
                eprintln!("[{}] empty content (finish={}) reasoning={:?}", label, reason, reasoning);
                return Err(format!("{}: empty response (finish={})", label, reason));
            }
            return Ok(text.to_string());
        }
        let status = resp.status().as_u16();
        let detail = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&detail)
            .ok().and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
            .unwrap_or(detail);
        eprintln!("[{}] HTTP {}: {}", label, status, msg);

        // Flex: 429 Resource Unavailable → 재시도 (5s/15s/35s) 후 standard 폴백 1회
        if flex && status == 429 {
            if attempt < 3 {
                let wait = [5u64, 15, 35][attempt];
                eprintln!("[{}] flex 리소스 부족 → {}s 후 재시도 ({}/3)", label, wait, attempt + 1);
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                attempt += 1;
                continue;
            }
            eprintln!("[{}] flex 3회 실패 → standard 폴백 시도", label);
            let mut std_body = body.clone();
            std_body.as_object_mut().map(|o| o.remove("service_tier"));
            let sresp = client.post(url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&std_body).send().await.map_err(|e| format!("{} standard 폴백: {}", label, e))?;
            if sresp.status().is_success() {
                let data: Value = sresp.json().await.map_err(|e| format!("{} parse: {}", label, e))?;
                let choice = &data["choices"][0];
                let text = choice["message"]["content"].as_str().unwrap_or("");
                if text.trim().is_empty() {
                    return Err(format!("{}: empty response (standard 폴백)", label));
                }
                eprintln!("[{}] standard 폴백 성공", label);
                return Ok(text.to_string());
            }
            let sstatus = sresp.status().as_u16();
            let sdetail = sresp.text().await.unwrap_or_default();
            let smsg = serde_json::from_str::<Value>(&sdetail)
                .ok().and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                .unwrap_or(sdetail);
            return Err(format!("{} HTTP {}: {}", label, sstatus, smsg.chars().take(200).collect::<String>()));
        }
        return Err(format!("{} HTTP {}: {}", label, status, msg.chars().take(200).collect::<String>()));
    }
}

async fn call_anthropic(prompt: &str, api_key: &str, model: &str, max_tokens: u32) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = json!({"model":model,"max_tokens":max_tokens,"messages":[{"role":"user","content":prompt}]});
    let resp = client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body).send().await.map_err(|e| format!("Anthropic: {}", e))?;
    if !resp.status().is_success() { return Err(format!("Anthropic HTTP {}", resp.status().as_u16())); }
    let data: Value = resp.json().await.map_err(|e| format!("Anthropic parse: {}", e))?;
    let text = data["content"][0]["text"].as_str().unwrap_or("");
    Ok(text.to_string())
}

async fn call_lmstudio(prompt: &str, url: &str, model: &str, api_type: &str, max_tokens: u32) -> Result<String, String> {
    let client = reqwest::Client::new();
    let base = url.trim_end_matches('/');
    let (sys, usr) = split_system_user(prompt);
    let mut msgs = vec![];
    if !sys.is_empty() { msgs.push(json!({"role":"system","content":sys})); }
    msgs.push(json!({"role":"user","content":usr}));

    let (endpoint, body) = if api_type == "ollama" {
        (format!("{}/api/chat", base),
         json!({"model":model,"messages":msgs,"stream":false}))
    } else {
        (format!("{}/v1/chat/completions", base),
         json!({"messages":msgs,"temperature":0.1,"max_tokens":max_tokens}))
    };

    let resp = client.post(&endpoint).json(&body).send().await.map_err(|e| format!("LM Studio: {}", e))?;
    if !resp.status().is_success() { return Err(format!("LM Studio HTTP {}", resp.status().as_u16())); }
    let data: Value = resp.json().await.map_err(|e| format!("LM Studio parse: {}", e))?;
    let text = if api_type == "ollama" {
        data["message"]["content"].as_str().unwrap_or("")
    } else {
        data["choices"][0]["message"]["content"].as_str()
            .or(data["choices"][0]["message"]["reasoning_content"].as_str())
            .unwrap_or("")
    };
    Ok(text.to_string())
}

const OCR_PROMPT: &str = "유튜브 동영상 썸네일 이미지입니다. 이미지 안에 포함되어 있는 모든 텍스트(자막, 제목, 강조 문구 등)를 그대로 텍스트로 추출해 주세요. 부연 설명 없이 추출된 텍스트만 나열해 주세요.";

async fn extract_thumbnail_text(url: &str, ocr_provider: &str, ocr_key: &str, ocr_model: &str) -> String {
    if url.is_empty() || ocr_key.is_empty() { return String::new(); }
    let client = reqwest::Client::new();
    let bytes = match client.get(url).send().await {
        Ok(r) => match r.bytes().await { Ok(b) => b.to_vec(), Err(_) => return String::new() },
        Err(_) => return String::new(),
    };
    let b64 = B64.encode(&bytes);
    let mime = if url.to_lowercase().contains(".png") { "image/png" } else { "image/jpeg" };

    match ocr_provider {
        "openai" | "openrouter" | "deepseek" => {
            // OpenAI-compatible vision: image_url content block
            let api_url = if ocr_provider == "openai" { "https://api.openai.com/v1/chat/completions" }
                else if ocr_provider == "deepseek" { return String::new(); } // DeepSeek has no vision
                else { "https://openrouter.ai/api/v1/chat/completions" };
            let body = json!({
                "model": ocr_model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {"type": "image_url", "image_url": {"url": format!("data:{};base64,{}", mime, b64)}}
                    ]
                }],
                "max_tokens": 1500
            });
            match client.post(api_url)
                .header("Authorization", format!("Bearer {}", ocr_key))
                .header("Content-Type", "application/json")
                .json(&body).send().await {
                Ok(r) => match r.json::<Value>().await {
                    Ok(data) => data["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string(),
                    Err(_) => String::new(),
                },
                Err(_) => String::new(),
            }
        }
        "anthropic" => {
            let body = json!({
                "model": ocr_model,
                "max_tokens": 1500,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
                    ]
                }]
            });
            match client.post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", ocr_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body).send().await {
                Ok(r) => match r.json::<Value>().await {
                    Ok(data) => data["content"][0]["text"].as_str().unwrap_or("").trim().to_string(),
                    Err(_) => String::new(),
                },
                Err(_) => String::new(),
            }
        }
        _ => {
            // Gemini: inlineData vision
            let body = json!({
                "contents": [{
                    "parts": [
                        {"text": OCR_PROMPT},
                        {"inlineData": {"mimeType": mime, "data": b64}}
                    ]
                }]
            });
            let api_url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", ocr_model, ocr_key);
            match client.post(&api_url).json(&body).send().await {
                Ok(r) => match r.json::<Value>().await {
                    Ok(data) => data["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or("").trim().to_string(),
                    Err(_) => String::new(),
                },
                Err(_) => String::new(),
            }
        }
    }
}

fn split_system_user(prompt: &str) -> (String, String) {
    if let Some(idx) = prompt.find("Transcript:") {
        (prompt[..idx].trim().to_string(),
         format!("Transcript:\n{}", &prompt[idx + "Transcript:".len()..]))
    } else if let Some(idx) = prompt.find("README text:") {
        (prompt[..idx].trim().to_string(),
         format!("README text:\n{}", &prompt[idx + "README text:".len()..]))
    } else {
        (String::new(), prompt.to_string())
    }
}

// ═══════════════════════════════════════════════════════════
// Response normalization + repair + post-processing
// ═══════════════════════════════════════════════════════════

fn normalize_keys(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        let mut mapped = serde_json::Map::new();
        for (k, val) in std::mem::take(obj) {
            let lower = k.to_lowercase();
            let key = match lower.as_str() {
                "summary" => "Summary", "insights" => "Insights", "implications" => "Implications",
                "keywords" => "Keywords", "analysis" => "Analysis", "category" => "Category",
                "timeline" => "Timeline", "title" => "Title", "applications" => "Applications",
                other => other,
            };
            mapped.insert(key.to_string(), val);
        }
        *obj = mapped;
    }
    v
}

/// Repair truncated/broken JSON: balance braces/brackets, fix dangling commas/colons.
fn repair_json(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    let first_brace = text.find('{');
    let first_brace = match first_brace { Some(i) => i, None => return text };
    text = text[first_brace..].to_string();

    // Detect if we're inside an unterminated string
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if ch == '\\' && !escaped { escaped = true; continue; }
        if ch == '"' && !escaped { in_string = !in_string; }
        escaped = false;
    }
    if in_string {
        text.push('"');
    } else {
        text = text.trim().to_string();
        if text.ends_with(',') { text.pop(); }
        if text.ends_with(':') {
            text.pop();
            let t = text.trim().to_string();
            if let Some(last_quote) = t.rfind('"') {
                if let Some(prev_quote) = t[..last_quote].rfind('"') {
                    text = t[..prev_quote].trim().to_string();
                }
            }
        }
        if text.ends_with(',') { text.pop(); }
    }

    // Balance braces/brackets (ignoring strings)
    let mut open_braces = 0i32;
    let mut open_brackets = 0i32;
    in_string = false;
    escaped = false;
    for ch in text.chars() {
        if ch == '\\' && !escaped { escaped = true; continue; }
        if ch == '"' && !escaped { in_string = !in_string; continue; }
        escaped = false;
        if in_string { continue; }
        match ch {
            '{' => open_braces += 1,
            '}' => open_braces -= 1,
            '[' => open_brackets += 1,
            ']' => open_brackets -= 1,
            _ => {}
        }
    }
    while open_brackets > 0 { text.push(']'); open_brackets -= 1; }
    while open_braces > 0 { text.push('}'); open_braces -= 1; }
    text
}

/// Reconstruct JSON from known key positions — robust against LLM escaping mistakes.
fn clean_json_response(raw: &str) -> String {
    let mut clean = raw.trim().to_string();
    // Strip thinking blocks
    let think_re = Regex::new(r"(?s)<think>.*?</think>").unwrap();
    clean = think_re.replace_all(&clean, "").to_string();
    clean = clean.replace("```json", "").replace("```", "").trim().to_string();

    // Timeline: convert array form to string form (handles unclosed brackets)
    let timeline_re = Regex::new(r#""Timeline"\s*:\s*\[([\s\S]*?)(?:\]|\})"#).unwrap();
    if let Some(caps) = timeline_re.captures(&clean) {
        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let replacement = if inner.contains('•') {
            let formatted = inner.replace('"', "").replace("\\n", "\n").replace('\n', "\\n").replace('\r', "");
            format!("\"Timeline\": \"{}\"", formatted)
        } else {
            let items: Vec<String> = Regex::new(r#""([^"\\]*(?:\\.[^"\\]*)*)""#).unwrap()
                .captures_iter(inner).map(|m| m[1].to_string()).collect();
            if items.len() > 1 {
                format!("\"Timeline\": \"{}\"", items.join("\\n"))
            } else {
                let formatted = inner.replace("\\n", "\n").replace('"', "").replace('\n', "\\n").replace('\r', "");
                format!("\"Timeline\": \"{}\"", formatted)
            }
        };
        clean = timeline_re.replace(&clean, replacement.as_str()).to_string();
    }

    clean = repair_json(&clean);

    let first_brace = clean.find('{');
    let last_brace = clean.rfind('}');
    let (first_brace, last_brace) = match (first_brace, last_brace) {
        (Some(f), Some(l)) => (f, l),
        _ => return clean,
    };
    clean = clean[first_brace..=last_brace].to_string();

    // Reconstruct from known keys
    const KNOWN_KEYS: [&str; 10] = ["Summary", "Insights", "Implications", "Keywords", "Analysis", "Category", "Timeline", "Title", "Applications", "usedModel"];
    let mut key_positions: Vec<(String, usize, usize)> = Vec::new(); // (key, startIndex, valueStartIndex)
    for key in KNOWN_KEYS {
        let re = Regex::new(&format!(r#""{}"\s*:\s*(?:\r?\n)?\s*""#, key)).unwrap();
        for m in re.find_iter(&clean) {
            key_positions.push((key.to_string(), m.start(), m.start() + m.as_str().len()));
        }
    }
    key_positions.sort_by_key(|k| k.1);

    if !key_positions.is_empty() {
        let mut reconstructed = String::from("{");
        for (i, (key, _start, value_start)) in key_positions.iter().enumerate() {
            let raw_value_end = if let Some(next) = key_positions.get(i + 1) {
                let pre_next = &clean[..next.1];
                match pre_next.rfind(',') {
                    Some(ci) if ci > *value_start => ci,
                    _ => next.1,
                }
            } else {
                clean.rfind('}').unwrap_or(clean.len())
            };
            let mut value_content = clean[*value_start..raw_value_end].trim().to_string();
            if value_content.ends_with('"') { value_content.pop(); }
            // A. Escape double quotes inside value
            value_content = value_content.replace("\\\"", "\u{1}\u{2}");
            value_content = value_content.replace('"', "\\\"");
            value_content = value_content.replace("\u{1}\u{2}", "\\\"");
            // B. Physical newlines → \n
            value_content = value_content.replace("\r\n", "\\n").replace('\n', "\\n");
            // C. Collapse excessive backslashes
            value_content = value_content.replace("\\\\\\", "\\\\");
            reconstructed.push_str(&format!("\n  \"{}\": \"{}\"", key, value_content));
            if i < key_positions.len() - 1 { reconstructed.push(','); }
        }
        reconstructed.push_str("\n}");
        return reconstructed;
    }

    // Fallback: strip invalid escapes, escape newlines inside strings
    let bad_escape = Regex::new(r#"\\([^"\\/bfnrtu0-9])"#).unwrap();
    clean = bad_escape.replace_all(&clean, "$1").to_string();
    let string_re = Regex::new(r#""([^"\\]*(?:\\.[^"\\]*)*)""#).unwrap();
    clean = string_re.replace_all(&clean, |caps: &regex::Captures| {
        caps[0].replace("\r\n", "\\n").replace('\n', "\\n")
    }).to_string();
    clean
}

/// Post-process summary fields for clean HTML rendering.
/// Converts **bold** → <b>, splits merged bullets, strips hanja, removes prompt leaks.
fn post_process_fields(result: &mut Value) {
    if !result.is_object() { return; }
    let text_fields = ["Summary", "Insights", "Implications", "Analysis", "Timeline", "Applications", "Title"];
    // ── Guard: a field may accidentally contain raw JSON structure (parse fallback
    //    stored the whole LLM response). If it starts with '{' + a known key pattern,
    //    try to re-extract the real value for that key.
    let known_keys: [&str; 9] = ["Summary", "Insights", "Implications", "Keywords", "Analysis", "Category", "Timeline", "Title", "Applications"];
    for key in known_keys {
        let Some(text) = result.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()) else { continue };
        let t = text.trim_start();
        if t.starts_with('{') && (t.contains("\"Summary\":") || t.contains("\"Summary\" :")) {
            // Re-parse the embedded JSON and pull out the matching key's value
            if let Ok(v) = serde_json::from_str::<Value>(t) {
                if let Some(real) = v.get(key).and_then(|x| x.as_str()) {
                    result[key] = json!(real);
                } else if let Some(real) = v.get("Summary").and_then(|x| x.as_str()) {
                    result[key] = json!(real);
                }
            } else {
                // Extract value between "Summary": " and the next unescaped quote
                if let Some(vi) = t.find("\"Summary\":") {
                    let after = &t[vi + "\"Summary\":".len()..];
                    let after = after.trim_start();
                    let after = after.strip_prefix('"').unwrap_or(after);
                    if let Some(end) = after.find('"') {
                        result[key] = json!(after[..end].to_string());
                    }
                }
            }
        }
    }

    let bold_re = Regex::new(r"(?s)\*\*(.+?)\*\*").unwrap();
    let orphan_star = Regex::new(r"\*{2,}").unwrap();
    let merged_star = Regex::new(r"([^\n])(\*[^*]+?:)").unwrap();
    let merged_bullet = Regex::new(r"([^\n])•").unwrap();
    let star_lead = Regex::new(r"^\s*\*\s*").unwrap();
    let bullet_lead = Regex::new(r"^\s*•\s*").unwrap();
    let term_colon = Regex::new(r"^(.+?):(\s*)").unwrap();
    let hanja = Regex::new(r"[\u{4e00}-\u{9fff}\u{3400}-\u{4dbf}\u{f900}-\u{faff}]").unwrap();
    let triple_nl = Regex::new(r"\n{3,}").unwrap();
    let h3_space = Regex::new(r"(?m)^\s*###\s*(.+?)\s*$").unwrap();
    // Keywords: 최대 12개로 강제 제한 (LLM이 지시를 안 지켜도)
    if let Some(kw) = result.get("Keywords").and_then(|v| v.as_str()) {
        let cleaned: Vec<&str> = kw.split(',')
            .map(|k| k.trim().trim_start_matches('#'))
            .filter(|k| !k.is_empty())
            .collect();
        let mut seen: Vec<String> = Vec::new();
        for k in cleaned {
            if seen.len() >= 12 { break; }
            if !seen.iter().any(|s| s == k) { seen.push(k.to_string()); }
        }
        let joined = seen.iter().map(|k| format!("#{}", k)).collect::<Vec<_>>().join(", ");
        result["Keywords"] = json!(joined);
    }

    for key in text_fields {
        let Some(text) = result.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()) else { continue };
        let mut text = text;
        // </h3> 뒤 줄바꿈 강제 (LLM이 소제목과 본문을 붙여 쓴 경우)
        text = text.replace("</h3>\n", "</h3>@@NL@@");  // 이미 줄바꿈 있는 것 보호
        text = text.replace("</h3>", "</h3>\n");          // 없는 것에 줄바꿈 추가
        text = text.replace("@@NL@@", "\n");              // 보호분 복원
        // Literal "\n" (LLM double-escaped JSON) → real newline
        text = text.replace("\\n", "\n");
        // Decode HTML entities the LLM used to dodge quotes (&#39; &quot; &amp; etc.)
        text = text.replace("&#39;", "'").replace("&quot;", "\"").replace("&amp;", "&")
            .replace("&lt;", "<").replace("&gt;", ">").replace("&#x27;", "'").replace("&#34;", "\"");
        // Protect <pre><code> and <blockquote> blocks from bullet/newline transforms
        let pre_re = Regex::new(r"(?s)<pre><code>.*?</code></pre>").unwrap();
        let quote_re = Regex::new(r"(?s)<blockquote>.*?</blockquote>").unwrap();
        let mut pre_blocks: Vec<String> = Vec::new();
        text = pre_re.replace_all(&text, |caps: &regex::Captures| {
            pre_blocks.push(caps[0].to_string());
            format!("__PRE_BLOCK_{}__", pre_blocks.len() - 1)
        }).to_string();
        text = quote_re.replace_all(&text, |caps: &regex::Captures| {
            pre_blocks.push(caps[0].to_string());
            format!("__PRE_BLOCK_{}__", pre_blocks.len() - 1)
        }).to_string();
        // **bold** → <b>
        text = bold_re.replace_all(&text, "<b>$1</b>").to_string();
        text = orphan_star.replace_all(&text, "").to_string();
        // Split merged bullets on same line
        text = merged_star.replace_all(&text, "$1\n$2").to_string();
        text = merged_bullet.replace_all(&text, "$1\n•").to_string();
        // Line-level: * / • bullets → left accent-bar span (no bullet glyph)
        let lines: Vec<String> = text.split('\n').map(|l| {
            let mut line = l.to_string();
            if star_lead.is_match(&line) {
                line = star_lead.replace(&line, "").to_string();
                line = term_colon.replace(&line, "<b>$1:</b>$2").to_string();
                format!("<span class=\"dt-bullet\">{}</span>", line)
            } else if bullet_lead.is_match(&line) {
                line = bullet_lead.replace(&line, "").to_string();
                line = term_colon.replace(&line, "<b>$1:</b>$2").to_string();
                format!("<span class=\"dt-bullet\">{}</span>", line)
            } else {
                line
            }
        }).collect();
        let joined = lines.join("\n");
        text = joined;
        // Remove blank lines right before bullets (LLM tends to add \n\n•)
        let pre_bullet_nl = Regex::new("\\n{2,}(<span class=\"dt-bullet\")").unwrap();
        text = pre_bullet_nl.replace_all(&text, "\n$1").to_string();
        // Strip hanja
        text = hanja.replace_all(&text, "").to_string();
        // ### heading → <h3> (JS used markdown; our frontend renders HTML)
        text = h3_space.replace_all(&text, "<h3>$1</h3>").to_string();
        // Strip numbering from h3 headings: "<h3>1) 제목</h3>" → "<h3>제목</h3>"
        let h3_num = Regex::new(r"<h3>\s*\d+[).]\s*").unwrap();
        text = h3_num.replace_all(&text, "<h3>").to_string();
        // Also handle inline <h3>1) ...</h3> already in HTML form
        let h3_num2 = Regex::new(r"<h3>\s*\d+[).]\s*(.+?)</h3>").unwrap();
        text = h3_num2.replace_all(&text, "<h3>$1</h3>").to_string();
        // Normalize heading spacing
        text = text.replace("</h3>\n\n", "</h3>\n\n").replace("</h3>", "</h3>\n");
        text = triple_nl.replace_all(&text, "\n\n").to_string();
        // Trim lines + whole string
        text = text.split('\n').map(|l| l.trim()).collect::<Vec<_>>().join("\n");
        text = text.trim().to_string();
        // Newlines → <br> for HTML rendering
        text = text.replace('\n', "<br>\n");
        // Collapse blank lines right after h3 headings (</h3><br><br> → </h3><br>)
        let h3_br = Regex::new(r"</h3>(<br>\s*){2,}").unwrap();
        text = h3_br.replace_all(&text, "</h3><br>").to_string();
        // Remove empty <br> directly before/after tables (tighten spacing)
        let tbl_pad = Regex::new(r"(<br>\s*)+<table>").unwrap();
        text = tbl_pad.replace_all(&text, "<table>").to_string();
        let tbl_pad2 = Regex::new(r"</table>(<br>\s*)+").unwrap();
        text = tbl_pad2.replace_all(&text, "</table>").to_string();
        // Restore protected <pre><code> blocks (their internal newlines stay as-is)
        for (i, block) in pre_blocks.iter().enumerate() {
            text = text.replace(&format!("__PRE_BLOCK_{}__", i), block.as_str());
        }
        result[key] = json!(text);
    }

    // ── Keywords normalization: "#AI, #Tech" | "#AI #Tech" | mixed ──
    if let Some(kw) = result.get("Keywords").and_then(|v| v.as_str()).map(|s| s.to_string()) {
        let comma_parts: Vec<&str> = kw.split(',').map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
        let mut all_tokens: Vec<String> = Vec::new();
        for part in comma_parts {
            let hash_count = part.matches('#').count();
            if hash_count > 1 {
                for t in part.split(|c: char| c == ' ' || c == ';').filter(|t| !t.trim().is_empty()) {
                    all_tokens.push(t.trim().to_string());
                }
            } else {
                all_tokens.push(part.to_string());
            }
        }
        let hashtags: Vec<String> = all_tokens.into_iter()
            .filter(|t| t.contains('#'))
            .map(|t| {
                let cleaned = t.trim_end_matches(|c: char| matches!(c, ',' | ';' | ':' | ' ' | '\t')).to_string();
                if cleaned.starts_with('#') { cleaned } else {
                    Regex::new(r"#[\w\u{AC00}-\u{D7AF}]+").unwrap()
                        .find(&t).map(|m| m.as_str().to_string()).unwrap_or(t)
                }
            })
            .collect();
        if !hashtags.is_empty() {
            result["Keywords"] = json!(hashtags.join(", "));
        } else {
            result["Keywords"] = json!(kw.split(',').map(|t| t.trim()).collect::<Vec<_>>().join(", "));
        }
    }

    // ── Prompt instruction leak removal ──
    let leak_patterns: [&str; 10] = [
        "영상의 제목이 던지는 질문이나 주제에 대한",
        "소제목 아래 줄바꿈",
        "볼드 처리된 불렛포인트",
        "적재적소에 혼용",
        "HTML <table> 태그를",
        "<table>의 시작부터 끝",
        "시간 표시 [MM:SS] 절대 포함 금지",
        "각 불렛포인트 항목의 시작 부분에는",
        "분석할 때는 먼저 영상 질문에 대한",
        "따라 할 필요가 없습니다",
    ];
    for key in text_fields {
        let Some(text) = result.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()) else { continue };
        let match_count = leak_patterns.iter().filter(|p| text.contains(**p)).count();
        if match_count >= 2 {
            let earliest = leak_patterns.iter()
                .filter_map(|p| text.find(*p))
                .min().unwrap_or(text.len());
            if earliest < text.len() {
                let after = &text[earliest..];
                if let Some(content_start) = after.find("\n\n•") {
                    let mut t = after[content_start + 2..].trim().to_string();
                    t = t.strip_prefix('•').map(|s| s.trim_start().to_string()).unwrap_or(t);
                    result[key] = json!(format!("• {}", t));
                } else if let Some(content_start) = after.find("\n\n<h3>") {
                    result[key] = json!(after[content_start + 2..].trim().to_string());
                } else {
                    result[key] = json!(after.trim().to_string());
                }
            }
        }
    }
}

fn parse_and_process(raw: &str, model: &str) -> Value {
    let clean = raw.trim().replace("```json", "").replace("```", "").trim().to_string();
    let mut result: Value = serde_json::from_str(&clean).unwrap_or_else(|_| {
        // Try brace-slice fallback
        if let (Some(s), Some(e)) = (clean.find('{'), clean.rfind('}')) {
            serde_json::from_str(&clean[s..=e]).unwrap_or_else(|_| {
                // Full regex repair
                let repaired = clean_json_response(raw);
                serde_json::from_str(&repaired).unwrap_or_else(|_| json!({"Summary": raw}))
            })
        } else if clean.starts_with('{') {
            // LLM forgot to close the JSON object — try appending '}'
            serde_json::from_str(&format!("{clean}}}")).unwrap_or_else(|_| json!({"Summary": raw}))
        } else {
            json!({"Summary": raw})
        }
    });
    result = normalize_keys(result);
    // Arrays/objects in flat-string fields (LLM sometimes outputs arrays) → join into text
    if let Some(obj) = result.as_object_mut() {
        let flat_keys = ["Summary", "Insights", "Implications", "Analysis", "Timeline", "Applications"];
        for k in flat_keys {
            if let Some(v) = obj.get_mut(k) {
                if let Some(arr) = v.as_array() {
                    let joined: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                    *v = json!(joined.join("\n"));
                }
            }
        }
    }
    post_process_fields(&mut result);
    if let Some(obj) = result.as_object_mut() {
        let expected = ["Summary","Insights","Implications","Keywords","Analysis","Category","Timeline","Title","Applications"];
        for k in &expected {
            if !obj.contains_key(*k) {
                obj.insert((*k).to_string(), json!(""));
            }
        }
        obj.insert("usedModel".into(), json!(model));
    }
    result
}
