/* Coach Assiette — © 2026 Sébastien Bassous (github.com/keyvos). Tous droits réservés. */
/* Coach Assiette : service worker. Rappels (notifications) + installation de l'application.
   Aucune mise en cache : la page vient toujours du réseau (donc toujours à jour) ;
   sans connexion, un petit message s'affiche à la place d'une page d'erreur. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = {
  fr: ['Pas de connexion internet', 'Coach Assiette a besoin d’internet. Vérifie ta connexion (Wi-Fi ou données mobiles), puis réessaie.', 'Réessayer'],
  en: ['No internet connection', 'Coach Assiette needs the internet. Check your connection (Wi-Fi or mobile data), then try again.', 'Try again'],
  pt: ['Sem ligação à internet', 'O Coach Assiette precisa de internet. Verifica a tua ligação (Wi-Fi ou dados móveis) e tenta outra vez.', 'Tentar outra vez'],
  es: ['Sin conexión a internet', 'Coach Assiette necesita internet. Comprueba tu conexión (wifi o datos móviles) y vuelve a intentarlo.', 'Reintentar'],
  ar: ['لا يوجد اتصال بالإنترنت', 'يحتاج Coach Assiette إلى الإنترنت. تحقّق من اتصالك (Wi-Fi أو بيانات الجوال)، ثم أعد المحاولة.', 'إعادة المحاولة'],
};
function offlinePage() {
  // the page picks the app's language (saved by the app on this same site), else the phone's language
  const m = OFFLINE.fr;
  const pick = 'var D=' + JSON.stringify(OFFLINE) + ';var l="fr";try{l=(localStorage.getItem("ca_lang")||navigator.language||"fr").slice(0,2).toLowerCase();}catch(e){}' +
    'if(D[l]){document.documentElement.lang=l;document.documentElement.dir=l==="ar"?"rtl":"ltr";document.getElementById("t").textContent=D[l][0];document.getElementById("d").textContent=D[l][1];document.getElementById("r").textContent=D[l][2];}';
  const html = '<!doctype html><html lang="fr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Coach Assiette</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F3F8F6;color:#24403A;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;box-sizing:border-box;text-align:center}' +
    '@media (prefers-color-scheme:dark){body{background:#0F1715;color:#E3EFEB}}main{max-width:420px}.b{font-weight:800;color:#2C7868;letter-spacing:.02em}@media (prefers-color-scheme:dark){.b{color:#6FC7B2}}h1{font-size:22px;margin:16px 0 8px}' +
    'button{margin-top:18px;font:inherit;font-weight:700;border:0;border-radius:999px;padding:12px 26px;background:#2C7868;color:#fff}</style></head>' +
    '<body><main><div class="b">Coach Assiette</div><h1 id="t">' + m[0] + '</h1><p id="d">' + m[1] + '</p><button id="r" onclick="location.reload()">' + m[2] + '</button></main><script>' + pick + '</script></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.mode !== 'navigate' || r.method !== 'GET') return;
  e.respondWith(fetch(r).catch(() => offlinePage()));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Coach Assiette', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'coach-assiette', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) { if ('navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
