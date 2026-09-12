// SUMMARIZER 웹 뷰어 Service Worker — PWA 오프라인 캐시
// 정책:
//  - HTML(/)은 network-first → 배포 후 항상 최신 페이지
//  - 정적 파일(아이콘 등)은 cache-first → 오프라인 지원
//  - API(/api/)는 항상 네트워크 (캐시 금지)
const CACHE = 'summ-viewer-v4';  // v4: icon-192 크기 갱신 캐시 무효화
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 새 버전 즉시 적용 메시지
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API는 항상 네트워크
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // HTML(navigation) — network-first: 새 배포 반영 우선
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
    );
    return;
  }

  // 정적 파일 — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match('/')))
  );
});
