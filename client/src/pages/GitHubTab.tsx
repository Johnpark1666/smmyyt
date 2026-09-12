import React, { useEffect, useRef, useState } from 'react';
import api from '../lib/api';
import { useLang } from '../lib/i18n';
import { notify } from '../lib/notify';

const B = '2px solid var(--color-border-emphasized, var(--border-color))';
const s = {
  panel: { border: B, background: 'var(--bg-card)', marginBottom: 16 },
  panelHdr: {
    background: 'var(--bg-card)', borderBottom: B, padding: '8px 12px',
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
    color: 'var(--text-muted)',
  },
  btn: {
    padding: '10px 20px', border: B, background: 'transparent',
    color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', cursor: 'pointer', opacity: 0.4,
  },
  btnActive: {
    padding: '10px 20px', border: B, background: 'var(--text-primary)',
    color: '#fff', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', cursor: 'pointer',
  },
};

export default function GitHubTab() {
  const { t } = useLang();
  const ghThumb = (r) => r.thumbnail || r.ownerAvatar || (r.id ? `https://opengraph.githubassets.com/1/${r.id}` : '');
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [repos, setRepos] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [status, setStatus] = useState('');
  const [currentRepo, setCurrentRepo] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [ghList, setGhList] = useState(false);
  const [ghConc, setGhConc] = useState(1);
  const [ghLang, setGhLang] = useState('ko');
  const [showGhFilter, setShowGhFilter] = useState(false);
  const [ghInputLimit, setGhInputLimit] = useState(40000);
  const ghHeroRef = useRef(null);
  const [ghOutputTokens, setGhOutputTokens] = useState(8000);
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [notifications, setNotifications] = useState(() => localStorage.getItem('gh_notify') === '1');

  useEffect(() => {
    api.get('/api/settings').then(r => {
      setGhLang(r.data?.github_lang || 'ko');
      setGhInputLimit(Number(r.data?.github_input_limit) || 40000);
      setGhOutputTokens(Number(r.data?.github_output_tokens) || 8000);
      if (r.data?.gh_notify !== undefined) {
        setNotifications(r.data.gh_notify === '1');
        localStorage.setItem('gh_notify', r.data.gh_notify === '1' ? '1' : '0');
      }
    }).catch(() => {});
  }, []);

  const fetchTrending = async () => {
    setLoading(true); setStatus('');
    try {
      const { data } = await api.get('/api/github/fetch', { params: { days: '7' } });
      const list = data.repos || [];
      setRepos(list);
      setSelectedIds(new Set(list.map(r => r.id)));
      // status text removed per user request
      if (autoSummarize && list.length > 0) {
        processRepos(list);
      }
    } catch (e) {
      setStatus('❌ ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  const toggleAll = () => {
    if (selectedIds.size === repos.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(repos.map(r => r.id)));
  };

  const toggleRepo = (id) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const saveGhLang = (v) => {
    setGhLang(v);
    api.put('/api/settings', { github_lang: v }).catch(() => {});
  };
  const saveGhTokens = (k, v, setter) => {
    setter(v);
    api.put('/api/settings', { [k]: String(v) }).catch(() => {});
  };

  const processRepos = async (list) => {
    const selected = list.filter(r => r.id && true);
    if (selected.length === 0) return;
    setProcessing(true);
    setProgress({ current: 0, total: selected.length });
    // 동시 진행 수 (설정 — 기본 1)
    let conc = 1;
    try { const s = await api.get('/api/settings'); conc = Math.max(1, parseInt(s.data?.process_concurrency || '1', 10) || 1); } catch {}
    let done = 0;
    for (let i = 0; i < selected.length; i += conc) {
      const chunk = selected.slice(i, i + conc);
      await Promise.all(chunk.map(async (repo) => {
        setCurrentRepo(repo);
        try {
          await api.post('/api/github/process', { repo });
        } catch (e) {
          setStatus(`❌ ${repo.name}: ${e.response?.data?.error || e.message}`);
        }
        done++;
        setProgress({ current: done, total: selected.length });
        setStatus(`🔄 [${done}/${selected.length}] 요약 진행 중...`);
      }));
    }
    setStatus(`✅ ${selected.length}개 완료`);
    if (notifications) { notify(t('GitHub 요약 완료', 'GitHub summary done'), t(`${selected.length}개 레포 요약이 완료되었습니다`, `${selected.length} repos summarized`)); }
    // Notify Results viewer to refresh
    window.dispatchEvent(new CustomEvent('summ-data-changed'));
    setCurrentRepo(null);
    setRepos([]);
    setSelectedIds(new Set());
    setProcessing(false);
  };

  const startProcess = async () => {
    await processRepos(repos.filter(r => selectedIds.has(r.id)));
    // scrollIntoView finds the actual scroll container (.main-content)
    setTimeout(() => {
      ghHeroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 650);
  };

  return (
    <div style={{ fontFamily: "'Outfit','Inter',-apple-system,sans-serif", position: 'relative' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');`}</style>

      {/* ── STICKY HEADER (title → control panel) ── */}

      {/* ── PAGE TITLE ── */}
      <h1 style={{ fontSize: '2.08rem', fontWeight: 800, color: '#121212', margin: '14px 0 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/icons/ysnew2/github.png" alt="" style={{ width: 26, height: 26 }} /> {t('GitHub 트렌딩', 'GitHub Trending')}
      </h1>

      {/* ── TAB DESCRIPTION ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16, padding: '10px 14px', borderBottom: B, background: 'var(--bg-card)' }}>
        <div style={{ width: 3, height: '100%', minHeight: 48, background: 'var(--text-primary)', flexShrink: 0, alignSelf: 'stretch' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>{t('GitHub 트렌딩 분석', 'GitHub Trending Analysis')}</div>
          <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6 }}>
            <b style={{ color: 'var(--text-primary)' }}>GitHub Trending</b>{t('은 GitHub에서 일정 기간(일주일) 동안 가장 많은 관심을 받은 인기 레포지토리 목록입니다. 별(Star) 수 증가율, 포크 수, 기여자 활동 등을 기준으로 선정되며, 개발자들이 최신 기술 트렌드를 파악하는 중요한 지표로 활용됩니다.', 'is a list of trending repos that got the most attention on GitHub over the past week, selected by star growth, forks and contributor activity — a key signal for developers tracking the latest tech trends.')}
            <br /><br />
            <b>{t('사용 방법:', 'How to use:')}</b> {t('FETCH 버튼으로 현재 트렌딩 레포 목록을 불러온 후, 분석할 레포를 선택하고 PROCESS를 실행하면 AI가 README를 분석하여 요약·인사이트를 제공합니다.', 'Click FETCH to load trending repos, select repos and run PROCESS — AI analyzes the README to provide summaries and insights.')}
          </div>
        </div>
      </div>

      {/* ── PROCESSING HERO ── */}
      <div ref={ghHeroRef} style={{
        maxHeight: processing ? 400 : 0, opacity: processing ? 1 : 0,
        overflow: 'hidden', transition: 'max-height 0.5s ease, opacity 0.4s ease',
        marginBottom: processing ? 16 : 0,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 0, borderBottom: B, background: 'var(--bg-card)' }}>
          {/* LEFT: Avatar */}
          <div style={{ position: 'relative', overflow: 'hidden', borderRight: B, aspectRatio: '1 / 1', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {currentRepo?.ownerAvatar ? (
              <img src={currentRepo.ownerAvatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
            ) : (
              <div style={{ fontSize: 48, opacity: 0.25 }}>📦</div>
            )}
            <div style={{ position: 'absolute', top: 10, right: 10, padding: '4px 10px', border: '2px solid var(--text-primary)', background: 'var(--text-primary)', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
              {progress.current}/{progress.total}
            </div>
          </div>

          {/* RIGHT: Info */}
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, background: 'var(--bg-card)' }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>
              {currentRepo?.name || 'Preparing...'}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>
              {currentRepo?.owner || ''}
            </div>
            {currentRepo?.description && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {currentRepo.description}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              {currentRepo?.stars > 0 && <span style={{ color: '#f59e0b', fontWeight: 700 }}>⭐{currentRepo.stars}</span>}
              {currentRepo?.language && <span style={{ padding: '1px 6px', border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{currentRepo.language}</span>}
              {currentRepo?.forks > 0 && <span>⑂{currentRepo.forks}</span>}
            </div>
          </div>
        </div>
        {processing && (
          <div style={{ padding: 10, borderBottom: B, background: 'var(--bg-card)' }}>
            <button onClick={async () => { try { await api.post('/api/process-cancel'); } catch {/* ignore */} }}
              style={{ ...s.btn, background: '#c6a6a2', borderColor: '#c6a6a2', color: '#101314' }}>
              {t('⏹ 중단', '⏹ Stop')}
            </button>
          </div>
        )}
      </div>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', boxShadow: '0 1px 0 #d4d4d8', width: '100%' }}>

      {/* ── CONTROL PANEL ── */}
      <div style={{ ...s.panel, marginBottom: 12 }}>
        <div style={s.panelHdr}>
          <span>◇</span> control panel
          <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 9, color: 'var(--border-color)' }}>
            {processing ? 'processing...' : repos.length > 0 ? `${repos.length} repos loaded` : 'idle'}
          </span>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={fetchTrending} disabled={loading || processing} style={(loading || processing) ? s.btn : s.btnActive}>
              {loading ? '⟳ FETCHING...' : 'FETCH Trending'}
            </button>
            {repos.length > 0 && (
              <button onClick={startProcess} disabled={processing} style={processing ? s.btn : s.btnActive}>
                {processing ? '⟳ PROCESSING...' : `PROCESS (${selectedIds.size})`}
              </button>
            )}

            <div style={{ position: 'relative' }}>
            <button onClick={() => setShowGhFilter(!showGhFilter)}
              style={{ ...s.btnActive, display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderColor: showGhFilter ? 'var(--accent)' : 'var(--text-primary)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </button>
            {showGhFilter && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 100,
              marginTop: 4,
              background: 'var(--bg-card, #fff)',
              border: '2px solid var(--accent, #6366f1)',
              padding: 16, minWidth: 280,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: 14 }}>
                ◇ fetch filters
                <button onClick={() => setShowGhFilter(false)} style={{ float: 'right', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>✕</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                <input type="checkbox" checked={autoSummarize} onChange={() => setAutoSummarize(!autoSummarize)} style={{ width: 15, height: 15, accentColor: 'var(--accent)' }} />
                {t('자동 요약', 'Auto summary')}
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>{t('FETCH 후 자동으로 PROCESS', 'Starts PROCESS after FETCH')}</span>
              </label>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('요약 언어', 'Summary language')}</div>
                <select value={ghLang} onChange={e => saveGhLang(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', border: '2px solid var(--border-color)', background: 'var(--bg-card, #fff)', color: 'var(--text-primary)', fontSize: 11, outline: 'none' }}>
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                  <option value="zh">中文</option>
                </select>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('요약 동시 진행 (API)', 'Parallel summaries (API)')}</div>
                <select value={String(ghConc ?? 1)} onChange={e => { const v = e.target.value; setGhConc(Number(v)); api.put('/api/settings', { process_concurrency: v }).catch(() => {}); }}
                  style={{ width: '100%', padding: '6px 10px', border: '2px solid var(--border-color)', background: 'var(--bg-card, #fff)', color: 'var(--text-primary)', fontSize: 11, outline: 'none' }}>
                  {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}{n === 1 ? ` (${t('순차', 'sequential')})` : ''}</option>)}
                </select>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                  <span>{t('입력 제한', 'Input limit')}</span><span style={{ color: 'var(--accent)', fontWeight: 800 }}>{(ghInputLimit / 1000).toFixed(0)}k</span>
                </div>
                <input type="range" value={ghInputLimit} min={5000} max={120000} step={5000}
                  onChange={e => saveGhTokens('github_input_limit', Number(e.target.value), setGhInputLimit)}
                  style={{ width: '100%', accentColor: 'var(--accent, #6366f1)', cursor: 'pointer' }} />
              </div>
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                  <span>{t('출력 토큰', 'Output tokens')}</span><span style={{ color: 'var(--accent)', fontWeight: 800 }}>{ghOutputTokens}</span>
                </div>
                <input type="range" value={ghOutputTokens} min={1000} max={16000} step={1000}
                  onChange={e => saveGhTokens('github_output_tokens', Number(e.target.value), setGhOutputTokens)}
                  style={{ width: '100%', accentColor: 'var(--accent, #6366f1)', cursor: 'pointer' }} />
              </div>
            </div>
            )}
            </div>
            {repos.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                <button onClick={() => setGhList(!ghList)}
                  style={{ width: 34, height: 34, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-primary)' }}
                  title="View mode">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {ghList ? <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></> : <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>}
                  </svg>
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10, color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={selectedIds.size === repos.length && repos.length > 0}
                    onChange={toggleAll}
                    style={{ width: 14, height: 14, accentColor: 'var(--accent)' }} />
                  {t('전체 선택', 'Select all')}
                </label>
                <button onClick={() => { if (confirm(t('레포 목록을 모두 지울까요?', 'Clear the whole list?'))) { setRepos([]); setSelectedIds(new Set()); } }}
                  style={{ padding: '2px 8px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', border: '1px solid var(--color-error, #dc2626)', background: 'transparent', color: 'var(--color-error, #dc2626)', cursor: 'pointer' }}>
                  {t('지우기', 'Clear')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      </div>

      {/* ── REPO GRID / LIST ── */}
      {repos.length > 0 && (
        <>
          <div style={ghList
            ? { display: 'flex', flexDirection: 'column', background: 'transparent' }
            : { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, background: 'transparent' }}>
          {repos.map(r => {
            const selected = selectedIds.has(r.id);
            if (ghList) return (
              <div key={r.id} onClick={() => toggleRepo(r.id)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px',
                borderBottom: '1px solid var(--border-subtle)',
                background: selected ? 'var(--accent-tint)' : 'var(--bg-card)',
                cursor: 'pointer', transition: 'background 0.12s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = selected ? 'var(--accent-tint)' : 'var(--bg-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = selected ? 'var(--accent-tint)' : 'var(--bg-card)'; }}
              >
                <div onClick={e => { e.stopPropagation(); toggleRepo(r.id); }} style={{
                  width: 20, height: 20, flexShrink: 0,
                  border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: selected ? 'var(--accent)' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                }}>
                  {selected && <span style={{ color: '#fff', fontWeight: 900, fontSize: 11 }}>✓</span>}
                </div>
                <div style={{ width: 96, height: 54, flexShrink: 0, overflow: 'hidden', background: 'var(--bg-hover)', position: 'relative' }}>
                  <img src={ghThumb(r)} alt=""
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => {
                      const a = r.ownerAvatar || (r.id ? `https://github.com/${r.id.split('/')[0]}.png?size=96` : '');
                      if (a && (e.target as HTMLImageElement).src !== a) { (e.target as HTMLImageElement).src = a; return; }
                      (e.target as HTMLElement).style.display = 'none';
                    }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, opacity: 0.4, pointerEvents: 'none' }}>📦</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.owner} · ⭐{r.stars} {r.language ? `· ${r.language}` : ''} {r.forks > 0 ? `· ⑂${r.forks}` : ''}
                  </div>
                </div>
              </div>
            );
            return (
              <div key={r.id} onClick={() => toggleRepo(r.id)}
                style={{
                  borderBottom: selected ? '3px solid var(--accent)' : '2px solid var(--border-color)',
                  background: 'var(--bg-card)',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column',
                  transition: 'border-bottom-width 0.15s',
                  position: 'relative',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderBottomWidth = '3px'; }}
                onMouseLeave={e => { e.currentTarget.style.borderBottomWidth = selected ? '3px' : '2px'; }}
              >
                {/* Selection checkbox */}
                <div style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 2,
                  width: 22, height: 22,
                  border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: selected ? 'var(--accent)' : 'var(--bg-card)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 800, color: selected ? 'var(--text-primary)' : 'transparent',
                }}>{selected ? '✓' : ''}</div>

                {/* Thumbnail (og:image) */}
                <div style={{ aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-hover)', position: 'relative' }}>
                  <img src={ghThumb(r)} alt=""
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => {
                      const a = r.ownerAvatar || (r.id ? `https://github.com/${r.id.split('/')[0]}.png?size=96` : '');
                      if (a && (e.target as HTMLImageElement).src !== a) { (e.target as HTMLImageElement).src = a; return; }
                      (e.target as HTMLElement).style.display = 'none';
                    }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, opacity: 0.4, pointerEvents: 'none' }}>📦</div>
                </div>

                {/* Avatar + Name row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px 8px' }}>
                  {r.ownerAvatar ? (
                    <img src={r.ownerAvatar} alt=""
                      style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border-subtle)' }}
                      onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                  ) : (
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>📦</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.owner}</div>
                  </div>
                </div>

                {/* Description */}
                <div style={{ padding: '0 14px 10px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {r.description || 'No description'}
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', marginTop: 'auto' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b' }}>⭐{r.stars}</span>
                  {r.language && (
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', padding: '1px 6px', border: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}>{r.language}</span>
                  )}
                  {r.forks > 0 && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>⑂{r.forks}</span>}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
