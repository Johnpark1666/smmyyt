#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SMMYNP Vercel Blob → Cloudflare R2 데이터 이관 스크립트 (범용)
//
// 이 스크립트는 SMMYNP 앱 배포본 안에서 호출되거나,
// 사용자가 직접 실행하는 1회성 마이그레이션 도구입니다.
//
// 사용법 (사용자가 직접 실행):
//   1. vercel-deploy URL을 env 또는 --from 인자로 전달:
//      VERCEL_VIEWER=https://my-old.vercel.app node workers/migrate.js
//      또는
//      node workers/migrate.js --from https://my-old.vercel.app
//   2. Cloudflare 인증 확인 (wrangler whoami 성공)
//   3. 새 R2 버킷 자동 생성 (summarizer-data 또는 --to 버킷명)
//   4. 데이터 다운로드 → 보정 → 업로드
//
// 호출 시 옵션:
//   --from <url>     : 이전 Vercel 뷰어 URL (env: VERCEL_VIEWER)
//   --to <bucket>    : 새 R2 버킷 이름 (env: R2_BUCKET, 기본: summarizer-data)
//   --skip-download   : 이미 다운로드된 파일 사용 (workers/_migration/*.json)
//   --skip-upload     : 다운로드만 (디버그/검증용)
//   --yes            : 모든 confirm 프롬프트 자동 yes
//
// ⚠️ 안전:
//   - R2에 이미 데이터가 있어도 videos/repos/settings 3개 파일을 통째로 덮어씀
//   - 큰 데이터(200+ 레코드)는 한 번에 처리 (Vercel Blob은 chunked 응답이라 안전)
//   - 백업은 자동 생성 안 함 — 필요하면 실행 전 ./workers/_migration/ 폴더를 별도 복사
// ═══════════════════════════════════════════════════════════════

const TABLES = ['videos', 'github_repos', 'settings'];
const OUT_DIR = './workers/_migration';

// ───────── CLI 인자 파싱 ─────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    from: process.env.VERCEL_VIEWER || '',
    to: process.env.R2_BUCKET || 'summarizer-data',
    skipDownload: false,
    skipUpload: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--from':
        if (!args[i + 1]) throw new Error('--from <url> 필요');
        opts.from = args[++i];
        break;
      case '--to':
        if (!args[i + 1]) throw new Error('--to <bucket> 필요');
        opts.to = args[++i];
        break;
      case '--skip-download': opts.skipDownload = true; break;
      case '--skip-upload': opts.skipUpload = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
    }
  }
  if (!opts.from) {
    printHelp();
    throw new Error('--from 또는 env VERCEL_VIEWER 필요 (예: --from https://my-app.vercel.app)');
  }
  // URL 검증
  try {
    const u = new URL(opts.from);
    if (!u.protocol.startsWith('http')) throw new Error();
  } catch {
    throw new Error(`잘못된 --from 값: ${opts.from} (https://로 시작해야 함)`);
  }
  return opts;
}

function printHelp() {
  console.log(`
SMMYNP Vercel → Cloudflare R2 데이터 이관

사용법:
  node workers/migrate.js --from <vercel-url> [--to <bucket>] [옵션]

옵션:
  --from <url>       이전 vercel-deploy 뷰어 URL (필수)
  --to <bucket>      새 R2 버킷 이름 (기본: summarizer-data)
  --skip-download    이미 받은 데이터로 업로드만
  --skip-upload      다운로드만
  --yes, -y          모든 confirm 자동 yes
  --help, -h         도움말

예시:
  node workers/migrate.js --from https://my-old-app.vercel.app
  VERCEL_VIEWER=https://my-old.vercel.app node workers/migrate.js
`);
}

// ───────── 다운로드 ─────────

async function downloadAll(vercelViewer) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const table of TABLES) {
    const url = `${vercelViewer}/api/sync?table=${table}&t=${Date.now()}`;
    console.log(`⬇️  GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${table} 다운로드 실패: HTTP ${res.status} — 이전 Vercel URL이 맞는지, 사이트가 살아있는지 확인하세요.`);
    }
    const data = await res.json();
    const outPath = path.join(OUT_DIR, `${table}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    const count = Array.isArray(data) ? data.length : Object.keys(data).length;
    console.log(`   → ${outPath}  (${count}건)`);
  }
}

// ───────── updated_at 빈 레코드 보정 ─────────

function fillEmptyUpdatedAt() {
  const fs = require('fs');
  const path = require('path');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (const table of ['videos', 'github_repos']) {
    const p = path.join(OUT_DIR, `${table}.json`);
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    let fixed = 0;
    for (const r of arr) {
      if (!r.updated_at) {
        r.updated_at = r.processed_at || r.published_at || now;
        fixed++;
      }
    }
    fs.writeFileSync(p, JSON.stringify(arr, null, 2));
    if (fixed > 0) console.log(`🔧 ${table}: ${fixed}건의 updated_at 보정 (UTC ISO8601)`);
  }
}

// ───────── settings에서 구 vercel_* 키 제거 ─────────

function cleanSettings() {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(OUT_DIR, 'settings.json');
  if (!fs.existsSync(p)) return;
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const removed = [];
  for (const k of ['vercel_token', 'vercel_blob_id', 'vercel_url', 'sync_url', 'sync_last_at']) {
    if (k in obj) {
      delete obj[k];
      removed.push(k);
    }
  }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  if (removed.length) console.log(`🧹 settings에서 이전 키 제거: ${removed.join(', ')}`);
}

// ───────── R2 업로드 ─────────

function ensureBucket(bucket) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`npx wrangler r2 bucket list`, { encoding: 'utf-8' });
    if (out.includes(bucket)) {
      console.log(`✓ R2 버킷 '${bucket}' 이미 있음`);
      return;
    }
  } catch (e) {
    throw new Error('wrangler 인증 실패 — `npx wrangler whoami` 실행해서 로그인/토큰 확인하세요.');
  }
  console.log(`📦 R2 버킷 '${bucket}' 생성...`);
  execSync(`npx wrangler r2 bucket create "${bucket}"`, { stdio: 'inherit' });
}

function uploadToR2(bucket) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  for (const table of TABLES) {
    const file = path.join(OUT_DIR, `${table}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`⚠️  ${file} 없음 — 스킵`);
      continue;
    }
    const cmd = `npx wrangler r2 object put "${bucket}" "${table}.json" --file "${file}" --content-type "application/json"`;
    console.log(`⬆️  ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }
}

// ───────── 메인 ─────────

(async () => {
  const opts = parseArgs();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' SMMYNP Vercel → Cloudflare R2 데이터 이관');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`이전 Vercel URL: ${opts.from}`);
  console.log(`새 R2 버킷:      ${opts.to}`);
  console.log('');

  if (!opts.skipDownload) {
    console.log('▶️  1단계: 이전 Vercel에서 데이터 다운로드');
    await downloadAll(opts.from);
  } else {
    console.log('⏭  1단계: 다운로드 스킵 (--skip-download)');
  }

  console.log('\n▶️  2단계: updated_at 빈 레코드 보정');
  fillEmptyUpdatedAt();

  console.log('\n▶️  3단계: settings에서 이전 vercel 키 제거');
  cleanSettings();

  if (!opts.skipUpload) {
    console.log('\n▶️  4단계: R2 버킷 확인/생성');
    ensureBucket(opts.to);

    console.log('\n▶️  5단계: R2 업로드');
    uploadToR2(opts.to);
  } else {
    console.log('\n⏭  4~5단계: 업로드 스킵 (--skip-upload)');
  }

  console.log('\n✅ 이관 완료!');
  console.log(`   새 Worker의 /api/sync?table=videos로 GET해서 확인하세요.`);
  console.log(`   다음 단계: Settings.jsx에서 "Cloudflare 연동" → [원클릭 배포] 누르면 새 도메인이 생성됩니다.`);
})().catch(e => {
  console.error('\n❌ 실패:', e.message || e);
  process.exit(1);
});