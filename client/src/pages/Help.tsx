import React, { useState, ReactNode } from 'react';
import { useLang } from '../lib/i18n';

const BORDER = '2px solid var(--border-color)';
const C = 'var(--text-primary)';

interface GroupProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

/* Accordion group — title bar always visible, body toggles */
const Group = ({ title, children, defaultOpen }: GroupProps) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderBottom: BORDER, background: '#fff' }}>
      <div onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: '1rem', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
      </div>
      {open && <div style={{ padding: '4px 18px 16px', fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.8 }}>{children}</div>}
    </div>
  );
};

interface StepProps {
  num: number;
  children: ReactNode;
}

const Step = ({ num, children }: StepProps) => (
  <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
    <span style={{ fontWeight: 800, color: C, flexShrink: 0, width: 28, textAlign: 'center', fontSize: '1rem' }}>{num}.</span>
    <span style={{ fontSize: '0.95rem' }}>{children}</span>
  </div>
);

interface CodeProps {
  children: ReactNode;
}

const Code = ({ children }: CodeProps) => (
  <code style={{ background: '#f1f5f9', padding: '2px 6px', border: '1.5px solid #d4d4d8', color: C, fontSize: '0.8rem' }}>{children}</code>
);

interface BoxProps {
  children: ReactNode;
}

const Box = ({ children }: BoxProps) => (
  <div style={{ padding: '12px 0', borderBottom: '1.5px solid #d4d4d8', fontSize: '0.9rem', marginBottom: 10 }}>{children}</div>
);

export default function Help() {
  const { t } = useLang();
  return (
    <div style={{ padding: '0 0 40px 0', fontFamily: 'Outfit, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');
      `}</style>

      <h1 style={{ fontSize: '2.08rem', fontWeight: 800, color: C, margin: '14px 0 28px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {t('도움말', 'Help')}
      </h1>

      {/* 시작하기 투어 재실행 */}
      <Group title={t('시작하기', 'Get started')}>
        <Box>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('처음 사용하는 분들을 위한 3단계 안내 투어입니다. 언제든 다시 볼 수 있어요.', 'A 3-step onboarding tour for first-time users. You can restart it anytime.')}
          </span><br /><br />
          <button onClick={() => window.dispatchEvent(new Event('summ-tour-open'))}
            style={{ padding: '9px 18px', fontSize: 13, fontWeight: 800, border: '2px solid #121212', background: '#121212', color: '#fff', cursor: 'pointer' }}>
            🚀 {t('시작하기 투어 다시 보기', 'Restart onboarding tour')}
          </button>
        </Box>
      </Group>

      {/* 요약 생성 흐름 */}
      <Group title={t('요약 생성 흐름', 'Summary flow')} defaultOpen>
        <Step num={1}><b>{t('채널 등록', 'Register channels')}</b> ({t('YouTube 연결', 'YouTube Setup')})<br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('Google Takeout CSV 업로드 또는 채널 URL/ID 직접 입력. 등록된 채널은 앱 내 DB(SQLite)에 저장됩니다.', 'Upload Google Takeout CSV or enter channel URL/ID directly. Channels are saved in the local DB (SQLite).')}</span>
        </Step>
        <Step num={2}><b>FETCH</b> ({t('YouTube 탭', 'YouTube tab')})<br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('등록된 채널의 RSS 피드에서 최신 영상 목록을 가져옵니다. 쇼츠 제외·기간 설정 가능.', 'Fetches the latest videos from registered channels via RSS. Supports Shorts filtering and date range.')}</span>
        </Step>
        <Step num={3}><b>PROCESS</b> ({t('YouTube 탭', 'YouTube tab')})<br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('선택한 영상들의 자막을 YouTube API로 수집하고, 설정된 AI 모델로 요약·분석·인사이트·시사점·타임라인을 생성합니다.', 'Collects captions via the YouTube API and generates summary, analysis, insights, implications and timeline with your chosen AI model.')}</span>
        </Step>
        <Step num={4}><b>{t('결과 확인', 'View results')}</b> ({t('홈 탭', 'Home tab')})<br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('카테고리·채널·즐겨찾기별로 필터링. 전체 탭에서 다중 선택 후 일괄 삭제 가능.', 'Filter by category, channel or favorites. Multi-select and batch-delete from the All tab.')}</span>
        </Step>
      </Group>

      {/* 비인증 vs Google 연동 */}
      <Group title={t('비인증 vs Google 연동', 'No-auth vs Google')}>
        <Box>
          <b>{t('비인증 모드 (기본)', 'No-auth mode (default)')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('Google 계정 연동 없이 RSS 피드로 영상 수집, YouTube API로 자막 다운로드, AI로 요약. 단, RSS에 영상 길이 정보가 없으면 쇼츠 필터링이 불완전하고, 요청 제한(429)에 걸릴 수 있습니다.', 'Collects videos via RSS, downloads captions via the YouTube API and summarizes with AI — no Google account needed. Shorts filtering may be incomplete and rate limits (429) possible.')}
          </span>
        </Box>
        <Box>
          <b>{t('Google 계정 연동', 'Google account connected')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('YouTube 연결에서 Client ID 입력 후 Google 로그인. YouTube API 직접 호출로 구독 목록 자동 등록, 재생목록 기반 Fetch, 정확한 쇼츠 필터링, 요청 제한 회피가 가능합니다.', 'Enter Client ID in YouTube Setup and sign in with Google. Direct API calls enable auto-syncing subscriptions, playlist Fetch, accurate Shorts filtering and no rate limits.')}
          </span>
        </Box>
      </Group>

      {/* AI 처리 파이프라인 */}
      <Group title={t('AI 처리 파이프라인', 'AI pipeline')}>
        <Box>
          <b>{t('1. 자막 수집', '1. Get captions')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('YouTube API로 영상의 자동 생성 자막을 가져옵니다. 자막이 없는 영상은 제목 기반으로만 요약됩니다.', 'Fetches auto-generated captions via the YouTube API. Videos without captions get a title-only summary.')}
          </span>
        </Box>
        <Box>
          <b>{t('2. AI 요청 구성', '2. Build AI request')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('자막 + 영상 제목을 AI 프롬프트에 포함하여 요청을 구성합니다. JSON 형식의 응답을 요구합니다.', 'Builds the AI prompt from captions + video title and requests a JSON response.')}
          </span>
        </Box>
        <Box>
          <b>{t('썸네일 OCR', 'Thumbnail OCR')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('환경 설정에서 비전 지원 모델을 설정하면, 영상 썸네일 속 텍스트를 읽어 분석에 반영합니다. 미설정 시 건너뜁니다.', 'If a vision-capable model is configured in Settings, text inside video thumbnails is read and used in the analysis. Skipped when not configured.')}
          </span>
        </Box>
        <Box>
          <b>{t('3. AI 요약', '3. AI summary')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('설정된 AI(DeepSeek/Gemini/OpenAI/Anthropic/OpenRouter/LM Studio)가 분석하여 6개 항목 생성:', 'The configured AI (DeepSeek/Gemini/OpenAI/Anthropic/OpenRouter/LM Studio) generates 6 items:')}<br />
            <b>Summary · Analysis · Insights · Implications · Keywords · Timeline</b>
          </span>
        </Box>
        <Box>
          <b>{t('4. DB 저장', '4. Save to DB')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('처리된 결과를 로컬 SQLite DB(', 'Results are saved to the local SQLite DB (')}<Code>smmy.db</Code>) {t('에 저장합니다. 데이터는 앱 내에서 바로 확인 가능.', 'and can be viewed right inside the app.')}
          </span>
        </Box>
      </Group>

      {/* GitHub 트렌딩 분석 */}
      <Group title={t('GitHub 트렌딩 분석', 'GitHub trending')}>
        <Box>
          <b>FETCH</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('GitHub API로 주간 트렌딩 레포지토리를 불러옵니다. 카드/리스트 뷰 전환으로 별점·언어·설명을 확인한 후 분석할 레포를 선택하세요.', 'Fetches weekly trending repos via the GitHub API. Switch between card/list views to check stars, language and description, then pick repos to analyze.')}
          </span>
        </Box>
        <Box>
          <b>PROCESS</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('선택한 레포의 README를 GitHub API로 가져와 AI가 분석합니다. 결과는 홈 탭의 GitHub 탭에서 확인 가능합니다.', 'Fetches the repo README via the GitHub API and analyzes it with AI. Results appear in the GitHub tab of Home.')}
          </span>
        </Box>
      </Group>

      {/* 문제가 생기면 */}
      <Group title={t('문제가 생기면', 'Troubleshooting')}>
        <Box>
          <b>{t('데이터가 안 보여요', 'No data visible')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('홈 뷰어는 처리 완료 시 자동 갱신되며, 최대 10초마다 최신 데이터를 다시 불러옵니다. 그래도 안 보이면 창 우측 상단의 새로고침 버튼을 눌러보세요. 그것도 안 되면 앱을 재시작해보세요.', 'The Home viewer auto-refreshes when processing finishes and polls for the latest data every 10 seconds. If nothing shows, press the refresh button in the top-right window bar, then restart the app.')}
          </span>
        </Box>
        <Box>
          <b>{t('FETCH가 안 돼요', 'FETCH not working')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('YouTube가 일시적으로 차단(429)한 것. 10~20분 후 재시도. Google 계정 연동 시 API 할당량으로 회피 가능.', 'YouTube temporarily rate-limited you (429). Retry in 10-20 minutes, or connect Google to use API quota.')}
          </span>
        </Box>
        <Box>
          <b>{t('요약이 비어있어요', 'Summary is empty')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('환경 설정에서 API 키와 모델명을 확인하세요. 자막 없는 영상은 제목 기반 요약만 생성됩니다. 로컬 LLM은 7B 이상 권장.', 'Check your API key and model name in Settings. Videos without captions get title-only summaries. 7B+ models recommended for local LLMs.')}
          </span>
        </Box>
        <Box>
          <b>{t('OAuth 연동이 안 돼요', 'OAuth not working')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('Google Cloud Console에서 OAuth Client ID와 Client Secret을 발급받아 YouTube 연결에 입력한 뒤 로그인하세요. PKCE 방식을 사용하므로 별도의 리디렉션 URI 등록은 필요하지 않습니다.', 'Create an OAuth Client ID and Client Secret in Google Cloud Console, enter them in YouTube Setup, then sign in. Since PKCE is used, no redirect URI registration is needed.')}
          </span>
        </Box>
        <Box>
          <b>{t('YouTube API 할당량', 'YouTube API quota')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('• FETCH (search.list): 채널당 ~100 유닛 + videos.list: 1 유닛', '• FETCH (search.list): ~100 units per channel + videos.list: 1 unit')}<br/>
            {t('• 구독 동기화 (subscriptions.list): 1 유닛', '• Sync subscriptions (subscriptions.list): 1 unit')}<br/>
            {t('• 하루 10,000 유닛 기본 제공, 한국 시간 5 PM 기준 초기화', '• 10,000 units per day, resets at 5 PM KST')}<br/>
            {t('• 할당량 소진 시 다음 날 5 PM까지 API 호출이 차단됩니다', '• When quota runs out, API calls are blocked until 5 PM the next day')}
          </span>
        </Box>
      </Group>

      {/* 웹 동기화 / 다른 PC */}
      <Group title={t('웹 동기화 · 다른 PC', 'Web sync · Another PC')}>
        <Box>
          <b>{t('웹 뷰어란?', 'What is the web viewer?')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('환경 설정 → 웹 동기화에서 [원클릭 배포]를 누르면 Cloudflare에 무료 웹 뷰어가 만들어집니다. 스마트폰에서 읽음/별표/삭제 상태를 확인하고 정리할 수 있으며, 앱과 자동으로 동기화됩니다. (요약 데이터와 상태는 웹 DB에 공유되고, 인증 토큰은 로컬에만 보관)', 'Press [One-click deploy] in Settings → Web sync to create a free Cloudflare web viewer. You can check/read/star/delete from your phone, and it syncs automatically with the app. (Summary data & state are shared on the web DB; auth tokens stay local only)')}
          </span>
        </Box>
        <Box>
          <b>{t('앱 시작/종료 시 동기화', 'Sync on start/close')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('앱을 켜면 자동으로 웹과 동기화되고, 끌 때도 설정 저장 + 전체 동기화 후 종료됩니다. 외부에서 정리한 내용이 항상 반영됩니다.', 'The app syncs automatically on startup, and saves settings + full-syncs before closing. Changes made outside are always reflected.')}
          </span>
        </Box>
        <Box>
          <b>{t('다른 PC에서 사용하기', 'Use on another PC')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('환경 설정 → 설정 백업/복원에서 [내보내기]로 설정+채널을 파일로 저장 → 새 PC에서 [불러오기]. 데이터(요약/상태)는 웹 동기화로 자동 복원됩니다.', 'Settings → Backup/Restore → [Export] saves settings + channels to a file → [Import] on the new PC. Data (summaries/state) is restored via web sync automatically.')}
          </span>
        </Box>
        <Box>
          <b>{t('웹 뷰어 주소를 알면 누구나 볼 수 있나요?', 'Can anyone with the URL view it?')}</b><br />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('네, 인증 없이 URL만 알면 열람할 수 있습니다. 개인 데이터라면 주소 공유에 주의하세요.', 'Yes — anyone with the URL can view it without login. Be careful sharing the link if your data is private.')}
          </span>
        </Box>
      </Group>
    </div>
  );
}