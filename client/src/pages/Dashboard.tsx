import React, { useEffect, useState, useRef } from 'react';
import api from '../lib/api';
import { useLang } from '../lib/i18n';
import { notify } from '../lib/notify';

const getVideoId = (item) => {
  return item.video?.snippet?.resourceId?.videoId || item.video?.contentDetails?.videoId || item.video?.id?.videoId || item.video?.id || item.id;
};

/** Normalize a title for flexible matching */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const fmtElapsed = (s) => `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;

const formatDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  try { return dt.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return d?.slice(0, 10) || ''; }
};

const fmtDuration = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
};

const ToggleRow = ({ label, desc, checked, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, padding: '6px 0' }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ fontSize: 8, color: 'var(--color-text-disabled)' }}>{desc}</div>
    </div>
    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', flexShrink: 0, marginLeft: 10 }}>
      <input type="checkbox" checked={checked} onChange={onChange}
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', border: 0 }} />
      <div onClick={onChange} style={{
        width: 34, height: 18,
        border: '2px solid var(--color-border-emphasized, #495056)',
        background: checked ? 'var(--color-accent, #E8F1F6)' : 'transparent',
        position: 'relative', cursor: 'pointer',
      }}>
        <div style={{
          width: 12, height: 12,
          background: 'var(--color-background-body, #101314)',
          border: '1px solid var(--color-border-emphasized, #495056)',
          position: 'absolute', top: 1, left: checked ? 18 : 1,
          transition: 'left 0.12s',
        }} />
      </div>
    </label>
  </div>
);

// ─── Astryx-inspired brutalist component primitives ───
const s: Record<string, any> = {
  mono: { fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)" },
  label: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary, #96A0AB)' },
  value: { fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary, #E8F1F6)', ...{ fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)" } },
  panel: {
    border: '2px solid var(--color-border-emphasized, #495056)',
    background: 'var(--color-background-card, #1a1d20)',
    display: 'flex', flexDirection: 'column',
  },
  panelHdr: {
    background: 'var(--color-background-muted, #24292D)',
    borderBottom: '2px solid var(--color-border-emphasized, #495056)',
    padding: '8px 12px',
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
    color: 'var(--color-text-secondary, #96A0AB)',
  },
  progTrack: {
    width: '100%', height: 6,
    border: '2px solid var(--color-border-emphasized, #495056)',
    background: 'var(--color-background-muted, #24292D)',
  },
  progFill: (pct) => ({
    height: '100%', width: `${pct}%`,
    background: 'var(--color-accent, #E8F1F6)',
    transition: 'width 0.4s ease',
  }),
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px',
    fontSize: 9, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.08em',
    border: '1px solid var(--color-border-emphasized, #495056)',
    background: 'var(--color-background-muted, #24292D)',
    color: 'var(--color-text-primary, #E8F1F6)',
  },
};

export default function Dashboard() {
  const { t } = useLang();
  const [authenticated, setAuthenticated] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState(() => localStorage.getItem('yt_notify') !== '0');
  const [showFilter, setShowFilter] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [fetchFilters, setFetchFilters] = useState<any>({
    excludeShorts: true,
    daysBack: 3,
    excludeProcessed: true,
    replaceList: true,
  });
  const [dashList, setDashList] = useState(false);
  const [fetchLogs, setFetchLogs] = useState([]);  // FETCH 결과 콘솔 로그
  const [fetchedVideos, setFetchedVideos] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dash_videos') || '[]'); }
    catch { return []; }
  });
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [summaryLang, setSummaryLang] = useState('auto');
  const [inputLimit, setInputLimit] = useState(40000);
  const heroRef = useRef(null);
  const [outputTokens, setOutputTokens] = useState(8000);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [fetchSource, setFetchSource] = useState('subscriptions');
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);

  // ─── Processing state ───
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const [currentVideoInfo, setCurrentVideoInfo] = useState(null);
  const processingQueueRef = useRef([]);
  const handledCompletionRef = useRef(false);

  const trySendEmailSummary = async () => {
    const settings = await api.get('/api/settings');
    const savedEmail = settings.data?.email;
    if (!savedEmail) return;

    const queue = processingQueueRef.current;
    if (!queue || queue.length === 0) return;

    const videos = queue.map(v => ({
      title: v.video?.snippet?.title || v.title || '',
      channel_name: v.channelName || v.video?.snippet?.channelTitle || '',
      image_url: v.video?.snippet?.thumbnails?.high?.url || '',
      summary: '',
    }));

    if (!confirm(t(`${videos.length}개 요약 완료. 결과를 ${savedEmail}로 보낼까요?`, `${videos.length} summaries done. Send results to ${savedEmail}?`))) return;

    try {
      const res = await api.post('/api/send-email', { to: savedEmail, videos });
      alert(t(`✅ 이메일 발송 완료 (${res.data.count}개, ${res.data.method || 'SMTP'}): ${savedEmail}`, `✅ Email sent (${res.data.count} items, ${res.data.method || 'SMTP'}): ${savedEmail}`));
    } catch (err) {
      alert('이메일 발송 실패: ' + (err.response?.data?.error || err.message) + '\n\nSettings > 이메일 주소 아래 안내 참고: Gmail OAuth 또는 SMTP 설정이 필요합니다.');
    }
  };

  useEffect(() => { checkAuth(); pollStatus(); const i = setInterval(pollStatus, 2000); const onFocus = () => checkAuth(); window.addEventListener('focus', onFocus); return () => { clearInterval(i); window.removeEventListener('focus', onFocus); }; }, []);
  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [jobStatus?.logs]);
  useEffect(() => { try { localStorage.setItem('dash_videos', JSON.stringify(fetchedVideos)); } catch {} }, [fetchedVideos]);

  const checkAuth = async () => {
    try { const r = await api.get('/api/settings'); setAuthenticated(!!(r.data?.google_access_token)); setSummaryLang(r.data?.youtube_lang || 'auto'); setNotifications(r.data?.yt_notify === '0' ? false : true); setInputLimit(Number(r.data?.youtube_input_limit) || 40000); setOutputTokens(Number(r.data?.youtube_output_tokens) || 8000); }
    catch {}
  };

  const pollStatus = async () => {
    try {
      const r = await api.get('/api/status');
      setJobStatus(r.data);

      if (r.data?.status === 'running') {
        if (!processingRef.current) {
          processingRef.current = true;
          setProcessing(true);
        }
        const logs = r.data.logs || [];
        // 병렬 처리: currentItems에서 현재 처리 중 영상 직접 사용 (로그 파싱 대체)
        const curItems = r.data?.currentItems || [];
        if (curItems.length > 0) {
          const it = curItems[0];
          setCurrentVideoInfo(info => {
            const newInfo = {
              title: it.title || info?.title || 'Processing...',
              thumbnail: it.thumbnail || info?.thumbnail || null,
              channelName: info?.channelName || '',
              publishDate: info?.publishDate || '',
            };
            if (newInfo.thumbnail) sessionStorage.setItem('proc_thumb', newInfo.thumbnail);
            if (newInfo.title) sessionStorage.setItem('proc_title', newInfo.title);
            return newInfo;
          });
        }
        const lastProcessLine = [...logs].reverse().find(l => l.includes('for [') || l.includes('Processing ['));
        if (lastProcessLine) {
          const titleMatch = lastProcessLine.match(/(?:for|Processing)\s*\[(.*)\]\s*$/);
          if (titleMatch) {
            const logTitle = titleMatch[1].trim();
            let match = processingQueueRef.current.find(v => {
              const t = v.video?.snippet?.title || v.title || '';
              return norm(t) === norm(logTitle) || norm(t).startsWith(norm(logTitle)) || norm(logTitle).startsWith(norm(t));
            });
            setCurrentVideoInfo(info => {
              const newInfo = {
                title: logTitle,
                current: r.data.current,
                total: r.data.total,
                elapsed: r.data.elapsedTime || 0,
                channelName: match?.channelName || match?.video?.snippet?.channelTitle || sessionStorage.getItem('proc_channel') || '',
                thumbnail: match ? `https://i.ytimg.com/vi/${getVideoId(match)}/maxresdefault.jpg` : (sessionStorage.getItem('proc_thumb') || null),
                publishDate: match?.video?.snippet?.publishedAt
                  || match?.video?.contentDetails?.videoPublishedAt
                  || match?.publish_date
                  || '',
              };
              // Persist to sessionStorage for tab-switch resilience
              if (newInfo.thumbnail) sessionStorage.setItem('proc_thumb', newInfo.thumbnail);
              if (newInfo.channelName) sessionStorage.setItem('proc_channel', newInfo.channelName);
              if (newInfo.title) sessionStorage.setItem('proc_title', newInfo.title);
              return newInfo;
            });
          }
        }
      } else if ((r.data?.status === 'completed' || r.data?.status === 'done' || r.data?.status === 'failed') && processingRef.current && !handledCompletionRef.current) {
        handledCompletionRef.current = true;
        const doneCount = processingQueueRef.current.length;
        if (r.data?.status === 'completed' && doneCount > 0) {
          if (notifications) { notify(t('요약 완료', 'Summary done'), t(`${doneCount}개 영상 요약이 완료되었습니다`, `${doneCount} videos summarized`)); }
          setTimeout(() => trySendEmailSummary(), 1000);
        } else if (r.data?.status === 'failed') {
          if (notifications) { notify(t('요약 실패', 'Summary failed'), t('처리 중 오류가 발생했습니다', 'An error occurred during processing')); }
        }
        // Notify Results viewer to refresh
        window.dispatchEvent(new CustomEvent('summ-data-changed'));
      } else if (r.data?.status !== 'running' && processingRef.current) {
        processingRef.current = false;
        setTimeout(() => {
          setProcessing(false);
          setCurrentVideoInfo(null);
          // Remove processed videos from the list
          const processedIds = new Set(processingQueueRef.current.map(v => getVideoId(v)));
          setFetchedVideos(prev => prev.filter(v => !processedIds.has(getVideoId(v))));
          setSelectedVideos(new Set());
          processingQueueRef.current = [];
          sessionStorage.removeItem('proc_thumb');
          sessionStorage.removeItem('proc_channel');
          sessionStorage.removeItem('proc_title');
          // Release the scroll pin — return to the control panel (hero collapses)
          setTimeout(() => {
            const cp = document.getElementById('yt-control-panel');
            cp?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 650);
        }, 800);
      }
    } catch {}
  };

  const loadPlaylists = async () => {
    try {
      const r = await api.get('/api/youtube/playlists');
      const list = r.data?.playlists || [];
      setPlaylists(list);
      if (list.length === 0) alert(t('재생목록이 없습니다', 'No playlists found'));
    } catch (e) {
      console.error('[playlists]', e);
      setPlaylists([]);
      alert(t('재생목록 로드 실패: ', 'Playlist load failed: ') + (e.message || JSON.stringify(e)));
    }
  };

  const handleConnect = async () => {
    try { const r = await api.get('/auth/url'); window.location.href = r.data.url; }
    catch (e) { alert(e.message); }
  };

  const startProcessing = async (videos) => {
    processingQueueRef.current = videos;
    handledCompletionRef.current = false;
    setLoading(true);
    try {
      await api.post('/api/process-videos', { videos });
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  };

  const handleFetch = async () => {
    setIsFetching(true);
    try {
      const params: Record<string, any> = { days: fetchFilters.daysBack, excludeShorts: fetchFilters.excludeShorts ? '1' : '0', excludeProcessed: fetchFilters.excludeProcessed ? '1' : '0' };
      if (fetchSource === 'playlists' && selectedPlaylistId) params.playlistId = selectedPlaylistId;
      const r = fetchSource === 'playlists' && selectedPlaylistId
        ? await api.get('/api/youtube/playlist-videos', { params })
        : await api.get('/api/fetch-videos', { params });
      const videos = r.data.videos || [];
      setFetchedVideos(videos);
      const checked = r.data.ytDlpChecked ?? 0, failed = r.data.ytDlpFailed ?? 0, unknown = r.data.unknownDuration ?? 0;
      setFetchLogs(prev => [...prev,
        `[fetch] ${videos.length} videos loaded`,
        ...(unknown > 0 ? [`[shorts] length-checked ${checked} · excluded ${Math.max(0, unknown - checked - failed)}${failed > 0 ? ` · FAILED ${failed}: ${r.data.ytDlpReason || 'yt-dlp unavailable'}` : ''}`] : [])
      ]);
      // 첫 영상 1개만 자동 선택 (설정 검증용 — 전부 선택하면 실수로 대량 처리)
      setSelectedVideos(new Set(videos.length ? [videos[0]] : []));
      alert(t(`${videos.length}개 영상을 가져왔습니다`, `${videos.length} videos fetched`));
      if (autoSummarize && videos.length > 0) {
        await startProcessing(videos);
      }
    } catch (e) { alert(e.message); }
    finally { setIsFetching(false); }
  };

  const saveSummaryLang = (v) => {
    setSummaryLang(v);
    api.put('/api/settings', { youtube_lang: v }).catch(() => {});
  };
  const saveTokens = (k, v, setter) => {
    setter(v);
    api.put('/api/settings', { [k]: String(v) }).catch(() => {});
  };

  const handleProcess = async () => {
    if (selectedVideos.size === 0) return;
    // Scroll so the hero (thumbnail + progress) is fully visible at top.
    // Use scrollIntoView — it finds the actual scroll container (.main-content),
    // unlike window.scrollTo which only scrolls the window.
    await startProcessing(Array.from(selectedVideos));
    setTimeout(() => {
      heroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 650); // wait for hero expand transition (0.6s)
  };

  const handleAddUrl = async (e) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    // Validate YouTube URL format before calling the API
    const ytRe = /(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/;
    if (!ytRe.test(urlInput.trim())) {
      alert(t('올바른 YouTube URL을 입력하세요 (예: https://youtube.com/watch?v=... )', 'Enter a valid YouTube URL (e.g. https://youtube.com/watch?v=... )'));
      return;
    }
    setIsAddingUrl(true);
    try {
      const r = await api.post('/api/add-video-url', { url: urlInput });
      const item = r.data.video;
      if (fetchedVideos.some(v => getVideoId(v) === getVideoId(item))) {
        alert('Already in list');
      } else {
        setFetchedVideos([item, ...fetchedVideos]);
        setSelectedVideos(prev => { const n = new Set(prev); n.add(item); return n; });
        setUrlInput('');
      }
    } catch (e) { alert(e.response?.data?.error || e.message); }
    finally { setIsAddingUrl(false); }
  };

  const toggleVideo = (v) => {
    setSelectedVideos(prev => {
      const n = new Set(prev);
      if (n.has(v)) n.delete(v); else n.add(v);
      return n;
    });
  };

  const toggleAll = () => {
    if (selectedVideos.size === fetchedVideos.length) setSelectedVideos(new Set());
    else setSelectedVideos(new Set(fetchedVideos));
  };

  const isRunning = jobStatus?.status === 'running' || loading;
  const pct = jobStatus?.total > 0 ? Math.round((jobStatus.current / jobStatus.total) * 100) : 0;
  const elapsed = jobStatus?.elapsedTime || 0;

  const statusLabel = isRunning ? 'RUNNING' : jobStatus?.status === 'completed' ? 'COMPLETED' : jobStatus?.status === 'failed' ? 'FAILED' : 'STANDBY';
  const statusColor = isRunning ? '#d3c490' : jobStatus?.status === 'completed' ? '#b3c79a' : '#96A0AB';

  return (
    <div style={{ position: 'relative' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');`}</style>

      {/* ── STICKY HEADER (title → control panel) ── */}

      {/* ── PAGE TITLE ── */}
      <h1 style={{ fontSize: '2.08rem', fontWeight: 800, color: '#121212', margin: '14px 0 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/icons/tabs/youtube.svg" alt="" style={{ width: 26, height: 26 }} /> {t('YouTube', 'YouTube')}
      </h1>

      {/* ════════════════════════════════════════
          PROCESSING HERO
          ════════════════════════════════════════ */}
      <div ref={heroRef} style={{
        maxHeight: processing ? 600 : 0,
        opacity: processing ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.5s ease',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(300px, 720px) minmax(220px, 1fr)',
          gap: 0,
          border: '2px solid var(--color-border-emphasized, #495056)',
          background: 'var(--color-background-card, #1a1d20)',
        }}>
          {/* ── LEFT: Thumbnail + info overlay ── */}
          <div style={{
            position: 'relative',
            overflow: 'hidden',
            borderRight: '2px solid var(--color-border-emphasized, #495056)',
            aspectRatio: '16 / 9',
          }}>
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(135deg, var(--color-background-card, #1a1d20) 0%, var(--color-background-muted, #24292D) 100%)',
              zIndex: 0,
            }} />

            {currentVideoInfo?.thumbnail && (
              <img
                src={currentVideoInfo.thumbnail}
                alt=""
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 1 }}
                onError={(e) => {
                  const src = (e.target as HTMLImageElement).src;
                  // maxresdefault → hqdefault → hide (graceful fallback chain)
                  if (src.includes('/maxresdefault.jpg')) {
                    (e.target as HTMLImageElement).src = src.replace('/maxresdefault.jpg', '/hqdefault.jpg');
                  } else {
                    (e.target as HTMLElement).style.display = 'none';
                  }
                }}
              />
            )}

            <div style={{
              position: 'absolute', top: 12, right: 12, zIndex: 3,
              padding: '4px 10px',
              border: '2px solid var(--color-accent, #E8F1F6)',
              background: 'rgba(16,19,20,0.85)',
              color: '#fff',
              fontSize: 11, fontWeight: 700,
              fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)",
            }}>
              {jobStatus?.current || 0}/{jobStatus?.total || 0}
            </div>

            <div style={{
              position: 'absolute', top: 12, left: 12, right: 80, zIndex: 2,
              padding: '8px 12px',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              borderRadius: 4,
            }}>
              <div style={{
                color: '#fff', fontWeight: 700, fontSize: 15, lineHeight: 1.3,
              }}>
                {currentVideoInfo?.title || 'Processing...'}
              </div>
              {currentVideoInfo?.channelName && (
                <div style={{
                  color: '#fff', fontSize: 11, fontWeight: 600, marginTop: 3, opacity: 0.85,
                  textShadow: '0 1px 6px rgba(0,0,0,0.9)',
                }}>
                  {currentVideoInfo.channelName}
                  {currentVideoInfo?.publishDate && (
                    <span style={{ marginLeft: 10, color: '#fff', fontWeight: 400, opacity: 0.7 }}>
                      {currentVideoInfo.publishDate.length > 10
                        ? currentVideoInfo.publishDate.slice(0, 10)
                        : currentVideoInfo.publishDate}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT: Status panel ── */}
          <div style={{
            padding: 16,
            display: 'flex', flexDirection: 'column', gap: 14,
            background: 'var(--color-background-card, #1a1d20)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...s.label }}>Status</span>
              <span style={{
                ...s.badge,
                color: statusColor,
                borderColor: statusColor,
                animation: isRunning ? 'astryxPulse 1.2s infinite' : 'none',
              }}>
                <span style={{
                  display: 'inline-block', width: 6, height: 6,
                  background: statusColor,
                  marginRight: 4,
                }} />
                {statusLabel}
              </span>
            </div>

            <div style={{ ...s.progTrack }}>
              <div style={{ ...s.progFill(pct) }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { label: 'Progress', value: `${pct}%` },
                { label: 'Elapsed', value: fmtElapsed(elapsed) },
                { label: 'Videos', value: `${jobStatus?.total || 0} total` },
                { label: 'ETA', value: pct > 0 ? fmtElapsed(elapsed / pct * (100 - pct)) : '—' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ ...s.label, marginBottom: 2 }}>{label}</div>
                  <div style={{ ...s.value, fontSize: 16 }}>{value}</div>
                </div>
              ))} 
            </div>

            {isRunning && (
              <button onClick={async () => { try { await api.post('/api/process-cancel'); } catch {/* ignore */} }}
                style={{ ...s.btn, background: '#c6a6a2', borderColor: '#c6a6a2', color: '#101314', marginTop: 4 }}>
                {t('⏹ 중단', '⏹ Stop')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════
           TOP ROW: Metrics + Terminal
           ════════════════════════════════════════ */}
      <div style={{
        display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12,
        marginBottom: 18,
        height: 220,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ ...s.panel, flex: 1, padding: 14, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ ...s.label, marginBottom: 4 }}>System</div>
            <div style={{ ...s.value, fontSize: 28, letterSpacing: '0.02em', marginBottom: 2 }}>
              {statusLabel}
            </div>
            <div style={{ ...s.label, marginTop: 'auto' }}>
              {isRunning ? `${pct}% complete` : jobStatus?.status === 'completed' ? 'All jobs done' : 'Awaiting command'}
            </div>
            {/* 진행 중인 영상들 (병렬 — 동시성 수만큼) */}
            {(jobStatus?.currentItems || []).length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 110, overflowY: 'auto' }}>
                {jobStatus.currentItems.map((it, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 3, borderRadius: 4, background: 'rgba(211,196,144,0.08)', border: '1px solid rgba(211,196,144,0.2)' }}>
                    {it.thumbnail
                      ? <img src={it.thumbnail} alt="" style={{ width: 34, height: 20, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }}
                        onError={e => {
                          const src = (e.target as HTMLImageElement).src;
                          if (src.includes('hqdefault')) { (e.target as HTMLImageElement).src = src.replace('hqdefault', 'mqdefault'); }
                          else { (e.target as HTMLElement).style.display = 'none'; }
                        }} />
                      : <div style={{ width: 34, height: 20, borderRadius: 3, background: 'rgba(128,128,128,0.3)', flexShrink: 0 }} />}
                    <span style={{ fontSize: 10, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }}>
                      {it.title || it.id}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: '#d3c490', flexShrink: 0 }}>●</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ ...s.panel, overflow: 'hidden', minHeight: 0, flexShrink: 0 }}>
          <div style={{ ...s.panelHdr }}>
            <span style={{ color: 'var(--color-error, #c6a6a2)' }}>●</span> console
            {(jobStatus?.logs?.length > 0 || fetchLogs.length > 0) && (
              <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 9 }}>
                {(jobStatus?.logs?.length || 0) + fetchLogs.length} entries
              </span>
            )}
          </div>
          <div ref={logsContainerRef} style={{
            flex: 1, minHeight: 0, padding: 8,
            overflowY: 'auto',
            fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)",
            fontSize: 10, lineHeight: 1.8,
          }}>
            {((jobStatus?.logs?.length || 0) + fetchLogs.length > 0) ? (
              [...fetchLogs, ...(jobStatus?.logs || [])].map((log, i) => {
                const isErr = log.includes('Error') || log.includes('Failed') || log.includes('FAILED');
                const isInfo = log.includes('Processing') || log.includes('Completed') || log.includes('[fetch]') || log.includes('[shorts]');
                return (
                  <div key={i} style={{
                    color: isErr ? 'var(--color-error, #f87171)' : isInfo ? 'var(--color-accent, #E8F1F6)' : 'var(--color-text-secondary, #96A0AB)',
                    padding: '1px 0',
                    borderBottom: '1px solid var(--color-border, rgba(232,241,246,0.1))',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{log}</div>
                );
              })
            ) : (
              <div style={{
                color: 'var(--color-text-disabled, #495056)',
                padding: '20px 0', textAlign: 'center',
                fontStyle: 'italic', fontSize: 9,
              }}>
                [ idle ]<br />
                <span style={{ color: 'var(--color-text-disabled, #495056)' }}>
                  Fetch videos or run a summary to populate logs
                </span>
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      <div id="yt-control-panel" style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', boxShadow: '0 1px 0 #d4d4d8', width: '100%' }}>
      {/* ════════════════════════════════════════
           CONTROL PANEL
           ════════════════════════════════════════ */}

      {!authenticated && (
        <div style={{ flexShrink: 0, padding: '8px 12px', marginBottom: 10, border: '1px solid var(--color-warning, #eab308)', background: 'rgba(234,179,8,0.12)', fontSize: 11, color: '#111', lineHeight: 1.5, fontWeight: 500 }}>
          ⚠ <b>{t('비인증 모드', 'No-auth mode')}</b> {t('— RSS 피드 기반으로 작동합니다. 다음 제한사항이 있습니다:', '— Works via RSS feeds. Limitations:')}<br/>
          {t('• YouTube 요청 제한(429)에 걸릴 수 있음', '• May hit YouTube rate limits (429)')}<br/>
          {t('• RSS에 영상 길이 정보가 없는 영상은 yt-dlp로 실제 길이를 조회해 필터링합니다 (조금 느릴 수 있음)', '• Videos without duration in RSS get their real length checked via yt-dlp for filtering (may be slightly slower)')}<br/>
          {t('• 구독 목록·재생목록 자동 가져오기 불가', '• Cannot auto-import subscriptions/playlists')}<br/>
          <b>{t('Google 계정 연동 시', 'With Google connected,')}</b> YouTube API <b>{t('로 위 문제가 모두 해결됩니다.', 'all of the above is resolved.')}</b>
        </div>
      )}
      <div style={{
        flexShrink: 0, display: processing ? 'none' : 'block',
      }}>
        <div style={{ ...s.panel, marginBottom: 12 }}>
          <div style={{ ...s.panelHdr }}>
            <span>◇</span> control panel
            <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 9, color: 'var(--color-text-disabled)' }}>
              {fetchedVideos.length > 0 ? `${fetchedVideos.length} videos loaded` : 'idle'}
            </span>
          </div>

          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <form onSubmit={handleAddUrl} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
                <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)}
                  placeholder={t('영상 URL을 붙여넣으면 목록에 추가됩니다', 'Paste a video URL to add it')}
                  disabled={isAddingUrl}
                  style={{
                    flex: 1, minWidth: 140,
                    border: '2px solid var(--color-border-emphasized, #495056)',
                    background: 'transparent',
                    padding: '8px 12px',
                    color: 'var(--color-text-primary, #E8F1F6)',
                    fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)",
                    fontSize: 11, fontWeight: 500, outline: 'none',
                  }} />
                <button type="submit" disabled={!urlInput.trim() || isAddingUrl} style={{
                  padding: '8px 14px',
                  border: '2px solid var(--color-error, #c6a6a2)',
                  background: 'var(--color-error, #dc2626)',
                  color: '#fff',
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                  cursor: 'pointer',
                  opacity: (!urlInput.trim() || isAddingUrl) ? 0.4 : 1,
                }}>
                  {isAddingUrl ? '···' : '+ Add'}
                </button>
              </form>

              {authenticated && (
              <div style={{
                display: 'flex', gap: 0,
                border: '2px solid var(--color-border-emphasized, #495056)',
              }}>
                {['subscriptions', 'playlists'].map(src => (
                    <button key={src}
                      onClick={() => { setFetchSource(src); if (src === 'playlists' && playlists.length === 0) loadPlaylists(); }}
                      style={{
                        padding: '8px 14px',
                        border: 'none',
                        borderRight: src === 'subscriptions' ? '1px solid var(--color-border-emphasized, #495056)' : 'none',
                        background: fetchSource === src ? 'var(--color-background-muted, #24292D)' : 'transparent',
                        color: fetchSource === src ? 'var(--color-text-primary, #E8F1F6)' : 'var(--color-text-disabled)',
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                        cursor: 'pointer',
                      }}>
                      {src}
                    </button>
                  ))}
              </div>
              )}
            </div>

            {authenticated && fetchSource === 'playlists' && (
              <select value={selectedPlaylistId} onChange={e => setSelectedPlaylistId(e.target.value)} style={{
                border: '2px solid var(--color-border-emphasized, #495056)',
                background: 'transparent',
                color: 'var(--color-text-primary, #E8F1F6)',
                padding: '8px 10px',
                fontSize: 11, fontWeight: 600,
                fontFamily: "var(--font-family-code, 'JetBrains Mono', monospace)",
                outline: 'none', cursor: 'pointer',
                maxWidth: 400,
              }}>
                <option value="">Select playlist...</option>
                {playlists.map(pl => (
                  <option key={pl.id} value={pl.id}>
                    {pl.title || pl.id}{pl.itemCount ? ` (${pl.itemCount})` : ''}
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {/* Fetch + Filter button group */}
              <div style={{ display: 'flex', alignItems: 'stretch', position: 'relative' }}>
                <button onClick={authenticated ? handleFetch : async () => {
                  setIsFetching(true);
                  try {
                    const params = new URLSearchParams({
                      days: fetchFilters.daysBack,
                      excludeShorts: fetchFilters.excludeShorts ? '1' : '0',
                      excludeProcessed: fetchFilters.excludeProcessed ? '1' : '0',
                    });
                    const data = (await api.get('/api/channels/fetch-rss', { params: { days: fetchFilters.daysBack, excludeShorts: fetchFilters.excludeShorts ? '1' : '0' } })).data;
                    if (data.videos?.length > 0) {
                      const formatted = data.videos.map(v => ({
                        video: { id: { videoId: v.id }, snippet: { title: v.title, channelTitle: v.channelName, thumbnails: { high: { url: v.thumbnail } }, resourceId: { videoId: v.id }, publishedAt: v.publishDate, channelAvatar: v.channelAvatar } },
                        channelName: v.channelName, title: v.title, image_url: v.thumbnail,
                        publishDate: v.publishDate, duration: v.duration,
                      }));
                      setFetchedVideos(formatted); // 항상 교체 (캐시 없음)
                      setSelectedVideos(new Set(formatted.length ? [formatted[0]] : [])); // 첫 1개만 선택
                      const checked = data.ytDlpChecked ?? 0, failed = data.ytDlpFailed ?? 0, unknown = data.unknownDuration ?? 0;
                      setFetchLogs(prev => [...prev,
                        `[fetch] ${data.videos.length} videos loaded`,
                        ...(unknown > 0 ? [`[shorts] length-checked ${checked} · excluded ${Math.max(0, unknown - checked - failed)}${failed > 0 ? ` · FAILED ${failed}: ${data.ytDlpReason || 'yt-dlp unavailable'}` : ''}`] : [])
                      ]);
                      alert(t(`${data.videos.length}개 영상을 가져왔습니다`, `${data.videos.length} videos fetched`));
                    } else {
                      const errMsg = data.error ? ` (${data.error})` : '';
                      const chCnt = data.channelCount ? ` | 채널 ${data.channelCount}개` : '';
                      alert(`새 영상이 없습니다${chCnt}${errMsg}\n\n기간(일)을 늘리거나 채널을 확인해보세요`);
                    }
                  } catch (e) { alert(t('Fetch 실패: ', 'Fetch failed: ') + e.message); }
                  setIsFetching(false);
                }} disabled={isFetching} style={{
                padding: '10px 20px',
                border: '2px solid var(--color-border-emphasized, #495056)',
                background: 'var(--color-accent, #E8F1F6)',
                color: 'var(--color-on-accent, #101314)',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                cursor: 'pointer',
                opacity: (isFetching || (fetchSource === 'playlists' && !selectedPlaylistId)) ? 0.4 : 1,
              }}>
                {isFetching ? '⟳ fetching...' : '▸ fetch'}
              </button>
                <button onClick={() => setShowFilter(!showFilter)}
                  title={t('필터 설정', 'Filter settings')}
                  style={{
                    padding: '10px 14px',
                    border: '2px solid var(--color-accent, #16a34a)',
                    borderLeft: '1px solid var(--color-accent, #16a34a)',
                    background: showFilter ? 'var(--color-accent, #16a34a)' : 'transparent',
                    color: showFilter ? '#fff' : 'var(--color-accent, #16a34a)',
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    cursor: 'pointer',
                  }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>

                {/* 필터 팝업 */}
                {showFilter && (
                  <div style={{
                    position: 'absolute', top: 0, left: '100%', zIndex: 100,
                    marginLeft: 4,
                    background: 'var(--color-background-card, #1a1d20)',
                    border: '2px solid var(--color-border-emphasized, #495056)',
                    padding: 16, minWidth: 280,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
                      ◇ fetch filters
                      <button onClick={() => setShowFilter(false)} style={{ float: 'right', background: 'none', border: 'none', color: 'var(--color-text-disabled)', cursor: 'pointer', fontSize: 12 }}>✕</button>
                    </div>
                    <ToggleRow label={t('자동 요약', 'Auto summary')} desc={t('Fetch 후 자동으로 AI 요약 시작', 'Starts AI summary automatically after Fetch')}
                      checked={autoSummarize}
                      onChange={() => setAutoSummarize(!autoSummarize)} />
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{t('요약 언어', 'Summary language')}</div>
                      <select value={summaryLang} onChange={e => saveSummaryLang(e.target.value)}
                        style={{ width: '100%', padding: '6px 10px', border: '2px solid var(--color-border-emphasized, #495056)', background: 'var(--color-background-body, #101314)', color: 'var(--color-text-primary, #E8F1F6)', fontSize: 11, outline: 'none' }}>
                        <option value="auto">{t('자막 언어 따라가기', 'Follow caption language')}</option>
                        <option value="ko">한국어</option>
                        <option value="en">English</option>
                        <option value="ja">日本語</option>
                        <option value="zh">中文</option>
                      </select>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                        <span>{t('입력 제한', 'Input limit')}</span><span style={{ color: 'var(--color-accent)', fontWeight: 800 }}>{(inputLimit / 1000).toFixed(0)}k</span>
                      </div>
                      <input type="range" value={inputLimit} min={5000} max={120000} step={5000}
                        onChange={e => saveTokens('youtube_input_limit', Number(e.target.value), setInputLimit)}
                        style={{ width: '100%', accentColor: 'var(--color-accent, #6366f1)', cursor: 'pointer' }} />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                        <span>{t('출력 토큰', 'Output tokens')}</span><span style={{ color: 'var(--color-accent)', fontWeight: 800 }}>{outputTokens}</span>
                      </div>
                      <input type="range" value={outputTokens} min={1000} max={16000} step={1000}
                        onChange={e => saveTokens('youtube_output_tokens', Number(e.target.value), setOutputTokens)}
                        style={{ width: '100%', accentColor: 'var(--color-accent, #6366f1)', cursor: 'pointer' }} />
                    </div>
                    <ToggleRow label={t('쇼츠 제외', 'Exclude Shorts')} desc={t('3분 1초(181초) 미만 영상 필터링', 'Filters videos under 3m 1s (181s)')}
                      checked={fetchFilters.excludeShorts}
                      onChange={() => setFetchFilters({ ...fetchFilters, excludeShorts: !fetchFilters.excludeShorts })} />
                    <div style={{ fontSize: 9, color: '#96A0AB', lineHeight: 1.5, padding: '4px 0 8px', borderBottom: '1px solid rgba(232,241,246,0.08)', marginBottom: 8 }}>
                    {t('⚡ RSS 피드에 영상 길이 정보가 없는 채널의 경우 필터가 적용되지 않을 수 있습니다. Google 계정 연동 시 YouTube API로 더 정확한 필터링이 가능합니다.', '⚡ Filters may not apply to channels without duration info in their RSS feed. Connecting Google enables more accurate filtering via the YouTube API.')}
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{t('가져올 기간', 'Period')}</div>
                      <select value={fetchFilters.daysBack}
                        onChange={e => setFetchFilters({ ...fetchFilters, daysBack: Number(e.target.value) })}
                        style={{ width: '100%', padding: '6px 10px', border: '2px solid var(--color-border-emphasized, #495056)', background: 'var(--color-background-body, #101314)', color: 'var(--color-text-primary, #E8F1F6)', fontSize: 11, outline: 'none' }}>
                        <option value={1}>{t('최근 1일', 'Last 1 day')}</option>
                        <option value={3}>{t('최근 3일', 'Last 3 days')}</option>
                        <option value={7}>{t('최근 7일', 'Last 7 days')}</option>
                        <option value={14}>{t('최근 14일', 'Last 14 days')}</option>
                        <option value={30}>{t('최근 30일', 'Last 30 days')}</option>
                      </select>
                    </div>
                    <ToggleRow label={t('이미 처리된 영상 제외', 'Exclude processed')} desc={t('요약 완료된 영상은 건너뜀', 'Skips already summarized')}
                      checked={fetchFilters.excludeProcessed}
                      onChange={() => setFetchFilters({ ...fetchFilters, excludeProcessed: !fetchFilters.excludeProcessed })} />
                    <ToggleRow label={t('목록 초기화', 'Reset list')} desc="FETCH 시 기존 목록을 새 결과로 교체"
                      checked={fetchFilters.replaceList}
                      onChange={() => setFetchFilters({ ...fetchFilters, replaceList: !fetchFilters.replaceList })} />
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                        {t('요약 동시 진행 (API)', 'Parallel summaries (API)')}
                      </div>
                      <select value={String(fetchFilters.concurrency ?? 1)}
                        onChange={e => {
                          const v = e.target.value;
                          setFetchFilters({ ...fetchFilters, concurrency: Number(v) });
                          api.put('/api/settings', { process_concurrency: v }).catch(() => {});
                        }}
                        style={{ padding: '6px 8px', border: '1px solid var(--color-border, #ccc)', borderRadius: 4, fontSize: 11, background: 'var(--color-bg-input, #fff)', color: 'var(--color-text-primary)' }}>
                        {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}{n === 1 ? ` (${t('순차', 'sequential')})` : ''}</option>)}
                      </select>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{t('제목/채널 검색 (표시 필터)', 'Search title/channel (display filter)')}</div>
                      <input type="text" value={filterText} onChange={e => setFilterText(e.target.value)}
                        placeholder={t('검색어 입력...', 'Search...')}
                        style={{ width: '100%', padding: '6px 10px', border: '2px solid var(--color-border-emphasized, #495056)', background: 'transparent', color: 'var(--color-text-primary)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                )}
              </div>
              <button onClick={() => {
                if (selectedVideos.size === 0) {
                  alert(t('처리할 영상을 1개 이상 선택하세요.', 'Select at least one video to process.'));
                  return;
                }
                handleProcess();
              }} disabled={isRunning} style={{
                padding: '10px 20px',
                border: '2px solid var(--color-border-emphasized, #495056)',
                background: 'transparent',
                color: 'var(--color-text-primary, #E8F1F6)',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                cursor: 'pointer',
                opacity: (selectedVideos.size === 0 || isRunning) ? 0.4 : 1,
              }}>
                ▶ process {selectedVideos.size > 0 ? `(${selectedVideos.size})` : ''}
              </button>


              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setDashList(!dashList)}
                  style={{ width: 30, height: 30, border: '1px solid var(--color-border-emphasized, #495056)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-primary)' }}
                  title="View mode">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {dashList ? <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></> : <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>}
                  </svg>
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                  <input type="checkbox" checked={selectedVideos.size === fetchedVideos.length && fetchedVideos.length > 0}
                    onChange={toggleAll}
                    style={{ width: 14, height: 14, accentColor: 'var(--color-accent)' }} />
                  Select all
                </label>
                <button onClick={() => { if (confirm(t('영상 목록을 모두 지울까요?', 'Clear the whole list?'))) { setFetchedVideos([]); setSelectedVideos(new Set()); localStorage.removeItem('dash_videos'); } }}
                  style={{ padding: '2px 8px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', border: '1px solid var(--color-error, #dc2626)', background: 'transparent', color: 'var(--color-error, #dc2626)', cursor: 'pointer' }}>
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>

        {/* ════════════════════════════════════════
             VIDEO LIST
             ════════════════════════════════════════ */}
        <div>
        <div className="dashboard-video-grid" style={dashList
          ? { display: 'flex', flexDirection: 'column', background: '#fff', padding: 8, gap: 0 }
          : { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, background: '#fff', padding: 8 }}>
          {(() => {
            const filtered = filterText
              ? fetchedVideos.filter(v => {
                  const t = v.video?.snippet?.title || v.title || '';
                  const c = v.channelName || v.video?.snippet?.channelTitle || '';
                  const q = filterText.toLowerCase();
                  return t.toLowerCase().includes(q) || c.toLowerCase().includes(q);
                })
              : fetchedVideos;
            return filtered.map((v, i) => {
            const videoId = getVideoId(v);
            const title = v.video?.snippet?.title || v.title || 'Untitled';
            const channel = v.channelName || v.video?.snippet?.channelTitle || '';
            const pubDate = v.publishDate || v.video?.snippet?.publishedAt || '';
            const thumb = v.video?.snippet?.thumbnails?.high?.url || v.image_url || v.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            const selected = selectedVideos.has(v);
            if (dashList) return (
              <div key={videoId || i} onClick={() => toggleVideo(v)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px',
                borderBottom: '1px solid #e2e8f0',
                background: selected ? '#f0fdf4' : '#fff',
                cursor: 'pointer', transition: 'background 0.12s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = selected ? '#f0fdf4' : '#f8fafc'; }}
                onMouseLeave={e => { e.currentTarget.style.background = selected ? '#f0fdf4' : '#fff'; }}
              >
                <div onClick={e => { e.stopPropagation(); toggleVideo(v); }} style={{
                  width: 20, height: 20, flexShrink: 0,
                  border: `2px solid ${selected ? '#16a34a' : '#cbd5e1'}`,
                  background: selected ? '#16a34a' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                }}>
                  {selected && <span style={{ color: '#fff', fontWeight: 900, fontSize: 11 }}>✓</span>}
                </div>
                <div style={{ width: 96, height: 54, flexShrink: 0, overflow: 'hidden', background: '#f1f5f9', position: 'relative' }}>
                  <img src={thumb} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }} />
                  {v.duration > 0 && (
                    <span style={{ position: 'absolute', bottom: 2, right: 2, background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '1px 4px', fontSize: 9, fontWeight: 600 }}>{fmtDuration(v.duration)}</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                  <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel}{pubDate ? ` · ${formatDate(pubDate)}` : ''}</div>
                </div>
                <div onClick={e => { e.stopPropagation(); setFetchedVideos(prev => { const n = prev.filter(x => getVideoId(x) !== videoId); setSelectedVideos(s => { const ns = new Set(s); ns.delete(v); return ns; }); return n; }); }}
                  style={{ width: 24, height: 24, flexShrink: 0, background: 'transparent', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>✕</div>
              </div>
            );
            return (
              <div key={videoId || i} onClick={() => toggleVideo(v)} style={{
                display: 'flex', flexDirection: 'column',
                border: `2px solid ${selected ? '#111' : '#e2e8f0'}`,
                background: selected ? '#fff' : '#fff',
                cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = selected ? '#fff' : '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = selected ? '#fff' : '#fff'; }}
              >
                <div style={{ position: 'relative' }}>
                  <img src={thumb} alt=""
                    style={{
                      width: '100%', aspectRatio: '16/9', objectFit: 'cover',
                      borderBottom: '1px solid #e2e8f0',
                    }}
                    onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                  />
                  {v.duration > 0 && (
                    <span style={{
                      position: 'absolute', bottom: 4, right: 4,
                      background: 'rgba(0,0,0,0.75)', color: '#fff',
                      padding: '2px 6px', fontSize: 10, fontWeight: 600,
                    }}>{fmtDuration(v.duration)}</span>
                  )}
                  <div onClick={e => { e.stopPropagation(); setFetchedVideos(prev => { const n = prev.filter(x => getVideoId(x) !== videoId); setSelectedVideos(s => { const ns = new Set(s); ns.delete(v); return ns; }); return n; }); }}
                    style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, background: 'rgba(0,0,0,0.6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: '50%', fontSize: 12, lineHeight: 1, zIndex: 2 }}>✕</div>
                  <div onClick={e => { e.stopPropagation(); toggleVideo(v); }} style={{
                    position: 'absolute', bottom: 4, left: 4,
                    width: 20, height: 20,
                    border: `2px solid ${selected ? '#16a34a' : 'rgba(255,255,255,0.6)'}`,
                    background: selected ? '#16a34a' : 'rgba(0,0,0,0.35)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer',
                  }}>
                    {selected && <span style={{ color: '#fff', fontWeight: 900, fontSize: 12 }}>✓</span>}
                  </div>
                </div>
                <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{
                    fontWeight: 700, fontSize: 13, lineHeight: 1.4,
                    color: '#111',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    marginBottom: 6,
                  }}>
                    {title}
                  </div>
                  {channel && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 'auto' }}>
                      {channel}
                    </div>
                  )}
                  {pubDate && (
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{formatDate(pubDate)}</div>
                  )}
                </div>
              </div>
            );
          });
          })()}
        </div>
        </div>
      <style>{`
        @keyframes astryxPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @media (max-width: 1024px) {
          .dashboard-video-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (max-width: 640px) {
          .dashboard-video-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
