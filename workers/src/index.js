// ═══════════════════════════════════════════════════════════════
// SUMMARIZER Cloudflare Worker — 웹 동기화 API (R2 저장)
// ═══════════════════════════════════════════════════════════════
//
// 엔드포인트: /api/sync
//   GET    /api/sync?table=videos          → 전체 조회 (purge 적용)
//   GET    /api/sync?table=videos&since=... → updated_at > since (pull용)
//   POST   /api/sync?table=videos           → 레코드 upsert (body: {id, ...} 또는 배열)
//   PATCH  /api/sync?table=videos&id=xxx   → 부분 수정 (body: {field: val})
//
// 데이터: Cloudflare R2 버킷 (binding: SUMMARIZER_BUCKET)에 JSON 파일로 저장
//   videos.json, github_repos.json, settings.json
//
// Vercel Blob(@vercel/blob) → R2(env.SUMMARIZER_BUCKET) 교체.
//   - strongly consistent (Vercel Blob의 eventual consistency + memCache 우회 불필요)
//   - CACHE_TTL_MS는 안전 마진으로 5초 유지 (다중 isolate race 대비)
//   - BLOB_READ_WRITE_TOKEN 환경변수 불필요 (binding이 자동 주입)
//
// 동기화 규칙(vercel-deploy/api/sync.js와 100% 동일):
//   - PATCH: 상태 필드(read/favorite/deleted/saved) 변경 시 ts + updated_at 갱신
//   - POST: 이중 병합 (① 상태 ts 비교 — 웹 최신이면 웹 유지, ② 요약 메타 updated_at 비교)
//   - 7일 경과 deleted 레코드 자동 purge

const BLOB_FILES = {
  videos: 'videos.json',
  github_repos: 'github_repos.json',
  settings: 'settings.json',
};

// R2 strongly consistent지만 안전 마진으로 짧은 TTL 유지
// (Worker isolate 인스턴스 간 memCache 어긋남 방지)
const CACHE_TTL_MS = 5000;
let memCache = {}; // { [table]: { data, at } }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tableKey(table) {
  return BLOB_FILES[table] || null;
}

// ───────── I/O 헬퍼: R2 binding으로 교체 ─────────

// R2 public bucket URL — wrangler.jsonc의 env.R2_PUBLIC_URL 또는 기본값 사용
// (이전 vercel-deploy의 blobPublicUrl 패턴과 동일)
// env는 fetch(request, env, ctx) 시그니처의 두 번째 인자 — module-level 접근 불가
// → fetchAll에서 ctx를 통해 전달받도록 변경
let CURRENT_ENV = null;

function r2PublicUrl(key, env) {
  // R2_PUBLIC_URL은 배포 시 환경변수로 주입 (하드코딩 금지 — 개인 버킷 URL 노출 방지)
  const base = (env && env.R2_PUBLIC_URL) || '';
  if (!base) throw new Error('R2_PUBLIC_URL 미설정 — wrangler.jsonc vars 또는 환경변수 필요');
  return `${base}/${key}`;
}

async function readAll(table, env) {
  const key = tableKey(table);
  if (!key) return [];
  // [DEBUG] 캐시 무시하고 매번 직접 fetch
  const publicUrl = r2PublicUrl(key, env);
  try {
    const url = publicUrl + '?t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text || !text.trim()) return [];
    const data = JSON.parse(text);
    return data;
  } catch (e) {
    console.log(`[readAll] ERR: ${e.message || e}`);
    return [];
  }
}

async function writeAll(table, records, env) {
  const key = tableKey(table);
  if (!key) return false;
  try {
    memCache[table] = { data: records, at: Date.now() };
    // R2 binding PUT (Strongly consistent — 같은 isolate에서 즉시 가시)
    await env.SUMMARIZER_BUCKET.put(key, JSON.stringify(records), {
      httpMetadata: { contentType: 'application/json' },
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ───────── purge: 7일 경과 deleted 자동 제거 ─────────

function purgeExpired(records) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  return records.filter(r => {
    if (String(r.deleted) !== '1') return true;
    const ts = r.deleted_ts;
    if (!ts) return true;
    const t = new Date(ts).getTime();
    return isNaN(t) || t > cutoff;
  });
}

async function readAllPurged(table, env) {
  const records = await readAll(table, env);
  if (table === 'settings') return records;
  const purged = purgeExpired(records);
  if (purged.length !== records.length) {
    await writeAll(table, purged, env);
  }
  return purged;
}

// ───────── 핸들러: 이전 sync.js의 handler()와 100% 동일 로직 ─────────

export default {
  async fetch(request, env, ctx) {
    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    const url = new URL(request.url);
    const table = url.searchParams.get('table') || 'videos';
    const id = url.searchParams.get('id') || '';
    const since = url.searchParams.get('since') || '';
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // /api/sync 가 아니면 정적 자산 서빙 (env가 정의된 상태에서 env.ASSETS 접근)
    if (!url.pathname.startsWith('/api/')) {
      try {
        return await env.ASSETS.fetch(request);
      } catch (e) {
        return new Response('Asset not found: ' + url.pathname, { status: 404 });
      }
    }

    try {
      // GET — 전체 조회 또는 since 필터링
      if (method === 'GET') {
        let records = await readAllPurged(table, env);
        if (since) {
          records = records.filter(r => (r.updated_at || '') > since);
        }
        return new Response(JSON.stringify(records), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST — settings 객체 병합 / 명시적 __delete 삭제 / 일반 upsert
      if (method === 'POST') {
        const body = await request.json();
        // settings — 객체 병합
        if (table === 'settings') {
          const cur = (await readAll('settings', env)) || {};
          const merged = { ...cur, ...body };
          await writeAll('settings', merged, env);
          return new Response(JSON.stringify({ success: true, count: Object.keys(merged).length }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // 명시적 삭제
        if (body && Array.isArray(body.__delete)) {
          const del = new Set(body.__delete);
          let records = await readAllPurged(table, env);
          const before = records.length;
          records = records.filter(r => !del.has(r.id));
          if (records.length !== before) {
            await writeAll(table, records, env);
          }
          return new Response(JSON.stringify({ success: true, deleted: before - records.length, count: records.length }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // upsert
        const items = Array.isArray(body) ? body : [body];
        if (!items.length || !items[0] || !items[0].id) {
          return new Response(JSON.stringify({ error: 'id required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        let records = await readAllPurged(table, env);
        const byId = new Map(records.map(r => [r.id, r]));
        for (const record of items) {
          const existing = byId.get(record.id);
          if (existing) {
            const merged = { ...existing, ...record };
            // ① 상태 필드 ts 비교
            for (const f of ['read', 'favorite', 'deleted', 'saved']) {
              const tsCol = f + '_ts';
              const lt = record[tsCol] || '';
              const wt = existing[tsCol] || '';
              if (wt && (!lt || wt > lt)) {
                if (existing[f] !== undefined) merged[f] = existing[f];
                merged[tsCol] = wt;
              }
            }
            // ② 요약 메타 updated_at 비교
            const lua = record.updated_at || '';
            const wua = existing.updated_at || '';
            const META = ['title', 'summary', 'insights', 'analysis', 'applications', 'implications', 'keywords', 'timeline', 'category', 'model', 'image_url', 'channel_name', 'description'];
            if (wua && (!lua || wua > lua)) {
              for (const f of META) {
                if (existing[f] !== undefined && existing[f] !== '') merged[f] = existing[f];
              }
            } else {
              for (const f of ['summary', 'analysis', 'insights', 'applications', 'implications', 'keywords', 'timeline']) {
                if (!(record[f] && String(record[f]).trim())) merged[f] = existing[f] || '';
              }
            }
            byId.set(record.id, merged);
          } else {
            byId.set(record.id, record);
          }
        }
        records = Array.from(byId.values());
        await writeAll(table, records, env);
        return new Response(JSON.stringify({ success: true, count: records.length }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH — 부분 수정 + ts + updated_at 갱신
      if (method === 'PATCH') {
        if (!id) {
          return new Response(JSON.stringify({ error: 'id required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        let records = await readAllPurged(table, env);
        const idx = records.findIndex(r => r.id === id);
        if (idx < 0) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const upd = await request.json();
        const TS_MAP = { read: 'read_ts', favorite: 'favorite_ts', deleted: 'deleted_ts', saved: 'saved_ts' };
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        for (const f of Object.keys(TS_MAP)) {
          if (f in upd) upd[TS_MAP[f]] = now;
        }
        records[idx] = { ...records[idx], ...upd, updated_at: now };
        await writeAll(table, records, env);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};