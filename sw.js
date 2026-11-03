/* Помощник страницы «Открыть свой файл». Отдаёт файлы выбранной папки из хранилища браузера,
   поэтому у открытой страницы работают картинки, стили и ссылки на соседние страницы.
   В сеть ничего не уходит: страница кладёт файлы в хранилище, помощник только читает их оттуда */

const CACHE = 'pravki-files'
// Один вид адреса для страницы и помощника, как бы браузер ни закодировал имя файла
const canon = p => { try { p = decodeURIComponent(p) } catch {} return p.split('/').map(encodeURIComponent).join('/') }
const BASE = canon(new URL('f/', self.registration.scope).pathname)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url)
  if (u.origin !== location.origin || !canon(u.pathname).startsWith(BASE)) return
  e.respondWith(serve(u, e.request.headers.get('range')))
})

async function serve(u, range) {
  let path = u.pathname
  if (path.endsWith('/')) path += 'index.html'
  const cache = await caches.open(CACHE)
  const hit = await cache.match(u.origin + canon(path))
  if (!hit) {
    return new Response('Этого файла нет в открытой папке. Откройте папку сайта целиком', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (!range) return hit
  // Видео и звук просят кусками, Safari без этого не играет
  const blob = await hit.blob()
  const m = /bytes=(\d*)-(\d*)/.exec(range)
  let start = m && m[1] ? +m[1] : 0
  let end = m && m[2] ? +m[2] : blob.size - 1
  if (m && !m[1] && m[2]) { start = Math.max(0, blob.size - +m[2]); end = blob.size - 1 }
  end = Math.min(end, blob.size - 1)
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'content-type': hit.headers.get('content-type') || 'application/octet-stream',
      'content-range': `bytes ${start}-${end}/${blob.size}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    },
  })
}
