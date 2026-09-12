import React, { useEffect, useState, useRef } from 'react';
import api from '../lib/api';
import { useLang } from '../lib/i18n';
import { invoke } from '@tauri-apps/api/core';

const BORDER = '2px solid var(--border-color)';
const BORDER_L = '1.5px solid var(--border-subtle)';
const openLink = (url) => { invoke('open_url', { url }).catch(e => console.warn('open:', e)); };

export default function YouTubeConnect() {
  const { t, lang } = useLang();
  // t() 문자열 안의 <b>…</b>를 JSX <b>로 변환 (React 이스케이프 방지)
  const rich = (s) => {
    const parts = String(s).split(/<b>(.*?)<\/b>/g);
    if (parts.length === 1) return parts[0];
    return parts.map((part, i) => i % 2 === 1 ? <b key={i}>{part}</b> : part);
  };
  const [auth, setAuth] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState('');
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [channels, setChannels] = useState([]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savedClientId, setSavedClientId] = useState('');
  const [savedClientSecret, setSavedClientSecret] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  window.__summDirty = dirty;


  useEffect(() => {
    checkAuth();
    loadChannels();
    const onFocus = () => checkAuth();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const checkAuth = async () => {
    try {
      const r = await api.get('/api/settings');
      const s = r.data || {};
      const hasToken = !!(s.google_access_token || s.google_refresh_token);
      setSavedClientId(s.google_client_id || '');
      setSavedClientSecret(s.google_client_secret || '');
      setClientId(s.google_client_id || '');
      setClientSecret(s.google_client_secret || '');
      setAuth({
        authenticated: hasToken,
        email: s.google_email || '',
        hasRefreshToken: !!s.google_refresh_token,
        isExpired: false,
      });
    } catch { setAuth({ authenticated: false }); }
  };

  const loadChannels = async () => {
    try { const r = await api.get('/api/channels'); setChannels(r.data.channels || []); }
    catch { setChannels([]); }
  };

  const toggleChannel = (id) => setSelectedChannels(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelectAll = () => setSelectedChannels(selectedChannels.size === channels.length ? new Set() : new Set(channels.map(c => c.channelId)));

  const handleDeleteSelected = async () => {
    if (!confirm(`선택한 ${selectedChannels.size}개 채널을 삭제할까요?`)) return;
    try { for (const id of selectedChannels) await api.delete(`/api/channels/${id}`); setSelectedChannels(new Set()); loadChannels(); }
    catch { alert(t('일부 삭제 실패', 'Some failed to delete')); }
  };

  const handleCsvImport = async () => {
    const rows = csvText.trim().split('\n').filter(r => r.trim());
    if (rows.length < 1) { alert(t('내용이 비었습니다', 'Content is empty')); return; }
    const firstRow = rows[0].replace(/\"/g, '').trim();
    const hasHeader = /(채널\s*ID|Channel\s*Id|channel_id)/i.test(firstRow);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    if (dataRows.length < 1) { alert(t('채널 데이터가 없습니다', 'No channel data')); return; }
    const parsed = dataRows.map(r => {
      const cols = r.split(',').map(c => c.replace(/\"/g, '').trim());
      return { channelId: cols[0] || '', channelName: cols[2] || (cols[1]?.includes('youtube.com') ? '' : cols[1]) };
    }).filter(c => c.channelId && /^UC/.test(c.channelId));
    if (parsed.length === 0) { alert(t('유효한 채널 ID를 찾을 수 없습니다 (UC로 시작하는 ID 필요)', 'No valid channel ID (must start with UC)')); return; }
    try {
      const r = await api.post('/api/channels/import-csv', { channels: parsed });
      setImportResult(`${r.data.imported}개 채널 등록 완료`); setCsvText(''); loadChannels();
    } catch (e) { setImportResult('실패: ' + e); }
  };


  async function handleCsvImportFromText(text) {
    const rows = text.trim().split('\n').filter(r => r.trim());
    if (rows.length < 1) return;
    const firstRow = rows[0].replace(/\"/g, '').trim();
    const hasHeader = /(채널\s*ID|Channel\s*Id|channel_id)/i.test(firstRow);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const parsed = dataRows.map(r => {
      const cols = r.split(',').map(c => c.replace(/\"/g, '').trim());
      return { channelId: cols[0] || '', channelName: cols[2] || (cols[1]?.includes('youtube.com') ? '' : cols[1]) };
    }).filter(c => c.channelId && /^UC/.test(c.channelId));
    if (parsed.length > 0) {
      try {
        const r = await api.post('/api/channels/import-csv', { channels: parsed });
        setImportResult(`${r.data.imported}개 채널 등록 완료`);
        loadChannels();
      } catch (err) { setImportResult('실패: ' + err); }
    }
  }

  const Section = ({ icon, title, children }) => (
    <div style={{ borderBottom: BORDER, background: '#fff', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: BORDER }}>
        <span style={{ fontSize: '1.17rem', fontWeight: 800, color: '#121212' }}>{title}</span>
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );

  return (
    <div style={{ paddingTop: 8 }}>
      {dirty && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 999, background: '#fffbeb', borderBottom: '2px solid #d97706', padding: '8px 16px', fontSize: 12, fontWeight: 700, color: '#92400e', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>⚠️ {t('Client ID/Secret을 입력한 뒤 [Google 로그인] 버튼을 눌러야 저장됩니다. 저장하지 않고 떠나면 변경사항이 사라집니다.', 'Press [Google Sign-in] to save the Client ID/Secret. Leaving now will lose your changes.')}</span>
        </div>
      )}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
        @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }
      `}</style>

      <h1 style={{ fontSize: '2.08rem', fontWeight: 800, color: '#121212', margin: '6px 0 24px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/icons/youtube.ico" alt="" style={{ width: 28, height: 28 }} /> {t('YouTube 연결', 'YouTube Connection')}
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 300px', gap: 16, marginBottom: 24 }}>
        <div style={{ borderBottom: '2px solid #121212', background: '#fff', padding: '18px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: 8 }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#121212' }}>{t('등록된 채널', 'Channels')}</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: '#121212', lineHeight: 1 }}>{channels.length}</div>
          {auth?.authenticated && (
            <button onClick={async () => {
              try { const r = await api.get('/api/youtube/subscriptions'); alert(t(`구독 동기화 완료: ${r.data.imported}개 신규 등록 (총 ${r.data.total}개)`, `Sync done: ${r.data.imported} added (${r.data.total} total)`)); loadChannels(); }
              catch (e) { alert(t('동기화 실패: ', 'Sync failed: ') + (e.message || JSON.stringify(e))); }
            }} style={{ padding: '4px 12px', fontSize: '0.78rem', fontWeight: 700, border: 'none', borderBottom: '2px solid #121212', background: 'transparent', color: '#121212', cursor: 'pointer', transition: 'background 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-tint)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              {t('구독 동기화', 'Sync subscriptions')}
            </button>
          )}
        </div>

        <div style={{ borderBottom: '2px solid #121212', background: '#fff', padding: '18px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
          <div style={{ fontSize: '1.15rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#121212' }}>{t('연동 상태', 'Connection status')}</div>
          {auth === null ? <div style={{ color: 'var(--text-muted)' }}>{t('확인 중...', 'Checking...')}</div>
          : auth.authenticated ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'stretch', justifyContent: 'center' }}>
                <span style={{ fontSize: 24 }}>✅</span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, color: '#16a34a', fontSize: '1.2rem' }}>{t('Google 계정 연동됨', 'Google connected')}</div>
                  <div style={{ fontSize: '0.845rem', color: 'var(--text-secondary)' }}>{auth.email || ''}{auth.hasRefreshToken ? t(' · 자동 갱신 가능', ' · auto-refresh') : ''}{auth.isExpired ? t(' · 토큰 만료됨', ' · token expired') : ''}</div>
                </div>
              </div>
              <button onClick={async () => { if (!confirm('Google 계정 연동을 해제할까요?\n저장된 토큰이 삭제됩니다.')) return; try { await api.put('/api/settings', { google_access_token: '', google_refresh_token: '', google_email: '' }); checkAuth(); } catch { alert(t('해제 실패', 'Disconnect failed')); } }}
                style={{ padding: '6px 14px', border: 'none', borderBottom: '2px solid #121212', background: 'transparent', cursor: 'pointer', fontSize: '0.845rem', fontWeight: 700, color: '#dc2626', transition: 'background 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                {t('연동 해제하기', 'Disconnect')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span style={{ fontSize: 24 }}>❌</span>
              <span style={{ fontSize: '1.04rem', color: 'var(--text-secondary)' }}>{t('연동 안 됨', 'Not connected')}</span>
            </div>
          )}
        </div>
      </div>

      {channels.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            {selectedChannels.size > 0 && (
              <button onClick={handleDeleteSelected} style={{ padding: '3px 10px', fontSize: '0.845rem', fontWeight: 700, border: 'none', borderBottom: '2px solid #121212', background: 'transparent', color: '#dc2626', cursor: 'pointer' }}>
                선택 삭제 ({selectedChannels.size})
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, borderBottom: '2px solid #121212', background: '#fff', maxHeight: 350, overflowY: 'auto', padding: 0 }}>
            <div style={{ gridColumn: '1 / -1', padding: '6px 10px', borderBottom: '1.5px solid #d4d4d8', background: '#fff', fontSize: '0.845rem', color: 'var(--text-secondary)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedChannels.size === channels.length && channels.length > 0} onChange={toggleSelectAll} style={{ width: 14, height: 14, accentColor: '#121212' }} />
                {t('전체 선택', 'Select all')}
              </label>
            </div>
            {channels.map((ch, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', fontSize: '0.845rem', color: '#121212', borderBottom: i < channels.length - 1 ? '1.5px solid #d4d4d8' : 'none', background: selectedChannels.has(ch.channelId) ? '#f0fdf4' : '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <input type="checkbox" checked={selectedChannels.has(ch.channelId)} onChange={() => toggleChannel(ch.channelId)} style={{ width: 14, height: 14, accentColor: '#16a34a', flexShrink: 0 }} />
                  <img src={`https://www.google.com/s2/favicons?sz=32&domain=youtube.com/channel/${ch.channelId}`} alt="" style={{ width: 14, height: 14, flexShrink: 0 }} onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.channelName || ch.channelId?.slice(0, 12) + '...'}</span>
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '1px 4px', border: '1.5px solid', flexShrink: 0, marginLeft: 4, color: ch.source === 'youtube' ? '#0369a1' : '#767676', borderColor: ch.source === 'youtube' ? '#7dd3fc' : '#d4d4d8' }}>{ch.source === 'youtube' ? 'YouTube' : 'CSV'}</span>
                </div>
                <button onClick={async (e) => { e.stopPropagation(); if (!confirm(`'${ch.channelName || ch.channelId}' 채널을 삭제할까요?`)) return; try { await api.delete(`/api/channels/${ch.channelId}`); loadChannels(); } catch { alert(t('삭제 실패', 'Delete failed')); } }}
                  style={{ flexShrink: 0, marginLeft: 6, padding: '1px 6px', fontSize: '0.78rem', fontWeight: 700, border: 'none', borderBottom: '2px solid #121212', background: 'transparent', color: '#dc2626', cursor: 'pointer' }}>{t('삭제', 'Delete')}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={auth?.authenticated ? '' : 'two-col'}>
        <div>
          {!auth?.authenticated && (
          <Section icon="/icons/youtube/benefit.svg" title={t('미인증 상태로 사용하기', 'Use without auth')}>
            <p style={{ fontSize: '1.04rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
              {rich(t('Google 계정을 연동하지 않아도 <b>RSS 피드</b>와 <b>CSV 구독 목록</b>으로 채널을 등록하고 영상을 가져올 수 있습니다. 아래에서 CSV 파일을 불러오거나 채널을 직접 입력하세요.', 'No Google account needed — register channels and fetch videos via <b>RSS feed</b> or a <b>CSV subscription list</b>. Load a CSV below or add channels manually.'))}
            </p>
          </Section>
          )}

          {!auth?.authenticated && (
          <Section icon="/icons/youtube/benefit.svg" title={t('연동하면 좋은 점', 'Benefits of connecting')}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[
                [t('YouTube API 직접 호출', 'Direct YouTube API'), t('RSS보다 빠르고 안정적이며 요청 제한(429)이 없습니다', 'faster and more reliable than RSS, with no rate limits (429)')],
                [t('구독 목록 자동 동기화', 'Auto-sync subscriptions'), t('내가 구독한 채널을 한 번에 등록합니다', 'register all your subscriptions at once')],
                [t('영상 상세 정보 확보', 'Accurate video details'), t('카테고리 · 게시일자 · 영상 길이를 정확히 가져옵니다', 'exact category, date and duration')],
                [t('쇼츠 필터링 정확', 'Accurate Shorts filtering'), t('RSS에 길이 정보가 없어도 정확히 구분합니다', 'API tells Shorts apart even without RSS duration')],
                [t('나중에 볼 영상 저장', 'Watch Later'), t('요약 보다가 맘에 드는 영상을 내 YouTube 계정에 저장합니다. (Google이 API로 기본 나중에 볼 영상 목록 수정을 차단하여, 앱 전용으로 생성되는 비공개 플레이리스트에 저장됩니다)', 'save videos to your YouTube account while reading summaries. (Google blocks API writes to the built-in Watch Later list, so videos go to a private app-created playlist instead)')],
              ].map(([a, b], i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 0', borderBottom: i < 4 ? '1px solid #d4d4d8' : 'none' }}>
                  <span style={{ width: 130, flexShrink: 0, fontSize: '0.91rem', fontWeight: 800, color: '#121212' }}>{a}</span>
                  <span style={{ fontSize: '0.845rem', color: 'var(--text-muted)' }}>{b}</span>
                </div>
              ))}
            </div>
          </Section>
          )}

          

          {!auth?.authenticated && (
          <Section icon="/icons/youtube/oauth.svg" title={t('Google 계정 연동', 'Google account connection')}>
            <p style={{ fontSize: '0.975rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 10px 0' }}>
              {rich(t('Google 계정을 연동하면 <b>내 구독 목록 자동 등록</b>, <b>재생목록 기반 Fetch</b>, <b>YouTube API 직접 호출</b>이 가능해집니다. OAuth <b>데스크톱 앱</b> 방식으로 앱 심사 불필요합니다.', 'Connecting Google enables <b>auto-registering your subscriptions</b>, <b>playlist-based Fetch</b> and <b>direct YouTube API calls</b>. Uses OAuth <b>Desktop App</b> — no app review needed.'))}
            </p>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, padding: '10px 14px', background: 'var(--bg-hover)', border: BORDER, fontSize: '1.04rem' }}>📖 {t('Google Cloud Console 설정 방법', 'Google Cloud Console setup guide')}</summary>
              <div style={{ padding: '12px', border: BORDER, borderTop: 'none', background: 'var(--bg-hover)', fontSize: '0.91rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                <h3 style={{ fontSize: '1.04rem', fontWeight: 800, color: '#121212', marginBottom: 6 }}>① {t('프로젝트 선택/생성', 'Select / create project')}</h3>
                <div><span onClick={() => openLink('https://console.cloud.google.com')} style={{ color: '#2563eb', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Google Cloud Console</span> {t('접속', 'open')}</div>
                <div>{t('상단 프로젝트 선택 →', 'Pick a project at the top →')} <b>{t('기존 프로젝트 활용', 'use existing')}</b> or <b>{t('새 프로젝트', 'new project')}</b> {t('생성 (이름: 아무거나)', '(any name)')}</div>
                <div style={{ background: 'var(--bg-hover)', border: '1px solid #fecaca', padding: '6px 10px', marginTop: 4, fontSize: '0.845rem', color: '#991b1b' }}>
                  ⚠️ <b>{t('MFA(2단계 인증)', 'MFA (2-step verification)')}</b>{t('가 설정되어 있어야 진행할 수 있습니다. 미설정 시 Google 계정 보안 설정에서 먼저 등록하세요.', 'must be enabled to continue. If not set up, enable it in your Google account security settings first.')}
                </div>

                <h3 style={{ fontSize: '1.04rem', fontWeight: 800, color: '#121212', margin: '14px 0 6px' }}>② {t('YouTube Data API v3 사용 설정', 'Enable YouTube Data API v3')}</h3>
                <div>{t('좌측 메뉴 ≡ →', 'Left menu ≡ →')} <b>{t('API 및 서비스', 'APIs & Services')}</b> → <b>{t('라이브러리', 'Library')}</b> → <b>YouTube Data API v3</b> {t('검색 →', 'search →')} <b>{t('사용 설정', 'Enable')}</b></div>
                <div style={{ fontSize: '0.845rem', color: 'var(--text-muted)', marginTop: 2 }}>{t('사용 설정 버튼 클릭 후 생성까지 잠시 대기 (10~30초)', 'Wait 10-30s after clicking Enable')}</div>

                <h3 style={{ fontSize: '1.04rem', fontWeight: 800, color: '#121212', margin: '14px 0 6px' }}>③ {t('OAuth 동의 화면', 'OAuth consent screen')}</h3>
                <div>{t('좌측 메뉴 ≡ →', 'Left menu ≡ →')} <b>{t('API 및 서비스', 'APIs & Services')}</b> → <b>{t('OAuth 동의 화면', 'OAuth consent screen')}</b> → User Type: <b>{t('외부(External)', 'External')}</b> → {t('만들기', 'Create')}</div>
                <div style={{ background: 'var(--bg-hover)', border: '1px solid #fecaca', padding: '6px 10px', marginTop: 4, fontSize: '0.845rem', color: '#991b1b' }}>
                  ⚠️ {t('앱 이름, 사용자 지원 이메일, 개발자 연락처 정보만 입력하면 됩니다. 나머지는 건너뛰고', 'Only enter app name, support email and developer contact. Skip the rest and click')} <b>저장 후 계속</b>.
                </div>
                <div>범위(Scopes) 화면은 <b>건너뛰기</b></div>

                <h3 style={{ fontSize: '1.04rem', fontWeight: 800, color: '#121212', margin: '14px 0 6px' }}>④ {t('OAuth 클라이언트 ID 발급 + 테스트 사용자 등록', 'Create OAuth Client ID + add test users')}</h3>
                <div>좌측 메뉴 ≡ → <b>API 및 서비스</b> → <b>{t('사용자 인증 정보', 'Credentials')}</b> → <b>{t('사용자 인증 정보 만들기', 'Create credentials')}</b> → <b>{t('OAuth 클라이언트 ID', 'OAuth Client ID')}</b></div>
                <div>{t('애플리케이션 유형:', 'Application type:')} <b>{t('데스크톱 앱', 'Desktop app')}</b></div>
                <div>{t('이름: 아무거나 (예: SMMYNP)', 'Name: anything (e.g. SMMYNP)')}</div>
                <div style={{ background: 'var(--bg-hover)', border: '1px solid #fecaca', padding: '6px 10px', marginTop: 4, fontSize: '0.845rem', color: '#991b1b' }}>
                  ⚠️ <b>{t('이름만 입력', 'only the name')}</b>{t('하면 생성됩니다. 만들기 버튼 클릭 시', 'is enough. When you click Create, a popup shows your')} <b>{t('클라이언트 ID와 Client Secret', 'Client ID and Client Secret')}</b>{t('가 포함된 팝업이 표시됩니다. 둘 다 복사해서 아래에 입력하세요.', 'Popup. Copy both and enter them below.')}<br/>
                  <b style={{ color: '#dc2626' }}>{t('이 정보는 외부에 공개하지 말고 로컬에 안전하게 보관하세요.', 'Keep this private and stored safely on your machine.')}</b>
                </div>
                <div style={{ background: 'var(--bg-hover)', border: '1px solid #fecaca', padding: '6px 10px', marginTop: 8, fontSize: '0.845rem', color: '#991b1b' }}>
                  ⚠️ <b>{t('클라이언트 생성 후, 반드시 테스트 사용자를 등록해야 합니다.', 'After creating the client, you MUST register a test user.')}</b><br/>
                  {t('등록 경로: 좌측 메뉴 ≡ →', 'Path: left menu ≡ →')} <b>{t('API 및 서비스', 'APIs & Services')}</b> → <b>{t('OAuth 동의 화면', 'OAuth consent screen')}</b> → <b>{t('대상', 'Audience')}</b> → <b>{t('테스트 사용자', 'Test users')}</b> → <b>Add Users</b> → {t('내 이메일 주소 입력', 'enter your email')}<br/>
                  {t('추가하지 않으면', 'Without this you will get')} <b>"액세스 차단됨"</b> {t('오류가 발생하여 로그인할 수 없습니다.', 'and cannot sign in.')}
                </div>

                <h3 style={{ fontSize: '1.04rem', fontWeight: 800, color: '#121212', margin: '14px 0 6px' }}>⑤ {t('앱에 Client ID 입력', 'Enter Client ID in the app')}</h3>
                <div>{t('생성된', 'Copy the generated')} <b>클라이언트 ID</b>{t('를 복사해서 아래 입력창에 붙여넣으세요.', 'and paste it into the input below.')}
                <b style={{ color: '#16a34a' }}>{t('Client ID와 Client Secret 모두 입력해야 합니다. 리디렉션 URI 등록은 필요 없습니다.', 'Both Client ID and Client Secret are required. No redirect URI registration needed.')}</b></div>
              </div>
            </details>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" placeholder={t('Google Client ID 붙여넣기', 'Paste Google Client ID')} value={clientId}
                onChange={e => { setClientId(e.target.value); setDirty(e.target.value !== savedClientId || clientSecret !== savedClientSecret); }}
                style={{ flex: 2, minWidth: 200, padding: '8px 12px', fontSize: '0.91rem', border: BORDER, outline: 'none', fontFamily: 'monospace' }} />
              <input type="text" placeholder={t('Client Secret (필수)', 'Client Secret (required)')} value={clientSecret}
                onChange={e => { setClientSecret(e.target.value); setDirty(e.target.value !== savedClientSecret || clientId !== savedClientId); }}
                style={{ flex: 1, minWidth: 140, padding: '8px 12px', fontSize: '0.91rem', border: BORDER, outline: 'none', fontFamily: 'monospace' }} />
              <button onClick={async () => {
                const cid = clientId.trim();
                const csec = clientSecret.trim();
                if (!cid) { alert(t('Client ID를 입력하세요', 'Enter Client ID')); return; }
                if (!csec) { alert(t('Client Secret을 입력하세요', 'Enter Client Secret')); return; }
                try {
                  await api.put('/api/settings', { google_client_id: cid, google_client_secret: csec });
                  setSavedClientId(cid); setSavedClientSecret(csec); setDirty(false);
                  const r = await api.get('/api/oauth/url');
                  if (r.data?.url) invoke('open_url', { url: r.data.url });
                  else alert(t('OAuth URL 생성 실패: ', 'OAuth URL failed: ') + JSON.stringify(r.data));
                } catch (e) { alert(t('오류: ', 'Error: ') + JSON.stringify(e)); }
              }}
                style={{ padding: '8px 18px', fontSize: '1.04rem', fontWeight: 700, border: BORDER, background: '#121212', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                🔗 {t('Google 로그인', 'Google Sign-in')}
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: '0.845rem', color: 'var(--text-muted)' }}>
              {t('Google 로그인 창이 열리면:', 'When the Google sign-in window opens:')} <b>{t('로그인', 'Sign in')}</b> → <b>{t('계속', 'Continue')}</b> → {t('체크박스 선택 →', 'select the checkbox →')} <b>{t('계속', 'Continue')}</b> {t('순서로 진행하세요.', '')}<br/>
              {t('완료 후 자동으로 이 앱으로 돌아와 인증이 완료됩니다.', 'You will automatically return to the app and be authenticated.')}
            </div>
          </Section>
          )}
        </div>

        <div>
          <Section icon="/icons/youtube/register.svg" title={t('개별 채널 등록', 'Add channel manually')}>
            <p style={{ fontSize: '0.975rem', color: 'var(--text-muted)', margin: '0 0 10px 0' }}>
              {t('YouTube 채널 URL 또는 채널 ID를 입력해서 하나씩 추가할 수 있습니다', 'Enter a YouTube channel URL or channel ID to add them one by one')}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="single-channel-input" type="text"
                placeholder="https://youtube.com/@채널명  또는  UCxxxxxxxx"
                style={{ flex: 1, padding: '8px 12px', fontSize: '1.04rem', border: BORDER, outline: 'none', fontFamily: 'Outfit, sans-serif' }} />
              <button onClick={async () => {
                const input = document.getElementById('single-channel-input') as HTMLInputElement;
                const raw = input?.value?.trim();
                if (!raw) { alert(t('채널 URL 또는 ID를 입력하세요', 'Enter channel URL or ID')); return; }
                let channelId = raw;
                // channel/UC... 패턴
                const m = raw.match(/channel\/(UC[\w-]+)/);
                if (m) channelId = m[1];
                // @handle 패턴 → API로 UC ID 조회
                else if (raw.includes('@') || raw.includes('youtube.com') || raw.includes('youtu.be')) {
                  try {
                    const r = await api.get('/api/resolve-channel', { params: { url: raw } });
                    if (r.data?.channelId) {
                      channelId = r.data.channelId;
                      const chName = r.data.channelName || '';
                      const reg = await api.post('/api/channels/import-csv', { channels: [{ channelId, channelName: chName }] });
                      setImportResult(`${reg.data.imported}개 채널 등록 완료 (${chName || channelId})`);
                      input.value = '';
                      loadChannels();
                      return;
                    } else { alert(t('채널 ID를 찾을 수 없습니다', 'Channel ID not found')); return; }
                  } catch (e) { alert(t('조회 실패: ', 'Lookup failed: ') + (e.message || e)); return; }
                }
                if (!channelId.startsWith('UC')) { alert(t('UC로 시작하는 채널 ID를 찾을 수 없습니다', 'No channel ID starting with UC')); return; }
                try {
                  const r = await api.post('/api/channels/import-csv', { channels: [{ channelId, channelName: '' }] });
                  setImportResult(`${r.data.imported}개 채널 등록 완료`);
                  input.value = '';
                  loadChannels();
                } catch (e) { alert(t('등록 실패: ', 'Register failed: ') + e); }
              }}
                style={{ padding: '8px 18px', fontSize: '1.04rem', fontWeight: 700, border: BORDER, background: '#121212', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                ➕ {t('추가', 'Add')}
              </button>
            </div>
          </Section>

          {!auth?.authenticated && (
          <Section icon="/icons/youtube/csv.svg" title={t('Google Takeout CSV 불러오기', 'Import Google Takeout CSV')}>
            <div style={{ margin: '0 0 8px 0', fontSize: '0.91rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              ① <span onClick={() => openLink('https://takeout.google.com')} style={{ color: '#2563eb', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>Google Takeout</span> {t('접속', 'open')}<br/>
              ② <b>{t('포함할 데이터 선택', 'Select data to include')}</b> → <b>YouTube 및 YouTube Music</b> <span style={{ color: '#16a34a', fontWeight: 700 }}>✔</span> {t('체크', 'check')}<br/>
              ③ <b>{t('모든 YouTube 데이터 포함됨', 'All YouTube data included')}</b> → <b>{t('구독정보', 'Subscriptions')}</b> {t('만', 'only')} <span style={{ color: '#16a34a', fontWeight: 700 }}>✔</span> {t('체크 후', 'check, then')} <b>{t('확인', 'Confirm')}</b><br/>
              ④ {t('페이지 하단', 'At the bottom, click')} <b>{t('내보내기 생성', 'Create export')}</b><br/>
              ⑤ {t('Google 이메일 수신 확인 → ZIP 다운로드 → 압축 해제', 'Confirm in your email → download ZIP → extract')}<br/>
              ⑥ <code style={{ background: 'var(--bg-hover)', padding: '1px 4px', border: BORDER_L, fontSize: '0.845rem' }}>{lang === 'en' ? 'Takeout/YouTube and YouTube Music/Subscriptions/subscriptions.csv' : 'Takeout/YouTube 및 YouTube Music/구독정보/구독정보.csv'}</code> {t('파일 업로드', 'upload the file')}<br/>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {lang === 'en'
                  ? t('(한국어 Google 계정이면 폴더명이 구독정보입니다: Takeout/YouTube 및 YouTube Music/구독정보/구독정보.csv)', '(If your Google account is in Korean, the folder is named 구독정보: Takeout/YouTube 및 YouTube Music/구독정보/구독정보.csv)')
                  : t('(영문 Google 계정이면 폴더명이 Subscriptions입니다: Takeout/YouTube and YouTube Music/Subscriptions/subscriptions.csv)', '(If your Google account is in English, the folder is named Subscriptions: Takeout/YouTube and YouTube Music/Subscriptions/subscriptions.csv)')}
              </span>
            </div>
            <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg-hover)', border: '1.5px solid #fecaca', fontSize: '0.845rem', color: '#991b1b', lineHeight: 1.6 }}>
              ⚠️ <b>{t('주의:', 'Note:')}</b> {t('채널을 내보낼 Google 계정으로 로그인했는지 반드시 확인하세요.', 'make sure you are logged into the Google account that owns the channels.')}
            </div>
            <div onDragOver={e => { e.preventDefault(); e.currentTarget.style.background = '#f0f9ff'; }}
              onDragLeave={e => { e.currentTarget.style.background = '#fafafa'; }}
              onClick={() => {
                const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv';
                inp.onchange = async () => { if (inp.files[0]) { const text = await inp.files[0].text(); setCsvText(text); handleCsvImportFromText(text); } };
                inp.click();
              }}
              style={{ padding: '20px', marginBottom: 10, textAlign: 'center', border: `2px dashed #121212`, background: 'var(--bg-hover)', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.975rem' }}>
              📁 <b>구독정보.csv</b> {t('파일 업로드', 'upload the file')} (클릭하여 선택)
            </div>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
              placeholder="또는 내용을 직접 붙여넣으세요"
              style={{ width: '100%', minHeight: 50, padding: 8, fontSize: '0.845rem', border: BORDER, outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={handleCsvImport} style={{ padding: '7px 16px', fontSize: '1.04rem', fontWeight: 700, border: BORDER, background: '#121212', color: '#fff', cursor: 'pointer' }}>{t('📥 채널 등록', '📥 Register')}</button>
              {importResult && <span style={{ alignSelf: 'center', fontSize: '0.975rem', fontWeight: 600, color: importResult.includes('실패') ? '#dc2626' : '#16a34a' }}>{importResult}</span>}
            </div>
          </Section>
          )}
        </div>
    </div>
    </div>
  );
}