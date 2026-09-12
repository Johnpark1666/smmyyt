import React, { useEffect, useState } from 'react';
import api from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import { useLang } from '../lib/i18n';

/* ════════════════════════════════════════════
   ysnew2 Premium Brutalist Light Theme v2
   ════════════════════════════════════════════ */
const C = {
  bg: 'var(--bg-primary)', bgCard: 'var(--bg-card)', cardHover: 'var(--bg-hover)',
  text: 'var(--text-primary)', textSec: 'var(--text-secondary)', muted: 'var(--text-muted)',
  border: 'var(--border-color)',
  accent: 'var(--accent)', success: '#10b981', warning: '#ff5722', danger: '#ef4444',
  shadow: '4px 4px 0px var(--border-color)',
};
const B = '2px solid var(--border-color)';

const isTrue = v => v === true || v === 1 || v === '1' || String(v).toUpperCase() === 'TRUE';

/* Original Feather-style icons (MIT-licensed geometry, no brand logos) */
const TAB_ICONS = {
  // Unread — chat bubble
  unread: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>),
  // Github — git branch
  github: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>),
  // Favorite — star
  favorite: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>),
  // All — grid
  all: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>),
};

const TABS = [
  { key: 'unread', icon: 'unread', label: 'Unread' },
  { key: 'github', icon: 'github', label: 'Github' },
  { key: 'favorite', icon: 'favorite', label: 'Favorite' },
  { key: 'all', icon: 'all', label: 'All' },
];

/* ── Detail sections config (ysnew2 color system) ── */
const SECTIONS = [
  { key: 'timeline',   title: '타임라인 (Timeline)',        color: '#e11d48' },
  { key: 'keywords',   title: '키워드 (Keywords)',           color: '#dc2626' },
  { key: 'summary',    title: '요약 (Summary)',              color: '#0d9488' },
  { key: 'analysis',   title: '분석 (Analysis)',             color: '#7c3aed' },
  { key: 'insights',   title: '인사이트 & 시사점 (Insights)', color: '#d97706' },
  { key: 'applications',title: '활용 (Applications)',        color: '#0284c7' },
];

/* ── Time helpers ── */
const fmtDuration = s => { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = d => { if (!d) return ''; const dt = new Date(d); if (isNaN(dt.getTime())) return ''; try { return dt.toLocaleDateString(); } catch { return d; } };
// GitHub title: LLM one-line summary title (DB title) or repo name fallback
const ghTitle = (v) => {
  if (v.title && v._t === 'github') {
    // DB title now holds the LLM summary title for github repos
    return v.title;
  }
  return (v.channel_name || '').includes('/') ? (v.channel_name || '').split('/')[1] || v.channel_name : (v.channel_name || v.title || '');
};

const kwList = (str, max = 5) => {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/^#/, '')).filter(Boolean).slice(0, max);
};

const parseTimeline = (str) => {
  if (!str) return [];
  // Normalize: br→줄바꿈, 나머지 HTML 태그(<span>/<b> 등)는 전부 제거
  const normalized = str.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  const parts = normalized.split(/\n|•|\*|-/).map(s => s.trim()).filter(Boolean);
  const items = [];
  const re = /\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.+)/;
  for (const part of parts) {
    const m = part.match(re);
    if (m) items.push({ time: m[1], text: m[2].replace(/^[•\s-]+/, '').trim() });
  }
  return items;
};
const tsToSec = (t) => { const p = t.split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };
const fmtTime = (secs) => { const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60; const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0'); return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`; };

export default function Results() {
  const [allVideos, setAllVideos] = useState([]);
  const [allRepos, setAllRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const { lang, t } = useLang();
  // 사용자 설정 (기본 정렬 / 삭제 확인 없이 / 폰트 크기 / 액센트 색)
  const [prefs, setPrefs] = useState({ sort: '', noConfirmDelete: false, fontScale: 1, accent: '#4f46e5', heroThumbDefault: 'open' });
  const [tab, setTab] = useState('unread');
  const [catFilter, setCatFilter] = useState('');
  const [searchText, setSearchText] = useState('');
  const [list, setList] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [sortBy, setSortBy] = useState('');  // 초기값은 prefs 로드 후 설정
  const [detail, setDetail] = useState(null);
  const [thumbOpen, setThumbOpen] = useState(true);
  // 상세 열 때 기본값 적용
  const openDetail = (v) => { setThumbOpen(prefs.heroThumbDefault === 'closed' ? false : true); setDetail(v); };
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [playerTime, setPlayerTime] = useState(0);
  const [playerKey, setPlayerKey] = useState(0);
  const [panelWidth, setPanelWidth] = useState(650);
  const [isGoogleLinked, setIsGoogleLinked] = useState(false);

  // 설정(정렬/삭제확인/폰트/액센트) 로드 + focus 시 재로드
  useEffect(() => {
    const loadPrefs = () => {
      api.get('/api/settings').then(r => {
        const s = r.data || {};
        setPrefs({
          sort: s.default_sort || '',
          noConfirmDelete: s.no_confirm_delete === '1' || s.no_confirm_delete === true,
          fontScale: parseFloat(s.font_scale) || 1,
          accent: s.accent_color || '#4f46e5',
          heroThumbDefault: s.hero_thumb_default === 'closed' ? 'closed' : 'open',
        });
      }).catch(() => {});
    };
    loadPrefs();
    window.addEventListener('focus', loadPrefs);
    window.addEventListener('summ-prefs-changed', loadPrefs);
    return () => {
      window.removeEventListener('focus', loadPrefs);
      window.removeEventListener('summ-prefs-changed', loadPrefs);
    };
  }, []);

  const loadData = () => {
    Promise.all([
      api.get('/api/videos'),
      api.get('/api/github/repos'),
    ]).then(([r1, r2]) => {
      setAllVideos((r1.data?.data || []).map(v => ({ ...v, _t: 'video' })));
      setAllRepos((r2.data?.data || []).map(r => ({ ...r, _t: 'github' })));
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  // Live refresh: reload when a process completes (custom event from Dashboard/GitHubTab),
  // when the window regains focus, or on a 10s polling interval (guaranteed freshness).
  // 웹뷰어 등 외부 변경(읽음/별/삭제)도 주기적으로 pull — 로컬 DB를 웹과 동기화
  const syncNow = () => {
    api.get('/api/settings').then(s => {
      if (s.data?.worker_url) api.post('/api/sync/now').catch(() => {});
    }).catch(() => {});
  };
  useEffect(() => {
    loadData();
    api.get('/api/settings').then(r => {
      const s = r.data || {};
      setIsGoogleLinked(!!(s.google_access_token || s.google_refresh_token));
    }).catch(() => {});
    const onDataChanged = () => { loadData(); };
    const onFocus = () => { syncNow(); loadData(); };
    const poll = setInterval(() => { syncNow(); loadData(); }, 10000);
    window.addEventListener('summ-data-changed', onDataChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener('summ-data-changed', onDataChanged);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const videos = allVideos;
  const cats = ['Technology','Science','News/Politics','Entertainment','Education','Business/Finance','Gaming','Music','Lifestyle','Sports'];
  const CAT_KR = { 'Technology':'테크', 'Science':'과학', 'News/Politics':'뉴스/정치', 'Entertainment':'엔터테인먼트', 'Education':'교육', 'Business/Finance':'비즈니스/금융', 'Gaming':'게임', 'Music':'음악', 'Lifestyle':'라이프스타일', 'Sports':'스포츠' };
  const CAT_NORM = {
    'AI/테크': 'Technology', 'IT/기술': 'Technology', '테크': 'Technology',
    '경제/금융': 'Business/Finance', '금융': 'Business/Finance', '비즈니스': 'Business/Finance', '경제': 'Business/Finance',
    '교육': 'Education', '정치/국제': 'News/Politics', '정치': 'News/Politics', '뉴스': 'News/Politics',
    '과학': 'Science', '엔터테인먼트': 'Entertainment', '게임': 'Gaming', '음악': 'Music', '라이프스타일': 'Lifestyle', '스포츠': 'Sports',
  };
  const catNorm = (c) => CAT_NORM[c] || c;

  const filtered = (() => {
    // prefs.sort가 있으면 sortBy 대신 사용 (기본 정렬)
  const effSort = sortBy || prefs.sort || '';
  let data = [];
    if (tab === 'github') data = allRepos.filter(v => !isTrue(v.read) && !isTrue(v.deleted) && v.title);
    else if (tab === 'all') data = [...allVideos.filter(v => !isTrue(v.deleted)), ...allRepos.filter(r => r.summary && !isTrue(r.deleted))];
    else if (tab === 'favorite') data = [...allVideos.filter(v => isTrue(v.favorite) && !isTrue(v.deleted)), ...allRepos.filter(r => r.summary && isTrue(r.favorite) && !isTrue(r.deleted))];
    else data = allVideos.filter(v => !isTrue(v.read) && !isTrue(v.deleted));
    // Search filter (title/channel/keywords)
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      data = data.filter(v =>
        (v.title || '').toLowerCase().includes(q) ||
        (v.channelName || v.channel_name || '').toLowerCase().includes(q) ||
        (v.keywords || '').toLowerCase().includes(q)
      );
    }
    // Category filter (always available via floating toolbar)
    if (catFilter) data = data.filter(v => (v.category || '').trim() === catFilter);
    if (tab === 'favorite' && sourceFilter === 'video') data = data.filter(v => v._t !== 'github');
    if (tab === 'favorite' && sourceFilter === 'github') data = data.filter(v => v._t === 'github');
    // Sort
    if (effSort === 'title') data.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (effSort === 'channel') data.sort((a, b) => (a.channelName || a.channel_name || '').localeCompare(b.channelName || b.channel_name || ''));
    if (effSort === 'oldest') data.sort((a, b) => (a.publishDate || a.publishedAt || a.processed_at || '').localeCompare(b.publishDate || b.publishedAt || b.processed_at || ''));
    return data;
  })();

  const selectAll = () => setSelectedIds(new Set(filtered.map(v => v.id)));
  const clearSel = () => setSelectedIds(new Set());
  const toggleSel = (v) => setSelectedIds(p => { const n = new Set(p); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; });

  const openVideo = (v) => invoke('open_url', { url: `https://youtube.com/watch?v=${v.id}` });
  const openGithub = (v) => invoke('open_url', { url: `https://github.com/${v.channel_name || v.title}` });

  // ── Auto web-sync after state changes (debounced 3s) ──
  let syncTimer = null;
  const triggerAutoSync = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const s = await api.get('/api/settings');
        if (s.data?.worker_url) {
          await api.post('/api/sync/now');
        }
      } catch { /* silent — sync is best-effort */ }
    }, 3000);
  };

  const toggleRead = async (v, e) => {
    e.stopPropagation();
    const upd = isTrue(v.read) ? '0' : '1';
    const table = v._t === 'github' ? 'github_repos' : 'videos';
    const prefix = v._t === 'github' ? '/api/github/repos/' : '/api/videos/';
    // 레코드 단위 PATCH — 웹 DB에 즉시 반영 (전체 sync 불필요)
    api.patch(prefix + v.id, { read: upd }).catch(() => {});
    const setter = v._t === 'github' ? setAllRepos : setAllVideos;
    setter(prev => prev.map(x => x.id === v.id ? { ...x, read: upd } : x));
    if (detail?.id === v.id) {
      if (upd === '1') {
        // 읽음 처리 → 다음 항목으로 자동 이동 (마지막이면 닫기)
        const idx = filtered.findIndex(x => x.id === v.id);
        const next = idx >= 0 ? filtered[idx + 1] : null;
        if (next) setDetail(next);
        else setDetail(null);
      } else {
        setDetail(p => p ? { ...p, read: upd } : null);
      }
    }
  };

  const toggleFav = async (v, e) => {
    e.stopPropagation();
    const upd = isTrue(v.favorite) ? '0' : '1';
    const prefix = v._t === 'github' ? '/api/github/repos/' : '/api/videos/';
    // 레코드 단위 PATCH — 웹 DB에 즉시 반영
    api.patch(prefix + v.id, { favorite: upd }).catch(() => {});
    const setter = v._t === 'github' ? setAllRepos : setAllVideos;
    setter(prev => prev.map(x => x.id === v.id ? { ...x, favorite: upd } : x));
    if (detail?.id === v.id) setDetail(p => p ? { ...p, favorite: upd } : null);
  };

  // Add the video to the user's REAL YouTube "Watch Later" playlist
  const toggleSaved = async (v, e) => {
    e?.stopPropagation?.();
    if (isTrue(v.saved)) { alert(t('이미 나중에 볼 영상에 있습니다', 'Already in Watch Later')); return; }
    try {
      await api.post('/api/youtube/watch-later', { videoId: v.id });
      const setter = v._t === 'github' ? setAllRepos : setAllVideos;
      setter(prev => prev.map(x => x.id === v.id ? { ...x, saved: '1' } : x));
      if (detail?.id === v.id) setDetail(p => p ? { ...p, saved: '1' } : null);
      alert(t('나중에 볼 영상에 추가했습니다', 'Added to Watch Later'));
    } catch (err) {
      alert(t('추가 실패: ', 'Add failed: ') + (err.message || JSON.stringify(err)));
    }
  };

  const handleDelete = async (v, e) => {
    e.stopPropagation();
    if (!prefs.noConfirmDelete && !confirm(t(`'${v.title || v.id}' 항목을 삭제할까요?`, `Delete '${v.title || v.id}'?`))) return;
    const prefix = v._t === 'github' ? '/api/github/repos/' : '/api/videos/';
    // 웹: 소프트 삭제 (deleted=1) — push 시 되살아나지 않도록
    try { await api.patch(prefix + v.id, { deleted: '1' }).catch(() => {}); } catch {}
    // 로컬: 목록에서 제거
    const setter = v._t === 'github' ? setAllRepos : setAllVideos;
    setter(prev => prev.filter(x => x.id !== v.id));
    if (detail?.id === v.id) setDetail(null);
  };

  const batchAction = async (field, val) => {
    const items = filtered.filter(v => selectedIds.has(v.id));
    for (const v of items) {
      const prefix = v._t === 'github' ? '/api/github/repos/' : '/api/videos/';
      await api.patch(prefix + v.id, { [field]: val }).catch(() => {});
      const setter = v._t === 'github' ? setAllRepos : setAllVideos;
      if (field === 'excluded' || field === 'deleted') {
        setter(prev => prev.filter(x => x.id !== v.id));
      } else {
        setter(prev => prev.map(x => x.id === v.id ? { ...x, [field]: val } : x));
      }
    }
    if (field === 'excluded' || field === 'deleted') { setDetail(null); clearSel(); }
  };

  /* ── ysnew2 detail page render ── */
  const renderDetail = () => {
    if (!detail) return null;
    const v = detail;
    const isGithub = v._t === 'github';

    return (
      <div style={{
        position: 'fixed', top: 110, right: 0, width: panelWidth, height: 'calc(100% - 110px)', zIndex: 1000,
        background: C.bgCard, borderLeft: B, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 0 var(--border-color)',
      }}>
        {/* Drag handle */}
        <div onMouseDown={e => {
          const startX = e.clientX;
          const startW = panelWidth;
          const onMove = (ev) => {
            const newW = Math.max(360, Math.min(1200, startW - (ev.clientX - startX)));
            setPanelWidth(newW);
          };
          const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
          style={{ position: 'absolute', left: -5, top: 0, width: 10, height: '100%', cursor: 'col-resize', zIndex: 1001 }} />
        {/* Sticky header */}
        <div style={{ position: 'sticky', top: 0, zIndex: 100, background: C.bgCard, borderBottom: B }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3, color: C.text, wordBreak: 'keep-all' }}>{v.title || v.channel_name}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', marginTop: 4 }}>
                {isGithub ? v.owner || v.channel_name : v.channelName || v.channel_name} · {fmtDate(v.publishDate || v.publishedAt || v.publish_date)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, marginLeft: 12 }}>
              <button onClick={() => setDetail(null)} style={{ width: 40, height: 40, border: 'none', borderBottom: B, background: C.bgCard, cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: '0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = C.text; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = C.bgCard; e.currentTarget.style.color = C.text; }}>✕</button>
              <button onClick={() => setThumbOpen(o => !o)}
                style={{ padding: '5px 10px', fontSize: 11, fontWeight: 800, border: '2px solid #121212', background: '#fff', color: '#121212', cursor: 'pointer', boxShadow: '2px 2px 0 rgba(0,0,0,0.2)', whiteSpace: 'nowrap' }}>
                {thumbOpen ? '▲ ' + t('썸네일 접기', 'Hide thumb') : '▼ ' + t('썸네일 펼치기', 'Show thumb')}
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
          {/* Video player section */}
          {!isGithub && (
            <div style={{ borderBottom: B, background: '#000', position: 'relative' }}>
              {thumbOpen && (
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9' }}>
                <iframe key={playerKey} src={playerTime > 0 ? `https://www.youtube.com/embed/${v.id}?start=${playerTime}&autoplay=1&rel=0` : `https://www.youtube.com/embed/${v.id}?rel=0`}
                  title={v.title || ''} allow="autoplay; encrypted-media" allowFullScreen
                  style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
              </div>
              )}
              <div style={{ display: 'flex', height: 50, background: C.bgCard }}>
                <button onClick={() => openVideo(v)} style={{ flex: 2, border: 'none', background: C.danger, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRight: B }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#d32f2f'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = C.danger; }}>{t('▶ YouTube 열기', '▶ Open on YouTube')}</button>
                <button onClick={() => toggleRead(v, { stopPropagation: () => {} })}
                  style={{ flex: 1.5, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRight: B, transition: '0.15s', color: C.text }}
                  onMouseEnter={e => { e.currentTarget.style.background = C.success; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.text; }}>{isTrue(v.read) ? t('✓ 읽음', '✓ Read') : t('읽음 처리', 'Mark as read')}</button>
                {isGoogleLinked && (
                  <button onClick={() => toggleSaved(v, { stopPropagation: () => {} })}
                    style={{ flex: 1.2, border: 'none', borderRight: B, background: 'transparent', cursor: 'pointer', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: '0.15s', color: C.text }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#6366f1'; e.currentTarget.style.color = '#fff'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.text; }}>{isTrue(v.saved) ? t('나중에 볼 영상', 'Watch Later') : t('나중에 볼 영상 추가', 'Watch Later')}</button>
                )}
                <button onClick={() => toggleFav(v, { stopPropagation: () => {} })}
                  style={{ width: 48, border: 'none', borderLeft: B, background: isTrue(v.favorite) ? C.warning : 'transparent', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isTrue(v.favorite) ? '#fff' : C.muted, transition: '0.15s' }}
                                    onMouseEnter={e => { e.currentTarget.style.background = C.warning; e.currentTarget.style.color = '#fff'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = isTrue(v.favorite) ? C.warning : 'transparent'; e.currentTarget.style.color = isTrue(v.favorite) ? '#fff' : C.muted; }}>{isTrue(v.favorite) ? '★' : '☆'}</button>
              </div>
            </div>
          )}

          {/* GitHub section */}
          {isGithub && (
            <div style={{ borderBottom: B, position: 'relative' }}>
              {thumbOpen && (
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#f0f0f0' }}>
                <img src={v.image_url || v.avatar || (v.channel_name && v.channel_name.includes('/') ? `https://opengraph.githubassets.com/1/${v.channel_name}` : '') || `https://github.com/${(v.channel_name || '').split('/')[0] || v.owner || ''}.png?size=600`} alt=""
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.78) 100%)' }} />
                <div style={{ position: 'absolute', bottom: 12, left: 16, right: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img src={v.image_url || v.avatar || (v.channel_name && v.channel_name.includes('/') ? `https://opengraph.githubassets.com/1/${v.channel_name}` : '') || `https://github.com/${(v.channel_name || '').split('/')[0] || v.owner || ''}.png?size=96`} alt=""
                    style={{ width: 40, height: 40, borderRadius: '50%', border: '2px solid #fff', objectFit: 'cover', flexShrink: 0 }}
                    onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(v.channel_name || '').split('/')[1] || v.channel_name || v.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                      {(v.channel_name || '').split('/')[0] || v.owner} {v.language ? `· ${v.language}` : ''} · ⭐{v.stars || 0} · ⑂{v.forks || 0}
                    </div>
                  </div>
                </div>
              </div>
              )}
              <div style={{ display: 'flex', height: 50, background: C.bgCard }}>
                <button onClick={() => openGithub(v)} style={{ flex: 2, border: 'none', background: C.text, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRight: B }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#2a2a2a'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = C.text; }}>{t('GitHub에서 보기', 'View on GitHub')}</button>
                <button onClick={() => toggleRead(v, { stopPropagation: () => {} })}
                  style={{ flex: 1.5, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRight: B, transition: '0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = C.success; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.text; }}>{isTrue(v.read) ? t('✓ 읽음', '✓ Read') : t('읽음 처리', 'Mark as read')}</button>
                <button onClick={() => toggleFav(v, { stopPropagation: () => {} })}
                  style={{ width: 50, border: 'none', background: isTrue(v.favorite) ? C.warning : 'transparent', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isTrue(v.favorite) ? '#fff' : C.muted, transition: '0.15s' }}
                                    onMouseEnter={e => { e.currentTarget.style.background = C.warning; e.currentTarget.style.color = '#fff'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = isTrue(v.favorite) ? C.warning : 'transparent'; e.currentTarget.style.color = isTrue(v.favorite) ? '#fff' : C.muted; }}>{isTrue(v.favorite) ? '★' : '☆'}</button>
              </div>
            </div>
          )}

          {/* ysnew2 style content sections with color coding */}
          {SECTIONS.map(s => {
            // 섹션 제목 i18n — EN 모드에서는 영어만 표시
            const SEC_T = {
              timeline: t('타임라인', 'Timeline'),
              keywords: t('키워드', 'Keywords'),
              summary: t('요약', 'Summary'),
              analysis: t('분석', 'Analysis'),
              insights: t('인사이트 & 시사점', 'Insights & Implications'),
              applications: t('활용', 'Applications'),
            };
            const secTitle = SEC_T[s.key] || s.title;
            let content = v[s.key];
            if (s.key === 'insights') {
              // Combined Insights + Implications section
              const imp = v.implications;
              content = imp && imp.trim() && !content ? imp
                : content && imp && imp.trim() ? content + '<br/><br/>' + imp
                : content;
            }
            if (!content) return null;
            // Timeline has special rendering
            if (s.key === 'keywords') {
              const kws = kwList(content, 30);
              if (kws.length === 0) return null;
              return (
                <div key={s.key} style={{ borderBottom: B, background: C.bgCard }}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: C.bg }}>
                    <span style={{ width: 4, height: 16, background: s.color, marginRight: 10, flexShrink: 0 }} />
                    <span style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', color: C.text }}>{secTitle}</span>
                  </div>
                  <div style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {kws.map(k => (
                      <span key={k} style={{ fontSize: 12, fontWeight: 700, color: s.color, background: 'rgba(255,255,255,0.7)', padding: '5px 14px', borderRadius: 999, border: `2px solid ${s.color}`, boxShadow: '2px 2px 0 rgba(18,18,18,0.15)' }}>#{k}</span>
                    ))}
                  </div>
                </div>
              );
            }
            if (s.key === 'timeline') {
              const chapters = parseTimeline(content);
              if (chapters.length === 0) return null;
              return (
                <div key={s.key} style={{ borderBottom: B, background: C.bgCard, ['--sec-color']: s.color }}>
                   <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: C.bg }}>
                    <span style={{ width: 4, height: 16, background: s.color, marginRight: 10, flexShrink: 0 }} />
                    <span style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', color: C.text }}>{secTitle}</span>
                  </div>
                  <div style={{ padding: '12px 16px', maxHeight: 260, overflowY: 'auto' }}>
                    {chapters.map((ch, i) => {
                      const secs = tsToSec(ch.time);
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '5px 0', fontSize: 13, lineHeight: 1.6, borderBottom: i < chapters.length - 1 ? '1px solid rgba(18,18,18,0.08)' : 'none' }}>
                          <span onClick={() => { setPlayerTime(secs); setPlayerKey(k => k + 1); }}
                            style={{ background: s.color, color: '#fff', padding: '3px 12px', fontSize: 11, fontWeight: 700, fontFamily: 'monospace', flexShrink: 0, cursor: 'pointer', transition: '0.15s', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            onMouseEnter={e => { e.currentTarget.style.opacity = '0.8'; }}
                            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}>{fmtTime(secs)}</span>
                          <span style={{ color: C.textSec, fontWeight: 500, paddingTop: 2 }}>{ch.text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <div key={s.key} style={{ borderBottom: B, background: C.bgCard, ['--sec-color']: s.color }}>
                 <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: C.bg }}>
                  <span style={{ width: 4, height: 16, background: s.color, marginRight: 10, flexShrink: 0 }} />
                  <span style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', color: C.text }}>{s.title}</span>
                </div>
                <div className="detail-body" style={{ padding: 20, fontSize: 15, lineHeight: 1.6, color: C.textSec, wordBreak: 'keep-all' }}
                  dangerouslySetInnerHTML={{ __html: content }} />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  /* ── Card (ysnew2 brutalist style) ── */
  const renderCard = (v) => {
    const sel = selectedIds.has(v.id);
    const isGithub = v._t === 'github';

    return (
      <div key={v.id} onClick={() => { openDetail(v); setPlayerTime(0); setPlayerKey(k => k + 1); }}
        style={{
          borderBottom: B, background: C.bgCard, display: 'flex', flexDirection: 'column', cursor: 'pointer',
          transition: 'transform 0.15s, box-shadow 0.15s', position: 'relative',
          outline: sel ? `3px solid ${C.accent}` : 'none',
        }}
        onMouseEnter={e => { if (!list && !sel) { e.currentTarget.style.transform = 'translate(-4px, -4px)'; e.currentTarget.style.boxShadow = C.shadow; } }}
        onMouseLeave={e => { if (!sel) { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; } }}>
        {/* Selection checkbox overlay */}
        <div onClick={e => { e.stopPropagation(); toggleSel(v); }}
          style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, width: 24, height: 24, background: sel ? C.accent : '#fff', border: B, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: sel ? '#fff' : C.text, cursor: 'pointer' }}>
          {sel ? '✓' : ''}
        </div>

        {/* Thumbnail / GitHub visual */}
        {!isGithub ? (
          <div style={{ aspectRatio: '16/9', overflow: 'hidden', borderBottom: B, background: C.bg, position: 'relative' }}>
            <img src={v.image_url || v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {v.duration > 0 && (
              <span style={{ position: 'absolute', bottom: 6, right: 6, background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '2px 6px', fontSize: 10, fontWeight: 600 }}>{fmtDuration(v.duration)}</span>
            )}
          </div>
        ) : (
          <div style={{ aspectRatio: '16/9', overflow: 'hidden', borderBottom: B, background: '#f0f0f0', position: 'relative' }}>
            <img src={v.image_url || v.avatar || (v.channel_name && v.channel_name.includes('/') ? `https://opengraph.githubassets.com/1/${v.channel_name}` : '') || `https://github.com/${(v.channel_name || '').split('/')[0] || v.owner || ''}.png?size=400`} alt=""
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.72) 100%)' }} />
            <div style={{ position: 'absolute', bottom: 8, left: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src={v.image_url || v.avatar || `https://github.com/${(v.channel_name || '').includes('/') ? (v.channel_name || '').split('/')[0] : (v.owner || '')}.png?size=64`} alt=""
                style={{ width: 26, height: 26, borderRadius: '50%', border: '2px solid #fff', objectFit: 'cover', flexShrink: 0 }}
                onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
              <span style={{ fontSize: 13, fontWeight: 800, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(v.channel_name || '').split('/')[1] || v.channel_name || v.title}
              </span>
            </div>
            {v.language && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 4, background: v.language === 'JavaScript' ? '#f7df1e' : v.language === 'TypeScript' ? '#3178c6' : v.language === 'Python' ? '#3572A5' : v.language === 'Rust' ? '#dea584' : v.language === 'Go' ? '#00ADD8' : v.language === 'C' ? '#555' : v.language === 'C++' ? '#f34b7d' : v.language === 'HTML' ? '#e34c26' : v.language === 'CSS' ? '#563d7c' : '#ccc' }} />}
          </div>
        )}

        {/* Content */}
        <div style={{ padding: 16, flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {isGithub && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.muted }}>
            <img src={v.image_url || v.avatar || `https://github.com/${(v.channel_name || '').includes('/') ? (v.channel_name || '').split('/')[0] : (v.owner || '')}.png?size=32`} alt=""
              style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }}
              onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
            <span style={{ color: C.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.channel_name || v.owner || v.title}</span>
          </div>}
          <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.4, color: C.text, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {isGithub ? ghTitle(v) : v.title}
          </div>
          {isGithub && v.description && <div style={{ fontSize: 12, color: C.textSec, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.description}</div>}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: C.muted, marginTop: isGithub ? 'auto' : 0 }}>
            {!isGithub && <span style={{ color: C.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.channelName || v.channel_name}</span>}
            {isGithub && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {v.language && <span style={{ fontSize: 10, padding: '1px 6px', border: '1px solid #d4d4d8', color: C.muted }}>{v.language}</span>}
              <span>⭐{v.stars || 0}</span>
              <span>⑂{v.forks || 0}</span>
            </div>}
            <span>{!isGithub ? fmtDate(v.publishDate || v.publishedAt || v.publish_date) : ''}</span>
          </div>
        </div>

        {/* Keywords (top 5) */}
        {kwList(v.keywords).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 16px 12px' }}>
            {kwList(v.keywords).map(k => (
              <span key={k} style={{ fontSize: 10, fontWeight: 600, color: C.muted, border: '1px solid #d4d4d8', padding: '1px 8px', borderRadius: 999 }}>#{k}</span>
            ))}
          </div>
        )}

        {/* Action bar */}
        <div style={{ display: 'flex', borderTop: B, height: 48 }}>
          <button onClick={e => toggleRead(v, e)} style={{ flex: 1, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: '0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.background = C.success; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.text; }}>{isTrue(v.read) ? t('✓ 읽음', '✓ Read') : t('읽음 처리', 'Mark as read')}</button>
          <button onClick={e => toggleFav(v, e)} style={{ width: 48, border: 'none', borderLeft: B, background: isTrue(v.favorite) ? C.warning : 'transparent', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isTrue(v.favorite) ? '#fff' : C.muted, transition: '0.15s' }}
          onMouseEnter={e => { e.currentTarget.style.background = C.warning; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = isTrue(v.favorite) ? C.warning : 'transparent'; e.currentTarget.style.color = isTrue(v.favorite) ? '#fff' : C.muted; }}>{isTrue(v.favorite) ? '★' : '☆'}</button>
          {(tab === 'all' || tab === 'github') && (
            <button onClick={e => handleDelete(v, e)} style={{ width: 48, border: 'none', borderLeft: B, background: 'transparent', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, transition: '0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = C.danger; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.muted; }}>🗑</button>
          )}
        </div>
      </div>
    );
  };

  /* ── List row (horizontal, small thumbnail) ── */
  const renderListItem = (v) => {
    const sel = selectedIds.has(v.id);
    const isGithub = v._t === 'github';
    const repoName = isGithub ? (v.channel_name || '').includes('/') ? v.channel_name.split('/')[1] : (v.channel_name || v.title) : null;
    const thumb = isGithub
      ? (v.image_url || v.avatar || (v.channel_name && v.channel_name.includes('/') ? `https://opengraph.githubassets.com/1/${v.channel_name}` : '') || `https://github.com/${(v.channel_name || '').split('/')[0] || v.owner || ''}.png?size=96`)
      : (v.image_url || v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`);

    return (
      <div key={v.id} onClick={() => { openDetail(v); setPlayerTime(0); setPlayerKey(k => k + 1); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', cursor: 'pointer',
          background: sel ? C.cardHover : C.bgCard, borderBottom: B, transition: 'background 0.12s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = C.cardHover; }}
        onMouseLeave={e => { e.currentTarget.style.background = sel ? C.cardHover : C.bgCard; }}>
        {/* Selection checkbox */}
        <div onClick={e => { e.stopPropagation(); toggleSel(v); }}
          style={{ width: 20, height: 20, flexShrink: 0, background: sel ? C.accent : '#fff', border: B, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: sel ? '#fff' : 'transparent', cursor: 'pointer' }}>
          {sel ? '✓' : ''}
        </div>
        {/* Tiny thumbnail */}
        <div style={{ width: 88, height: 50, flexShrink: 0, overflow: 'hidden', background: '#f0f0f0', position: 'relative', borderRadius: 4 }}>
          <img src={thumb} alt=""
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
        </div>
        {/* Title + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isGithub ? ghTitle(v) : v.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 11, color: C.muted, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {!isGithub && <span style={{ color: C.accent, fontWeight: 600 }}>{v.channelName || v.channel_name}</span>}
            {isGithub && <span style={{ color: C.accent, fontWeight: 600 }}>{(v.channel_name || '').split('/')[0] || v.owner}</span>}
            {isGithub && v.language && <span>{v.language}</span>}
            {isGithub && <span>⭐{v.stars || 0} · ⑂{v.forks || 0}</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.description || ''}</span>
            {kwList(v.keywords).length > 0 && (
              <span style={{ color: C.accent, flexShrink: 0 }}>
                {kwList(v.keywords).map(k => `#${k}`).join(' ')}
              </span>
            )}
          </div>
        </div>
        {/* Date */}
        <div style={{ fontSize: 10, color: C.muted, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {!isGithub ? fmtDate(v.publishDate || v.publishedAt || v.publish_date) : ''}
        </div>
        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button onClick={e => toggleRead(v, e)} style={{ width: 34, height: 34, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: isTrue(v.read) ? C.success : C.muted, transition: '0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.color = C.success; }}
            onMouseLeave={e => { e.currentTarget.style.color = isTrue(v.read) ? C.success : C.muted; }}>{isTrue(v.read) ? '✓' : '○'}</button>
          <button onClick={e => toggleFav(v, e)} style={{ width: 34, height: 34, border: 'none', background: isTrue(v.favorite) ? C.warning : 'transparent', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isTrue(v.favorite) ? '#fff' : C.muted, transition: '0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.background = C.warning; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = isTrue(v.favorite) ? C.warning : 'transparent'; e.currentTarget.style.color = isTrue(v.favorite) ? '#fff' : C.muted; }}>{isTrue(v.favorite) ? '★' : '☆'}</button>
          {(tab === 'all' || tab === 'github') && (
            <button onClick={e => handleDelete(v, e)} style={{ width: 34, height: 34, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: C.muted, transition: '0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.color = C.danger; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.muted; }}>🗑</button>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return <div style={{ padding: 80, textAlign: 'center', fontFamily: 'Outfit' }}><div style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>LOADING...</div></div>;
  }

  return (
    <div style={{
      fontFamily: 'Outfit, sans-serif', height: '100%', display: 'flex', flexDirection: 'column', background: C.bg,
      fontSize: `${prefs.fontScale * 100}%`,
      ['--accent']: prefs.accent,
      ['--accent-tint']: prefs.accent + '1a',
    }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
      @keyframes pop { 0% { transform: scale(1); } 40% { transform: scale(1.15); } 100% { transform: scale(1); } }
      .sf-btn { animation: pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
      .detail-body h3 { background: var(--sec-color, #0d9488); color: #fff; font-size: 13px; font-weight: 800; padding: 7px 14px; margin: 20px 0 12px; border: 2px solid #121212; border-radius: 0; box-shadow: 3px 3px 0 rgba(18,18,18,0.9); letter-spacing: 0.02em; display: block; }
      .detail-body h3 + br { display: none; }
      .detail-body h3:first-child { margin-top: 0; }
      .detail-body p, .detail-body div { margin: 0; }
      /* Bullet points → left vertical accent bar */
      .detail-body { line-height: 1.5; }
      .detail-body .dt-bullet { display: block; padding-left: 12px; margin: 2px 0; position: relative; }
      .detail-body .dt-bullet::before { content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 4px; background: var(--sec-color, #0d9488); border: 1.5px solid #121212; }
      .detail-body br + .dt-bullet { margin-top: 3px; }
      /* Table → brutalist */
      .detail-body table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; border: 2px solid #121212; box-shadow: 3px 3px 0 rgba(18,18,18,0.9); background: #fff; }
      .detail-body table + br, .detail-body br + table { display: none; }
      .detail-body table th, .detail-body table td { border: 1px solid #121212; padding: 6px 10px; text-align: left; }
      .detail-body table th { background: #121212; color: #fff; font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .detail-body table tr:nth-child(even) td { background: #fafafa; }
      /* Key words / numbers / names → accent color */
      .detail-body b { color: var(--sec-color, #0d9488); font-weight: 800; background: color-mix(in srgb, var(--sec-color, #0d9488) 8%, transparent); padding: 0 2px; }
      .detail-body b b { color: inherit; background: none; padding: 0; }
      /* Code blocks */
      .detail-body pre { background: #1a1a1a; color: #e8e8e8; padding: 10px 14px; margin: 10px 0; border: 2px solid #121212; border-radius: 0; box-shadow: 3px 3px 0 rgba(18,18,18,0.9); overflow-x: auto; font-size: 11.5px; line-height: 1.6; }
      .detail-body pre code { background: transparent; color: inherit; padding: 0; font-family: 'JetBrains Mono', Consolas, monospace; white-space: pre; }
      .detail-body code { background: #f1f5f9; color: #dc2626; padding: 1px 5px; font-size: 0.92em; font-family: 'JetBrains Mono', Consolas, monospace; border: 1px solid #d4d4d8; }
      /* Quote — left accent bar + italic, no box */
      .detail-body blockquote { display: block; margin: 8px 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--sec-color, #0d9488); font-size: 13px; color: var(--sec-color, #0d9488); font-style: italic; font-weight: 600; line-height: 1.5; }
      .detail-body blockquote b { background: none; padding: 0; color: inherit; }
      .detail-body blockquote + br { display: none; }`}</style>

      {/* Tab bar */}
      <div style={{ display: 'flex', height: 70, background: C.bgCard, flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => { setTab(t.key); setCatFilter(''); setDetail(null); }}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 2, border: 'none', background: tab === t.key ? 'rgba(79,70,229,0.06)' : 'transparent',
              cursor: 'pointer', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
              color: tab === t.key ? C.accent : C.text,
              transition: '0.15s',
            }}>
            <span style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: tab === t.key ? C.accent : C.text, opacity: tab === t.key ? 1 : 0.55 }}>
              {React.cloneElement(TAB_ICONS[t.icon], { width: 24, height: 24 })}
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>


      {/* Grid / List */}
      <div style={{ flex: 1, overflow: 'auto', padding: list ? 16 : 32 }}>
        {catFilter && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setCatFilter('')} style={{ padding: '4px 10px', border: B, background: C.bgCard, cursor: 'pointer', fontSize: 11, fontWeight: 700, transition: '0.12s' }}
              onMouseEnter={e => { e.currentTarget.style.background = C.text; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = C.bgCard; e.currentTarget.style.color = C.text; }}>✕ {t('필터 해제', 'Clear filter')}</button>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>📂 {lang === 'en' ? catNorm(catFilter) : CAT_KR[catNorm(catFilter)] || catNorm(catFilter)}</span>
          </div>
        )}
        <div style={{ display: list ? 'flex' : 'grid', flexDirection: list ? 'column' : undefined, gap: list ? 16 : 24, gridTemplateColumns: list ? undefined : 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {filtered.map(list ? renderListItem : renderCard)}
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', fontSize: 28, fontWeight: 700, color: '#999', letterSpacing: '0.02em' }}>{t('데이터가 없습니다', 'No data')}</div>
          )}
        </div>
      </div>

      {/* Floating toolbar */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: C.bgCard, borderBottom: B, padding: '6px 10px', boxShadow: C.shadow }}>
          <input value={searchText} onChange={e => setSearchText(e.target.value)} placeholder={t('검색...', 'Search...')}
            style={{ width: 140, padding: '6px 10px', border: 'none', borderBottom: B, background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: C.text, fontFamily: 'Outfit, sans-serif' }} />
          <div style={{ width: 2, height: 24, background: C.text }} />
          <button onClick={() => setList(!list)} style={{ width: 36, height: 36, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text, transition: '0.15s' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {list ? <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></> : <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>}
            </svg>
          </button>
          <div style={{ width: 2, height: 24, background: C.text }} />
          <button onClick={() => selectedIds.size === filtered.length ? clearSel() : selectAll()}
            style={{ width: 36, height: 36, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text, transition: '0.15s' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              {selectedIds.size === filtered.length && <polyline points="9 12 12 15 15 9" />}
              {selectedIds.size > 0 && selectedIds.size < filtered.length && <line x1="8" y1="12" x2="16" y2="12" />}
            </svg>
          </button>
          {selectedIds.size > 0 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{selectedIds.size}</span>
          )}
          <div style={{ width: 2, height: 24, background: C.text }} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
            style={{ border: 'none', background: 'transparent', fontWeight: 800, fontSize: 12, textTransform: 'uppercase', cursor: 'pointer', outline: 'none', maxWidth: 120 }}>
            <option value="">📂 {t('전체', 'All')}</option>
            {cats.map(c => <option key={c} value={c}>📂 {CAT_KR[c] || c}</option>)}
          </select>
          <div style={{ width: 2, height: 24, background: C.text }} />
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            style={{ border: 'none', background: 'transparent', fontWeight: 800, fontSize: 12, textTransform: 'uppercase', cursor: 'pointer', outline: 'none' }}>
            <option value="">{t('최신순', 'Latest')}</option>
            <option value="oldest">{t('오래된순', 'Oldest')}</option>
            <option value="title">{t('제목순', 'Title')}</option>
            <option value="channel">{t('채널순', 'Channel')}</option>
          </select>
          {tab === 'favorite' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <div style={{ width: 1, height: 20, background: C.text, margin: '0 4px' }} />
              {['all', 'video', 'github'].map(s => (
                <button key={s} onClick={e => { setSourceFilter(s); e.currentTarget.classList.remove('sf-btn'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('sf-btn'); }}
                  style={{ padding: s === 'all' ? '8px 20px' : '6px 12px', border: 'none', background: 'transparent', color: C.text, cursor: 'pointer', fontSize: s === 'all' ? 13 : 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4, borderRadius: 0 }}>
                  {s === 'all' ? 'ALL' : <img src={s === 'video' ? '/icons/tabs/youtube.svg' : '/icons/ysnew2/github.png'} alt="" style={{ width: 20, height: 20 }} />}
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: C.bgCard, borderBottom: B, padding: '6px 10px', boxShadow: C.shadow }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginRight: 4 }}>{selectedIds.size} {t('개 선택', 'selected')}</span>
            {tab === 'unread' && (
              <>
                <button onClick={() => batchAction('read', '1')} style={{ padding: '4px 10px', border: 'none', background: C.bgCard, cursor: 'pointer', fontSize: 10, fontWeight: 700, transition: '0.15s', borderBottom: '2px solid transparent' }}
                  onMouseEnter={e => { e.currentTarget.style.borderBottom = '2px solid #121212'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderBottom = '2px solid transparent'; }}>{t('✓ 읽음', '✓ Read')}</button>
                <button onClick={() => batchAction('favorite', '1')} style={{ padding: '4px 10px', border: 'none', background: C.bgCard, cursor: 'pointer', fontSize: 10, fontWeight: 700, transition: '0.15s', borderBottom: '2px solid transparent' }}
                  onMouseEnter={e => { e.currentTarget.style.borderBottom = '2px solid #121212'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderBottom = '2px solid transparent'; }}>{t('⭐ 찜', '⭐ Fav')}</button>
              </>
            )}
            {(tab === 'all' || tab === 'github') && (
              <button onClick={() => batchAction('deleted', '1')} style={{ padding: '4px 10px', border: 'none', background: C.bgCard, cursor: 'pointer', fontSize: 10, fontWeight: 700, transition: '0.15s', borderBottom: '2px solid transparent' }}
                onMouseEnter={e => { e.currentTarget.style.borderBottom = '2px solid #121212'; }}
                onMouseLeave={e => { e.currentTarget.style.borderBottom = '2px solid transparent'; }}>{t('🗑 삭제', '🗑 Delete')}</button>
            )}
            {tab === 'favorite' && (
              <button onClick={() => batchAction('favorite', '0')} style={{ padding: '4px 10px', border: 'none', background: C.bgCard, cursor: 'pointer', fontSize: 10, fontWeight: 700, transition: '0.15s', borderBottom: '2px solid transparent' }}
                onMouseEnter={e => { e.currentTarget.style.borderBottom = '2px solid #121212'; }}
                onMouseLeave={e => { e.currentTarget.style.borderBottom = '2px solid transparent'; }}>{t('☆ 찜 해제', '☆ Unfav')}</button>
            )}
          </div>
        )}
      </div>

      {/* Detail overlay */}
      {renderDetail()}
    </div>
  );
}
