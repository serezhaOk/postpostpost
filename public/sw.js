// Service worker: делает приложение устанавливаемым и принимает видео через «Поделиться» (Android)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const file = form.get('video');
      if (file) {
        const cache = await caches.open('share');
        await cache.put('/shared-video', new Response(file, {
          headers: { 'Content-Type': file.type || 'video/mp4', 'X-Name': encodeURIComponent(file.name || 'video.mp4') },
        }));
      }
      return Response.redirect('/?shared=1', 303);
    })());
  }
});
