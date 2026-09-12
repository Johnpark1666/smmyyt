import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLang } from './lib/i18n';
import api from './lib/api';
import Dashboard from './pages/Dashboard';
import GitHubTab from './pages/GitHubTab';
import UnifiedSettings from './pages/UnifiedSettings';
import YouTubeConnect from './pages/YouTubeConnect';
import Help from './pages/Help';
import Results from './pages/Results';

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './index.css';

const win = getCurrentWindow();
const TITLE_H = 40;

const PAGE_TITLES = {
  '/': { icon: 'home', name: '홈', en: 'Home' },
  '/dashboard': { icon: 'youtube', name: 'YouTube', en: 'YouTube' },
  '/github': { icon: 'github', name: 'GitHub Trending', en: 'GitHub Trending' },
  '/youtube-connect': { icon: 'connection', name: 'YouTube 연결', en: 'YouTube Connect' },
  '/settings': { icon: 'settings', name: '환경 설정', en: 'Settings' },
  '/help': { icon: 'help', name: '도움말', en: 'Help' },
};

// Shared Feather-style icon set — same as sidebar (14px, strokeWidth 2.5)
const PAGE_ICONS = {
  home: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>,
  youtube: <img src="/icons/tabs/youtube.svg" alt="" style={{ width: 14, height: 14 }} />,
  github: <img src="/icons/ysnew2/github.png" alt="" style={{ width: 14, height: 14 }} />,
  connection: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></svg>,
  settings: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  help: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
};

function App() {
  const loc = useLocation();
  const { lang, t, setLang: changeLang } = useLang();
  const page = PAGE_TITLES[loc.pathname] || { icon: '', name: '', en: '' };

  // ── 스켈레톤 (동기화 중 전체 화면) ──
  const [syncing, setSyncing] = useState(false);
  const [closing, setClosing] = useState(false);  // 앱 종료 시 동기화/저장 중
  const [appVersion, setAppVersion] = useState('');  // tauri.conf.json 버전 (하드코딩 없음)
  useEffect(() => { invoke('get_version').then(setAppVersion).catch(() => {}); }, []);

  // ── 온보딩 인터랙티브 투어 (첫 실행 + 데이터 0일 때만) ──
  // 하이라이트 대상 근처로 툴팁이 따라다님 + 사용자 행동을 인식해 자동 진행
  const navigate = useNavigate();
  const navRefs = useRef({});
  const [onb, setOnb] = useState({ visible: false, step: 1 });
  const tourElRef = useRef(null);  // 현재 하이라이트 대상 DOM 요소
  // 대상 요소에 직접 하이라이트 스타일 (좌표 계산 없음 → 위치가 절대 어긋나지 않음)
  const applyHighlight = (el) => {
    clearHighlight();
    if (!el) return;
    el.setAttribute('data-tour-hl', '1');
    el.style.outline = '3px solid #38bdf8';
    el.style.outlineOffset = '3px';
    el.style.boxShadow = '0 0 0 4px #fff, 0 0 24px 8px rgba(56,189,248,0.55)';
  };
  const clearHighlight = () => {
    document.querySelectorAll('[data-tour-hl]').forEach(n => {
      n.removeAttribute('data-tour-hl');
      const el = n as HTMLElement;
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.boxShadow = '';
    });
  };
  const [tipPos, setTipPos] = useState(null);  // 툴팁 동적 위치

  // DOM 요소 찾기 (텍스트 기반, 다국어 후보) — 버튼 우선!
  const findBtn = (texts) => {
    const list = Array.isArray(texts) ? texts : [texts];
    // 1) button 태그 우선 (fetch/process는 실제 클릭 버튼)
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const txt = b.textContent ? b.textContent.trim().toLowerCase() : '';
      if (txt && list.some(x => txt.includes(x.toLowerCase()))) return b;
    }
    // 2) 없으면 섹션 헤더/span에서 검색 (Takeout, AI 제공자 등)
    const others = document.querySelectorAll('.brutal-section-header, span');
    for (const b of others) {
      const txt = b.textContent ? b.textContent.trim().toLowerCase() : '';
      if (txt && list.some(x => txt.includes(x.toLowerCase()))) return b;
    }
    return null;
  };
  // 섹션 전체(하이라이트 범위)로 확장 — .brutal-section 클래스를 조상에서 찾기
  const toSection = (el) => {
    if (!el) return el;
    let cur = el;
    for (let i = 0; i < 4 && cur; i++) {
      if (cur.classList && cur.classList.contains('brutal-section')) return cur;
      cur = cur.parentElement;
    }
    // 못 찾으면 2단계 위로 (span → title div → 섹션 div)
    let up = el;
    for (let i = 0; i < 2 && up; i++) up = up.parentElement;
    return up || el;
  };

  // ── 단계 정의 ──
  const TOUR_STEPS = [
    // 1: 언어 선택 (특수 — 툴팁에 버튼)
    {
      kind: 'lang',
      title: t('언어 선택', 'Choose your language'),
      desc: t('앱 전체의 언어를 선택하세요. 아래 버튼을 누르면 즉시 적용됩니다.', 'Pick the language for the whole app. It applies immediately.'),
      target: null,
    },
    // 2: YouTube 연결 메뉴 하이라이트 → 클릭 인식(경로)
    {
      kind: 'nav', path: '/youtube-connect',
      title: t('YouTube 연결', 'Connect YouTube'),
      desc: t('왼쪽 [YouTube 연결] 메뉴를 눌러보세요. (선택사항 — RSS로도 사용할 수 있어요)', 'Click [Connect YouTube] in the left menu. (Optional — RSS works too)'),
    },
    // 3: Takeout 하이라이트 → 채널 업로드 인식
    {
      kind: 'channels', path: '/youtube-connect', domText: 'takeout',
      title: t('구독 채널 추가', 'Add subscription channels'),
      desc: t('화면의 [Google Takeout CSV 불러오기]를 따라 CSV를 업로드하거나, 채널 URL을 직접 추가해보세요. (나중에 Google 계정 API를 연동하면 더 편합니다)', 'Follow [Import Google Takeout CSV] to upload a CSV, or add a channel URL directly. (Connecting Google later makes this easier)'),
    },
    // 4: 환경 설정 메뉴 → 클릭 인식
    {
      kind: 'nav', path: '/settings',
      title: t('환경 설정', 'Settings'),
      desc: t('왼쪽 [환경 설정] 메뉴를 눌러보세요. AI 모델을 선택하는 곳입니다.', 'Click [Settings] in the left menu. This is where you pick your AI model.'),
    },
    // 5: AI 제공자 + 모두 저장 하이라이트
    {
      kind: 'manual', path: '/settings', domText: 'ai_provider',
      title: t('AI 제공자 선택', 'Choose AI provider'),
      desc: t('사용할 AI를 선택하고 API 키를 입력한 뒤, 우측 하단 [💾 모두 저장] 버튼을 눌러 저장하세요.', 'Pick your AI provider, enter the API key, then press [💾 Save all] at the bottom-right to save.'),
    },
    // 6: YouTube 탭 메뉴 → 클릭 인식
    {
      kind: 'nav', path: '/dashboard',
      title: t('YouTube 탭', 'YouTube tab'),
      desc: t('이제 왼쪽 [YouTube] 메뉴를 눌러 영상을 가져와 볼 차례입니다.', 'Now click [YouTube] in the left menu to fetch some videos.'),
    },
    // 7: FETCH 하이라이트
    {
      kind: 'manual', path: '/dashboard', domText: 'fetch',
      title: t('FETCH — 영상 가져오기', 'FETCH — load videos'),
      desc: t('[▸ fetch] 버튼을 눌러 영상을 가져와 보세요. 전부가 아니라 몇 개만 있으면 충분해요 — 지금은 설정이 잘 됐는지 확인하는 단계니까요.', 'Press [▸ fetch] to load some videos — a few is enough. This step is just to verify your setup works.'),
    },
    // 8: PROCESS 하이라이트
    {
      kind: 'manual', path: '/dashboard', domText: 'process',
      title: t('PROCESS — AI 요약', 'PROCESS — AI summary'),
      desc: t('FETCH 후 첫 번째 영상이 자동으로 선택되어 있습니다. 그대로 [PROCESS]를 눌러보세요. 요약이 정상적으로 나오면 설정이 올바른 것입니다. 확인되면 나머지 영상도 처리하면 됩니다.', 'After FETCH, the first video is auto-selected — just press [PROCESS]. If the summary comes out fine, your setup works — then process the rest.'),
    },
    // 9: 마무리
    {
      kind: 'final',
      title: t('완료! 🎉', 'Done! 🎉'),
      desc: t('첫 요약이 확인됐다면 이제 나머지 영상들도 PROCESS로 처리하면 됩니다. 궁금한 점은 왼쪽 [도움말] 메뉴에서 확인할 수 있어요.', 'Now that your first summary is confirmed, process the rest of the videos with PROCESS. For details, check the [Help] menu on the left.'),
      target: null,
    },
  ];
  const tourStep = TOUR_STEPS[onb.step - 1] || TOUR_STEPS[0];

  useEffect(() => {
    // 도움말에서 '투어 다시 시작' 이벤트 수신
    const openTour = () => { setOnb({ visible: true, step: 1 }); };
    window.addEventListener('summ-tour-open', openTour);
    (async () => {
      try {
        const s = await api.get('/api/settings');
        if (s.data?.onboarding_done === '1') return;
        if (s.data?.google_access_token) return;
        try {
          const ch = await api.get('/api/channels');
          if ((ch.data?.channels || []).length > 0) return;
        } catch { return; }
        try {
          const v = await api.get('/api/videos');
          const vids = Array.isArray(v.data) ? v.data : (v.data?.data || []);
          if (vids.some(x => x.summary)) return;
        } catch { return; }
        setOnb({ visible: true, step: 1 });
      } catch {}
    })();
    return () => window.removeEventListener('summ-tour-open', openTour);
  }, []);

  // ── 행동 인식: nav 클릭(경로) / 채널 업로드(폴링) ──
  useEffect(() => {
    if (!onb.visible) return;
    const s = tourStep;
    if (s.kind === 'nav') {
      // 해당 경로로 이동하면 자동 다음
      if (loc.pathname === s.path) setOnb(p => ({ ...p, step: p.step + 1 }));
    } else if (s.kind === 'channels') {
      // 진입 시점 채널 수(base)를 먼저 확정한 뒤 폴링 시작
      // → 기존 채널로는 절대 안 넘어가고, 새로 추가된 경우만 자동 다음
      let base = 0;
      let iv = null;
      (async () => {
        try { const ch0 = await api.get('/api/channels'); base = (ch0.data?.channels || []).length; } catch {}
        iv = setInterval(async () => {
          try {
            const ch = await api.get('/api/channels');
            if ((ch.data?.channels || []).length > base) {
              clearInterval(iv);
              setOnb(p => ({ ...p, step: p.step + 1 }));
            }
          } catch {}
        }, 2000);
      })();
      return () => { if (iv) clearInterval(iv); };
    } else if (s.kind === 'manual' && s.domText === 'ai_provider') {
      // AI 제공자가 선택되면 자동 다음 (모두 저장 후)
      const iv = setInterval(async () => {
        try {
          const st = await api.get('/api/settings');
          if (st.data?.ai_provider || st.data?.provider) {
            clearInterval(iv);
            setOnb(p => ({ ...p, step: p.step + 1 }));
          }
        } catch {}
      }, 2000);
      return () => clearInterval(iv);
    }
  }, [onb.visible, onb.step, loc.pathname]);

  // ── 하이라이트 (대상 요소 직접 스타일) + 툴팁 위치 ──
  useEffect(() => {
    if (!onb.visible) { clearHighlight(); setTipPos(null); return; }
    const measure = () => {
      let el = null;
      const s = tourStep;
      if (s.kind === 'nav') el = navRefs.current[s.path];
      else if (s.domText === 'takeout') el = toSection(findBtn(['takeout csv']));
      else if (s.domText === 'ai_provider') el = toSection(findBtn(['제공자', 'ai provider']));
      else if (s.domText === 'fetch') el = findBtn('fetch');
      else if (s.domText === 'process') el = findBtn('process');
      if (el) {
        tourElRef.current = el;
        const apply = () => {
          applyHighlight(el);  // 요소에 직접 스타일 — 위치 자동 정확
          // 툴팁 위치
          const r = el.getBoundingClientRect();
          const vw = window.innerWidth;
          const tipW = Math.min(360, vw * 0.4);
          const placeLeft = s.domText === 'takeout';
          if (s.domText === 'ai_provider') {
            setTipPos({ left: Math.max(8, vw - tipW - 16), top: 60 });  // 우측 상단
          } else {
            const left = placeLeft
              ? Math.max(8, r.left - tipW - 14)
              : ((r.right + 14 + tipW) > vw ? Math.max(8, r.left - tipW - 14) : r.right + 14);
            const top = placeLeft ? Math.max(8, r.top) : Math.max(8, r.top + r.height / 2 - 60);
            setTipPos({ left, top });
          }
        };
        if (s.kind === 'nav') {
          apply();  // 사이드바는 항상 보임
        } else {
          // 페이지 내부 요소: 화면 중앙으로 스크롤 후 적용
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
          // 요소가 화면에 보일 때까지 재시도 (최대 3초)
          let tries = 0;
          const iv = setInterval(() => {
            tries++;
            const r = el.getBoundingClientRect();
            const inView = r.width > 0 && r.height > 0 && r.top >= -40 && r.top < window.innerHeight + 40;
            if (inView || tries >= 12) {
              clearInterval(iv);
              apply();
            }
          }, 250);
        }
      } else {
        tourElRef.current = null;
        clearHighlight();
        setTipPos(null);
      }
    };
    const t1 = setTimeout(measure, 350);  // 페이지 렌더링 대기
    return () => {
      clearTimeout(t1);
      clearHighlight();
      tourElRef.current = null;
    };
  }, [onb.visible, onb.step, loc.pathname]);

  const closeTour = () => setOnb(p => ({ ...p, visible: false }));
  const doneOnboarding = () => {
    api.put('/api/settings', { onboarding_done: '1' }).catch(() => {});
    setOnb(p => ({ ...p, visible: false }));
  };
  const pickLang = (code) => {
    changeLang(code);
    setOnb(p => ({ ...p, step: p.step + 1 }));
  };
  const prevTourStep = () => { if (onb.step > 1) setOnb(p => ({ ...p, step: p.step - 1 })); };
  const nextTourStep = () => {
    if (onb.step < TOUR_STEPS.length) { setOnb(p => ({ ...p, step: p.step + 1 })); }
    else { doneOnboarding(); }
  };

  // ── 앱 종료 시: 설정 저장 + 전체 동기화 후 닫기 ──
  useEffect(() => {
    let unlisten = null;
    let closing = false;
    (async () => {
      try {
        unlisten = await listen('sync-before-close', async () => {
          if (closing) return;
          closing = true;
          setClosing(true);
          setSyncing(true);
          try {
            // ① 미저장 설정 저장 (Settings의 dirty 플래그가 true면)
            if (window.__summDirty) {
              try {
                const s = await api.get('/api/settings');
                if (s.data) await api.put('/api/settings', s.data);
              } catch {}
            }
            // ② 전체 동기화 (웹 동기화 설정된 경우)
            try {
              await api.post('/api/sync/now');
            } catch {}
          } catch {}
          // ③ 실제 종료
          try { await invoke('finish_close'); } catch {}
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── 앱 시작 시 자동 웹 동기화 ──
  // 외부(웹 뷰어)에서 변경된 읽음/별/삭제를 로컬에 반영 (pull 우선)
  useEffect(() => {
    // 전역 동기화 상태 이벤트 — Settings 수동 sync도 스켈레톤 연동
    const onStart = () => setSyncing(true);
    const onEnd = () => setSyncing(false);
    window.addEventListener('sync-start', onStart);
    window.addEventListener('sync-end', onEnd);

    const timer = setTimeout(async () => {
      try {
        const s = await api.get('/api/settings');
        if (s.data?.worker_url) {
          setSyncing(true);
          await api.post('/api/sync/now');
        }
      } catch { /* silent — sync is best-effort */ }
      finally {
        // 살짝만 보여주고 숨김 (최소 600ms)
        setTimeout(() => setSyncing(false), 600);
      }
    }, 4000);
    return () => { clearTimeout(timer); window.removeEventListener('sync-start', onStart); window.removeEventListener('sync-end', onEnd); };
  }, []);

  const Btn = ({ onClick, children, hoverBg = '#f1f1f4', hoverColor = '#121212' }) => (
    <button onClick={onClick}
      style={{ width: 36, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 0, color: '#767676', transition: 'background 0.12s, color 0.12s' }}
      onMouseEnter={e => { e.currentTarget.style.background = hoverBg; e.currentTarget.style.color = hoverColor; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#767676'; }}>
      {children}
    </button>
  );

  return (
    <div className="app-layout" style={{ paddingTop: TITLE_H }}>
      {/* Custom title bar */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: TITLE_H, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#fff', borderBottom: '1px solid #d4d4d8', padding: '0 2px 0 12px',
        WebkitAppRegion: 'drag', userSelect: 'none',
      }}>
        {/* Left spacer */}
        <div style={{ width: 80 }} />

        {/* Center: current page title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#767676' }}>
          {PAGE_ICONS[page.icon] || <span>{page.icon}</span>}
          <span>{lang === 'ko' ? page.name : page.en}</span>
        </div>

        {/* Right: utility buttons + window controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, WebkitAppRegion: 'no-drag' }}>
          <Btn onClick={() => window.location.reload()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </Btn>
          <Btn onClick={() => { const a = document.createElement('a'); a.href = '/help'; a.click(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </Btn>
          <div style={{ width: 1, height: 16, background: '#d4d4d8', margin: '0 4px' }} />
          <Btn onClick={() => win.minimize()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="11" width="18" height="2.5" rx="1" /></svg>
          </Btn>
          <Btn onClick={() => win.toggleMaximize()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          </Btn>
          <Btn onClick={() => win.close()} hoverBg="#ef4444" hoverColor="#fff">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </Btn>
        </div>
      </div>

      <aside className="sidebar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 16 }}>
          <img src="/icon-app.png" alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
          <div>
            <h1>SUMMARIZER</h1>
            <div className="sub">{appVersion ? `v${appVersion}-preview` : ''}</div>
          </div>
        </div>
        <nav>
          {[
            { to: '/', end: true, icon: PAGE_ICONS.home, label: t('홈', 'Home') },
            { to: '/dashboard', icon: PAGE_ICONS.youtube, label: 'YouTube' },
            { to: '/github', icon: PAGE_ICONS.github, label: 'GitHub Trending' },
            { to: '/youtube-connect', icon: PAGE_ICONS.connection, label: t('YouTube 연결', 'YouTube Connect') },
            { to: '/settings', icon: PAGE_ICONS.settings, label: t('환경 설정', 'Settings') },
            { to: '/help', icon: PAGE_ICONS.help, label: t('도움말', 'Help') },
          ].map(nav => (
            <NavLink key={nav.to} to={nav.to} end={nav.end}
              ref={el => { navRefs.current[nav.to] = el; }}
              onClick={(e) => {
                // 미저장 변경사항이 있으면 탭 이동 차단
                if (window.__summDirty && !window.confirm(t('저장되지 않은 변경사항이 있습니다. 저장하지 않고 떠날까요?', 'You have unsaved changes. Leave without saving?'))) {
                  e.preventDefault();
                }
              }}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span>{nav.icon}</span> {nav.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        <div style={{ display: loc.pathname === '/' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}>
          <Results />
        </div>
        <div style={{ display: loc.pathname === '/dashboard' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}><Dashboard /></div>
        <div style={{ display: loc.pathname === '/github' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}><GitHubTab /></div>
        <div style={{ display: loc.pathname === '/youtube-connect' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}><YouTubeConnect /></div>
        <div style={{ display: loc.pathname === '/settings' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}><UnifiedSettings /></div>
        <div style={{ display: loc.pathname === '/help' ? 'flex' : 'none', flexDirection: 'column', minHeight: '100%' }}><Help /></div>
      </main>

      {/* ── 동기화 스켈레톤 오버레이 (전체 화면) ── */}
      {onb.visible && (
        <div style={{
          position: 'fixed', zIndex: 9998, width: 'min(360px, 42vw)',
          left: tipPos ? tipPos.left : '50%', top: tipPos ? tipPos.top : '50%',
          transform: tipPos ? 'none' : 'translate(-50%, -50%)',
          pointerEvents: 'auto',
        }}>
          <div style={{ background: '#fff', border: '2px solid #121212', boxShadow: '6px 6px 0 rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '9px 14px', borderBottom: '2px solid #121212', background: '#f6f6f8' }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: '#121212' }}>🚀 {t('시작하기', 'Get started')}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', marginLeft: 'auto' }}>
                {t('단계', 'Step')} {onb.step} / {TOUR_STEPS.length}
              </span>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#121212', marginBottom: 6 }}>{tourStep.title}</div>
              <div style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.65 }}>{tourStep.desc}</div>
              {/* 1단계: 언어 선택 버튼 */}
              {tourStep.kind === 'lang' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={() => pickLang('ko')}
                    style={{ flex: 1, padding: '9px 0', fontSize: 12, fontWeight: 800, border: '2px solid #121212', background: lang === 'ko' ? '#121212' : '#fff', color: lang === 'ko' ? '#fff' : '#121212', cursor: 'pointer' }}>
                    한국어
                  </button>
                  <button onClick={() => pickLang('en')}
                    style={{ flex: 1, padding: '9px 0', fontSize: 12, fontWeight: 800, border: '2px solid #121212', background: lang === 'en' ? '#121212' : '#fff', color: lang === 'en' ? '#fff' : '#121212', cursor: 'pointer' }}>
                    English
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 5, marginTop: 12 }}>
                {TOUR_STEPS.map((_, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: i + 1 === onb.step ? '#121212' : '#d4d4d8' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, padding: '10px 14px', borderTop: '2px solid #121212', flexWrap: 'wrap' }}>
              {tourStep.kind !== 'lang' && (
                <button onClick={prevTourStep} disabled={onb.step === 1}
                  style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: onb.step === 1 ? '#f3f4f6' : '#fff', color: onb.step === 1 ? '#9ca3af' : '#121212', cursor: onb.step === 1 ? 'default' : 'pointer' }}>
                  {t('← 이전', '← Back')}
                </button>
              )}
              <button onClick={closeTour} style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: '#fff', color: '#121212', cursor: 'pointer' }}>
                {t('나중에', 'Later')}
              </button>
              <button onClick={doneOnboarding} style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
                {t('다시 보지 않기', "Don't show again")}
              </button>
              {tourStep.kind !== 'lang' && (
                <button onClick={nextTourStep} style={{ marginLeft: 'auto', padding: '6px 16px', fontSize: 11, fontWeight: 800, border: '2px solid #121212', background: '#121212', color: '#fff', cursor: 'pointer' }}>
                  {onb.step === TOUR_STEPS.length ? t('완료', 'Finish') : t('다음 →', 'Next →')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {syncing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#121212', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {closing
              ? t('동기화 후 자동으로 꺼집니다', 'Closing after sync')
              : t('웹 DB 검증 · 동기화 중...', 'Verifying & syncing web DB...')}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.8, textAlign: 'center', width: 280, maxWidth: '88vw', whiteSpace: 'normal', wordBreak: 'keep-all', wordWrap: 'break-word' }}>
            {closing
              ? t('설정 저장과 웹 동기화가 진행 중입니다.\n완료되면 자동으로 종료됩니다.', 'Saving settings and syncing...\nThe app will close automatically when done.')
              : t('웹 뷰어에서 변경된 읽음/별표/삭제 상태를 가져오고,\n이 PC의 데이터를 웹에 반영하고 있습니다.', 'Pulling read/favorite/deleted changes from the web viewer\nand pushing this PC\'s data to the web.')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 2].map(i => (
              <span key={i} className="sync-dot" style={{ width: 10, height: 10, background: '#121212', animation: `syncPulse 1s ${i * 0.18}s infinite ease-in-out` }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
