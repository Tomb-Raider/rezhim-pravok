/* Открыть свой файл в режиме правок, прямо со страницы пакета.
   Нужны на странице: #picked (куда писать, что открылось), #dirIn и #fileIn (скрытые поля выбора),
   #drop (затемнение при перетаскивании), кнопки с data-open="dir" или data-open="file".
   Рядом должны лежать sw.js и pravki.js */

/* ---------- Открыть свой файл ----------
   Файлы кладём в хранилище браузера по адресам f/<папка>/…, помощник sw.js отдаёт их оттуда.
   В каждую HTML-страницу дописываем режим правок, как это делает pravki_server.py */

const $ = s => document.querySelector(s)
const picked = $('#picked')
const say = (html) => { picked.innerHTML = html }
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const CAN = 'serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:'
const ready = CAN ? navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready) : null

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf', vtt: 'text/vtt; charset=utf-8',
}
const SKIP = /(^|\/)(node_modules|\.git|__pycache__)(\/|$)|(^|\/)\.DS_Store$/
const isHTML = p => /\.html?$/i.test(p)
const encPath = p => p.split('/').map(encodeURIComponent).join('/')
// Один вид адреса для страницы и помощника sw.js, как бы браузер ни закодировал имя файла
const canon = p => { try { p = decodeURIComponent(p) } catch {} return encPath(p) }
const hash = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }
const order = (a, b) => (a.split('/').length - b.split('/').length) || ((b === 'index.html') - (a === 'index.html')) || a.localeCompare(b)

// Режим правок перед последним </body>, а если его нет, перед </html> или в конец.
// Запрет скриптов в самой странице (meta Content-Security-Policy, его кладут некоторые ИИ) снимаем
// только в копии для правок: иначе браузер не даст режиму запуститься. Файл человека не меняется,
// и «Скачать с правками» берёт его исходник вместе с этим запретом
function inject(html, snippet) {
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
  for (const re of [/<\/body\s*>/gi, /<\/html\s*>/gi]) {
    let last = null, m
    while ((m = re.exec(html))) last = m
    if (last) return html.slice(0, last.index) + snippet + html.slice(last.index)
  }
  return html + snippet
}

// Картинки, стили и скрипты страницы, которых нет среди выбранных файлов. Ссылки на другие страницы не в счёт
function missing(html, page, have) {
  const dir = page.includes('/') ? page.replace(/[^/]*$/, '') : ''
  const out = new Set()
  const re = /(?:<link\b[^>]*?\bhref|\bsrc|\bposter)\s*=\s*["']([^"'#?]+)|url\(\s*["']?([^"')#?]+)/gi
  let m
  while ((m = re.exec(html))) {
    const ref = (m[1] || m[2] || '').trim()
    if (!ref || /^(?:[a-z]+:|\/\/|\/)/i.test(ref) || ref.includes('${') || /(^|\/)pravki\.js$/.test(ref)) continue
    let path
    try { path = decodeURIComponent(new URL(ref, 'http://x/' + encPath(dir)).pathname).slice(1) } catch { continue }
    if (path && !have.has(path) && !have.has(path + 'index.html')) out.add(path)
  }
  return [...out]
}

async function openFiles(root, entries, as) {
  if (!CAN) {
    say('<p class="warn">Так открыть можно только с&nbsp;сайта пакета: <a href="https://tomb-raider.github.io/rezhim-pravok/">tomb-raider.github.io/rezhim-pravok</a></p>')
    return
  }
  entries = entries.filter(e => !SKIP.test(e.path))
  const pages = entries.map(e => e.path).filter(isHTML).sort(order)
  if (!pages.length) { say('<p class="warn">Здесь нет HTML-страниц. Выберите папку сайта или файл .html</p>'); return }
  say(`<p>Открываю «${esc(root)}»…</p>`)
  await ready

  const basePath = new URL('f/' + encodeURIComponent(root) + '/', location.href).pathname
  const cache = await caches.open('pravki-files')
  const prefix = location.origin + canon(basePath)
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req)

  // Настройки сайта из .pravki.json, если он есть в папке
  let site = {}
  const cfgFile = entries.find(e => e.path === '.pravki.json')
  if (cfgFile) try { site = JSON.parse(await cfgFile.file.text()) } catch {}
  const cfg = Object.assign({}, site, {
    root, name: site.name || root, base: decodeURIComponent(basePath), baseURL: basePath, opened: true,
    // Здесь рядом с каждой страницей её исходник без режима: из него «Скачать с правками» собирает файл
    srcCache: 'pravki-files',
    // Ключ хранилища: имя и состав страниц. Его не меняет ни правка, ни ИИ, поэтому внесённое уходит из списка.
    // Если у другой папки с тем же именем правки от прошлого раза не находятся, режим спросит, начать ли заново
    key: root + '#' + hash(pages.join('|')),
    // Когда и что открыли: «Скачать с правками» скажет, из какой версии собран файл
    openedAt: Date.now(), openedAs: as || 'dir',
    pagesList: pages.map(p => ({ path: p, name: ((site.pages || {})[p] || {}).name || '' })),
  })
  // Режим берём свежим при каждом открытии папки, а не из кэша браузера
  const snippet = '\n<script>window.PRAVKI_CONFIG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';<\/script>\n' +
    '<script src="' + new URL('pravki.js', location.href).href + '?v=' + Date.now() + '" data-auto="1"><\/script>\n'

  const have = new Set(entries.map(e => e.path))
  const lost = new Set()
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(entries.slice(i, i + 8).map(async e => {
      const ext = (e.path.match(/\.([^./]+)$/) || [])[1]?.toLowerCase()
      let body = e.file
      if (isHTML(e.path)) {
        const html = await e.file.text()
        missing(html, e.path, have).forEach(p => lost.add(p))
        body = inject(html, snippet)
        await cache.put(location.origin + canon(basePath + encPath(e.path)) + '?pravki-src',
          new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
      }
      await cache.put(location.origin + canon(basePath + encPath(e.path)),
        new Response(body, { headers: { 'content-type': TYPES[ext] || e.file.type || 'application/octet-stream' } }))
    }))
  }

  const href = p => basePath + encPath(p)
  if (pages.length === 1 && !lost.size) { location.href = href(pages[0]); return }
  let html = ''
  if (lost.size) {
    html += `<p class="warn">Страница ссылается на&nbsp;файлы, которых нет среди выбранных: ${[...lost].slice(0, 4).map(esc).join(', ')}` +
      `${lost.size > 4 ? ' и&nbsp;ещё ' + (lost.size - 4) : ''}. Без них не&nbsp;будет картинок или стилей. Выберите папку целиком</p>`
  }
  html += `<p>«${esc(root)}», ${pages.length === 1 ? 'страница' : 'страниц: ' + pages.length}</p><ul class="pages">` +
    pages.slice(0, 60).map(p => `<li><a href="${href(p)}">${esc(p)}</a></li>`).join('') + '</ul>'
  say(html)
}

/* Выбор кнопками: data-open="dir" открывает папку, data-open="file" один файл */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-open]')
  if (!b) return
  e.preventDefault()
  $(b.dataset.open === 'file' ? '#fileIn' : '#dirIn').click()
})
$('#dirIn').addEventListener('change', e => {
  const files = [...e.target.files]
  if (!files.length) return
  const root = files[0].webkitRelativePath.split('/')[0]
  openFiles(root, files.map(f => ({ path: f.webkitRelativePath.split('/').slice(1).join('/'), file: f })), 'dir')
  e.target.value = ''
})
$('#fileIn').addEventListener('change', e => {
  const files = [...e.target.files]
  if (!files.length) return
  openFiles(files[0].name.replace(/\.html?$/i, ''), files.map(f => ({ path: f.name, file: f })), 'file')
  e.target.value = ''
})

/* Перетаскивание папки или файлов на страницу */
const drop = $('#drop')
let depth = 0
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; drop.classList.add('on') } })
addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.classList.remove('on') } })
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault() })
addEventListener('drop', async e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  depth = 0; drop.classList.remove('on')
  const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean)
  const dirs = items.filter(i => i.isDirectory)
  if (dirs.length === 1 && items.length === 1) {
    say('<p>Читаю папку…</p>')
    openFiles(dirs[0].name, await walk(dirs[0], ''), 'dir')
  } else {
    const files = []
    for (const it of items) {
      if (it.isDirectory) files.push(...await walk(it, it.name + '/'))
      else files.push({ path: it.name, file: await new Promise((ok, no) => it.file(ok, no)) })
    }
    const first = files.map(f => f.path).filter(isHTML).sort(order)[0] || 'страница'
    openFiles(first.replace(/\.html?$/i, '').split('/').pop(), files, 'file')
  }
})
async function walk(dir, prefix) {
  const out = []
  const reader = dir.createReader()
  for (;;) {
    const batch = await new Promise((ok, no) => reader.readEntries(ok, no))
    if (!batch.length) break
    for (const it of batch) {
      const path = prefix + it.name
      if (SKIP.test(path)) continue
      if (it.isDirectory) out.push(...await walk(it, path + '/'))
      else out.push({ path, file: await new Promise((ok, no) => it.file(ok, no)) })
    }
  }
  return out
}
