import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import { useLang } from '../lib/i18n';

const PROVIDERS = [
  { key: 'gemini', label: 'Google Gemini', icon: '/icons/gemini.ico', keyLink: 'https://aistudio.google.com/apikey' },
  { key: 'openai', label: 'OpenAI', icon: '/icons/openai.ico', keyLink: 'https://platform.openai.com/api-keys' },
  { key: 'openai_flex', label: 'OpenAI Flex', icon: '/icons/openai.ico', keyLink: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic', label: 'Anthropic Claude', icon: '/icons/anthropic.ico', keyLink: 'https://console.anthropic.com' },
  { key: 'openrouter', label: 'OpenRouter', icon: '/icons/openrouter.ico', keyLink: 'https://openrouter.ai/keys' },
  { key: 'openrouter_flex', label: 'OpenRouter Flex', icon: '/icons/openrouter.ico', keyLink: 'https://openrouter.ai/keys' },
  { key: 'deepseek', label: 'DeepSeek', icon: '/icons/deepseek.svg', keyLink: 'https://platform.deepseek.com/api_keys' },
  { key: 'lmstudio', label: '로컬 LLM (Ollama / LM Studio)', icon: '/icons/local_llm.svg', keyLink: null },
  { key: 'glm', label: 'GLM (Zhipu)', icon: '/icons/glm.svg', keyLink: 'https://open.bigmodel.cn' },
  { key: 'glm_flex', label: 'GLM Flex', icon: '/icons/glm.svg', keyLink: 'https://open.bigmodel.cn' },
  { key: 'grok', label: 'Grok (xAI)', icon: '/icons/grok.svg', keyLink: 'https://console.x.ai' },
];

// AI 설정 캐러셀 그룹 — OpenAI 호환 계열은 프리셋 통합
const COMPAT_KEYS = ['openai', 'openai_flex', 'openrouter', 'openrouter_flex', 'glm', 'glm_flex', 'grok', 'deepseek'];
const AI_GROUPS = [
  { key: 'compat', label: 'OpenAI 호환', desc: 'OpenAI · GLM · Grok · OpenRouter · DeepSeek', icon: '/icons/openai.svg', local: false },
  { key: 'gemini', label: 'Google Gemini', desc: 'Gemini API', icon: '/icons/gemini.svg', local: false },
  { key: 'anthropic', label: 'Anthropic Claude', desc: 'Claude API', icon: '/icons/anthropic.ico', local: false },
  { key: 'lmstudio', label: '로컬 LLM', desc: 'LM Studio · Ollama', icon: '/icons/local_llm.svg', local: true },
];

const MODEL_PLACEHOLDERS = {
  gemini: '예: gemini-2.5-flash',
  openai: '예: gpt-4o',
  openai_flex: '예: gpt-5.6-luna',
  anthropic: '예: claude-sonnet-4-20250514',
  deepseek: '예: deepseek-chat',
  openrouter: '예: google/gemini-2.5-flash',
  openrouter_flex: '예: openai/gpt-5.6-luna',
  lmstudio: '예: llama3, mistral',
  glm: '예: glm-4.6',
  glm_flex: '예: glm-4.6',
  grok: '예: grok-3',
};

const BORDER = '2px solid var(--border-color)';
const s = { h2: '1.35rem', body: '0.8rem', small: '0.7rem' };

const Input = ({ value, onChange, placeholder, type = 'text', onBlur, style }: { value: any, onChange: any, placeholder?: any, type?: string, onBlur?: any, style?: any }) => (
    <input type={type} defaultValue={value || ''} onInput={e => onChange(e.currentTarget.value)} placeholder={placeholder}
      onBlur={onBlur}
      onClick={e => e.stopPropagation()}
      spellCheck={false} autoComplete="off"
      style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: 'none', borderBottom: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box', ...style }} />
  );

export default function Settings() {
  const { lang, t, setLang } = useLang();
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [aiIdx, setAiIdx] = useState(0);          // AI 설정 캐러셀 인덱스
  const [channels, setChannels] = useState<any[]>([]);   // 자동 요약 대상 채널 선택용
  useEffect(() => {
    api.get('/api/channels').then(r => setChannels((r.data as any)?.channels || [])).catch(() => {});
  }, []);
  const [models, setModels] = useState<Record<string, any[]>>({});      // { providerKey: [{id: '...'}, ...] }
  const [syncState, setSyncState] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [deployState, setDeployState] = useState('');
  const [deployLogs, setDeployLogs] = useState([]);
  const [supaToken, setSupaToken] = useState('');
  const supaLinked = !!(settings.cloudflare_token);
  // 웹 뷰어 URL — 저장된 값 또는 worker_url에서 파생 (Cloudflare Worker 정적 사이트 — CSP 없음)
  const viewerUrl = settings.worker_url || '';

  const handleManualSync = async () => {
    if (!settings.worker_url) { alert(t('웹 동기화 연동이 필요합니다 (위에서 연결)', 'Web sync link required (connect above)')); return; }
    setSyncState('running');
    setSyncMsg('');
    window.dispatchEvent(new Event('sync-start'));
    try {
      const r = await api.post('/api/sync/now');
      setSyncState('ok');
      setSyncMsg(t(`완료! 웹에서 ${r.data?.pulled || 0}건 가져오고 ${r.data?.pushed || 0}건 업로드했습니다`, `Done! Pulled ${r.data?.pulled || 0} and pushed ${r.data?.pushed || 0} records`));
    } catch (err) {
      setSyncState('err');
      setSyncMsg(t('동기화 실패: ', 'Sync failed: ') + (err.message || String(err)));
    } finally {
      setTimeout(() => window.dispatchEvent(new Event('sync-end')), 600);
    }
  };

  const handleWebDeploy = async () => {
    setDeployState('running');
    setDeployLogs([]);
    try {
      const r = await api.post('/api/cloudflare/deploy');
      const d = r.data || {};
      if (d.needToken) {
        // PAT 필요 — 토큰 입력 폼 표시
        setDeployState('needToken');
        setDeployLogs([t('Cloudflare 인증이 필요합니다. 아래 버튼으로 토큰을 발급받아 입력하세요.', 'Cloudflare auth required. Create a token below and paste it.')]);
        return;
      }
      setDeployState('ok');
      setDeployLogs([
        t('✅ 프로젝트 생성 완료', '✅ Project created') + ': ' + (d.projectRef || ''),
        t('✅ 스키마 적용 완료', '✅ Schema applied'),
        t('✅ anon key 자동 저장 (설정에 반영됨)', '✅ anon key saved to settings'),
        t('URL', 'URL') + ': ' + (d.url || ''),
      ]);
      // 설정 리로드 (anon key가 자동 저장됐으므로)
      const s = await api.get('/api/settings');
      setSettings(s.data || {});
    } catch (err) {
      setDeployState('err');
      const msg = (err.message || String(err)).replace(/^Error: /, '');
      setDeployLogs([t('❌ 배포 실패', '❌ Deploy failed') + ': ' + msg.slice(0, 300)]);
    }
  };

  const saveCloudflareToken = async () => {
    if (!supaToken.trim()) { alert(t('토큰을 입력하세요', 'Enter the token')); return; }
    try {
      await api.put('/api/settings', { cloudflare_token: supaToken.trim() });
      setDeployState('');
      setDeployLogs([]);
      // 설정 리로드 → 연동 상태 카드 갱신
      const s = await api.get('/api/settings');
      setSettings(s.data || {});
      // 토큰 저장 후 재배포
      await handleWebDeploy();
    } catch (e) {
      alert(t('저장 실패: ', 'Save failed: ') + e.message);
    }
  };

  const clearCloudflareToken = async () => {
    try {
      // sync_last_at 초기화 → 재연결 시 전체 pull (웹 옛 데이터 복원)
      await api.put('/api/settings', { cloudflare_token: '', worker_url: '', sync_url: '', sync_last_at: '' });
      setDeployState('');
      setDeployLogs([]);
      setSupaToken('');
      const s = await api.get('/api/settings');
      setSettings(s.data || {});
    } catch (e) {
      alert(t('해제 실패: ', 'Unlink failed: ') + e.message);
    }
  };
  const [dirty, setDirty] = useState(false);
  const navigate = useNavigate();
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  window.__summDirty = dirty;


  // 변경사항 미저장 상태에서 탭 벗어나기 방지
  useEffect(() => {
    const handler = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const [loadingModels, setLoadingModels] = useState({}); // { providerKey: true/false }

  useEffect(() => {
    api.get('/api/settings').then(r => { setSettings(r.data || {}); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  // 저장된 API 키가 있으면 모델 자동 로드
  useEffect(() => {
    if (loading) return;
    PROVIDERS.forEach(p => {
      const key = settings[`${p.key}_key`];
      if (key && !models[p.key]) loadModels(p.key);
    });
  }, [loading]);

  const loadModels = async (provider: string, keyOverride?: string) => {
    setLoadingModels(prev => ({ ...prev, [provider]: true }));
    try {
      // keyOverride = key typed just now (stale state would otherwise
      // hide it); fall back to saved key.
      const key = keyOverride !== undefined ? keyOverride : (settings[`${provider}_key`] || '');
      const { data } = await api.get(`/api/models/${provider}`, { params: { key } });
      setModels(prev => ({ ...prev, [provider]: data.models || [] }));
    } catch (e) {
      setModels(prev => ({ ...prev, [provider]: [] }));
    } finally {
      setLoadingModels(prev => ({ ...prev, [provider]: false }));
    }
  };

  const save = async (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    setDirty(true);
  };

  // 화면/동작 설정 — 변경 즉시 자동 저장 (별도 저장 버튼 불필요)
  const prefsTimer = useRef(null);
  const savePref = async (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    try { await api.put('/api/settings', updated); } catch {}
    // 홈 탭에 즉시 반영 (Results.jsx가 이 이벤트로 prefs 재로드)
    // — textarea 타이핑 대비 500ms 디바운스
    if (prefsTimer.current) clearTimeout(prefsTimer.current);
    prefsTimer.current = setTimeout(() => {
      window.dispatchEvent(new Event('summ-prefs-changed'));
    }, 500);
  };

  const handleSaveAll = async () => {
    try { await api.put('/api/settings', settings); setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 1500); }
    catch (e) { alert(t('저장 실패: ', 'Save failed: ') + e.message); }
    // 자동 요약 설정 저장 시 서버(미니 PC)에 즉시 push — Windows 수정 → 서버 반영
    if (settings.auto_summary_enabled || settings.auto_summary_interval) {
      api.post('/api/sync/now', { pushSettings: true }).catch(() => {});
    }
  };

  // ── 설정 내보내기 / 불러오기 (다른 PC 이전) ──
  const [includeSensitive, setIncludeSensitive] = useState(true);
  const [backupErr, setBackupErr] = useState('');
  const handleExport = async () => {
    setBackupErr('');
    try {
      const r = await api.get('/api/settings/export', { params: { include_sensitive: includeSensitive ? '1' : '0' } });
      const json = JSON.stringify(r.data, null, 2);
      // 저장 대화상자 — 경로 직접 선택 (Rust 커맨드)
      const path = await invoke('pick_save_path', { defaultName: `SUMMARIZER_config_${new Date().toISOString().slice(0,10)}.json` });
      if (!path) return;  // 취소
      await invoke('save_text_file', { path, content: json });
      setSyncMsg(t(`내보내기 완료: ${path}`, `Exported to ${path}`));
      alert(t(`설정을 내보냈습니다:\n${path}`, `Settings exported:\n${path}`));
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e || e);
      console.error('[export]', e);
      setBackupErr(msg);
      alert(t('내보내기 실패: ', 'Export failed: ') + msg);
    }
  };
  const handleImport = async () => {
    setBackupErr('');
    const path = await invoke('pick_open_path');
    if (!path) return;  // 취소
    try {
      const content = await invoke('read_text_file', { path });
      const data = JSON.parse(content as string);
      const r = await api.post('/api/settings/import', data);
      alert(t(`불러오기 완료! 설정 ${r.data?.settings || 0}개 + 채널 ${r.data?.channels || 0}개 복원됨`, `Import done! ${r.data?.settings || 0} settings + ${r.data?.channels || 0} channels restored`));
      // 설정 다시 로드
      const s = await api.get('/api/settings');
      setSettings(s.data || {});
      // 웹 동기화 설정(worker_url)이 복원됐으면 즉시 동기화 (B 컴퓨터: 웹 DB 다운로드)
      if (s.data?.worker_url) {
        try {
          window.dispatchEvent(new Event('sync-start'));
          const sync = await api.post('/api/sync/now');
          window.dispatchEvent(new Event('sync-end'));
          if (sync.data?.pulled > 0) alert(t(`동기화 완료! 웹에서 ${sync.data.pulled}개 가져옴`, `Sync done! Pulled ${sync.data.pulled} from web`));
        } catch (e) { /* best-effort */ window.dispatchEvent(new Event('sync-end')); }
      }
    } catch (e) {
      alert(t('불러오기 실패: ', 'Import failed: ') + (e.message || String(e)));
    }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{t('⏳ 불러오는 중...', '⏳ Loading...')}</div>;

  return (
    <div style={{ fontFamily: 'Outfit, sans-serif' }}>
      {dirty && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 999, background: '#fffbeb', borderBottom: '2px solid #d97706', padding: '8px 16px', fontSize: 12, fontWeight: 700, color: '#92400e', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>⚠️ {t('저장되지 않은 변경사항이 있습니다. 우측 하단 [모두 저장] 버튼을 눌러 저장하세요.', 'Unsaved changes — click [Save all] at bottom-right to save.')}</span>
          <button onClick={handleSaveAll} style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #d97706', background: '#d97706', color: '#fff', cursor: 'pointer' }}>{t('지금 저장', 'Save now')}</button>
        </div>
      )}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
        .brutal-section { borderBottom: ${BORDER}; background: #fff; margin-bottom: 16px; }
        .brutal-section-header { display: flex; align-items: center; padding: 12px 16px; borderBottom: ${BORDER}; }
        .brutal-section-body { padding: 16px; }
        .provider-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
        @media (max-width: 900px) { .provider-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 600px) { .provider-grid { grid-template-columns: 1fr; } }
      `}</style>

      {/* 상단: 제목 */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '2.08rem', fontWeight: 800, color: '#121212', margin: '14px 0 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {t('환경 설정', 'Settings')}
        </h1>
      </div>

      {/* ═══ 언어 설정 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('언어 설정', 'Language')}</span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.body, color: 'var(--text-secondary)', margin: '0 0 14px 0' }}>
            {t('앱 UI 언어를 선택하세요. 모든 화면의 텍스트가 즉시 변경됩니다.', 'Choose the app UI language. All screen text changes immediately.')}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            {[['ko', '한국어'], ['en', 'English']].map(([code, label]) => (
              <button key={code} onClick={() => setLang(code)}
                style={{
                  padding: '8px 20px', fontSize: s.body, fontWeight: 700, cursor: 'pointer',
                  border: 'none', borderBottom: lang === code ? '3px solid #121212' : '3px solid transparent',
                  background: lang === code ? 'var(--accent-tint)' : 'transparent',
                  color: '#121212', transition: '0.15s',
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ 화면 / 동작 설정 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('화면 / 동작 설정', 'Display / Behavior')}</span>
        </div>
        <div className="brutal-section-body">
          {/* 기본 정렬 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e5e7eb' }}>
            <div>
              <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212' }}>{t('기본 정렬', 'Default sort')}</div>
              <div style={{ fontSize: s.small, color: 'var(--text-muted)', marginTop: 2 }}>{t('목록의 기본 정렬 순서', 'Default sort order for the list')}</div>
            </div>
            <select value={settings.default_sort || ''} onChange={e => savePref('default_sort', e.target.value)}
              style={{ padding: '7px 10px', fontSize: s.small, fontWeight: 600, border: '2px solid #121212', background: '#fff', fontFamily: 'inherit', cursor: 'pointer' }}>
              <option value="">{t('최신순', 'Newest')}</option>
              <option value="oldest">{t('오래된순', 'Oldest')}</option>
              <option value="title">{t('제목순', 'Title')}</option>
              <option value="channel">{t('채널순', 'Channel')}</option>
            </select>
          </div>
          {/* 삭제 확인 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e5e7eb' }}>
            <div>
              <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212' }}>{t('삭제 확인 없이', 'Delete without confirm')}</div>
              <div style={{ fontSize: s.small, color: 'var(--text-muted)', marginTop: 2 }}>{t('삭제 버튼 클릭 시 확인 창을 건너뜁니다', 'Skip the confirmation dialog when deleting')}</div>
            </div>
            <input type="checkbox" checked={settings.no_confirm_delete === '1' || settings.no_confirm_delete === true}
              onChange={e => savePref('no_confirm_delete', e.target.checked ? '1' : '0')}
              style={{ width: 18, height: 18, accentColor: '#121212', cursor: 'pointer' }} />
          </div>
          {/* 상세 페이지 썸네일 기본 상태 (홈 탭 반영) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e5e7eb' }}>
            <div>
              <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212' }}>{t('상세 페이지 썸네일 기본 상태', 'Detail thumbnail default')}</div>
              <div style={{ fontSize: s.small, color: 'var(--text-muted)', marginTop: 2 }}>{t('상세 페이지를 열 때 썸네일이 기본으로 펼쳐질지 접힐지 정합니다 (상세에서 ▲/▼ 버튼으로 토글 가능)', 'Sets whether the detail thumbnail starts expanded or collapsed (toggle with ▲/▼ in the detail)')}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: s.small, fontWeight: 600, color: '#121212', cursor: 'pointer' }}>
                <input type="radio" name="heroThumbDefault" checked={(settings.hero_thumb_default || 'open') !== 'closed'}
                  onChange={() => savePref('hero_thumb_default', 'open')} style={{ width: 15, height: 15, accentColor: '#121212', cursor: 'pointer' }} />
                {t('펼침', 'Expanded')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: s.small, fontWeight: 600, color: '#121212', cursor: 'pointer' }}>
                <input type="radio" name="heroThumbDefault" checked={(settings.hero_thumb_default || 'open') === 'closed'}
                  onChange={() => savePref('hero_thumb_default', 'closed')} style={{ width: 15, height: 15, accentColor: '#121212', cursor: 'pointer' }} />
                {t('접힘', 'Collapsed')}
              </label>
            </div>
          </div>
          {/* 폰트 크기 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e5e7eb' }}>
            <div>
              <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212' }}>{t('폰트 크기', 'Font size')}</div>
              <div style={{ fontSize: s.small, color: 'var(--text-muted)', marginTop: 2 }}>{t('전체 UI 글자 크기', 'Overall UI text size')}</div>
            </div>
            <select value={settings.font_scale || '1'} onChange={e => savePref('font_scale', e.target.value)}
              style={{ padding: '7px 10px', fontSize: s.small, fontWeight: 600, border: '2px solid #121212', background: '#fff', fontFamily: 'inherit', cursor: 'pointer' }}>
              <option value="0.85">{t('작게', 'Small')}</option>
              <option value="1">{t('기본', 'Default')}</option>
              <option value="1.15">{t('크게', 'Large')}</option>
            </select>
          </div>
          {/* 액센트 색 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
            <div>
              <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212' }}>{t('액센트 색', 'Accent color')}</div>
              <div style={{ fontSize: s.small, color: 'var(--text-muted)', marginTop: 2 }}>{t('선택/활성 강조 색상', 'Highlight color for selection and active states')}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {['#4f46e5', '#0d9488', '#dc2626', '#d97706', '#0284c7'].map(col => (
                <button key={col} onClick={() => savePref('accent_color', col)}
                  style={{ width: 26, height: 26, background: col, border: (settings.accent_color || '#4f46e5') === col ? '3px solid #121212' : '2px solid #d4d4d8', cursor: 'pointer', padding: 0, borderRadius: '50%' }} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ LLM 요약 프롬프트 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('LLM 요약 프롬프트', 'LLM Summary Prompts')}</span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.small, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px 0' }}>
            {t('요약 생성에 사용되는 프롬프트를 직접 편집할 수 있습니다. 빈 칸이면 기본 프롬프트가 사용됩니다.', 'Edit the prompts used for summarization. Empty = default prompt.')}
          </p>
          {/* 모드 선택 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: s.body, fontWeight: 600, color: '#121212', cursor: 'pointer' }}>
              <input type="radio" name="promptMode" checked={(settings.prompt_mode || 'append') !== 'replace'}
                onChange={() => savePref('prompt_mode', 'append')} style={{ width: 15, height: 15, accentColor: '#121212', cursor: 'pointer' }} />
              {t('보강 (기본 규칙 유지 + 추가 지시문)', 'Append (keep defaults + add instructions)')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: s.body, fontWeight: 600, color: '#121212', cursor: 'pointer' }}>
              <input type="radio" name="promptMode" checked={(settings.prompt_mode || 'append') === 'replace'}
                onChange={() => savePref('prompt_mode', 'replace')} style={{ width: 15, height: 15, accentColor: '#121212', cursor: 'pointer' }} />
              {t('대체 (프롬프트 전체 교체)', 'Replace (overwrite the entire prompt)')}
            </label>
          </div>
          {/* 주의 사항 */}
          <div style={{ fontSize: 11, color: '#b45309', lineHeight: 1.7, marginBottom: 14, padding: '10px 12px', border: '1.5px solid #f59e0b', background: '#fffbeb' }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('⚠️ 주의 사항', '⚠️ Cautions')}</div>
            <div>{t('· JSON 키 이름(Summary, Insights, Analysis 등)을 바꾸면 웹 뷰어 표시가 깨집니다.', '· Changing JSON keys (Summary, Insights, Analysis...) breaks the web viewer.')}</div>
            <div>{t('· <b> <h3> <table> 태그 규칙을 지우면 상세 페이지 디자인이 깨집니다.', '· Removing <b> <h3> <table> tag rules breaks the detail page design.')}</div>
            <div>{t('· 카테고리 10개 목록을 바꾸면 카테고리 필터와 불일치할 수 있습니다.', '· Changing the 10-category list may break the category filter.')}</div>
            <div>{t('· 대체 모드는 기본 규칙이 모두 사라지므로 신중히 사용하세요.', '· Replace mode removes all default rules — use with caution.')}</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14, padding: '8px 12px', border: '1px solid #e5e7eb', background: '#fafafa' }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('사용 가능한 변수 (YouTube)', 'Available variables (YouTube)')}</div>
            <code style={{ fontSize: 11 }}>{'{title}'} · {'{lang}'} · {'{lang_rule}'} · {'{lang_rule2}'} · {'{thumb}'} · {'{text}'}</code>
            <div style={{ fontWeight: 800, margin: '8px 0 4px' }}>{t('사용 가능한 변수 (GitHub)', 'Available variables (GitHub)')}</div>
            <code style={{ fontSize: 11 }}>{'{repo}'} · {'{description}'} · {'{lang}'} · {'{lang_rule}'} · {'{lang_rule2}'} · {'{readme}'}</code>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212', marginBottom: 6 }}>{t('YouTube 추가 지시문', 'YouTube additional instructions')}</div>
            <textarea value={settings.prompt_youtube || ''} onChange={e => savePref('prompt_youtube', e.target.value)}
              placeholder={t('(기본 프롬프트 사용)', '(uses default prompt)')}
              style={{ width: '100%', minHeight: 120, padding: 10, fontSize: 12, fontFamily: "'JetBrains Mono', Consolas, monospace", lineHeight: 1.6, border: '2px solid #121212', background: '#fff', color: '#121212', resize: 'vertical', boxSizing: 'border-box' }} />
          </div>
          <div>
            <div style={{ fontSize: s.body, fontWeight: 700, color: '#121212', marginBottom: 6 }}>{t('GitHub 추가 지시문', 'GitHub additional instructions')}</div>
            <textarea value={settings.prompt_github || ''} onChange={e => savePref('prompt_github', e.target.value)}
              placeholder={t('(기본 프롬프트 사용)', '(uses default prompt)')}
              style={{ width: '100%', minHeight: 120, padding: 10, fontSize: 12, fontFamily: "'JetBrains Mono', Consolas, monospace", lineHeight: 1.6, border: '2px solid #121212', background: '#fff', color: '#121212', resize: 'vertical', boxSizing: 'border-box' }} />
          </div>
        </div>
      </div>

      {/* ═══ 설정 백업 / 복원 (다른 PC 이전) ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('설정 백업 / 복원', 'Backup / Restore')}</span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.small, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 12px 0' }}>
            {t('환경 설정(API 키, 모델, 프롬프트, 화면 설정)과 구독 채널 목록을 파일로 내보내거나 불러올 수 있습니다. 새 PC에서 동일하게 구성하려면 내보내기 → 새 PC에서 불러오기 순서로 진행하세요. 데이터(요약/상태)는 웹 동기화로 자동 복원됩니다.', 'Export or import settings (API keys, models, prompts, display) and channel list. To set up a new PC: export here, then import on the new PC. Data (summaries/state) is restored via web sync automatically.')}
          </p>
          {backupErr && (
            <div style={{ marginBottom: 12, padding: '10px 12px', border: '2px solid #dc2626', background: '#fef2f2', fontSize: 12, fontWeight: 700, color: '#dc2626', wordBreak: 'break-all', lineHeight: 1.6 }}>
              {t('에러: ', 'Error: ')}{backupErr}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: s.small, fontWeight: 600, color: '#121212', cursor: 'pointer' }}>
              <input type="checkbox" checked={includeSensitive} onChange={e => setIncludeSensitive(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: '#121212', cursor: 'pointer' }} />
              {t('API 키 / 토큰 포함', 'Include API keys / tokens')}
            </label>
            <button onClick={handleExport}
              style={{ padding: '9px 16px', fontSize: s.body, fontWeight: 700, border: '2px solid #121212', background: '#121212', color: '#fff', cursor: 'pointer' }}>
              {t('⬇ 내보내기 (설정 파일 저장)', '⬇ Export (save config file)')}
            </button>
            <button onClick={handleImport}
              style={{ padding: '9px 16px', fontSize: s.body, fontWeight: 700, border: '2px solid #121212', background: '#fff', color: '#121212', cursor: 'pointer' }}>
              {t('⬆ 불러오기 (설정 파일 읽기)', '⬆ Import (load config file)')}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#b45309', lineHeight: 1.6, marginTop: 10, padding: '8px 12px', border: '1.5px solid #f59e0b', background: '#fffbeb' }}>
            {t('⚠️ 키/토큰 포함 파일은 민감 정보가 평문 저장됩니다. 외부에 공유하지 마세요. 불러오기 후에는 앱을 재시작하는 것이 좋습니다.', '⚠️ Files with keys/tokens store sensitive data in plain text — do not share them. Restart the app after importing.')}
          </div>
        </div>
      </div>

      {/* ═══ ① AI 제공자 선택 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('AI 제공자 선택', 'AI Provider')}</span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.body, color: 'var(--text-secondary)', margin: '0 0 14px 0' }}>{t('영상 요약에 사용할 AI 모델을 선택하세요', 'Choose the AI model for video summaries')}</p>
          {/* AI 제공자 캐러셀 — OpenAI 호환 통합 + 전용/로컬 그룹 */}
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            <button type="button" onClick={() => setAiIdx((aiIdx + AI_GROUPS.length - 1) % AI_GROUPS.length)}
              style={{ flexShrink: 0, width: 34, border: BORDER, background: '#fff', cursor: 'pointer', fontSize: 16, color: '#121212' }}>◀</button>
            <div style={{ flex: 1, minWidth: 0 }}>
              {AI_GROUPS.map((g, gi) => {
                const isCompat = g.key === 'compat';
                const pk = isCompat
                  ? (COMPAT_KEYS.includes(settings.provider || settings.ai_provider)
                    ? (settings.provider || settings.ai_provider)
                    : 'openai')
                  : g.key;
                const active = isCompat
                  ? COMPAT_KEYS.includes(settings.provider || settings.ai_provider)
                  : (settings.provider || settings.ai_provider) === g.key;
                const isLocal = g.local;
                const keyLink = isCompat ? (PROVIDERS.find(x => x.key === pk) || {}).keyLink : (PROVIDERS.find(x => x.key === pk) || {}).keyLink;
                return (
                  <div key={g.key} style={{ display: gi === aiIdx ? 'block' : 'none' }}>
                    <div
                      onClick={() => { if (!isCompat) { save('provider', g.key); save('ai_provider', g.key); } }}
                      style={{
                        border: active ? `3px solid ${isLocal ? '#d97706' : '#4f46e5'}` : '2px solid var(--border-color)',
                        background: active ? (isLocal ? '#fffbeb' : '#eef2ff') : '#fff',
                        padding: 14, transition: 'all 0.1s',
                        boxShadow: active ? '3px 3px 0 rgba(0,0,0,0.15)' : 'none',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <img src={g.icon} alt="" style={{ width: 24, height: 24 }}
                          onError={e => { (e.target as HTMLElement).style.display = 'none'; }} />
                        <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#121212' }}>{g.label}</span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>{g.desc}</span>
                        {active && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: isLocal ? '#d97706' : '#4f46e5', border: `1.5px solid ${isLocal ? '#d97706' : '#4f46e5'}`, padding: '1px 6px', background: '#fff' }}>{t('선택됨', 'Selected')}</span>}
                      </div>

                      {isCompat && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('제공자', 'Provider')}</div>
                          <select value={pk}
                            onChange={e => { const v = e.target.value; save('provider', v); save('ai_provider', v); if (!models[v]) loadModels(v, settings[`${v}_key`] || ''); }}
                            style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box' }}>
                            {COMPAT_KEYS.map(k => {
                              const pr = PROVIDERS.find(x => x.key === k);
                              return <option key={k} value={k}>{pr ? pr.label : k}</option>;
                            })}
                          </select>
                        </div>
                      )}

                      {/* API Key (non-local only) */}
                      {!isLocal && (
                        <div style={{ marginBottom: 8 }}>
                          <Input value={settings[`${pk}_key`] || ''} onChange={v => { save(`${pk}_key`, v); loadModels(pk, v); }}
                            placeholder="API 키 입력" type="password" />
                          {keyLink && (
                            <button type="button" onClick={e => { e.stopPropagation(); invoke('open_url', { url: keyLink }).catch(() => {}); }}
                              style={{ fontSize: s.small, color: '#4f46e5', fontWeight: 600, display: 'inline-block', marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'Outfit, sans-serif' }}>
                              {t('🔑 키 발급받기', '🔑 Get API key')}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Model Select / Input */}
                      <div style={{ marginBottom: 8 }}>
                        {models[pk] && models[pk].length > 0 ? (
                          <select value={settings[`${pk}_model`] || ''} onChange={e => save(`${pk}_model`, e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box' }}>
                            <option value="">{t('-- 모델 선택 --', '-- Select model --')}</option>
                            {models[pk].map(m => (
                              <option key={m.id} value={m.id}>{m.id}</option>
                            ))}
                          </select>
                        ) : loadingModels[pk] ? (
                          <div style={{ padding: '10px 12px', fontSize: s.small, color: 'var(--text-muted)' }}>{t('⟳ 모델 목록 로딩 중...', '⟳ Loading models...')}</div>
                        ) : (
                          <Input value={settings[`${pk}_model`] || ''} onChange={v => save(`${pk}_model`, v)}
                            placeholder={MODEL_PLACEHOLDERS[pk] || t('모델명 입력', 'Enter model')} />
                        )}
                      </div>

                      {/* Local LLM extra settings */}
                      {isLocal && (
                        <>
                          <div style={{ marginBottom: 6 }}>
                            <Input value={settings.lmstudio_url || ''} onChange={v => save('lmstudio_url', v)}
                              placeholder="http://localhost:1234/v1" />
                          </div>
                          <select value={settings.lmstudio_api_type || 'generic'} onChange={e => save('lmstudio_api_type', e.target.value)}
                            style={{ width: '100%', padding: '8px', fontSize: s.small, border: BORDER, background: '#fff', fontFamily: 'Outfit, sans-serif' }}>
                            <option value="generic">{t('LM Studio (OpenAI 호환)', 'LM Studio (OpenAI-compatible)')}</option>
                            <option value="ollama">Ollama (Native API)</option>
                          </select>
                          <div style={{ fontSize: '0.78rem', color: '#78716c', marginTop: 6, lineHeight: 1.5 }}>
                            {t('권장: GPU Offload 최대, Flash Attention ON, Context 40K+, 9B 이상', 'Recommended: max GPU offload, Flash Attention ON, 40K+ context, 9B+ model')}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setAiIdx((aiIdx + 1) % AI_GROUPS.length)}
              style={{ flexShrink: 0, width: 34, border: BORDER, background: '#fff', cursor: 'pointer', fontSize: 16, color: '#121212' }}>▶</button>
          </div>
          {/* 캐러셀 점 표시 */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10 }}>
            {AI_GROUPS.map((g, gi) => (
              <button key={g.key} type="button" onClick={() => setAiIdx(gi)}
                style={{ width: 8, height: 8, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: gi === aiIdx ? '#4f46e5' : '#d4d4d8' }} />
            ))}
          </div>
        </div>
      </div>

      {/* ═══ ② OCR / 비전 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('OCR / 비전', 'OCR / Vision')} <span style={{ fontSize: s.small, fontWeight: 500, color: 'var(--text-muted)' }}>{t('(선택사항)', '(optional)')}</span></span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.small, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>{t('비전 지원 AI 모델을 사용하면 영상 썸네일이나 화면 속 텍스트를 읽어서 더 정확한 요약이 가능합니다. API 키를 입력하지 않으면 이 기능이 비활성화됩니다.', 'Vision-capable models read thumbnails and on-screen text for more accurate summaries. This is disabled without an API key.')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('AI 제공자', 'AI provider')}</div>
              <select value={settings.ocr_provider || 'gemini'} onChange={e => { save('ocr_provider', e.target.value); if (!models[e.target.value]) loadModels(e.target.value, settings[`${e.target.value}_key`] || ''); }}
                style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box' }}>
                {PROVIDERS.map(p => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                {t('선택한 제공자의 API 키를 사용합니다. 비전 지원 모델이 필요합니다.', 'Uses the selected provider API key. A vision-capable model is required.')}
              </div>
            </div>
            <div>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('모델명', 'Model')}</div>
              {models[settings.ocr_provider || 'gemini'] && models[settings.ocr_provider || 'gemini'].length > 0 ? (
                <select value={settings.ocr_model || ''} onChange={e => save('ocr_model', e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box' }}>
                  <option value="">{t('-- 모델 선택 --', '-- Select model --')}</option>
                  {models[settings.ocr_provider || 'gemini'].map(m => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              ) : (
                <Input value={settings.ocr_model || ''} onChange={v => save('ocr_model', v)} placeholder="예: gemini-2.5-flash" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ ③ 알림 설정 ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('알림 설정', 'Notifications')}</span>
        </div>
        <div className="brutal-section-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              ['yt_notify', t('YouTube 요약 완료 알림', 'YouTube summary notification'), t('YouTube 요약이 완료되면 데스크톱 알림을 표시합니다', 'Shows a desktop notification when YouTube summaries finish')],
              ['gh_notify', t('GitHub 요약 완료 알림', 'GitHub summary notification'), t('GitHub 요약이 완료되면 데스크톱 알림을 표시합니다', 'Shows a desktop notification when GitHub summaries finish')],
            ].map(([key, label, desc], i) => {
              const on = settings[key] === '1' || settings[key] === undefined;
              return (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < 1 ? BORDER : 'none', cursor: 'pointer' }}>
                  <input type="checkbox" checked={on}
                    onChange={e => save(key, e.target.checked ? '1' : '0')}
                    style={{ width: 16, height: 16, accentColor: '#121212' }} />
                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#121212' }}>{label}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* ═══ ④ 웹 동기화 (Supabase) ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('웹 동기화 (Cloudflare)', 'Web sync (Cloudflare)')}</span>
        </div>
        <div className="brutal-section-body">
          <p style={{ fontSize: s.small, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
            {t('요약 데이터와 읽음/즐겨찾기/삭제 상태를 웹 DB에 동기화하여 웹 뷰어에서 확인합니다. 기준은 항상 이 PC의 로컬 DB이며, 동기화 시 로컬 변경사항이 웹으로 전송됩니다.', 'Syncs summaries and read/favorite/deleted state to a web DB for the web viewer. Your local DB is always the source of truth — changes are pushed to the web on sync.')}
          </p>
          {/* ── 연동 전에만 표시되는 도움말 ── */}
                    {!supaLinked && (
                      <div style={{ border: '1px solid #d4d4d8', borderBottom: '2px solid #121212', padding: '12px 14px', marginBottom: 10, background: '#fff' }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#121212', marginBottom: 6 }}>
                          {t('웹 뷰어가 필요할 때', 'When do you need the web viewer?')}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                          {t('PC 없이 스마트폰에서 요약 목록을 확인하고 싶을 때 연결하세요. 요약 데이터와 읽음/별표/삭제 상태가 웹 DB에 동기화되어, 외출 중 정리한 내용이 집에 돌아와 앱을 켜면 그대로 반영됩니다.', 'Connect when you want to check your summary list from your phone without the PC. Summary data and read/favorite/deleted state sync to the web DB, so changes made on the go are reflected when you open the app at home.')}
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.7, marginTop: 8, paddingTop: 8, borderTop: '1px solid #e5e7eb' }}>
                          {t('※ 인증 정보(토큰)는 로컬 앱에만 보관되고 웹으로 전송되지 않습니다. 웹 뷰어는 URL을 아는 사람이라면 누구나 열람할 수 있으므로, 개인 데이터라면 공유 시 주의하세요.', '※ Auth tokens are stored locally in the app and never sent to the web. Anyone with the URL can view the web viewer, so be careful when sharing if your data is private.')}
                        </div>
                      </div>
                    )}

                    {/* ── 미연동 시 단계별 세팅 가이드 (다른 사용자용) ── */}
                    {!supaLinked && (
                      <details style={{ border: '1px solid #d4d4d8', borderBottom: '2px solid #121212', marginBottom: 10, background: '#fafafa' }}>
                        <summary style={{ padding: '10px 14px', fontSize: '0.85rem', fontWeight: 800, color: '#121212', cursor: 'pointer', userSelect: 'none' }}>
                          {t('☁ 처음이세요? 단계별 설정 안내 (클릭)', '☁ First time? Step-by-step setup (click)')}
                        </summary>
                        <div style={{ padding: '0 14px 14px 14px', fontSize: 12, color: '#374151', lineHeight: 1.7 }}>
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('0단계 (한 번만): Cloudflare 가입', 'Step 0 (once): Sign up for Cloudflare')}</div>
                            <div>
                              {t('계정이 없으면 ', 'If you don')}<a href="#" onClick={(e) => { e.preventDefault(); invoke('open_url', { url: 'https://dash.cloudflare.com/sign-up' }); }} style={{ color: '#4f46e5', textDecoration: 'underline' }}>{t('여기', 'here')}</a>{t('에서 무료 가입 (이메일/Google/Apple 모두 가능). 무료 플랜으로 충분합니다.', ' to sign up for free (email/Google/Apple). The free plan is enough.')}
                            </div>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('1단계: API 토큰 만들기', 'Step 1: Create an API token')}</div>
                            <ol style={{ margin: 0, paddingLeft: 20 }}>
                              <li>{t('아래 [토큰 발급 페이지 열기] 클릭', 'Click [Open token page] below')}</li>
                              <li>{t('상단 [Create Token] 클릭 (Custom token 아님 — 템플릿 선택)', 'Click [Create Token] at the top — pick one of the templates, not Custom')}</li>
                              <li>{t('Permissions 템플릿 선택: ', 'Permissions template: ')}<b>{t('[Edit Cloudflare Workers] + [Edit Cloudflare R2]', '[Edit Cloudflare Workers] + [Edit Cloudflare R2]')}</b>{t(' 두 개 (둘 다 필요)', ' — both are required')}</li>
                              <li>{t('TTL(만료): 짧을수록 안전 — ', 'TTL (expiry): shorter is safer — ')}<b>{t('24시간 또는 7일', '24 hours or 7 days')}</b>{t(' 권장', ' ')}</li>
                              <li>{t('Continue to summary → Create Token → 토큰 문자열 복사 (한 번만 표시됨)', 'Continue to summary → Create Token → copy the token string (shown only once)')}</li>
                            </ol>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('2단계: 토큰 붙여넣기', 'Step 2: Paste the token')}</div>
                            <div>{t('아래 입력칸에 토큰을 붙여넣고 [연결] 클릭. 자동으로 R2 버킷이 만들어지고 웹 뷰어가 배포됩니다 (1~2분 소요).', 'Paste the token in the field below and click [Connect]. R2 bucket is created and the web viewer is deployed automatically (takes 1-2 minutes).')}</div>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('3단계: 끝 — 동기화', 'Step 3: Done — sync starts')}</div>
                            <div>{t('배포가 끝나면 [지금 동기화] 버튼이 보입니다. 클릭하면 지금까지의 데이터가 웹으로 올라가고, 스마트폰에서도 같은 URL을 열어 확인할 수 있습니다.', 'When deploy finishes, the [Sync now] button appears. Click it to upload all your data to the web, then open the same URL on your phone.')}</div>
                          </div>
                          <div style={{ marginTop: 10, padding: '8px 10px', background: '#fef3c7', border: '1px solid #fde68a', fontSize: 11, lineHeight: 1.6 }}>
                            ⚠️ {t('문제 해결: [연결] 후에도 5분 이상 배포가 안 끝나면 wrangler CLI 설치 문제일 수 있습니다. ', 'Troubleshooting: if deploy doesn\'t finish after 5+ minutes, wrangler CLI install may have failed. ')}
                            <span style={{ fontFamily: 'monospace' }}>{t('관리자 권한 PowerShell에서: npm i -g wrangler', 'In admin PowerShell: npm i -g wrangler')}</span>
                            {t(' 실행 후 앱을 재시작하세요.', ', then restart the app.')}
                          </div>
                        </div>
                      </details>
                    )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* ── 연동 상태 카드 ── */}
            <div style={{ border: '2px solid #121212', padding: 14, background: supaLinked ? '#f0fdf4' : '#fafafa' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 15 }}>{supaLinked ? '✅' : '🔗'}</span>
                <span style={{ fontSize: '0.92rem', fontWeight: 800, color: '#121212' }}>{t('Cloudflare 연동', 'Cloudflare link')}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: supaLinked ? '#16a34a' : '#9ca3af', border: `1.5px solid ${supaLinked ? '#16a34a' : '#d4d4d8'}`, padding: '2px 8px', background: '#fff' }}>
                  {supaLinked ? t('연동됨', 'Linked') : t('미연동', 'Not linked')}
                </span>
              </div>

              {supaLinked ? (
                <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.7 }}>
                  <div>{t('요약/읽음/즐겨찾기/삭제 상태가 Supabase DB와 자동 동기화됩니다. (기준: 로컬 DB)', 'Summaries and read/favorite/deleted state sync with your Supabase DB automatically. (Source: local DB)')}</div>
                  {settings.worker_url && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{t('배포 주소', 'Deploy URL')}: {settings.worker_url}</div>}
                  {viewerUrl && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, background: '#fff', border: '1px solid #d4d4d8', padding: '6px 8px' }}>
                      <span>🌐 {t('웹 뷰어', 'Viewer')}:</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', color: '#4f46e5', fontSize: 10.5 }}>{viewerUrl}</span>
                      <button onClick={() => invoke('open_url', { url: viewerUrl })} style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, border: '2px solid #121212', background: '#fff', cursor: 'pointer', flexShrink: 0 }}>{t('열기', 'Open')}</button>
                      <button onClick={() => { navigator.clipboard?.writeText(viewerUrl); alert(t('URL이 복사되었습니다', 'URL copied')); }} style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, border: '2px solid #121212', background: '#fff', cursor: 'pointer', flexShrink: 0 }}>{t('복사', 'Copy')}</button>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button onClick={handleManualSync} disabled={syncState === 'running'}
                      style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: '#121212', color: '#fff', cursor: syncState === 'running' ? 'wait' : 'pointer' }}>
                      {syncState === 'running' ? t('동기화 중...', 'Syncing...') : t('지금 동기화', 'Sync now')}
                    </button>
                    <button onClick={handleWebDeploy} disabled={deployState === 'running'}
                      style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: '#0d9488', color: '#fff', cursor: deployState === 'running' ? 'wait' : 'pointer' }}>
                      {deployState === 'running' ? t('재배포 중...', 'Deploying...') : t('재배포', 'Re-deploy')}
                    </button>
                    <button onClick={() => { if (confirm(t('Cloudflare 토큰을 삭제하고 연동을 해제할까요?', 'Remove Cloudflare token and unlink?'))) { clearCloudflareToken(); } }}
                      style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer' }}>
                      {t('연동 해제', 'Unlink')}
                    </button>
                  </div>
                  {syncMsg && <div style={{ fontSize: 11, marginTop: 6, color: syncState === 'err' ? '#dc2626' : '#16a34a' }}>{syncMsg}</div>}
                  {deployState !== '' && deployState !== 'running' && deployLogs.length > 0 && (
                    <div style={{ fontSize: 10.5, color: deployState === 'err' ? '#dc2626' : '#16a34a', fontFamily: 'monospace', background: '#fafafa', border: '1px solid #e5e7eb', padding: '7px 9px', marginTop: 6, maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                      {deployLogs.join('\n')}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#374151' }}>
                  <div style={{ marginBottom: 6, lineHeight: 1.6 }}>
                    {t('Cloudflare 토큰 하나로 웹 뷰어 + DB(Blob)를 자동 생성·배포합니다. GitHub 연동 불필요. (컴퓨터를 바꿔도 재배포 시 자동 복구)', 'Create and deploy your web viewer + DB(R2) with one Cloudflare token. No GitHub link needed. (Re-deploy restores it on a new computer.)')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    <button onClick={() => invoke('open_url', { url: 'https://dash.cloudflare.com/profile/api-tokens' })}
                      style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, border: '2px solid #121212', background: '#fff', cursor: 'pointer' }}>
                      🔗 {t('토큰 발급 페이지 열기', 'Open token page')}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, lineHeight: 1.6 }}>
                    {t('① [토큰 발급 페이지 열기] → ② "Generate new token" → 생성 → 복사 → ③ 아래에 붙여넣기 → [연결]', '① Open token page → ② "Generate new token" → create → copy → ③ paste below → [Connect]')}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={supaToken} onChange={e => setSupaToken(e.target.value)} type="password"
                      placeholder="sbp_..." style={{ flex: 1, minWidth: 150, padding: '7px 10px', fontSize: 12, border: '2px solid #121212', outline: 'none', fontFamily: 'monospace' }} />
                    <button onClick={saveCloudflareToken}
                      style={{ padding: '7px 14px', fontSize: 12, fontWeight: 800, border: '2px solid #121212', background: '#121212', color: '#fff', cursor: 'pointer' }}>
                      {t('연결', 'Connect')}
                    </button>
                  </div>
                  {deployState === 'err' && deployLogs.length > 0 && (
                    <div style={{ fontSize: 10.5, color: '#dc2626', fontFamily: 'monospace', background: '#fef2f2', border: '1px solid #fecaca', padding: '7px 9px', marginTop: 8, whiteSpace: 'pre-wrap' }}>
                      {deployLogs.join('\n')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ ⑤ 자동 요약 (미니 PC 서버) ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('자동 요약 (서버)', 'Auto-summary (server)')} <span style={{ fontSize: s.small, fontWeight: 500, color: 'var(--text-muted)' }}>{t('— 미니 PC 상시 서버용 설정', '— for the always-on mini PC server')}</span></span>
        </div>
        <div className="brutal-section-body">
          <div style={{ fontSize: '0.95rem', color: '#333', lineHeight: 2 }}>
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 700 }}>
                <input type="checkbox" checked={settings.auto_summary_enabled === '1'}
                  onChange={e => save('auto_summary_enabled', e.target.checked ? '1' : '0')} />
                {t('자동 요약 활성화', 'Enable auto-summary')}
              </label>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('실행 주기', 'Interval')}</div>
              <select value={settings.auto_summary_interval || '6h'} onChange={e => save('auto_summary_interval', e.target.value)}
                style={{ width: '100%', padding: '10px 12px', fontSize: s.body, border: BORDER, background: '#fff', color: '#121212', outline: 'none', fontFamily: 'Outfit, sans-serif', boxSizing: 'border-box' }}>
                <option value="3h">{t('3시간마다', 'Every 3 hours')}</option>
                <option value="6h">{t('6시간마다', 'Every 6 hours')}</option>
                <option value="12h">{t('12시간마다', 'Every 12 hours')}</option>
                <option value="24h">{t('매일 (24시간)', 'Daily (24h)')}</option>
                <option value="daily">{t('매일 특정 시각', 'Daily at specific time')}</option>
              </select>
              {(settings.auto_summary_interval === 'daily') && (
                <div style={{ marginTop: 6 }}>
                  <Input value={settings.auto_summary_time || '08:00'} onChange={v => save('auto_summary_time', v)}
                    placeholder="08:00" type="time" style={{ width: 'auto' }} />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 8 }}>{t('(서버 컴퓨터의 로컬 시간 기준)', '(server machine local time)')}</span>
                </div>
              )}
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('대상 채널 (미선택 = 전체)', 'Target channels (none = all)')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', maxHeight: 160, overflowY: 'auto', border: BORDER, padding: 8 }}>
                {channels.length === 0 && <span style={{ fontSize: s.small, color: 'var(--text-muted)' }}>{t('채널 없음 — YouTube 연결에서 추가하세요', 'No channels — add them in YouTube Connect')}</span>}
                {channels.map(ch => {
                  const sel = (settings.auto_summary_channels || '').split(',').filter(Boolean);
                  const on = sel.includes(ch.channelId);
                  return (
                    <label key={ch.channelId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer' }}>
                      <input type="checkbox" checked={on}
                        onChange={() => {
                          const next = on ? sel.filter(x => x !== ch.channelId) : [...sel, ch.channelId];
                          save('auto_summary_channels', next.join(','));
                        }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.channelName}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('최대 영상 길이 (분, 0 = 제한 없음)', 'Max video length (min, 0 = unlimited)')}</div>
              <Input value={settings.auto_summary_max_minutes || '0'} onChange={v => save('auto_summary_max_minutes', v)}
                placeholder="180" />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                {t('너무 긴 영상(라이브 녹화본 등)은 자동 요약에서 제외합니다', 'Very long videos (e.g. live recordings) are excluded from auto-summary')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ ⑥ LAN 서버 접속 (미니 PC) ═══ */}
      <div className="brutal-section">
        <div className="brutal-section-header">
          <span style={{ fontSize: s.h2, fontWeight: 800, color: '#121212' }}>{t('LAN 서버 접속 (미니 PC)', 'LAN server access (mini PC)')} <span style={{ fontSize: s.small, fontWeight: 500, color: 'var(--text-muted)' }}>{t('— 웹 뷰어로 서버 설정/수동 요약 조작', '— control server settings & manual summary via web viewer')}</span></span>
        </div>
        <div className="brutal-section-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('서버 주소 (IP)', 'Server address (IP)')}</div>
              <Input value={settings.server_address || ''} onChange={v => save('server_address', v)}
                placeholder="192.168.0.209" />
            </div>
            <div>
              <div style={{ fontSize: s.small, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('포트', 'Port')}</div>
              <Input value={settings.server_port || '8787'} onChange={v => save('server_port', v)}
                placeholder="8787" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => { const addr = (settings.server_address || '').trim(); const port = (settings.server_port || '8787').trim(); if (!addr) { alert(t('서버 주소를 입력하세요', 'Enter server address')); return; } invoke('open_url', { url: `http://${addr}:${port}` }).catch(() => {}); }}
              style={{ padding: '10px 18px', fontSize: '0.85rem', fontWeight: 700, border: BORDER, background: '#121212', color: '#fff', cursor: 'pointer' }}>
              🌐 {t('브라우저로 열기', 'Open in browser')}
            </button>
            <button onClick={async () => {
              const addr = (settings.server_address || '').trim(); const port = (settings.server_port || '8787').trim();
              if (!addr) { alert(t('서버 주소를 입력하세요', 'Enter server address')); return; }
              try {
                const r = await fetch(`http://${addr}:${port}/api/status`, { signal: AbortSignal.timeout(4000) });
                const d = await r.json();
                alert(t(`✅ 서버 연결됨 — 상태: ${d.status || 'idle'}`, `✅ Server connected — status: ${d.status || 'idle'}`));
              } catch { alert(t('❌ 서버에 연결할 수 없습니다 (주소/포트 확인, 서버 실행 여부)', '❌ Cannot connect (check address/port, is server running?)')); }
            }}
              style={{ padding: '10px 16px', fontSize: '0.85rem', fontWeight: 700, border: BORDER, background: '#fff', color: '#121212', cursor: 'pointer' }}>
              {t('상태 확인', 'Check status')}
            </button>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {t('미니 PC에서 서버 실행: cargo run --bin server -- --port 8787', 'On the mini PC: cargo run --bin server -- --port 8787')}
            </div>
          </div>
        </div>
      </div>

      {/* 플로팅 저장 버튼 — 스크롤을 따라 항상 표시 */}
      <button onClick={handleSaveAll}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 999,
          padding: '12px 32px', fontSize: '0.85rem', fontWeight: 700,
          border: BORDER, background: saved ? '#10b981' : '#121212', color: '#fff',
          cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
        {saved ? t('✅ 저장 완료', '✅ Saved') : t('💾 모두 저장', '💾 Save all')}
      </button>

    </div>
  );
}
