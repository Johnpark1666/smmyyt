use rusqlite::Connection;
use serde_json::json;
use std::sync::Mutex;
use std::path::PathBuf;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(data_dir: &PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("smmy.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                title TEXT DEFAULT '',
                channel_name TEXT DEFAULT '',
                channel_id TEXT DEFAULT '',
                channel_avatar TEXT DEFAULT '',
                video_url TEXT DEFAULT '',
                publish_date TEXT DEFAULT '',
                duration TEXT DEFAULT '',
                processed_at TEXT DEFAULT '',
                read INTEGER DEFAULT 0,
                favorite INTEGER DEFAULT 0,
                summary TEXT DEFAULT '',
                insights TEXT DEFAULT '',
                applications TEXT DEFAULT '',
                implications TEXT DEFAULT '',
                analysis TEXT DEFAULT '',
                keywords TEXT DEFAULT '',
                category TEXT DEFAULT '',
                timeline TEXT DEFAULT '',
                model TEXT DEFAULT '',
                image_url TEXT DEFAULT '',
                excluded INTEGER DEFAULT 0,
                saved INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT '',
                deleted TEXT DEFAULT '0',
                read_ts TEXT DEFAULT '',
                favorite_ts TEXT DEFAULT '',
                deleted_ts TEXT DEFAULT '',
                saved_ts TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS channels (
                channel_id TEXT PRIMARY KEY,
                channel_name TEXT DEFAULT '',
                active INTEGER DEFAULT 1,
                avatar TEXT DEFAULT '',
                registered_at TEXT DEFAULT '',
                source TEXT DEFAULT 'csv'
            );
            CREATE TABLE IF NOT EXISTS github_repos (
                id TEXT PRIMARY KEY,
                title TEXT DEFAULT '',
                channel_name TEXT DEFAULT '',
                owner TEXT DEFAULT '',
                description TEXT DEFAULT '',
                language TEXT DEFAULT '',
                stars TEXT DEFAULT '0',
                forks TEXT DEFAULT '0',
                avatar TEXT DEFAULT '',
                video_url TEXT DEFAULT '',
                publish_date TEXT DEFAULT '',
                duration TEXT DEFAULT '',
                processed_at TEXT DEFAULT '',
                read INTEGER DEFAULT 0,
                favorite INTEGER DEFAULT 0,
                summary TEXT DEFAULT '',
                insights TEXT DEFAULT '',
                applications TEXT DEFAULT '',
                implications TEXT DEFAULT '',
                analysis TEXT DEFAULT '',
                keywords TEXT DEFAULT '',
                category TEXT DEFAULT '',
                model TEXT DEFAULT '',
                image_url TEXT DEFAULT '',
                saved INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT '',
                deleted TEXT DEFAULT '0',
                read_ts TEXT DEFAULT '',
                favorite_ts TEXT DEFAULT '',
                deleted_ts TEXT DEFAULT '',
                saved_ts TEXT DEFAULT ''
            );
        ").map_err(|e| e.to_string())?;

        // Migration: add missing columns
        let _ = conn.execute("ALTER TABLE channels ADD COLUMN source TEXT DEFAULT 'csv'", []);
        for col in ["summary","insights","implications","analysis","keywords","category","timeline","model","image_url","excluded","saved"] {
            let _ = conn.execute(&format!("ALTER TABLE videos ADD COLUMN {} TEXT DEFAULT ''", col), []);
        }
        // Migration: sync columns (updated_at for bidirectional state sync, deleted for soft-delete)
        for col in ["updated_at", "deleted"] {
            let _ = conn.execute(&format!("ALTER TABLE videos ADD COLUMN {} TEXT DEFAULT ''", col), []);
        }
        // Migration: 필드별 상태 시각 (정합성 — 마지막 행동 승리)
        let ts_cols = ["read_ts", "favorite_ts", "deleted_ts", "saved_ts"];
        for col in ts_cols {
            let has = conn.query_row(format!("SELECT 1 FROM pragma_table_info('videos') WHERE name='{}'", col).as_str(), [], |r| r.get::<_, i64>(0)).is_ok();
            if !has {
                let _ = conn.execute(&format!("ALTER TABLE videos ADD COLUMN {} TEXT DEFAULT ''", col), []);
            }
        }
        for col in ts_cols {
            let has = conn.query_row(format!("SELECT 1 FROM pragma_table_info('github_repos') WHERE name='{}'", col).as_str(), [], |r| r.get::<_, i64>(0)).is_ok();
            if !has {
                let _ = conn.execute(&format!("ALTER TABLE github_repos ADD COLUMN {} TEXT DEFAULT ''", col), []);
            }
        }
        // Migration: github_repos columns (owner/description/language/stars/forks/avatar)
        for col in ["owner","description","language","stars","forks","avatar","excluded","applications","saved"] {
            let _ = conn.execute(&format!("ALTER TABLE github_repos ADD COLUMN {} TEXT DEFAULT ''", col), []);
        }
        for col in ["updated_at", "deleted"] {
            let _ = conn.execute(&format!("ALTER TABLE github_repos ADD COLUMN {} TEXT DEFAULT ''", col), []);
        }

        Ok(Database { conn: Mutex::new(conn) })
    }

    // ── Settings ──
    pub fn get_setting(&self, key: &str) -> Option<String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)", [key, value])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 전체 설정을 채널 목록과 함께 내보내기용 JSON으로 반환
    /// (include_sensitive=false면 API 키/토큰 제외)
    pub fn export_config(&self, include_sensitive: bool) -> serde_json::Value {
        let mut settings = self.get_all_settings();
        if !include_sensitive {
            if let Some(obj) = settings.as_object_mut() {
                let sensitive = [
                    "openai_key", "anthropic_key", "deepseek_key", "gemini_key", "openrouter_key",
                    "ocr_key", "cloudflare_token", "google_client_id",
                    "google_client_secret", "google_access_token", "google_refresh_token",
                    "oauth_code_verifier", "glm_key", "grok_key",
                ];
                for k in sensitive {
                    obj.remove(k);
                }
            }
        }
        // sync_last_at 제외 — 새 PC는 전체 pull이 필요
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("sync_last_at");
        }
        json!({
            "app": "SUMMARIZER",
            "version": "3.2.0",
            "exported_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "settings": settings,
            "channels": self.get_channels(),
        })
    }

    /// 내보내기된 설정 JSON을 병합 (settings merge + channels 교체)
    pub fn import_config(&self, data: &serde_json::Value) -> Result<(usize, usize), String> {
        let mut imported_settings = 0usize;
        if let Some(settings) = data.get("settings") {
            if let Some(obj) = settings.as_object() {
                for (k, v) in obj {
                    let val = v.as_str().unwrap_or("").to_string();
                    // 민감/런타임 키는 무시 (불러오기 시 새로 연결)
                    if k == "sync_last_at" { continue; }
                    let _ = self.set_setting(k, &val);
                    imported_settings += 1;
                }
            }
        }
        let mut imported_channels = 0usize;
        if let Some(channels) = data.get("channels").and_then(|c| c.as_array()) {
            imported_channels = self.import_channels(channels)?;
        }
        Ok((imported_settings, imported_channels))
    }

    pub fn get_all_settings(&self) -> serde_json::Value {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare("SELECT key, value FROM settings").unwrap();
        let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap().filter_map(|r| r.ok()).collect();
        let mut map = serde_json::Map::new();
        for (k, v) in rows { map.insert(k, serde_json::Value::String(v)); }
        serde_json::Value::Object(map)
    }

    pub fn merge_settings(&self, updates: &serde_json::Value) -> Result<(), String> {
        if let Some(obj) = updates.as_object() {
            for (k, v) in obj {
                self.set_setting(k, &v.as_str().unwrap_or("").to_string())?;
            }
        }
        Ok(())
    }

    // ── Videos ──
    pub fn get_videos(&self) -> Vec<serde_json::Value> {
        let c = self.conn.lock().unwrap();
        let cols = Self::video_columns();
        let mut stmt = c.prepare(&format!("SELECT {} FROM videos WHERE excluded!='1' AND deleted!='1' ORDER BY processed_at DESC LIMIT 500", cols.join(","))).unwrap();
        stmt.query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, col) in cols.iter().enumerate() {
                let v: String = r.get(i).unwrap_or_default();
                m.insert(col.to_string(), serde_json::Value::String(v));
            }
            Ok(serde_json::Value::Object(m))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn upsert_video(&self, v: &serde_json::Value) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        let cols = ["id","title","channel_name","channel_id","channel_avatar","video_url","publish_date","duration",
            "processed_at","read","favorite","summary","insights","implications","analysis","keywords","category",
            "timeline","model","image_url","excluded","saved"];
        let vals: Vec<String> = cols.iter().map(|col| {
            v.get(*col).and_then(|v| v.as_str()).unwrap_or("").to_string()
        }).collect();
        c.execute(&format!(
            "INSERT OR REPLACE INTO videos({}) VALUES({})",
            cols.join(","), cols.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        ), rusqlite::params_from_iter(vals.iter())).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// deleted=1 + deleted_ts가 days일 이상 지난 레코드 물리 삭제 (purge)
    pub fn purge_deleted(&self, table: &str, days: i64) -> usize {
        let c = self.conn.lock().unwrap();
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days))
            .format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let sql = format!(
            "DELETE FROM {} WHERE deleted='1' AND deleted_ts != '' AND deleted_ts < ?1",
            table
        );
        c.execute(&sql, [cutoff]).unwrap_or(0)
    }

    /// 읽었고(read=1) 별표 안 한(favorite=0) 레코드 중 read_ts가 days일 이상 지난 것 물리 삭제 (자동 정리)
    /// 삭제한 레코드 ID 목록 반환 — 웹 DB에도 명시적으로 전달해 물리 삭제하기 위함 (전체 sweep 아님)
    pub fn purge_read_unfavorite(&self, table: &str, days: i64) -> Vec<String> {
        let c = self.conn.lock().unwrap();
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days))
            .format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let sql = format!(
            "DELETE FROM {} WHERE read='1' AND (favorite IS NULL OR favorite='0' OR favorite='') AND read_ts != '' AND read_ts < ?1 RETURNING id",
            table
        );
        let mut stmt = c.prepare(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map([&cutoff], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
            .unwrap_or_default();
        ids
    }

    pub fn delete_video(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("UPDATE videos SET excluded=1 WHERE id=?1 OR id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_video(&self, id: &str, updates: &serde_json::Value) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        if let Some(obj) = updates.as_object() {
            for (k, v) in obj {
                let val = v.as_str().unwrap_or("");
                c.execute(&format!("UPDATE videos SET {} = ?1 WHERE id = ?2", k), [val, id])
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn get_processed_video_ids(&self) -> std::collections::HashSet<String> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare("SELECT id FROM videos").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    fn video_columns() -> &'static [&'static str] {
        &["id","title","channel_name","channel_id","channel_avatar","video_url","publish_date","duration",
          "processed_at","read","favorite","summary","insights","implications","analysis","keywords","category",
          "timeline","model","image_url","excluded","saved","updated_at","deleted", "read_ts", "favorite_ts", "deleted_ts", "saved_ts"]
    }

    // ── Channels ──
    pub fn get_channels(&self) -> Vec<serde_json::Value> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare("SELECT channel_id, channel_name, active, avatar, registered_at, source FROM channels ORDER BY registered_at DESC").unwrap();
        stmt.query_map([], |r| {
            let mut m = serde_json::Map::new();
            m.insert("channelId".into(), serde_json::Value::String(r.get::<_,String>(0).unwrap_or_default()));
            m.insert("channelName".into(), serde_json::Value::String(r.get::<_,String>(1).unwrap_or_default()));
            m.insert("active".into(), serde_json::Value::Bool(r.get::<_,i32>(2).unwrap_or(1) == 1));
            m.insert("avatar".into(), serde_json::Value::String(r.get::<_,String>(3).unwrap_or_default()));
            m.insert("registeredAt".into(), serde_json::Value::String(r.get::<_,String>(4).unwrap_or_default()));
            m.insert("source".into(), serde_json::Value::String(r.get::<_,String>(5).unwrap_or_default()));
            Ok(serde_json::Value::Object(m))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn import_channels(&self, channels: &[serde_json::Value]) -> Result<usize, String> {
        let c = self.conn.lock().unwrap();
        let mut count = 0;
        // ① upsert: 기존 채널은 이름/활성 갱신, 신규는 추가 (youtube 소스)
        for ch in channels {
            let cid = ch.get("channelId").and_then(|v| v.as_str()).unwrap_or("");
            if cid.is_empty() { continue; }
            let name = ch.get("channelName").and_then(|v| v.as_str()).unwrap_or("");
            let src = ch.get("source").and_then(|v| v.as_str()).unwrap_or("csv");
            let existing: Option<String> = c.query_row("SELECT channel_id FROM channels WHERE channel_id=?1", [cid], |r| r.get(0)).ok();
            match existing {
                Some(_) => {
                    // 기존 채널: 구글 목록과 일치하면 이름/활성 갱신 + source를 youtube로 재분류
                    // (csv로 등록됐어도 구글 구독이면 동기화 대상이 되도록 — 최초 1회 동기화로 전환)
                    if src == "youtube" {
                        c.execute("UPDATE channels SET channel_name=?1, active=1, source='youtube' WHERE channel_id=?2", [name, cid]).map_err(|e| e.to_string())?;
                    } else {
                        c.execute("UPDATE channels SET channel_name=?1, active=1 WHERE channel_id=?2", [name, cid]).map_err(|e| e.to_string())?;
                    }
                }
                None => {
                    c.execute("INSERT INTO channels(channel_id, channel_name, active, registered_at, source) VALUES(?1,?2,1,datetime('now'),?3)", [cid, name, src]).map_err(|e| e.to_string())?;
                    count += 1;
                }
            }
        }
        // ② 해지 반영: youtube 소스 중 이번 목록에 없는 활성 채널 → active=0 (구독 해지)
        let incoming: std::collections::HashSet<String> = channels.iter()
            .filter_map(|ch| ch.get("channelId").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        if !incoming.is_empty() {
            let mut stmt = c.prepare("SELECT channel_id FROM channels WHERE source='youtube' AND active=1").map_err(|e| e.to_string())?;
            let ids: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
                .filter_map(|r| r.ok()).collect();
            drop(stmt);
            for id in ids {
                if !incoming.contains(&id) {
                    c.execute("UPDATE channels SET active=0 WHERE channel_id=?1", [&id]).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(count)
    }

    pub fn delete_channel(&self, channel_id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM channels WHERE channel_id=?1", [channel_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── GitHub Repos ──
    pub fn get_github_repos(&self) -> Vec<serde_json::Value> {
        let c = self.conn.lock().unwrap();
        let cols = ["id","title","channel_name","owner","description","language","stars","forks","avatar","video_url","publish_date","duration","processed_at","read","favorite",
            "summary","insights","applications","implications","analysis","keywords","category","model","image_url","saved","updated_at","deleted"];
        let mut stmt = c.prepare(&format!("SELECT {} FROM github_repos WHERE deleted!='1' ORDER BY processed_at DESC LIMIT 200", cols.join(","))).unwrap();
        stmt.query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, col) in cols.iter().enumerate() {
                let v: String = r.get(i).unwrap_or_default();
                m.insert(col.to_string(), serde_json::Value::String(v));
            }
            Ok(serde_json::Value::Object(m))
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn upsert_github_repo(&self, v: &serde_json::Value) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        let cols = ["id","title","channel_name","owner","description","language","stars","forks","avatar","video_url","publish_date","duration","processed_at","read","favorite",
            "summary","insights","applications","implications","analysis","keywords","category","model","image_url","saved","updated_at","deleted"];
        let vals: Vec<String> = cols.iter().map(|col| {
            v.get(*col).and_then(|v| v.as_str()).unwrap_or("").to_string()
        }).collect();
        c.execute(&format!(
            "INSERT OR REPLACE INTO github_repos({}) VALUES({})",
            cols.join(","), cols.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        ), rusqlite::params_from_iter(vals.iter())).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Web sync helpers ──
    /// 테이블(videos|github_repos)에서 id로 단일 레코드 조회 (동기화 병합용)
    pub fn get_sync_record(&self, table: &str, id: &str) -> Option<serde_json::Value> {
        let c = self.conn.lock().unwrap();
        let cols = if table == "videos" { Self::video_columns().join(",") } else {
            ["id","title","channel_name","owner","description","language","stars","forks","avatar","video_url","publish_date","duration","processed_at","read","favorite","summary","insights","applications","implications","analysis","keywords","category","model","image_url","saved","updated_at","deleted","read_ts","favorite_ts","deleted_ts","saved_ts"].join(",")
        };
        let sql = format!("SELECT {} FROM {} WHERE id=?1", cols, table);
        c.query_row(&sql, [id], |r| {
            let mut m = serde_json::Map::new();
            for (i, col) in cols.split(',').enumerate() {
                let v: String = r.get(i).unwrap_or_default();
                m.insert(col.to_string(), serde_json::Value::String(v));
            }
            Ok(serde_json::Value::Object(m))
        }).ok()
    }

    /// 테이블에 레코드 upsert (동기화 병합 결과 저장)
    pub fn upsert_sync_record(&self, table: &str, v: &serde_json::Value) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        let cols: Vec<&str> = if table == "videos" {
            Self::video_columns().to_vec()
        } else {
            vec!["id","title","channel_name","owner","description","language","stars","forks","avatar","video_url","publish_date","duration","processed_at","read","favorite","summary","insights","applications","implications","analysis","keywords","category","model","image_url","saved","updated_at","deleted","read_ts","favorite_ts","deleted_ts","saved_ts"]
        };
        let vals: Vec<String> = cols.iter().map(|col| {
            v.get(*col).and_then(|x| x.as_str()).unwrap_or("").to_string()
        }).collect();
        c.execute(&format!(
            "INSERT OR REPLACE INTO {}({}) VALUES({})",
            table, cols.join(","), cols.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        ), rusqlite::params_from_iter(vals.iter())).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// last_sync_at 이후 updated_at이 변경된 레코드 조회 (push 대상)
    pub fn get_sync_records_since(&self, table: &str, last_sync_at: &str) -> Vec<serde_json::Value> {
        let c = self.conn.lock().unwrap();
        let cols = if table == "videos" { Self::video_columns().join(",") } else {
            ["id","title","channel_name","owner","description","language","stars","forks","avatar","video_url","publish_date","duration","processed_at","read","favorite","summary","insights","applications","implications","analysis","keywords","category","model","image_url","saved","updated_at","deleted","read_ts","favorite_ts","deleted_ts","saved_ts"].join(",")
        };
        let sql = if last_sync_at.is_empty() {
            format!("SELECT {} FROM {} LIMIT 1000", cols, table)
        } else {
            format!("SELECT {} FROM {} WHERE updated_at > ?1 AND updated_at != '' LIMIT 1000", cols, table)
        };
        let mut stmt = c.prepare(&sql).unwrap();
        // INTEGER 컬럼(read/favorite)은 String으로 읽으면 타입 에러 → i64 fallback으로 숫자→문자열 변환
        // (이 버그로 서버 push가 웹의 read 상태를 ''로 덮어쓰고 있었음 — 2026-08-17 실측)
        let get_str = |r: &rusqlite::Row, i: usize| -> String {
            match r.get::<_, String>(i) {
                Ok(s) => s,
                Err(_) => r.get::<_, i64>(i).map(|n| n.to_string()).unwrap_or_default(),
            }
        };
        let iter: Vec<serde_json::Value> = if last_sync_at.is_empty() {
            stmt.query_map([], |r| {
                let mut m = serde_json::Map::new();
                for (i, col) in cols.split(',').enumerate() {
                    let v = get_str(r, i);
                    m.insert(col.to_string(), serde_json::Value::String(v));
                }
                Ok(serde_json::Value::Object(m))
            }).unwrap().filter_map(|r| r.ok()).collect()
        } else {
            stmt.query_map([last_sync_at], |r| {
                let mut m = serde_json::Map::new();
                for (i, col) in cols.split(',').enumerate() {
                    let v = get_str(r, i);
                    m.insert(col.to_string(), serde_json::Value::String(v));
                }
                Ok(serde_json::Value::Object(m))
            }).unwrap().filter_map(|r| r.ok()).collect()
        };
        iter
    }

    pub fn delete_github_repo(&self, id: &str) -> Result<(), String> {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM github_repos WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }
}
