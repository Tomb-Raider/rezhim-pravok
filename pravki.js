/* ============================================================
   Режим правок для любого HTML-сайта, слайдов и страниц с роликом.

   Работает прямо на странице, без обёртки-фрейма. Сайт не меняется:
   все правки копятся в браузере и отдаются одним текстом для ИИ,
   а ИИ вносит их в исходники.

   Как подключается (одно из трёх):
   1. pravki_server.py раздаёт папку сайта и сам дописывает этот
      скрипт в каждую страницу. В файлах сайта режима нет, значит,
      на прод он попасть не может.
   2. Закладка в браузере догружает этот скрипт в открытую страницу.
   3. Вручную: <script src="pravki.js" defer></script>, тогда режим
      включается только с ?pravki в адресе.

   Что умеет:
   - перетаскивание мышью → сдвиг фото, блока или текста, края прилипают
     к соседям (розовая линия), Cmd/Ctrl отключает привязку, Shift берёт
     блок уровнем выше, квадратик в углу выбранного меняет размер;
   - двойной щелчок по тексту → правка прямо на странице, было/стало;
   - Alt + щелчок по чему угодно → замечание, Alt + Shift → блок уровнем выше;
   - Alt + пробел → неразрывный пробел, Enter → перенос строки;
   - назад и вперёд по правкам и сдвигам (Cmd/Ctrl + Z, Shift + Cmd/Ctrl + Z);
   - сетка по кнопке: клетка или колонки, размеры ползунками, к ней тоже прилипает;
   - просмотр страницы с правками на ширине телефона;
   - правки копятся в localStorage по каждой странице и отдаются одним
     текстом «ПРАВКИ САЙТА · … · записей: N».

   Настройки (window.PRAVKI_CONFIG, сервер берёт их из .pravki.json):
     name     название сайта для шапки выгрузки
     root     папка сайта на диске (сервер подставляет сам)
     pages    { "путь/страница.html": { name, src, sources } }:
              src: файл, из которого страница собирается скриптом;
              sources: { "селектор": "файл" }, текст этих блоков живёт не в разметке
     sources  то же, что pages[…].sources, но для всех страниц
     skip     селекторы служебных блоков: их не правят и не двигают
     freeze   true → остановить GSAP, ScrollTrigger и Lenis
     reveal   true → сразу показать всё, что спрятано до прокрутки
     css      свои стили на время правки
     grid     { type: "cell", step: 8, cols: 12, gutter: 24, margin, row: 8, frame: ".slide" }:
              сетка: клетка с шагом step или колонки (cols, промежуток, поля,
              по умолчанию отступы кадра, шаг строк row) и селектор кадра.
              Меню «Сетка» меняет вид и размеры, выбор помнит браузер
     base, baseURL, pagesList, key, opened: для «Открыть папку» на сайте
              пакета: начало адреса, которое не входит в имя страницы, и список страниц
   ============================================================ */

(() => {
  'use strict';

  if (window.__pravki) return;
  const me = document.currentScript;
  const auto = !!(me && me.dataset.auto);
  if (!auto && !/[?&#]pravki\b/.test(location.search + location.hash)) return;
  // Во фрейме молчим: панель правок одна, у страницы верхнего уровня.
  // Исключение: просмотр на ширине телефона, там правки только показываем.
  const PREVIEW = window.top !== window && /pravki-preview/.test(location.hash);
  if (window.top !== window && !PREVIEW) return;
  window.__pravki = { loading: true };

  const CFG = Object.assign({ sources: {}, pages: {}, skip: [] }, window.PRAVKI_CONFIG || {});
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const CMD = MAC ? 'Cmd' : 'Ctrl';

  /* ---------- страница и хранилище ---------- */

  const PAGE = (() => {
    let p = decodeURIComponent(location.pathname).replace(/^\/+/, '');
    if (location.protocol === 'file:') p = p.split('/').pop();
    const base = (CFG.base || '').replace(/^\/+/, '');
    if (base && p.startsWith(base)) p = p.slice(base.length);
    if (!p || p.endsWith('/')) p += 'index.html';
    return p;
  })();
  const PG = CFG.pages[PAGE] || {};
  // Папка сайта: её даёт сервер, а у страницы, открытой файлом, она видна из адреса.
  const ROOT = CFG.root || (location.protocol === 'file:'
    ? decodeURIComponent(location.pathname.replace(/[^/]*$/, '')).replace(/\/$/, '').replace(/^\/([A-Za-z]:)/, '$1')
    : '');
  const SITE = CFG.name || (ROOT ? ROOT.split(/[\\/]/).filter(Boolean).pop() : '') || document.title || location.host;
  const KEY = 'pravki:' + (CFG.key || CFG.root || location.host + location.pathname.replace(/[^/]*$/, ''));

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (!s.pages) s.pages = {};
      return s;
    } catch { return { pages: {} }; }
  }
  let store = load();
  const page = () => {
    if (!store.pages[PAGE]) store.pages[PAGE] = { title: document.title, recs: {} };
    return store.pages[PAGE];
  };
  const recs = () => page().recs;

  /* Сохраняем только свою страницу поверх свежей копии: если сайт открыт
     в двух вкладках на разных страницах, они не затирают правки друг друга.
     Просмотр на ширине телефона ничего не пишет. */
  function save() {
    if (PREVIEW) return;
    try {
      const fresh = load();
      fresh.pages[PAGE] = page();
      store = fresh;
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {}
  }
  function saveAll() { if (!PREVIEW) try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {} }

  /* Запись живая, если в ней есть правка текста, сдвиг или непустое замечание. */
  const hasMove = r => !!(r.move && (r.move.dx || r.move.dy || r.move.w != null || r.move.h != null));
  const live = r => r.after !== r.before || hasMove(r) || !!(r.note && r.note.trim());
  const liveRecs = p => Object.values((store.pages[p] || {}).recs || {}).filter(live);
  const total = () => Object.keys(store.pages).reduce((n, p) => n + liveRecs(p).length, 0);
  const clone = o => o ? JSON.parse(JSON.stringify(o)) : null;

  /* ---------- текст ---------- */

  const NBSP = '\u00a0';

  /* Схлопываем только обычные пробелы: неразрывный значащий,
     иначе правка «поставила nbsp» пропала бы бесследно. */
  const norm = s => s
    .replace(/[^\S\u00a0\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');

  /* В выгрузке пишем их так, как они выглядят в разметке. */
  const forOut = s => s.replace(/\u00a0/g, '&nbsp;').replace(/\n/g, '<br>');

  /* Текст блока с переносами: <br> превращаем в \n, иначе в textContent его не видно. */
  function rawText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
    return c.textContent;
  }

  /* ---------- какие блоки считаются текстом ---------- */

  const BLOCK = new Set(['DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'P', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'TABLE',
    'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'MAIN', 'BLOCKQUOTE', 'DL', 'DT', 'DD', 'FORM',
    'PRE', 'DETAILS', 'SUMMARY', 'FIELDSET']);

  const SKIP_BASE = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'video', 'audio', 'object', 'embed', 'select', 'textarea', 'input', 'option',
    '[hidden]', '[contenteditable]:not([data-pv-ce])', 'pravki-ui'];
  // Чужой селектор с ошибкой не должен ронять весь режим: проверяем по одному.
  const SKIP_CFG = (CFG.skip || []).filter(s => {
    try { document.querySelector(s); return true; } catch { return false; }
  });
  const SKIP = SKIP_BASE.concat(SKIP_CFG).join(',');
  const SKIP_MOVE = SKIP_CFG.join(',');

  const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  const textyKids = el => [...el.children].filter(k => norm(k.textContent)).length;

  function isText(el) {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (!norm(el.textContent)) return false;
    for (const kid of el.children) if (BLOCK.has(kid.tagName)) return false;
    // Заголовок правится целиком, даже если разрезан на строки обёртками.
    if (/^H[1-6]$/.test(el.tagName)) return true;
    if (ownText(el)) return true;
    // Ряд из нескольких самостоятельных подписей разбираем на отдельные блоки.
    return textyKids(el) <= 1;
  }

  const STATE = /^(in|on|is-|js-|active|visible|shown|open|rv|aos|sec--)/;
  const firstClass = el => [...el.classList].find(c => !STATE.test(c));

  function sectionKey(el) {
    const sec = el.closest('section,article,header,footer,nav,aside,main');
    if (!sec) return 'page';
    return sec.id || firstClass(sec) || sec.tagName.toLowerCase();
  }

  /* Откуда править блок: свой файл у этого куска или файл-сборщик страницы. */
  function srcHint(el) {
    const maps = [PG.sources || {}, CFG.sources || {}];
    for (const m of maps) {
      for (const [sel, file] of Object.entries(m)) {
        try { if (el.closest(sel)) return file; } catch {}
      }
    }
    return '';
  }

  /* ---------- адреса ---------- */

  /* Точный путь по номерам детей: им блок находится после перезагрузки. */
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      const p = el.parentElement;
      parts.unshift(el.tagName.toLowerCase() +
        (p ? ':nth-child(' + ([...p.children].indexOf(el) + 1) + ')' : ''));
      el = p;
    }
    return 'body > ' + parts.join(' > ');
  }

  /* Короткий путь для выгрузки: от ближайшего предка с id, с классами.
     По нему проще найти блок в исходнике, чем по номерам детей. */
  function shortPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      const cls = firstClass(cur);
      let s = cur.tagName.toLowerCase() + (cls ? '.' + cls : '');
      const p = cur.parentElement;
      if (p) {
        const same = [...p.children].filter(k => k.tagName === cur.tagName && (!cls || k.classList.contains(cls)));
        if (same.length > 1) s += ':nth-child(' + ([...p.children].indexOf(cur) + 1) + ')';
      }
      parts.unshift(s);
      cur = p;
    }
    return parts.join(' > ');
  }

  /* Читаемый адрес нетекстового блока: секция, класс и номер среди таких же. */
  function addrFor(el) {
    if (el.dataset.pvAddr) return el.dataset.pvAddr;
    const cls = firstClass(el);
    const tag = el.tagName.toLowerCase();
    const scope = el.closest('section,article,header,footer,nav,aside,main') || document.body;
    let same = [...scope.getElementsByTagName(tag)];
    if (cls) same = same.filter(n => n.classList.contains(cls));
    let addr = sectionKey(el) + '.' + (cls || tag) + '-' + (same.indexOf(el) + 1);
    while (blocks.has(addr) && blocks.get(addr) !== el) addr += '+';
    return addr;
  }

  /* Чем блок подписан в списке: текстом, а без текста тегом, классом и цветом. */
  function describe(el) {
    // innerText, а не textContent: «87%» и подпись под ним не слипаются в одно слово.
    const t = norm(el.innerText || rawText(el)).replace(/\n/g, ' / ').slice(0, 90);
    if (t) return t;
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList].join('.');
    let extra = '';
    if (tag === 'img') extra = '  ' + (el.getAttribute('alt') || '') + '  ' + (el.getAttribute('src') || '');
    else {
      const painted = el.style && el.style.background ? el
        : [...el.children].find(k => k.style && k.style.background);
      if (painted) extra = '  ' + painted.style.background;
      else {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) extra = '  фон ' + bg;
      }
    }
    const title = el.getAttribute('title');
    return ('<' + tag + (cls ? '.' + cls : '') + '>' + extra + (title ? '  · ' + title.slice(0, 60) : '')).trim();
  }

  /* Короткое имя блока для строки «выровнено»: начало текста или тег с классом. */
  function nameOf(el) {
    const t = norm(el.innerText || '').replace(/\n/g, ' ');
    if (t) return '«' + (t.length > 40 ? t.slice(0, 38) + '…' : t) + '»';
    const cls = firstClass(el);
    return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls ? '.' + cls : '') + '>';
  }

  /* Позиция блока на странице, чтобы правки шли сверху вниз и на других страницах. */
  function posOf(el) {
    let i = 0;
    for (const b of blocks.values()) {
      if (b === el) return i;
      if (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) return i - 0.5;
      i++;
    }
    return i;
  }

  /* ---------- разбор страницы ---------- */

  let blocks = new Map();     // адрес → элемент

  /* Снять разметку режима: нужно перед повторным разбором страницы. */
  function unindex() {
    [...MOVED].forEach(clearMove);
    for (const el of document.querySelectorAll('[data-pv-addr],[data-pv-ce]')) {
      if (el.dataset.pvChanged && el._pvBeforeHTML !== undefined) el.innerHTML = el._pvBeforeHTML;
      if (el.dataset.pvCe) el.removeAttribute('contenteditable');
      for (const k of ['pvAddr', 'pvKind', 'pvChanged', 'pvNote', 'pvCe', 'pvHover']) delete el.dataset[k];
    }
  }

  function index() {
    unindex();
    const seen = Object.create(null);
    blocks = new Map();
    const add = el => {
      const key = sectionKey(el) + '.' + el.tagName.toLowerCase();
      seen[key] = (seen[key] || 0) + 1;
      const addr = key + '-' + seen[key];
      el.dataset.pvAddr = addr;
      el.dataset.pvCe = '1';
      el.setAttribute('contenteditable', 'plaintext-only');
      if (!el.isContentEditable) el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
      el._pvBefore = norm(rawText(el));
      el._pvBeforeHTML = el.innerHTML;
      blocks.set(addr, el);
    };
    // Как только блок признан текстовым, внутрь не идём: иначе заголовок
    // из нескольких обёрток дал бы несколько адресов вместо одного.
    const walk = el => {
      for (const kid of el.children) {
        if (kid.matches(SKIP) || kid.getAttribute('aria-hidden') === 'true') continue;
        if (isText(kid)) add(kid); else walk(kid);
      }
    };
    walk(document.body);
  }

  function markNote(el, addr) {
    el.dataset.pvAddr = addr;
    el.dataset.pvKind = 'note';
    blocks.set(addr, el);
  }
  function unmark(el) {
    blocks.delete(el.dataset.pvAddr);
    for (const k of ['pvAddr', 'pvKind', 'pvNote']) delete el.dataset[k];
  }
  const isTextBlock = el => !!(el && el.dataset && el.dataset.pvCe && !el.dataset.pvKind);
  const recOf = el => el && el.dataset && el.dataset.pvAddr ? recs()[el.dataset.pvAddr] || null : null;

  /* ---------- сдвиг и размер ---------- */

  // Сдвиг и размер ставим инлайн-стилем, а исходный инлайн-стиль помним,
  // чтобы откат и «Сбросить» вернули всё как было.
  const MOVED = new Set();
  const REPLACED = /^(IMG|SVG|VIDEO|CANVAS|PICTURE|IFRAME)$/i;
  const MEDIA = /^(IMG|SVG|VIDEO|CANVAS|PICTURE)$/i;
  const boxW = el => el.offsetWidth != null ? el.offsetWidth : el.clientWidth;
  const boxH = el => el.offsetHeight != null ? el.offsetHeight : el.clientHeight;

  /* Сколько экранных пикселей в одном пикселе элемента. У слайда,
     вписанного в окно через scale, меньше единицы. */
  function scaleOf(el) {
    if (!el) return 1;
    const w = boxW(el), r = el.getBoundingClientRect();
    return w && r.width ? r.width / w : 1;
  }

  function keepStyle(el) {
    if (el._pvStyle) return;
    const s = el.style, cs = getComputedStyle(el);
    el._pvStyle = { translate: s.translate, width: s.width, height: s.height, maxWidth: s.maxWidth,
      maxHeight: s.maxHeight, flex: s.flex, display: s.display };
    // Свой translate у сайта бывает редко, но тогда сдвигаем от него.
    const m = /^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/.exec(cs.translate || '');
    el._pvT0 = m ? [parseFloat(m[1]), parseFloat(m[2] || 0)] : [0, 0];
    // У строчного элемента translate не работает, на время сдвига делаем его строчно-блочным.
    el._pvInline = cs.display === 'inline' && !REPLACED.test(el.tagName);
  }

  function applyMove(el, m) {
    keepStyle(el);
    const s = el.style, o = el._pvStyle;
    const on = !!(m && (m.dx || m.dy || m.w != null || m.h != null));
    s.translate = on && (m.dx || m.dy) ? (el._pvT0[0] + m.dx) + 'px ' + (el._pvT0[1] + m.dy) + 'px' : o.translate;
    s.width = on && m.w != null ? m.w + 'px' : o.width;
    s.maxWidth = on && m.w != null ? 'none' : o.maxWidth;
    s.height = on && m.h != null ? m.h + 'px' : o.height;
    s.maxHeight = on && m.h != null ? 'none' : o.maxHeight;
    const flexKid = el.parentElement && /flex/.test(getComputedStyle(el.parentElement).display);
    s.flex = on && flexKid && (m.w != null || m.h != null) ? '0 0 auto' : o.flex;
    s.display = on && el._pvInline ? 'inline-block' : o.display;
    if (on) { el.dataset.pvMoved = '1'; MOVED.add(el); } else { delete el.dataset.pvMoved; MOVED.delete(el); }
  }
  function clearMove(el) { if (el._pvStyle) applyMove(el, null); }

  /* Где элемент стоит сам по себе, относительно родителя, в его пикселях.
     Меряем до сдвига: по этому числу потом видно, внесли ли сдвиг в файлы. */
  function natPos(el) {
    const p = el.parentElement || document.body;
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect(), k = scaleOf(p) || 1;
    return [Math.round((r.left - pr.left) / k), Math.round((r.top - pr.top) / k)];
  }

  function newMove(el) {
    const [ox, oy] = natPos(el);
    return { dx: 0, dy: 0, w: null, h: null, w0: boxW(el), h0: boxH(el), ox, oy, snap: [] };
  }

  /* После перезагрузки: то, что уже стоит на месте в файлах, из сдвига убираем.
     Возвращает true, если что-то из сдвига оказалось внесённым. */
  function settleMove(el, r) {
    const m = r.move;
    if (!hasMove(r)) { delete r.move; return false; }
    let done = false;
    const [x, y] = natPos(el);
    if (m.dx && m.ox != null && Math.abs(x - (m.ox + m.dx)) < 2) { m.ox = x; m.dx = 0; done = true; }
    if (m.dy && m.oy != null && Math.abs(y - (m.oy + m.dy)) < 2) { m.oy = y; m.dy = 0; done = true; }
    if (m.w != null && Math.abs(m.w - m.w0) >= 2 && Math.abs(boxW(el) - m.w) < 2) { m.w0 = m.w; m.w = null; done = true; }
    if (m.h != null && Math.abs(m.h - m.h0) >= 2 && Math.abs(boxH(el) - m.h) < 2) { m.h0 = m.h; m.h = null; done = true; }
    if (!hasMove(r)) delete r.move; else applyMove(el, m);
    return done;
  }

  /* Записать сдвиг элемента в его запись. m = null убирает сдвиг. */
  function setMove(el, m) {
    const r = ensureRec(el);
    if (m && (m.dx || m.dy || m.w != null || m.h != null)) r.move = m; else delete r.move;
    applyMove(el, r.move || null);
    if (!live(r)) {
      delete recs()[r.addr];
      if (el.dataset.pvKind === 'note') unmark(el);
    } else r.pos = posOf(el);
    save();
    render();
  }

  /* Возвращаем правки после перезагрузки. Правка, которую уже внесли в файлы
     (на странице теперь текст «стало» или блок уже на новом месте), убирается сама. */
  let applied = 0;
  function restore() {
    const rs = recs();
    for (const r of Object.values(rs)) {
      if (r.kind === 'note') {
        let el = null;
        try { el = r.sel && document.querySelector(r.sel); } catch {}
        if (el && (!el.dataset.pvAddr || el.dataset.pvAddr === r.addr)) {
          markNote(el, r.addr);
          if (r.note && r.note.trim()) el.dataset.pvNote = '1';
          delete r.lost;
          if (r.move && settleMove(el, r)) applied++;
          if (!live(r)) { unmark(el); delete rs[r.addr]; } else r.pos = posOf(el);
        } else r.lost = true;
        continue;
      }
      let el = blocks.get(r.addr);
      if (!el || (el._pvBefore !== r.before && el._pvBefore !== r.after)) {
        // Адрес съехал (на странице добавился блок): ищем по исходному тексту, потом по новому.
        const free = b => !rs[b.dataset.pvAddr];
        const all = [...blocks.values()];
        const found = all.find(b => b._pvBefore === r.before && free(b)) ||
          (r.after !== r.before && all.find(b => b._pvBefore === r.after && free(b)));
        if (found) {
          delete rs[r.addr];
          r.addr = found.dataset.pvAddr;
          rs[r.addr] = r;
          el = found;
        } else el = null;
      }
      if (!el) { r.lost = true; continue; }
      delete r.lost;
      if (r.after !== r.before && el._pvBefore === r.after) {
        // Текст уже в файлах: правка и замечание к ней сделаны, сдвиг проверяем отдельно.
        r.before = r.after;
        r.note = '';
        applied++;
      }
      if (r.after !== r.before) {
        el.innerHTML = r.afterHTML;
        el.dataset.pvChanged = '1';
      }
      if (r.note && r.note.trim()) el.dataset.pvNote = '1';
      if (r.move && settleMove(el, r)) applied++;
      if (!live(r)) { delete rs[r.addr]; continue; }
      r.pos = posOf(el);
    }
    page().title = document.title;
    save();
  }

  /* ---------- правки ---------- */

  function touch(el) {
    const addr = el.dataset.pvAddr;
    const now = norm(rawText(el));
    const rs = recs();
    const old = rs[addr];
    const changed = now !== el._pvBefore;
    const r = {
      addr, kind: 'text', before: el._pvBefore, after: now, afterHTML: el.innerHTML,
      note: old ? old.note || '' : '', src: srcHint(el), pos: posOf(el),
    };
    if (old && old.move) r.move = old.move;
    if (live(r)) rs[addr] = r; else delete rs[addr];
    if (changed) el.dataset.pvChanged = '1'; else delete el.dataset.pvChanged;
    save();
    render();
  }

  /* Запись под замечание или сдвиг: у текстового блока своя, у остального блока своя. */
  function ensureRec(el) {
    const isNote = el.dataset.pvKind === 'note' || !el.dataset.pvAddr;
    const addr = el.dataset.pvAddr || addrFor(el);
    if (isNote) markNote(el, addr);
    const rs = recs();
    if (!rs[addr]) {
      const text = isNote ? describe(el) : norm(rawText(el));
      rs[addr] = {
        addr, kind: isNote ? 'note' : 'text',
        before: isNote ? text : el._pvBefore, after: text,
        afterHTML: isNote ? '' : el.innerHTML, note: '', src: srcHint(el),
        sel: isNote ? cssPath(el) : '', where: isNote ? shortPath(el) : '', pos: posOf(el),
      };
    }
    return rs[addr];
  }

  function setNote(addr, text) {
    const r = recs()[addr];
    if (!r) return;
    r.note = text;
    const el = blocks.get(addr);
    if (el) { if (text.trim()) el.dataset.pvNote = '1'; else delete el.dataset.pvNote; }
    save();
    paintCount();
  }

  /* Пустая запись (Alt+щелчок без текста замечания) исчезает, как только
     из неё ушёл фокус. */
  function prune(addr) {
    const r = recs()[addr];
    if (!r || live(r)) return;
    drop(addr);
  }

  function drop(addr) {
    const el = blocks.get(addr);
    const r = recs()[addr];
    if (el) {
      delete el.dataset.pvChanged;
      delete el.dataset.pvNote;
      clearMove(el);
      if (el.dataset.pvKind === 'note') unmark(el);
      else if (r && r.after !== r.before && el._pvBeforeHTML !== undefined) el.innerHTML = el._pvBeforeHTML;
    }
    delete recs()[addr];
    save();
    render();
  }

  function clearAll() {
    for (const addr of Object.keys(recs())) drop(addr);
    store = { pages: {} };
    saveAll();
    hist.back = []; hist.fwd = [];
    paintHist();
    render();
  }

  /* ---------- выгрузка ---------- */

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function pageOrder() {
    const known = pagesList.map(p => p.path);
    return Object.keys(store.pages).sort((a, b) => {
      const ia = known.indexOf(a), ib = known.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      if (/(^|\/)index\.html$/.test(a)) return -1;
      if (/(^|\/)index\.html$/.test(b)) return 1;
      return a.localeCompare(b);
    });
  }

  /* Сдвиг словами: куда, насколько, какой стал размер и к чему прилип. */
  function moveWords(m) {
    const out = [];
    const dir = [];
    if (m.dx) dir.push((m.dx > 0 ? 'вправо на ' : 'влево на ') + Math.abs(m.dx));
    if (m.dy) dir.push((m.dy > 0 ? 'вниз на ' : 'вверх на ') + Math.abs(m.dy));
    if (dir.length) out.push(['сдвиг', dir.join(', ')]);
    if (m.w != null && m.h != null) out.push(['размер', m.w0 + ' × ' + m.h0 + ' → ' + m.w + ' × ' + m.h]);
    else if (m.w != null) out.push(['размер', 'ширина ' + m.w0 + ' → ' + m.w]);
    else if (m.h != null) out.push(['размер', 'высота ' + m.h0 + ' → ' + m.h]);
    // Ширину окна пишем к первой строке: сайт перестраивается под неё.
    if (out.length && m.vw) out[0][1] += ' · окно ' + m.vw + ' px';
    if (m.snap && m.snap.length) out.push(['выровнено', m.snap.join(', ')]);
    return out;
  }

  function build() {
    const out = ['ПРАВКИ САЙТА · ' + SITE + ' · ' + stamp() + ' · записей: ' + total()];
    if (ROOT) out.push('папка: ' + ROOT + (CFG.opened ? ' (открыта на сайте пакета, полный путь знает человек)' : ''));
    else {
      const dir = location.origin + location.pathname.replace(/[^/]*$/, '');
      let readable = dir;
      try { readable = decodeURI(dir); } catch {}
      out.push('адрес: ' + readable);
    }
    out.push('');
    let n = 0;
    for (const p of pageOrder()) {
      const list = liveRecs(p).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      if (!list.length) continue;
      const pc = CFG.pages[p] || {};
      const title = (store.pages[p].title || '').trim();
      out.push('═══ ' + p + (pc.name || title ? '  ·  ' + (pc.name || title) : ''));
      if (pc.src) out.push('    собирается: ' + pc.src);
      out.push('');
      for (const r of list) {
        n++;
        out.push('[' + n + '] ' + r.addr +
          (r.kind === 'note' ? '  · блок целиком, не текст' : '') +
          (r.src && r.src !== pc.src ? '  · ' + r.src : '') +
          (r.lost ? '  · на странице не нашёлся' : ''));
        if (r.after !== r.before) {
          out.push('- ' + forOut(r.before));
          out.push('+ ' + forOut(r.after));
        } else {
          out.push('  ' + forOut(r.before));
        }
        if (r.where) out.push('  где: ' + r.where);
        if (r.move) for (const [k, v] of moveWords(r.move)) out.push('  ' + k + ': ' + v);
        if (r.note && r.note.trim()) out.push('! ' + r.note.trim().replace(/\n+/g, '\n! '));
        out.push('');
      }
    }
    return out.join('\n');
  }

  async function copy() {
    if (!total()) { toast('Пока нечего копировать'); return; }
    const text = build();
    try {
      await navigator.clipboard.writeText(text);
      toast('Скопировано. Вставьте в чат одним сообщением');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      if (ok) { toast('Скопировано. Вставьте в чат одним сообщением'); return; }
      // Встроенный браузер Claude и некоторые настройки Safari буфер не дают:
      // показываем текст выделенным, Cmd+C руками срабатывает всегда.
      ui.mtext.value = text;
      ui.modal.classList.add('on');
      ui.mtext.focus();
      ui.mtext.select();
    }
  }

  function download() {
    if (!total()) { toast('Пока нечего сохранять'); return; }
    const blob = new Blob([build()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'правки-сайта · ' + SITE + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Файл с правками скачан');
  }

  /* ---------- остановить анимации и показать скрытое ---------- */

  function freeze() {
    const w = window;
    for (const l of [w.__lenis, w.lenis]) {
      if (l && l.destroy) { try { l.raf = () => {}; l.destroy(); } catch {} }
    }
    try {
      if (w.ScrollTrigger) w.ScrollTrigger.getAll().forEach(t => {
        try { if (t.animation) t.animation.progress(1); t.kill(false); } catch {}
      });
    } catch {}
    try {
      if (w.gsap) {
        w.gsap.globalTimeline.getChildren(true, true, false).forEach(t => {
          try { if (t.repeat() !== -1) t.progress(1); } catch {}
        });
        w.gsap.globalTimeline.pause();
      }
    } catch {}
  }

  /* Всё, что прозрачно или спрятано до прокрутки, делаем видимым. Трансформ
     не трогаем: им бывает повёрнута подпись, сдвиг на десяток пикселей не мешает. */
  function reveal() {
    let n = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.getAttribute('aria-hidden') === 'true' || el.matches('script,style,template')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      if (cs.opacity === '0' || cs.visibility === 'hidden') {
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        n++;
      }
    }
    return n;
  }

  /* ---------- интерфейс ---------- */

  const PAGE_CSS = `
    [data-pv-addr]{outline:1px dashed transparent;outline-offset:3px;transition:outline-color .12s,background-color .12s}
    [data-pv-addr]:not([data-pv-kind]):hover{outline-color:#7FA98A;background-color:rgba(33,160,56,.08)}
    [data-pv-ce]:not(:focus){cursor:default}
    [data-pv-addr]:focus{outline:2px solid #21A038!important;outline-offset:3px;background-color:rgba(33,160,56,.12)}
    [data-pv-changed]{outline:1px solid #21A038;background-color:rgba(33,160,56,.16)}
    [data-pv-note]{outline:1px solid #E0C400;background-color:rgba(224,196,0,.20)}
    [data-pv-kind="note"]:not([data-pv-moved]){outline:2px solid #E0C400;outline-offset:2px;background-color:rgba(224,196,0,.08)}
    [data-pv-moved]:not([data-pv-note]):not([data-pv-changed]):not(:focus){outline:1px solid rgba(76,141,255,.75);outline-offset:2px}
    [data-pv-hover]{outline:2px solid #E0C400!important;outline-offset:2px;cursor:crosshair!important}
    [data-pv-sel]:not(:focus):not([data-pv-hover]){outline-color:transparent!important}
    [data-pv-flash]{animation:pvflash 1.1s ease-out}
    html[data-pv-dragging],html[data-pv-dragging] *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}
    @keyframes pvflash{0%,100%{box-shadow:0 0 0 0 rgba(33,160,56,0)}18%{box-shadow:0 0 0 10px rgba(33,160,56,.32)}}
  `;

  const UI_CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .w{font:400 14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;color:#12151A;
       -webkit-font-smoothing:antialiased;letter-spacing:normal;text-transform:none}
    button{font:inherit;cursor:pointer}

    .bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:center;
         justify-content:center;flex-wrap:wrap;gap:4px;padding:6px;background:#12151A;color:#fff;border-radius:999px;font-size:13px;
         box-shadow:0 0 0 1px rgba(255,255,255,.08),0 12px 30px -12px rgba(0,0,0,.55);width:max-content;max-width:calc(100vw - 16px)}
    .bar.moved{transform:none}
    .bar .hand{display:flex;align-items:center;gap:8px;height:34px;padding:0 4px 0 8px;cursor:grab;user-select:none;white-space:nowrap}
    .bar.grab,.bar.grab .hand{cursor:grabbing}
    .bar .dot{width:8px;height:8px;border-radius:50%;background:#21A038;flex:none}
    .bar .t{font-weight:600}
    .bar .n{min-width:22px;height:22px;padding:0 7px;border-radius:11px;background:#262B33;display:inline-flex;align-items:center;
            justify-content:center;font-weight:600;font-variant-numeric:tabular-nums}
    .bar .sep{width:1px;height:20px;background:#2C323A;margin:0 4px;flex:none}
    .bar button{height:34px;padding:0 12px;border:0;border-radius:999px;display:inline-flex;align-items:center;gap:6px;
                background:transparent;color:#fff;font-size:13px;font-weight:500;line-height:1;white-space:nowrap}
    .bar button svg{flex:none}
    .bar button:hover{background:#232830}
    .bar button.ic{width:34px;padding:0;justify-content:center}
    .bar button[disabled]{opacity:.35;cursor:default;background:transparent}
    .bar button.on{background:#25303F;color:#8FB6FF}
    .bar button.go{background:#21A038;font-weight:600;padding:0 16px}
    .bar button.go:hover{background:#26B140}
    .bar.min .full{display:none}
    .bar.wrap{border-radius:22px}
    @media (max-width:820px){
      .bar .lb,.bar .t{display:none}
      .bar button.full:not(.ic):not(.go){width:34px;padding:0;justify-content:center}
    }
    .bar.min #fold svg{transform:rotate(180deg)}

    .side{position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);z-index:2147483645;display:none;
          flex-direction:column;background:#FAFBFC;border-left:1px solid #E4E7EA;
          box-shadow:-24px 0 48px -32px rgba(0,0,0,.45)}
    .side.on{display:flex}
    .hd{display:flex;align-items:center;gap:6px;padding:12px 12px 12px 16px;border-bottom:1px solid #E4E7EA}
    .hd b{font-size:15px;font-weight:600;margin-right:auto}
    .hd button,.tools button{font-size:13px;border:0;background:transparent;color:#5E666E;padding:6px 9px;border-radius:7px}
    .hd button:hover,.tools button:hover{background:#EDF0F2;color:#12151A}
    .tools{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:8px 12px;border-bottom:1px solid #E4E7EA}
    .tools select{font:inherit;font-size:13px;max-width:100%;flex:1 1 180px;padding:6px 8px;border:1px solid #E4E7EA;
                  border-radius:8px;background:#fff;color:#12151A}
    .list{flex:1;overflow:auto;padding:10px;overscroll-behavior:contain}
    .empty{padding:26px 14px;color:#7A8189;text-align:center;line-height:1.6}
    .grp{font-size:12px;color:#7A8189;font-weight:600;padding:12px 4px 6px}
    .other{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:1px solid #E4E7EA;
           background:#fff;border-radius:10px;padding:9px 12px;margin-bottom:6px;font-size:13px;color:#12151A}
    .other:hover{border-color:#21A038}
    .item{background:#fff;border:1px solid #E4E7EA;border-radius:12px;padding:12px;margin-bottom:10px}
    .item.sel{border-color:#21A038;box-shadow:0 0 0 2px rgba(33,160,56,.16)}
    .ih{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
    .addr{font:500 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;background:#EDF0F2;color:#454C52;
          padding:5px 8px;border-radius:6px;cursor:pointer;border:0}
    .addr:hover{background:#E4F5E8}
    .tag{font-size:11px;font-weight:500;padding:4px 7px;border-radius:6px}
    .tag.blk{color:#2A4A8A;background:#DCE8FB}
    .tag.src{color:#6B5300;background:#FBE74E}
    .tag.lost{color:#8A1F1F;background:#FDE2E2}
    .ih .sp{flex:1}
    .x{border:0;background:transparent;color:#7A8189;font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
    .x:hover{background:#FDECEC;color:#E5484D}
    .was,.now,.mv{font-size:13px;line-height:1.5;margin:0 0 6px;word-break:break-word;white-space:pre-wrap}
    .was{color:#98A0A8;text-decoration:line-through;text-decoration-color:#D2D8DC}
    .now::before{content:'→ ';color:#21A038;font-weight:600}
    .mv{color:#2A4A8A}
    .item.noteonly .now{display:none}
    .item.noteonly .was{text-decoration:none;color:#6E757B}
    textarea{display:block;width:100%;font:inherit;font-size:13px;line-height:1.45;color:#12151A;background:#fff;
             border:1px solid #E4E7EA;border-radius:8px;padding:8px 10px;resize:vertical;min-height:38px;margin-top:4px}
    textarea:focus{outline:0;border-color:#21A038}
    textarea::placeholder{color:#AEB5BB}
    .help{border-top:1px solid #E4E7EA;padding:12px 16px;font-size:13px;line-height:1.55;color:#454C52;display:none;
          max-height:55vh;overflow:auto}
    .help.on{display:block}
    .help p{margin:0 0 6px}
    kbd{font:500 11px/1 ui-monospace,Menlo,monospace;background:#EDF0F2;padding:3px 6px;border-radius:5px;color:#12151A}

    .lbl{position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:60vw;overflow:hidden;
         text-overflow:ellipsis;white-space:nowrap;font:500 10px/1 ui-monospace,Menlo,monospace;color:#fff;
         background:#12151A;padding:4px 6px;border-radius:4px}
    .lbl.alt{background:#8A6A00}
    .toast{position:fixed;left:50%;bottom:72px;transform:translateX(-50%) translateY(10px);z-index:2147483647;
           background:#12151A;color:#fff;padding:11px 18px;border-radius:999px;font-size:13px;font-weight:500;
           opacity:0;pointer-events:none;max-width:90vw}
    .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}

    .ov{position:fixed;inset:0;pointer-events:none;z-index:2147483644}
    .hov,.box{position:fixed;display:none}
    .hov{outline:1px solid #4C8DFF}
    .box{outline:1.5px solid #4C8DFF}
    .hdl{position:absolute;right:-6px;bottom:-6px;width:11px;height:11px;background:#fff;border:1.5px solid #4C8DFF;
         pointer-events:auto;cursor:nwse-resize}
    .dim{position:fixed;display:none;white-space:nowrap;font:500 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
         font-variant-numeric:tabular-nums;color:#fff;background:#4C8DFF;padding:4px 6px;border-radius:4px}
    .guides i{position:fixed;background:#FF3D8B}
    .cols i{position:fixed;background:rgba(255,61,90,.10)}
    .cell{position:fixed;display:none}
    .gm{position:fixed;z-index:2147483646;display:none;width:244px;padding:12px;background:#12151A;color:#fff;
        border-radius:14px;font-size:13px;box-shadow:0 12px 30px -12px rgba(0,0,0,.55)}
    .gm.on{display:grid;gap:12px}
    .gm [hidden]{display:none}
    .gm .seg{display:flex;gap:4px}
    .gm .seg button{flex:1;border:0;border-radius:8px;padding:8px 10px;background:#1E232A;color:#fff;font-size:13px}
    .gm .seg button.on{background:#25303F;box-shadow:inset 0 0 0 1px #4C8DFF}
    .gm label{display:grid;grid-template-columns:1fr 34px;gap:4px 8px;align-items:center;color:#98A0A8}
    .gm label span{grid-column:1/-1}
    .gm input{width:100%;margin:0;accent-color:#4C8DFF}
    .gm output{text-align:right;color:#fff;font-variant-numeric:tabular-nums}
    .gm .off{display:flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:8px;padding:9px 10px;
             background:transparent;color:#fff;box-shadow:inset 0 0 0 1px #363C44;font-size:13px}
    .gm .off:hover{background:#232830}

    .ph{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;
        background:rgba(18,21,26,.6)}
    .ph.on{display:flex}
    .phw{display:flex;flex-direction:column;align-items:center;gap:10px}
    .phb{display:flex;align-items:center;gap:12px;color:#fff;font-size:13px}
    .phb button{border:0;border-radius:999px;padding:7px 14px;background:#12151A;color:#fff;font-size:13px}
    .ph iframe{width:390px;height:min(844px,calc(100vh - 80px));border:0;border-radius:20px;background:#fff;
               box-shadow:0 30px 60px -30px rgba(0,0,0,.7)}

    .modal{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;
           background:rgba(18,21,26,.45);padding:16px}
    .modal.on{display:flex}
    .mbox{width:min(720px,100%);max-height:86vh;display:flex;flex-direction:column;gap:10px;background:#fff;
          border-radius:14px;padding:16px;box-shadow:0 30px 60px -30px rgba(0,0,0,.6)}
    .mbox p{margin:0;font-size:13px;color:#454C52}
    .mbox textarea{flex:1;min-height:40vh;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
    .mbox .row{display:flex;justify-content:flex-end}
    .mbox .row button{border:0;border-radius:999px;padding:9px 16px;background:#12151A;color:#fff;font-size:13px}
  `;

  let ui = null;
  let selected = null;        // адрес записи, подсвеченной в списке
  let pagesList = [];

  function mountUI() {
    const style = document.createElement('style');
    style.id = 'pravki-style';
    style.textContent = PAGE_CSS + (CFG.css || '');
    document.head.appendChild(style);

    const k = t => '<kbd>' + t + '</kbd>';
    const ARROW = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>';
    // Значки панели
    const ICONS = {
      grid: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11"/>',
      phone: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6"/><path d="M7.2 12h1.6"/>',
      list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="12" r=".6"/>',
      down: '<path d="M3.5 6l4.5 4.5L12.5 6"/>',
    };
    const ICON = n => '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[n] + '</svg>';
    const EYE_OFF = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z"/>' +
      '<circle cx="8" cy="8" r="1.8"/><path d="M2.5 13.5l11-11"/></svg>';
    const host = document.createElement('pravki-ui');
    // Хост вне body: обход текстовых блоков его не видит.
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + UI_CSS + '</style>' +
      '<div class="w">' +
        '<div class="ov"><div class="cols" id="cols"></div><div class="cell" id="cell"></div><div class="hov" id="hov"></div>' +
          '<div class="guides" id="guides"></div>' +
          '<div class="box" id="box"><div class="hdl" id="hdl" title="Тяните, чтобы поменять размер"></div></div>' +
          '<div class="dim" id="dim"></div></div>' +
        '<div class="bar" id="bar">' +
          '<div class="hand" id="hand" title="Тяните, чтобы переставить панель. Двойной щелчок вернёт её вниз по центру">' +
            '<span class="dot"></span><span class="t">Режим правок</span><span class="n" id="cnt" title="Записей в правках">0</span></div>' +
          '<span class="sep full"></span>' +
          '<button class="ic full" id="undo" title="Назад · ' + CMD + ' + Z" aria-label="Назад" disabled>' + ARROW + '</button>' +
          '<button class="ic full" id="redo" title="Вперёд · Shift + ' + CMD + ' + Z" aria-label="Вперёд" disabled>' +
            ARROW.replace('<svg ', '<svg style="transform:scaleX(-1)" ') + '</button>' +
          '<span class="sep full"></span>' +
          '<button class="full" id="gridBtn" title="Клетка или колонки, края встают по ним">' + ICON('grid') + '<span class="lb">Сетка</span></button>' +
          '<button class="full" id="phoneBtn" title="Страница с правками шириной 390 px">' + ICON('phone') + '<span class="lb">Телефон</span></button>' +
          '<button class="full" id="list">' + ICON('list') + '<span class="lb">Список</span></button>' +
          '<button class="go full" id="copy">Скопировать правки</button>' +
          '<button class="ic" id="fold" title="Свернуть панель" aria-label="Свернуть панель">' + ICON('down') + '</button>' +
        '</div>' +
        '<div class="gm" id="gm">' +
          '<div class="seg"><button data-g="cell">Клетка</button><button data-g="cols">Колонки</button></div>' +
          '<label id="gStepL"><span>Шаг клетки, px</span><input type="range" id="gStep" min="4" max="48" step="2"><output></output></label>' +
          '<label id="gColsL"><span>Колонок</span><input type="range" id="gCols" min="2" max="24" step="1"><output></output></label>' +
          '<label id="gGutL"><span>Промежуток, px</span><input type="range" id="gGut" min="0" max="64" step="4"><output></output></label>' +
          '<button class="off" id="gOff">' + EYE_OFF + 'Скрыть сетку</button>' +
        '</div>' +
        '<aside class="side" id="side">' +
          '<div class="hd"><b>Правки</b>' +
            '<button id="file">Скачать файлом</button>' +
            '<button id="reset">Сбросить</button>' +
            '<button id="hide" title="Закрыть">✕</button></div>' +
          '<div class="tools">' +
            '<select id="pages" hidden></select>' +
            '<button id="reveal">Показать скрытое</button>' +
            '<button id="helpBtn">Как это работает</button>' +
          '</div>' +
          '<div class="list" id="items"></div>' +
          '<div class="help" id="help">' +
            '<p><b>Двигать.</b> Тяните мышью фото, блок или текст. Края прилипают к соседям, появляется розовая линия. ' +
              'Всё внутри карточки тянет карточку целиком. Фото внутри карточки выбирает двойной щелчок, текст внутри карточки ' +
              'двойной щелчок открывает для правки, а после ' + k('Esc') + ' он выбран и тянется отдельно. ' +
              'С ' + k(CMD) + ' привязка отключается, с ' + k('Shift') + ' берётся блок уровнем выше. ' +
              'Стрелки двигают выбранное на 1 px, с ' + k('Shift') + ' на 10</p>' +
            '<p><b>Размер.</b> Тяните квадратик в правом нижнем углу выбранного. Фото держит пропорции, у текста меняется ширина</p>' +
            '<p><b>Текст.</b> Двойной щелчок или ' + k('Enter') + ' у выбранного, правьте прямо на странице. ' + k('Esc') + ' заканчивает</p>' +
            '<p><b>Замечание к чему угодно.</b> ' + k('Alt') + ' + щелчок. С ' + k('Shift') + ' берётся блок уровнем выше. Пока ' + k('Alt') + ' зажат, жёлтая рамка показывает, что возьмётся</p>' +
            '<p><b>Назад и вперёд.</b> Стрелки на панели или ' + k(CMD) + ' + ' + k('Z') + ' и ' + k('Shift') + ' + ' + k(CMD) + ' + ' + k('Z') + '</p>' +
            '<p><b>Сетка.</b> Кнопка показывает сетку и открывает меню: клетка или колонки, размеры ползунками. Пока сетка видна, края встают по ней. «Скрыть сетку» убирает её</p>' +
            '<p><b>Телефон.</b> Страница с правками шириной 390 px, как на телефоне</p>' +
            '<p><b>Панель.</b> Тяните за название, чтобы переставить. Двойной щелчок по названию вернёт её вниз по центру. Стрелка справа сворачивает и разворачивает</p>' +
            '<p><b>Неразрывный пробел.</b> ' + (MAC ? k('Alt') + ' + пробел или ' : '') + k('Ctrl') + ' + ' + k('Shift') + ' + пробел. <b>Перенос строки.</b> ' + k('Enter') + '</p>' +
            '<p><b>Отдать ИИ.</b> «Скопировать правки» и вставить в чат одним сообщением</p>' +
            '<p style="color:#7A8189">Правки хранятся в этом браузере по каждой странице, страницу можно закрыть и вернуться. Сам сайт не меняется, режим ничего не отправляет в сеть. Ссылки в режиме правок не открываются, открыть можно с ' + k(CMD) + '</p>' +
          '</div>' +
        '</aside>' +
        '<div class="lbl" id="lbl"></div>' +
        '<div class="toast" id="toast"></div>' +
        '<div class="ph" id="ph"><div class="phw">' +
          '<div class="phb"><span>Ширина телефона, 390 px. Сдвиги такие же, как на широком экране</span><button id="phx">Закрыть</button></div>' +
          '<iframe id="phf" title="Страница на ширине телефона"></iframe></div></div>' +
        '<div class="modal" id="modal"><div class="mbox">' +
          '<p><b>Браузер не дал скопировать сам.</b> Текст ниже уже выделен, нажмите ' + k(CMD) + ' + ' + k('C') + ' и вставьте в чат. ' +
          'Если у ИИ-агента есть доступ к этому браузеру, можно просто написать ему «забери правки»</p>' +
          '<textarea id="mtext" readonly></textarea>' +
          '<div class="row"><button id="mclose">Закрыть</button></div>' +
        '</div></div>' +
      '</div>';

    const $ = id => root.getElementById(id);
    ui = {
      host, root, bar: $('bar'), hand: $('hand'), cnt: $('cnt'), side: $('side'), items: $('items'), pages: $('pages'),
      lbl: $('lbl'), toast: $('toast'), help: $('help'), modal: $('modal'), mtext: $('mtext'),
      box: $('box'), hdl: $('hdl'), hov: $('hov'), dim: $('dim'), guides: $('guides'), cols: $('cols'),
      undo: $('undo'), redo: $('redo'), gridBtn: $('gridBtn'), gm: $('gm'), cell: $('cell'), ph: $('ph'), phf: $('phf'),
    };
    $('mclose').addEventListener('click', () => ui.modal.classList.remove('on'));
    ui.modal.addEventListener('keydown', e => { if (e.key === 'Escape') ui.modal.classList.remove('on'); });

    // Клавиши и прокрутка внутри панели не должны доходить до сайта:
    // у него бывают свои горячие клавиши и плавная прокрутка.
    for (const t of ['keydown', 'keyup', 'keypress', 'wheel', 'touchmove', 'click', 'mousedown', 'pointerdown']) {
      host.addEventListener(t, e => e.stopPropagation(), { passive: true });
    }
    // Нажатая кнопка панели не держит фокус: иначе стрелки и Cmd + Z остаются у неё, а не у страницы.
    root.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('button');
      if (b) b.blur();
    });

    $('copy').addEventListener('click', copy);
    $('file').addEventListener('click', download);
    $('list').addEventListener('click', () => { ui.side.classList.toggle('on'); render(); });
    $('hide').addEventListener('click', () => ui.side.classList.remove('on'));
    $('helpBtn').addEventListener('click', () => ui.help.classList.toggle('on'));
    $('reveal').addEventListener('click', () => toast('Показано скрытых блоков: ' + reveal()));
    $('undo').addEventListener('click', undo);
    $('redo').addEventListener('click', redo);
    // Первое нажатие показывает сетку и меню, следующие открывают и закрывают меню
    $('gridBtn').addEventListener('click', () => {
      if (!gridOn) { gridOn = true; ui.gm.classList.add('on'); }
      else ui.gm.classList.toggle('on');
      paintGridMenu();
      loop();
    });
    ui.gm.addEventListener('click', e => {
      const b = e.target.closest('[data-g]');
      if (b) { gridPref.type = b.dataset.g; saveGrid(); }
    });
    for (const [id, key] of [['gStep', 'step'], ['gCols', 'cols'], ['gGut', 'gutter']]) {
      $(id).addEventListener('input', e => { gridPref[key] = +e.target.value; saveGrid(); });
    }
    $('gOff').addEventListener('click', () => {
      gridOn = false;
      ui.gm.classList.remove('on');
      hideGrid();
      paintGridMenu();
    });
    $('phoneBtn').addEventListener('click', phone);
    $('phx').addEventListener('click', closePhone);
    $('fold').addEventListener('click', () => { barPref.min = !barPref.min; placeBar(); saveBar(); });
    bindBarDrag();
    placeBar();
    typoNodes(root);
    new MutationObserver(() => typoNodes(ui.items)).observe(ui.items, { childList: true, subtree: true });
    $('reset').addEventListener('click', () => {
      const here = liveRecs(PAGE).length, all = total();
      if (!all) return;
      const msg = here && here !== all
        ? 'Убрать ' + here + ' ' + plural(here) + ' этой страницы? На других останутся'
        : (all === 1 ? 'Убрать 1 правку?' : 'Убрать все ' + all + ' ' + plural(all) + '?');
      if (!confirm(msg)) return;
      if (here && here !== all) Object.keys(recs()).forEach(drop);
      else clearAll();
      select(null);
      toast('Список очищен');
    });
    ui.pages.addEventListener('change', () => {
      const p = ui.pages.value;
      if (p && p !== PAGE) location.href = pageURL(p);
    });
    bindResize();
  }

  // Адрес другой страницы сайта. У страниц, открытых файлом, в записи только имя файла из той же папки.
  const pageURL = p => location.protocol === 'file:'
    ? location.href.replace(/[^/]*([?#].*)?$/, '') + encodeURIComponent(p)
    : (CFG.baseURL || '/') + p.split('/').map(encodeURIComponent).join('/');

  const plural = n => (n % 10 === 1 && n % 100 !== 11) ? 'правку'
    : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'правки' : 'правок';
  // Неразрывный пробел после однобуквенных слов в подписях панели
  const typo = t => t.replace(/(^|[\s(«])([аиксоуяв])\s/gi, '$1$2' + NBSP).replace(/(^|[\s(«])([аиксоуяв])\s/gi, '$1$2' + NBSP);
  function typoNodes(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.parentElement && n.parentElement.closest('textarea,kbd,code,.addr')) continue;
      const v = typo(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
    }
  }

  function toast(msg) {
    if (!ui) return;
    ui.toast.textContent = typo(msg);
    ui.toast.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => ui.toast.classList.remove('on'), 2200);
  }

  function paintCount() { if (ui) ui.cnt.textContent = total(); }

  function flash(el) {
    el.dataset.pvFlash = '1';
    setTimeout(() => delete el.dataset.pvFlash, 1200);
  }

  function focusBlock(addr) {
    const el = blocks.get(addr);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    selected = addr;
    render();
  }

  function renderPages() {
    const list = pagesList.length ? pagesList : [{ path: PAGE }];
    const known = new Set(list.map(p => p.path));
    const extra = Object.keys(store.pages).filter(p => !known.has(p) && liveRecs(p).length).map(path => ({ path }));
    const all = list.concat(extra);
    if (all.length < 2) { ui.pages.hidden = true; return; }
    ui.pages.hidden = false;
    ui.pages.innerHTML = '';
    for (const p of all) {
      const o = document.createElement('option');
      const n = liveRecs(p.path).length;
      o.value = p.path;
      o.textContent = (p.path === PAGE ? 'Страница: ' : '') + ((CFG.pages[p.path] || {}).name || p.path) + (n ? '  · ' + n : '');
      if (p.path === PAGE) o.selected = true;
      ui.pages.appendChild(o);
    }
  }

  function render() {
    if (!ui) return;
    paintCount();
    renderPages();
    if (!ui.side.classList.contains('on')) return;
    const here = Object.values(recs()).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    const others = pageOrder().filter(p => p !== PAGE && liveRecs(p).length);
    const box = ui.items;
    box.innerHTML = '';

    if (!here.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = 'На этой странице правок нет<br>Тяните мышью, чтобы двигать. Двойной щелчок правит текст<br><kbd>Alt</kbd> + щелчок по чему угодно оставляет замечание';
      box.appendChild(e);
    }

    for (const r of here) {
      const noteOnly = r.after === r.before;
      const it = document.createElement('div');
      it.className = 'item' + (noteOnly ? ' noteonly' : '') + (selected === r.addr ? ' sel' : '');
      it.innerHTML =
        '<div class="ih"><button class="addr"></button>' +
        (r.kind === 'note' ? '<span class="tag blk">блок</span>' : '') +
        (r.src ? '<span class="tag src"></span>' : '') +
        (r.lost ? '<span class="tag lost">не нашёлся</span>' : '') +
        '<span class="sp"></span><button class="x" title="Убрать">✕</button></div>' +
        '<p class="was"></p><p class="now"></p>' +
        (hasMove(r) ? '<p class="mv"></p>' : '') +
        '<textarea rows="1" placeholder="Что здесь не так"></textarea>';
      it.querySelector('.addr').textContent = r.addr;
      if (r.src) it.querySelector('.tag.src').textContent = r.src;
      it.querySelector('.was').textContent = r.before;
      it.querySelector('.now').textContent = r.after;
      if (hasMove(r)) it.querySelector('.mv').textContent = moveWords(r.move).map(([k, v]) => k + ': ' + v).join('\n');
      const ta = it.querySelector('textarea');
      ta.value = r.note || '';
      ta.dataset.addr = r.addr;
      ta.addEventListener('input', () => setNote(r.addr, ta.value));
      ta.addEventListener('blur', () => setTimeout(() => prune(r.addr), 150));
      it.querySelector('.addr').addEventListener('click', () => focusBlock(r.addr));
      it.querySelector('.x').addEventListener('click', () => {
        const el = blocks.get(r.addr);
        if (el && el === sel) select(null);
        drop(r.addr);
      });
      box.appendChild(it);
    }

    if (others.length) {
      const g = document.createElement('div');
      g.className = 'grp';
      g.textContent = 'На других страницах';
      box.appendChild(g);
      for (const p of others) {
        const b = document.createElement('button');
        b.className = 'other';
        b.innerHTML = '<span></span><b></b>';
        b.firstChild.textContent = (CFG.pages[p] || {}).name || p;
        b.lastChild.textContent = liveRecs(p).length;
        b.addEventListener('click', () => { location.href = pageURL(p); });
        box.appendChild(b);
      }
    }
  }

  /* ---------- подсветка под курсором ---------- */

  let hoverEl = null, lastTarget = null, lastShift = false;

  function pick(t, shift) {
    if (!t || t.nodeType !== 1) t = t && t.parentElement;
    if (!t || t === ui.host || !t.closest) return null;
    let el = t.closest('[data-pv-addr]') || t;
    if (shift && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    if (el === document.body || el === document.documentElement) return null;
    return el;
  }

  function setHover(el) {
    if (hoverEl && hoverEl !== el) delete hoverEl.dataset.pvHover;
    hoverEl = el;
    if (el) el.dataset.pvHover = '1';
  }

  function showLabel(el, alt) {
    if (!el) { ui.lbl.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    ui.lbl.textContent = alt ? 'замечание · ' + (el.dataset.pvAddr || addrFor(el)) : el.dataset.pvAddr;
    ui.lbl.classList.toggle('alt', alt);
    ui.lbl.style.display = 'block';
    ui.lbl.style.left = Math.max(4, Math.min(innerWidth - 120, r.left - 4)) + 'px';
    ui.lbl.style.top = Math.max(4, r.top - 20) + 'px';
  }

  function updateHover(alt) {
    if (alt) {
      const el = pick(lastTarget, lastShift);
      setHover(el);
      showLabel(el, true);
    } else {
      setHover(null);
      const el = lastTarget && lastTarget.closest && lastTarget.closest('[data-pv-addr]');
      showLabel(el && !el.dataset.pvKind && !sel ? el : null, false);
    }
  }

  /* ---------- выбор, перетаскивание, привязка ---------- */

  let sel = null;             // выбранный элемент: рамка с квадратиком размера
  let hov = null;             // что возьмётся, если потянуть
  let drag = null;
  let suppressClick = false;
  let gridOn = false;
  // Вид и размеры сетки из меню. Браузер помнит их для всех страниц
  const GRID_KEY = 'pravki:grid';
  const gridPref = (() => { try { return JSON.parse(localStorage.getItem(GRID_KEY)) || {}; } catch { return {}; } })();
  let guides = [];
  let raf = 0;
  const SNAP = 6;             // экранные пиксели, с которых край прилипает

  const NOMOVE = 'input,select,textarea,option,iframe,audio,video[controls],pravki-ui';

  function okToMove(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    // Подложку во всю ширину окна (секцию, слайд) не таскаем: это фон, а не объект.
    if (MEDIA.test(el.tagName) || isTextBlock(el)) return true;
    const r = el.getBoundingClientRect();
    return !(r.left <= 1 && r.right >= innerWidth - 1);
  }

  /* Самое мелкое, что лежит под курсором: фото целиком, текстовый блок целиком или сам элемент. */
  function baseOf(t) {
    if (t && t.nodeType !== 1) t = t.parentElement;
    if (!t || !t.closest || (ui && t === ui.host)) return null;
    if (t.closest(NOMOVE)) return null;
    if (SKIP_MOVE && t.closest(SKIP_MOVE)) return null;
    let el = t.closest('img,picture,svg,video,canvas');
    if (el && el.ownerSVGElement) while (el.ownerSVGElement) el = el.ownerSVGElement;
    if (el && el.parentElement && el.parentElement.tagName === 'PICTURE') el = el.parentElement;
    if (!el) el = t.closest('[data-pv-addr]') || t;
    return okToMove(el) ? el : null;
  }

  /* Карточка: у блока свой фон, рамка или тень, и он не во весь экран. */
  function boxy(el) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const fill = (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) || cs.backgroundImage !== 'none';
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(s =>
      parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none');
    if (!fill && !border && (!cs.boxShadow || cs.boxShadow === 'none')) return false;
    const r = el.getBoundingClientRect();
    return r.width < innerWidth * 0.6 && r.height < innerHeight * 0.8;
  }

  /* Что потянется, как в Figma: текст или фото внутри карточки тянут всю карточку.
     Внутрь карточки заходит двойной щелчок. Shift берёт уровнем выше. */
  function movable(t, shift) {
    let el = baseOf(t);
    if (!el) return null;
    let p = el.parentElement;
    for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
      if (boxy(p)) { el = p; break; }
    }
    if (shift && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    return okToMove(el) ? el : null;
  }

  // Что потянется из этой точки: выбранное тянется целиком, за что его ни возьми.
  const grabbed = (t, shift) => sel && !shift && sel.contains(t) ? sel : movable(t, shift);

  const editingEl = () => {
    const a = document.activeElement;
    return a && a.dataset && a.dataset.pvCe ? a : null;
  };

  function select(el) {
    if (sel && sel !== el) delete sel.dataset.pvSel;
    sel = el || null;
    if (sel) sel.dataset.pvSel = '1';
    if (!sel) {
      ui.box.style.display = 'none';
      ui.dim.style.display = 'none';
      if (!gridOn) hideGrid();
    } else showLabel(null);
    loop();
  }

  function loop() { if (!raf) raf = requestAnimationFrame(track); }

  // Рамки рисуем каждый кадр, пока есть выбранное: страница может прокручиваться и анимироваться.
  function track() {
    raf = 0;
    if (sel && !sel.isConnected) select(null);
    if (hov && !hov.isConnected) hov = null;
    paintBox(ui.box, sel);
    paintBox(ui.hov, hov && hov !== sel && !drag ? hov : null);
    paintDim();
    paintGrid();
    if (sel || hov || gridOn) raf = requestAnimationFrame(track);
  }

  function paintBox(box, el) {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  function paintDim() {
    if (!sel) { ui.dim.style.display = 'none'; return; }
    const r = sel.getBoundingClientRect();
    const rec = recOf(sel);
    // Пока тянем, запись ещё старая: показываем живое значение.
    const m = drag && drag.on && drag.el === sel && drag.m ? drag.m : rec && rec.move;
    let t = boxW(sel) + ' × ' + boxH(sel);
    if (m && (m.dx || m.dy)) {
      const a = [];
      if (m.dx) a.push((m.dx > 0 ? '→ ' : '← ') + Math.abs(m.dx));
      if (m.dy) a.push((m.dy > 0 ? '↓ ' : '↑ ') + Math.abs(m.dy));
      t = a.join('  ') + '   ' + t;
    }
    ui.dim.textContent = t;
    ui.dim.style.display = 'block';
    const below = r.bottom + 8 + 20 < innerHeight;
    ui.dim.style.left = Math.max(4, Math.min(innerWidth - 200, r.left)) + 'px';
    ui.dim.style.top = (below ? r.bottom + 8 : Math.max(4, r.top - 26)) + 'px';
  }

  /* Сетка строится по кадру: заданному в настройках или ближайшему широкому предку. */
  function gridFor(el) {
    const g = CFG.grid || {};
    let fr = null;
    if (el && g.frame) { try { fr = el.closest(g.frame); } catch {} }
    if (!fr && el) {
      fr = el.parentElement;
      while (fr && fr !== document.body && fr.getBoundingClientRect().width < innerWidth * 0.6) fr = fr.parentElement;
      // Клетка держится за самый внешний кадр того же масштаба, чтобы не прыгала от блока к блоку
      if (fr && fr !== document.body && (gridPref.type || g.type || 'cell') === 'cell') {
        const k0 = scaleOf(fr) || 1;
        for (let up = fr.parentElement; up && up !== document.body && up !== document.documentElement; up = up.parentElement) {
          if (Math.abs((scaleOf(up) || 1) - k0) > 0.001) break;
          fr = up;
        }
      }
    }
    if (!fr || fr === document.documentElement) fr = document.body;
    const rect = fr.getBoundingClientRect(), k = scaleOf(fr) || 1, cs = getComputedStyle(fr);
    const padL = g.margin != null ? g.margin : parseFloat(cs.paddingLeft) || 0;
    const padR = g.margin != null ? g.margin : parseFloat(cs.paddingRight) || 0;
    const cols = gridPref.cols || g.cols || 12, row = g.row || 8;
    const gut = gridPref.gutter != null ? gridPref.gutter : g.gutter != null ? g.gutter : 24;
    const type = gridPref.type || g.type || 'cell', step = gridPref.step || g.step || 8;
    const cw = (rect.width / k - padL - padR - (cols - 1) * gut) / cols;
    const starts = [], ends = [];
    for (let i = 0; i < cols; i++) {
      const s = rect.left + (padL + i * (cw + gut)) * k;
      starts.push(s);
      ends.push(s + cw * k);
    }
    return { rect, starts, ends, row: row * k, rowLocal: row, top: rect.top, type, step: step * k, stepLocal: step };
  }

  function gridTarget() {
    if (sel) return sel;
    const c = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return c && c !== ui.host ? c : document.body;
  }

  /* Панель: внизу по центру, её можно перетащить за название и свернуть. Место и вид браузер помнит */
  const BAR_KEY = 'pravki:bar';
  const barPref = (() => { try { return JSON.parse(localStorage.getItem(BAR_KEY)) || {}; } catch { return {}; } })();
  function saveBar() { try { localStorage.setItem(BAR_KEY, JSON.stringify(barPref)); } catch {} }

  function placeBar() {
    const b = ui.bar;
    b.classList.toggle('min', !!barPref.min);
    ui.fold = ui.fold || b.querySelector('#fold');
    ui.fold.title = barPref.min ? 'Развернуть панель' : 'Свернуть панель';
    if (barPref.x == null) { b.classList.remove('moved'); b.style.left = b.style.top = b.style.bottom = ''; }
    else {
      b.classList.add('moved');
      const r = b.getBoundingClientRect();
      const x = Math.max(8, Math.min(barPref.x, innerWidth - r.width - 8));
      const y = Math.max(8, Math.min(barPref.y, innerHeight - r.height - 8));
      Object.assign(b.style, { left: x + 'px', top: y + 'px', bottom: 'auto' });
    }
    // Если панель не влезла в одну строку, скругляем её меньше, иначе она превращается в овал
    b.classList.remove('wrap');
    if (b.getBoundingClientRect().height > 52) b.classList.add('wrap');
  }

  function bindBarDrag() {
    let g = null;
    ui.hand.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ui.hand.setPointerCapture(ev.pointerId);
      const r = ui.bar.getBoundingClientRect();
      g = { sx: ev.clientX, sy: ev.clientY, x: r.left, y: r.top, on: false };
    });
    ui.hand.addEventListener('pointermove', ev => {
      if (!g) return;
      const dx = ev.clientX - g.sx, dy = ev.clientY - g.sy;
      if (!g.on && Math.hypot(dx, dy) < 4) return;
      g.on = true;
      ui.bar.classList.add('grab');
      barPref.x = g.x + dx;
      barPref.y = g.y + dy;
      placeBar();
    });
    const end = () => {
      if (!g) return;
      ui.bar.classList.remove('grab');
      if (g.on) saveBar();
      else if (barPref.min) { barPref.min = false; placeBar(); saveBar(); }
      g = null;
      paintGridMenu();
    };
    ui.hand.addEventListener('pointerup', end);
    ui.hand.addEventListener('pointercancel', end);
    ui.hand.addEventListener('dblclick', () => { delete barPref.x; delete barPref.y; placeBar(); saveBar(); paintGridMenu(); });
    window.addEventListener('resize', placeBar);
  }

  function hideGrid() {
    ui.cols.textContent = '';
    ui.cell.style.display = 'none';
  }

  function saveGrid() {
    try { localStorage.setItem(GRID_KEY, JSON.stringify(gridPref)); } catch {}
    paintGridMenu();
    loop();
  }

  // Меню над кнопкой «Сетка»: вид, ползунки для него и «Скрыть сетку»
  function paintGridMenu() {
    const g = CFG.grid || {}, $ = id => ui.gm.querySelector('#' + id);
    const type = gridPref.type || g.type || 'cell';
    ui.gridBtn.classList.toggle('on', gridOn);
    for (const b of ui.gm.querySelectorAll('[data-g]')) b.classList.toggle('on', b.dataset.g === type);
    $('gStepL').hidden = type !== 'cell';
    $('gColsL').hidden = $('gGutL').hidden = type !== 'cols';
    const val = { gStep: gridPref.step || g.step || 8, gCols: gridPref.cols || g.cols || 12,
      gGut: gridPref.gutter != null ? gridPref.gutter : g.gutter != null ? g.gutter : 24 };
    for (const id in val) { $(id).value = val[id]; $(id).nextElementSibling.textContent = val[id]; }
    const r = ui.gridBtn.getBoundingClientRect();
    ui.gm.style.left = Math.max(8, Math.min(r.left - 12, innerWidth - 252)) + 'px';
    if (r.top > 300) { ui.gm.style.bottom = (innerHeight - r.top + 8) + 'px'; ui.gm.style.top = 'auto'; }
    else { ui.gm.style.top = (r.bottom + 8) + 'px'; ui.gm.style.bottom = 'auto'; }
  }

  function paintGrid() {
    if (!gridOn) return;
    const G = gridFor(gridTarget());
    const top = Math.max(0, G.rect.top), bottom = Math.min(innerHeight, G.rect.bottom);
    const box = ui.cols;
    if (G.type === 'cell') {
      // Клетка одним слоем: тонкие линии с шагом и яркие через восемь клеток, от угла кадра
      box.textContent = '';
      const left = Math.max(0, G.rect.left), right = Math.min(innerWidth, G.rect.right);
      const s = G.step, b = s * 8, mod = (a, m) => ((a % m) + m) % m;
      const line = (dir, a) => 'linear-gradient(to ' + dir + ',rgba(255,61,90,' + a + ') 1px,transparent 1px)';
      const layers = [[line('right', .32), b], [line('bottom', .32), b]];
      if (s >= 4) layers.push([line('right', .14), s], [line('bottom', .14), s]);
      Object.assign(ui.cell.style, {
        display: 'block', left: left + 'px', top: top + 'px',
        width: Math.max(0, right - left) + 'px', height: Math.max(0, bottom - top) + 'px',
        backgroundImage: layers.map(l => l[0]).join(','),
        backgroundSize: layers.map(l => l[1] + 'px ' + l[1] + 'px').join(','),
        backgroundPosition: layers.map(l => mod(G.rect.left - left, l[1]) + 'px ' + mod(G.rect.top - top, l[1]) + 'px').join(','),
      });
      return;
    }
    ui.cell.style.display = 'none';
    while (box.children.length < G.starts.length) box.appendChild(document.createElement('i'));
    while (box.children.length > G.starts.length) box.lastChild.remove();
    G.starts.forEach((s, i) => Object.assign(box.children[i].style, {
      left: s + 'px', width: (G.ends[i] - s) + 'px', top: top + 'px', height: Math.max(0, bottom - top) + 'px',
    }));
  }

  /* Цели для привязки: родитель и дед (края и центр), соседи, все тексты и картинки в окне. */
  function collectTargets(el) {
    const out = [], seen = new Set([el]);
    const push = (n, container) => {
      if (!n || seen.has(n) || n.nodeType !== 1 || (ui && n === ui.host)) return;
      seen.add(n);
      if (!container && (el.contains(n) || n.contains(el))) return;
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      if (r.bottom < -200 || r.top > innerHeight + 200 || r.right < -200 || r.left > innerWidth + 200) return;
      out.push({ n, container, wide: !container && r.width > innerWidth * 0.8, l: r.left, r: r.right, t: r.top, b: r.bottom,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    };
    const p = el.parentElement, gp = p && p.parentElement;
    if (p && p !== document.documentElement) push(p, true);
    if (gp && gp !== document.documentElement && gp !== document.body) push(gp, true);
    for (const n of [p, gp]) if (n) for (const kid of n.children) push(kid, false);
    for (const n of blocks.values()) push(n, false);
    for (const n of document.querySelectorAll('img,picture,svg,video,canvas')) if (!n.ownerSVGElement) push(n, false);
    return out.slice(0, 800);
  }

  const XN = ['левый край', 'центр', 'правый край'], XD = ['левому краю', 'центру', 'правому краю'];
  const YN = ['верх', 'середина', 'низ'], YD = ['верху', 'середине', 'низу'];

  /* Ближайшее совпадение края или центра с соседом. Центр прилипает только к центру. */
  function snapAxis(pts, targets, x) {
    let best = null;
    for (const T of targets) {
      const vals = x ? [T.l, T.cx, T.r] : [T.t, T.cy, T.b];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if ((i === 1) !== (j === 1)) continue;
        if (i === 1 && T.wide) continue;  // центр блока во всю ширину это просто центр страницы
        const d = vals[j] - pts[i];
        if (Math.abs(d) > SNAP) continue;
        const score = Math.abs(d) + (T.container ? 0.3 : 0) + (i === 1 ? 0.2 : 0);
        if (!best || score < best.score) best = { d, at: vals[j], i, j, T, score };
      }
    }
    if (!best) return null;
    const N = x ? XN : YN, D = x ? XD : YD;
    best.text = N[best.i] + ' по ' + D[best.j] + ' ' + (best.T.container ? 'родителя ' : '') + nameOf(best.T.n);
    return best;
  }

  // К клетке встаёт ближний край: левый или правый, верх или низ
  function cellSnap(a, b, o, s) {
    const da = o + Math.round((a - o) / s) * s - a, db = o + Math.round((b - o) / s) * s - b;
    return Math.abs(da) <= Math.abs(db) ? { d: da, first: true } : { d: db, first: false };
  }

  function gridSnapX(R, G) {
    if (G.type === 'cell') {
      const c = cellSnap(R.l, R.l + R.w, G.rect.left, G.step);
      return { d: c.d, text: (c.first ? 'левый' : 'правый') + ' край по клетке ' + G.stepLocal + ' px сетки режима' };
    }
    let best = null;
    G.starts.forEach((s, c) => {
      const d = s - R.l;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, text: 'левый край по колонке ' + (c + 1) + ' из ' + G.starts.length + ' сетки режима' };
    });
    G.ends.forEach((s, c) => {
      const d = s - (R.l + R.w);
      if (Math.abs(d) < Math.abs(best.d)) best = { d, text: 'правый край по колонке ' + (c + 1) + ' из ' + G.starts.length + ' сетки режима' };
    });
    return best;
  }
  function gridSnapY(R, G) {
    if (G.type === 'cell') {
      const c = cellSnap(R.t, R.t + R.h, G.rect.top, G.step);
      return { d: c.d, text: (c.first ? 'верх' : 'низ') + ' по клетке ' + G.stepLocal + ' px сетки режима' };
    }
    const y = R.t - G.top;
    return { d: Math.round(y / G.row) * G.row - y, text: 'верх по шагу ' + G.rowLocal + ' px сетки режима' };
  }

  function drawGuides() {
    const box = ui.guides;
    box.textContent = '';
    for (const g of guides) {
      const i = document.createElement('i');
      if (g.x != null) Object.assign(i.style, { left: g.x - 0.5 + 'px', top: g.a + 'px', width: '1px', height: Math.max(1, g.b - g.a) + 'px' });
      else Object.assign(i.style, { top: g.y - 0.5 + 'px', left: g.a + 'px', height: '1px', width: Math.max(1, g.b - g.a) + 'px' });
      box.appendChild(i);
    }
  }

  function beginDrag(d) {
    const el = d.el;
    d.on = true;
    select(el);
    hov = null;
    keepStyle(el);
    const rec = recOf(el);
    d.before = rec && rec.move ? clone(rec.move) : null;
    d.base = d.before ? clone(d.before) : newMove(el);
    d.k = scaleOf(el.parentElement || document.body) || 1;
    d.rect = el.getBoundingClientRect();
    d.targets = collectTargets(el);
    d.grid = gridOn ? gridFor(el) : null;
    document.documentElement.dataset.pvDragging = '1';
    showLabel(null);
  }

  function moveDrag(d, ev) {
    let mx = ev.clientX - d.sx, my = ev.clientY - d.sy;
    const R = { l: d.rect.left + mx, t: d.rect.top + my, w: d.rect.width, h: d.rect.height };
    guides = [];
    const xs = [], ys = [];
    if (!(ev.metaKey || ev.ctrlKey)) {
      const sx = snapAxis([R.l, R.l + R.w / 2, R.l + R.w], d.targets, true);
      const sy = snapAxis([R.t, R.t + R.h / 2, R.t + R.h], d.targets, false);
      if (sx) { mx += sx.d; R.l += sx.d; xs.push(sx.text); }
      else if (d.grid) { const g = gridSnapX(R, d.grid); mx += g.d; R.l += g.d; xs.push(g.text); }
      if (sy) { my += sy.d; R.t += sy.d; ys.push(sy.text); }
      else if (d.grid && d.grid.type === 'cell') { const g = gridSnapY(R, d.grid); my += g.d; R.t += g.d; ys.push(g.text); }
      if (sx) guides.push({ x: sx.at, a: Math.min(R.t, sx.T.t), b: Math.max(R.t + R.h, sx.T.b) });
      if (sy) guides.push({ y: sy.at, a: Math.min(R.l, sy.T.l), b: Math.max(R.l + R.w, sy.T.r) });
    }
    // В «выровнено» только оси, по которым блок сдвинули. По другой оси остаётся то, что было
    const dx = Math.round(d.base.dx + mx / d.k), dy = Math.round(d.base.dy + my / d.k);
    const old = d.base.snap || [], isX = t => /^(левый|правый|центр)/.test(t);
    const snaps = [].concat(dx !== d.base.dx ? xs : old.filter(isX), dy !== d.base.dy ? ys : old.filter(t => !isX(t)));
    const m = Object.assign(clone(d.base), { dx, dy, snap: snaps, vw: innerWidth });
    applyMove(d.el, m);
    d.m = m;
    drawGuides();
  }

  function endDrag(d, cancel) {
    delete document.documentElement.dataset.pvDragging;
    guides = [];
    drawGuides();
    if (cancel || !d.m) { applyMove(d.el, d.before); return; }
    commitMove(d.el, d.before, d.m);
  }

  /* Сдвиг или размер в запись и в историю. merge склеивает подряд идущие нажатия стрелок. */
  function commitMove(el, before, after, merge) {
    setMove(el, after);
    pushHist({ type: 'move', el, before: clone(before), after: clone(after), merge, t: Date.now() });
  }

  function nudge(el, dx, dy) {
    const rec = recOf(el);
    const before = rec && rec.move ? clone(rec.move) : null;
    const m = before ? clone(before) : newMove(el);
    m.dx += dx; m.dy += dy; m.vw = innerWidth; m.snap = [];
    commitMove(el, before, m, true);
  }

  /* Квадратик в углу рамки: ширина, а у блоков и высота. Фото держит пропорции, текст меняет только ширину. */
  function bindResize() {
    let rs = null;
    ui.hdl.addEventListener('pointerdown', ev => {
      if (!sel || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      ui.hdl.setPointerCapture(ev.pointerId);
      const el = sel;
      keepStyle(el);
      const rec = recOf(el);
      const before = rec && rec.move ? clone(rec.move) : null;
      rs = { el, before, base: before ? clone(before) : newMove(el), sx: ev.clientX, sy: ev.clientY,
        rect: el.getBoundingClientRect(), ks: scaleOf(el) || 1, w: boxW(el), h: boxH(el),
        media: MEDIA.test(el.tagName), text: isTextBlock(el), targets: collectTargets(el), grid: gridOn ? gridFor(el) : null };
      document.documentElement.dataset.pvDragging = '1';
    });
    ui.hdl.addEventListener('pointermove', ev => {
      if (!rs) return;
      let right = rs.rect.right + ev.clientX - rs.sx, bottom = rs.rect.bottom + ev.clientY - rs.sy;
      guides = [];
      const snaps = [];
      if (!(ev.metaKey || ev.ctrlKey)) {
        const sx = snapAxis([right, right, right], rs.targets, true);
        if (sx && sx.i !== 1) { right += sx.d; snaps.push(sx.text.replace(/^левый край|^правый край/, 'правый край')); guides.push({ x: sx.at, a: Math.min(rs.rect.top, sx.T.t), b: Math.max(bottom, sx.T.b) }); }
        else if (rs.grid && rs.grid.type === 'cell') {
          const o = rs.grid.rect.left, s = rs.grid.step;
          right = o + Math.round((right - o) / s) * s;
        } else if (rs.grid) {
          let best = null;
          rs.grid.ends.concat(rs.grid.starts).forEach(s => { if (best == null || Math.abs(s - right) < Math.abs(best - right)) best = s; });
          if (best != null) right = best;
        }
        if (!rs.media && !rs.text) {
          const sy = snapAxis([bottom, bottom, bottom], rs.targets, false);
          if (sy && sy.i !== 1) { bottom += sy.d; snaps.push(sy.text.replace(/^верх|^низ/, 'низ')); guides.push({ y: sy.at, a: Math.min(rs.rect.left, sy.T.l), b: Math.max(right, sy.T.r) }); }
          else if (rs.grid && rs.grid.type === 'cell') { const o = rs.grid.rect.top, s = rs.grid.step; bottom = o + Math.round((bottom - o) / s) * s; }
        }
      }
      const w = Math.max(16, Math.round(rs.w + (right - rs.rect.right) / rs.ks));
      let h = null;
      if (rs.media) h = Math.round(w * rs.h / rs.w);
      else if (!rs.text) h = Math.max(16, Math.round(rs.h + (bottom - rs.rect.bottom) / rs.ks));
      const m = Object.assign(clone(rs.base), { w, h: h != null ? h : rs.base.h, vw: innerWidth });
      if (snaps.length) m.snap = snaps;
      applyMove(rs.el, m);
      rs.m = m;
      drawGuides();
    });
    const end = () => {
      if (!rs) return;
      const r = rs;
      rs = null;
      delete document.documentElement.dataset.pvDragging;
      guides = [];
      drawGuides();
      if (r.m) commitMove(r.el, r.before, r.m);
    };
    ui.hdl.addEventListener('pointerup', end);
    ui.hdl.addEventListener('pointercancel', end);
  }

  /* Правка текста: каретка туда, куда щёлкнули дважды. */
  function startEdit(el, x, y) {
    select(null);
    el.focus({ preventScroll: true });
    let range = null;
    if (x != null) {
      if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
      else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
      }
    }
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  /* ---------- назад и вперёд ---------- */

  const hist = { back: [], fwd: [] };

  function pushHist(a) {
    const last = hist.back[hist.back.length - 1];
    if (a.merge && last && last.merge && last.el === a.el && a.t - last.t < 800) {
      last.after = a.after;
      last.t = a.t;
    } else hist.back.push(a);
    if (hist.back.length > 300) hist.back.shift();
    hist.fwd = [];
    paintHist();
  }

  function paintHist() {
    if (!ui) return;
    ui.undo.disabled = !hist.back.length;
    ui.redo.disabled = !hist.fwd.length;
  }

  function act(a, side) {
    if (!a.el.isConnected) return;
    if (a.type === 'text') { a.el.innerHTML = a[side]; touch(a.el); }
    else setMove(a.el, clone(a[side]));
    flash(a.el);
  }

  function undo() {
    const ed = editingEl();
    if (ed) ed.blur();
    const a = hist.back.pop();
    if (!a) { toast('Откатывать нечего'); return; }
    act(a, 'before');
    hist.fwd.push(a);
    paintHist();
  }

  function redo() {
    const a = hist.fwd.pop();
    if (!a) { toast('Возвращать нечего'); return; }
    act(a, 'after');
    hist.back.push(a);
    paintHist();
  }

  /* ---------- ширина телефона ---------- */

  /* Снимок страницы с правками, без её скриптов. Нужен, когда во фрейм режим не подключить:
     страница открыта файлом, и браузер не пускает родителя внутрь фрейма. */
  function snapshot() {
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('pravki-ui, #pravki-style, script, noscript').forEach(n => n.remove());
    root.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    const head = root.querySelector('head') || root;
    const base = document.createElement('base');
    base.href = location.href;
    head.insertBefore(base, head.firstChild);
    return '<!doctype html>' + root.outerHTML;
  }

  // Фрейм каждый раз новый: первая загрузка свежего фрейма не пишется в историю, и «Назад» браузера работает сразу
  function freshFrame() {
    const f = ui.phf.ownerDocument.createElement('iframe');
    f.id = 'phf';
    f.title = 'Страница на ширине телефона';
    ui.phf.replaceWith(f);
    ui.phf = f;
    return f;
  }

  function closePhone() {
    ui.ph.classList.remove('on');
    freshFrame();
  }

  function phone() {
    select(null);
    const f = freshFrame();
    f.onload = () => {
      // Страница во фрейме сама показывает правки, если режим в неё уже подключён
      // (сервер или строка в странице). После закладки подключаем его сами.
      try {
        const w = f.contentWindow, d = f.contentDocument;
        if (!d) throw new Error('фрейм закрыт');
        if (!w.__pravki && me && me.src) {
          const sc = d.createElement('script');
          sc.src = me.src;
          sc.dataset.auto = '1';
          d.documentElement.appendChild(sc);
        }
      } catch {
        f.onload = null;
        f.setAttribute('sandbox', '');
        f.srcdoc = snapshot();
      }
    };
    f.src = location.href.replace(/#.*$/, '') + '#pravki-preview';
    ui.ph.classList.add('on');
  }

  /* ---------- события страницы ---------- */

  const editable = t => t && t.closest && t.closest('[data-pv-addr]:not([data-pv-kind])');
  const fromUI = ev => ui && ev.target === ui.host;

  function bind() {
    document.addEventListener('input', ev => {
      const el = editable(ev.target);
      if (el) touch(el);
    });

    // Правка текста целиком, от входа до выхода, это один шаг назад.
    document.addEventListener('focusin', ev => {
      const el = editable(ev.target);
      if (el) el._pvEditHTML = el.innerHTML;
    });
    document.addEventListener('focusout', ev => {
      const el = editable(ev.target);
      if (!el) return;
      if (el._pvEditHTML != null && el._pvEditHTML !== el.innerHTML) {
        pushHist({ type: 'text', el, before: el._pvEditHTML, after: el.innerHTML, t: Date.now() });
      }
      el._pvEditHTML = null;
    });

    // Клавиши, пока правится текст, перехватываем раньше сайта: иначе
    // его горячие клавиши (стрелки, пробел) сработают посреди слова.
    window.addEventListener('keydown', ev => {
      if (ev.key === 'Alt' || ev.key === 'Shift') { lastShift = ev.shiftKey; updateHover(ev.altKey); }
      if (fromUI(ev)) return;
      const el = editable(ev.target);
      if (!el) {
        const mod = ev.metaKey || ev.ctrlKey;
        if (mod && !ev.altKey && (ev.code === 'KeyZ' || ev.code === 'KeyY')) {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.code === 'KeyY' || ev.shiftKey) redo(); else undo();
          return;
        }
        if (ev.key === 'Escape' && ui.gm.classList.contains('on')) { ui.gm.classList.remove('on'); return; }
        if (ev.key === 'Escape' && ui.ph.classList.contains('on')) { closePhone(); return; }
        if (!sel || mod || ev.altKey) return;
        const step = ev.shiftKey ? 10 : 1;
        const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
        if (dir) { ev.preventDefault(); ev.stopPropagation(); nudge(sel, dir[0], dir[1]); return; }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); select(null); return; }
        if (ev.key === 'Enter' && isTextBlock(sel)) { ev.preventDefault(); ev.stopPropagation(); startEdit(sel); }
        return;
      }
      ev.stopPropagation();
      if (ev.key === 'Escape') { el.blur(); select(el); return; }
      if (ev.code === 'Space' && (ev.altKey || ((ev.metaKey || ev.ctrlKey) && ev.shiftKey))) {
        ev.preventDefault();
        document.execCommand('insertText', false, NBSP);
        return;
      }
      // В кнопке пробел нажимает её, поэтому ставим его сами
      if (ev.code === 'Space' && !ev.altKey && !ev.metaKey && !ev.ctrlKey && el.closest('button')) {
        ev.preventDefault();
        document.execCommand('insertText', false, ' ');
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!document.execCommand('insertLineBreak')) document.execCommand('insertHTML', false, '<br>');
      }
    }, true);
    window.addEventListener('keyup', ev => {
      if (ev.key === 'Alt' || ev.key === 'Shift') { lastShift = ev.shiftKey; updateHover(ev.altKey); }
      if (editable(ev.target)) ev.stopPropagation();
    }, true);
    window.addEventListener('keypress', ev => { if (editable(ev.target)) ev.stopPropagation(); }, true);
    window.addEventListener('blur', () => { setHover(null); showLabel(null); });

    document.addEventListener('mousemove', ev => {
      const next = !ev.altKey && !drag && !editingEl() ? grabbed(ev.target, ev.shiftKey) : null;
      const h = next && !isTextBlock(next) ? next : null;
      if (h !== hov) { hov = h; loop(); }
      if (ev.target === lastTarget && ev.shiftKey === lastShift && !!hoverEl === ev.altKey) return;
      lastTarget = ev.target;
      lastShift = ev.shiftKey;
      updateHover(ev.altKey);
    }, { passive: true });
    window.addEventListener('scroll', () => showLabel(null), { passive: true, capture: true });

    // Щелчок выбирает, а не ставит каретку: каретку даёт двойной щелчок.
    // Поэтому у mousedown гасим действие браузера (фокус и выделение), но
    // сайт событие получает. Внутри текста, который уже правится, всё как обычно.
    window.addEventListener('mousedown', ev => {
      if (ev.button !== 0 || ev.altKey || fromUI(ev)) return;
      const ed = editingEl();
      if (ed && ed.contains(ev.target)) return;
      if (ed) ed.blur();
      if (ev.target.closest && ev.target.closest(NOMOVE)) return;
      ev.preventDefault();
    }, true);

    window.addEventListener('pointerdown', ev => {
      if (!fromUI(ev)) ui.gm.classList.remove('on');
      if (ev.button !== 0 || ev.altKey || ev.pointerType === 'touch' || fromUI(ev)) return;
      const ed = editingEl();
      if (ed && ed.contains(ev.target)) return;
      const el = grabbed(ev.target, ev.shiftKey);
      if (!el) { select(null); return; }
      drag = { el, sx: ev.clientX, sy: ev.clientY, id: ev.pointerId, on: false };
    }, true);
    window.addEventListener('pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.on) {
        if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
        beginDrag(drag);
      }
      ev.preventDefault();
      moveDrag(drag, ev);
    }, true);
    window.addEventListener('pointerup', ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (d.on) {
        endDrag(d);
        // Отпустили после перетаскивания: щелчок, который браузер пришлёт следом, сайту не отдаём.
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 400);
      } else select(d.el);
    }, true);
    window.addEventListener('pointercancel', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.on) endDrag(d, true);
    }, true);
    window.addEventListener('click', ev => {
      if (!suppressClick) return;
      suppressClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    // Двойной щелчок: по тексту правка, по остальному заход внутрь карточки.
    window.addEventListener('dblclick', ev => {
      if (ev.altKey || fromUI(ev)) return;
      const el = editable(ev.target);
      if (el && el === editingEl()) return;
      ev.preventDefault();
      if (el) { startEdit(el, ev.clientX, ev.clientY); return; }
      const b = baseOf(ev.target);
      if (b) select(b);
    }, true);
    // Картинки и ссылки браузер умеет таскать сам, в режиме правок это мешает.
    window.addEventListener('dragstart', ev => { if (!editingEl()) ev.preventDefault(); }, true);

    // Alt + щелчок: замечание к тому, по чему щёлкнули.
    document.addEventListener('click', ev => {
      if (!ev.altKey) return;
      const el = pick(ev.target, ev.shiftKey);
      if (!el) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = ensureRec(el);
      save();
      setHover(null);
      ui.side.classList.add('on');
      selected = r.addr;
      render();
      const ta = ui.items.querySelector('textarea[data-addr="' + CSS.escape(r.addr) + '"]');
      if (ta) {
        ta.focus();
        ta.closest('.item').scrollIntoView({ block: 'nearest' });
      }
    }, true);

    // Ссылки на другие страницы в режиме правок не открываются: по ним правят
    // текст. Якоря внутри страницы и Cmd/Ctrl + щелчок работают.
    document.addEventListener('click', ev => {
      if (ev.altKey || ev.metaKey || ev.ctrlKey) return;
      // Кнопка формы в режиме правок форму не отправляет
      const fb = ev.target.closest && ev.target.closest('button,input[type=submit]');
      if (fb && fb.form) ev.preventDefault();
      const a = ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#') || href.startsWith('javascript:')) return;
      ev.preventDefault();
      if (!editingEl()) hintClick();
    });
    let hintAt = 0;
    const hintClick = () => {
      if (Date.now() - hintAt < 6000) return;
      hintAt = Date.now();
      toast('Ссылки и кнопки в режиме правок не нажимаются. ' + CMD + ' + щелчок нажмёт');
    };
    // Кнопки сайта в режиме правок не нажимаются, как и ссылки: двойной щелчок по ним правит текст.
    // Cmd или Ctrl + щелчок нажимает по-настоящему. Пока правится текст, щелчок внутри него тоже ничего не нажимает
    window.addEventListener('click', ev => {
      if (fromUI(ev) || ev.altKey) return;
      const ed = editingEl();
      if (ed && ed.contains(ev.target)) { ev.preventDefault(); ev.stopPropagation(); return; }
      if (ev.metaKey || ev.ctrlKey) return;
      const bt = ev.target.closest && ev.target.closest('button,[role=button],input[type=submit],input[type=button]');
      if (bt) { ev.preventDefault(); ev.stopPropagation(); hintClick(); }
    }, true);

    // Сайт открыт в другой вкладке на другой странице: подтягиваем её правки.
    window.addEventListener('storage', ev => {
      if (ev.key !== KEY) return;
      const mine = page();
      store = load();
      store.pages[PAGE] = mine;
      render();
    });
  }

  /* ---------- запуск ---------- */

  async function loadPages() {
    if (CFG.pagesList) { pagesList = CFG.pagesList; return; }
    if (!CFG.server) return;
    try {
      const res = await fetch('/__pravki/pages', { cache: 'no-store' });
      pagesList = await res.json();
    } catch { pagesList = []; }
  }

  function start() {
    // В плеере «Ролик из HTML» свои правки: со сценой и моментом, поверх кадра,
    // который код перерисовывает каждый миг. Закладка и сервер включают их.
    if (window.reelPlayer && typeof window.reelPlayer.edit === 'function') {
      window.__pravki = { reel: true, text: window.reelPlayer.edits };
      window.reelPlayer.edit(true);
      return;
    }
    if (CFG.freeze) freeze();
    mountUI();
    if (CFG.reveal) reveal();
    index();
    restore();
    bind();
    render();
    paintHist();
    loadPages().then(render);
    window.__pravki = {
      text: build, count: total, clear: clearAll, drop, reindex: () => { index(); restore(); render(); },
      reveal, data: () => JSON.parse(JSON.stringify(store)), page: PAGE, undo, redo,
    };
    toast(applied
      ? 'Уже внесено в файлы и убрано из списка: ' + applied
      : 'Режим правок. Тяните, чтобы двигать. Двойной щелчок правит текст, Alt + щелчок оставляет замечание');
  }

  /* Во фрейме «Телефон»: только показать правки, без панели и без записи. */
  function startPreview() {
    if (CFG.freeze) freeze();
    if (CFG.reveal) reveal();
    index();
    restore();
    for (const el of document.querySelectorAll('[data-pv-ce]')) el.removeAttribute('contenteditable');
    window.__pravki = { preview: true };
  }

  // Ждём, пока сайт достроит страницу своими скриптами.
  const go = () => setTimeout(PREVIEW ? startPreview : start, CFG.delay ?? 400);
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
})();
