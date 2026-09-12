<div align="center">

# SMMYNP v1.0.0

**YouTube / GitHub 영상·레포 AI 요약 — Pure Rust Tauri 데스크톱 앱**

![Tauri](https://img.shields.io/badge/Tauri-v2-ffc131?logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021-dea584?logo=rust)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![SQLite](https://img.shields.io/badge/SQLite-bundled-003b57?logo=sqlite)
![Status](https://img.shields.io/badge/Status-Preview-8b5cf6)

🇰🇷 한국어 · <a href="#english">🇺🇸 English</a>

</div>

---

<details id="ko" open>
<summary><b>🇰🇷 한국어</b></summary>

## 개요

SMMYNP는 유튜브 영상과 GitHub 트렌딩 레포지토리를 AI로 요약/분석하는 데스크톱 앱입니다. 자막을 분석해 **요약·분석·인사이트·시사점·키워드·타임라인**을 생성하고, 웹 뷰어로 스마트폰에서도 확인할 수 있습니다.

- **Tauri v2** + **Rust** 백엔드 — 별도 서버/포트 불필요
- **SQLite** 로컬 DB (`rusqlite` bundled)
- **React 19 + TypeScript** 프론트엔드 (Vite)
- **0 ports, 0 Express, 0 Python** — 전부 Rust 바이너리 안에 내장

> ℹ️ **버전 1.0.0** — 로컬 우선 설계로 데이터는 전부 기기 안에 보관됩니다.

## 주요 기능

### 🏠 홈 탭 — 요약 결과 카드

![홈 탭 예시](docs/screenshots/home-sample.png)

> ※ 카드 썸네일은 저작권을 고려해 **AI로 생성한 예시 이미지**입니다.

### 🎬 YouTube 요약
- **FETCH**: 등록 채널의 최신 영상 가져오기 (RSS / Google API)
- **PROCESS**: 선택한 영상 AI 요약 — 자막 기반 (요약·분석·인사이트·시사점·키워드·타임라인)
- **Google 연동 (선택)**: 구독 목록 자동 등록, 재생목록 기반 FETCH, 정확한 쇼츠 필터링, 요청 제한 회피
- 쇼츠 제외 / 기간 설정 / 중복 제외 필터

### 🐙 GitHub 트렌딩 분석
- 주간 트렌딩 레포지토리 수집 → README 기반 AI 분석
- 별점·언어·설명 확인 후 분석할 레포 선택

### 🌐 웹 뷰어 + 동기화
- **원클릭 Cloudflare 배포** — 스마트폰에서 읽음/별/삭제 정리 가능 (PWA, 설치형)
- 앱 시작·종료 시 자동 동기화, 액션별 즉시 반영
- **필드별 타임스탬프 정합성** — 여러 기기에서 동시에 써도 충돌 없음

### 🎨 UI / 설정
- **온보딩 투어** — 첫 실행 시 언어 선택부터 9단계 스포트라이트 가이드
- **한/영 i18n** — 전체 UI 즉시 전환
- **LLM 요약 프롬프트 편집** — 보강(기본 규칙 유지 + 추가 지시) / 대체 모드
- **설정 백업/복원** — 다른 PC로 내보내기/불러오기
- 화면 설정: 기본 정렬 / 폰트 크기 / 액센트 색 / 상세 썸네일 토글
- 라이트 브루탈리즘 디자인

### 🤖 AI 제공자
| 제공자 | 비고 |
|--------|------|
| Google Gemini | 비전 지원 |
| OpenAI | — |
| Anthropic Claude | — |
| OpenRouter | 통합 게이트웨이 |
| DeepSeek | — |
| LM Studio / Ollama | 로컬 LLM (오프라인) |

## 설치

| OS | 다운로드 |
|----|---------|
| **Windows** | `.msi` / `.exe` (Releases 참조) |

## 개발 환경

```bash
# 프론트엔드 dev 서버 (UI만 테스트)
cd client
npm install
npm run dev
# → http://localhost:1420

# 풀스택 Tauri dev (Rust + React HMR)
npm run tauri:dev

# 패키징 (배포용)
npm run tauri:build
```

**요구사항**: [Rust](https://rustup.rs) (edition 2021) · [Node.js](https://nodejs.org) 18+ · Tauri v2 [시스템 의존성](https://v2.tauri.app/start/prerequisites/)

## 아키텍처

```
SMMYNP/
├── client/               → React 19 + TypeScript 프론트엔드 (Vite)
│   ├── src/pages/        → Dashboard, Results, Settings, GitHubTab ...
│   └── src/lib/api.ts    → invoke() 기반 API 클라이언트
├── src-tauri/            → Tauri v2 + Rust
│   └── src/
│       ├── lib.rs        → Tauri commands + API 라우터
│       ├── db.rs         → SQLite (rusqlite)
│       ├── httpd.rs      → 내장 HTTP 서버 (OAuth 콜백)
│       └── services/
│           ├── llm.rs    → AI 요청 + 프롬프트 빌더
│           ├── sync.rs   → 웹 동기화 (필드별 ts 병합)
│           └── youtube.rs → RSS/YouTube API
├── workers/              → 웹 뷰어 + 동기화 API (Cloudflare Worker + R2)
└── package.json          → npm scripts
```

**포트리스 아키텍처**: 모든 API 호출은 Tauri IPC(`invoke`)로 이루어지며 외부 HTTP 서버가 필요 없습니다. 내장 httpd는 OAuth 콜백 처리용입니다.

## 데이터 안내

- 로컬 DB: `%APPDATA%/com.smmynp.app/smmy.db` (설정 + 채널 + 데이터)
- **백업**: 환경 설정 → 설정 백업/복원 → 내보내기 (파일 탐색기)
- **다른 PC 이전**: 내보내기 → 새 PC에서 불러오기 → 웹 동기화로 데이터 복원
- **웹 뷰어 주의**: URL을 아는 사람은 인증 없이 열람 가능 — 공유 주의

## 라이선스

MIT

</details>

---

<details id="english">
<summary><b>🇺🇸 English</b></summary>

## Overview

SMMYNP is a desktop app that summarizes YouTube videos and GitHub trending repositories with AI. It analyzes captions to generate **summary, analysis, insights, implications, keywords, and timeline**, and lets you check them from your phone via the web viewer.

- **Tauri v2** + **Rust** backend — no separate server or ports
- **SQLite** local DB (`rusqlite` bundled)
- **React 19 + TypeScript** frontend (Vite)
- **0 ports, 0 Express, 0 Python** — everything embedded in the Rust binary

> ℹ️ **Version 1.0.0** — local-first by design; all data stays on your device.

## Features

### 🏠 Home Tab — Summary Cards

![Home tab sample](docs/screenshots/home-sample.png)

> ※ Card thumbnails are **AI-generated sample images** to respect copyright.

### 🎬 YouTube Summaries
- **FETCH**: load latest videos from registered channels (RSS / Google API)
- **PROCESS**: AI summary of selected videos — caption-based (summary, analysis, insights, implications, keywords, timeline)
- **Google connect (optional)**: auto-import subscriptions, playlist-based FETCH, accurate Shorts filtering, no rate limits
- Shorts exclusion / date range / duplicate filters

### 🐙 GitHub Trending Analysis
- Collect weekly trending repos → AI analysis based on README
- Check stars, language, description, then pick repos to analyze

### 🌐 Web Viewer + Sync
- **One-click Cloudflare deploy** — read/star/delete from your phone (PWA, installable)
- Auto-sync on app start/close, instant per-action sync
- **Per-field timestamp reconciliation** — safe concurrent edits across devices

### 🎨 UI / Settings
- **Onboarding tour** — 9-step spotlight guide from language selection
- **KO/EN i18n** — instant full-UI language switch
- **LLM prompt editing** — append (keep base rules + extra instructions) / replace mode
- **Settings backup/restore** — export/import to another PC
- Display options: default sort / font size / accent color / detail thumbnail toggle
- Light brutalism design

### 🤖 AI Providers
| Provider | Notes |
|----------|-------|
| Google Gemini | vision-capable |
| OpenAI | — |
| Anthropic Claude | — |
| OpenRouter | unified gateway |
| DeepSeek | — |
| LM Studio / Ollama | local LLM (offline) |

## Install

| OS | Download |
|----|----------|
| **Windows** | `.msi` / `.exe` (see Releases) |

## Development

```bash
# Frontend dev server (UI only)
cd client
npm install
npm run dev
# → http://localhost:1420

# Full-stack Tauri dev (Rust + React HMR)
npm run tauri:dev

# Package (release)
npm run tauri:build
```

**Requirements**: [Rust](https://rustup.rs) (edition 2021) · [Node.js](https://nodejs.org) 18+ · Tauri v2 [prerequisites](https://v2.tauri.app/start/prerequisites/)

## Architecture

```
SMMYNP/
├── client/               → React 19 + TypeScript frontend (Vite)
│   ├── src/pages/        → Dashboard, Results, Settings, GitHubTab ...
│   └── src/lib/api.ts    → invoke()-based API client
├── src-tauri/            → Tauri v2 + Rust
│   └── src/
│       ├── lib.rs        → Tauri commands + API router
│       ├── db.rs         → SQLite (rusqlite)
│       ├── httpd.rs      → embedded HTTP server (OAuth callback)
│       └── services/
│           ├── llm.rs    → AI requests + prompt builder
│           ├── sync.rs   → web sync (per-field ts merge)
│           └── youtube.rs → RSS/YouTube API
├── workers/              → web viewer + sync API (Cloudflare Worker + R2)
└── package.json          → npm scripts
```

**Portless architecture**: all API calls go through Tauri IPC (`invoke`); no external HTTP server is needed. The embedded httpd only handles OAuth callbacks.

## Data Notes

- Local DB: `%APPDATA%/com.smmynp.app/smmy.db` (settings + channels + data)
- **Backup**: Settings → Backup/Restore → Export (file dialog)
- **Move to another PC**: Export → Import on the new PC → web sync restores data
- **Web viewer caution**: anyone with the URL can view without login — be careful sharing it

## License

MIT

</details>
