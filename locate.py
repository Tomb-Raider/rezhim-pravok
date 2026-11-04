#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Находит в файлах проекта место каждой записи пакета «ПРАВКИ САЙТА».

    python3 locate.py пакет.txt [--root папка]
    pbpaste | python3 locate.py - [--root папка]

Папку берёт из строки «папка: …» пакета, если --root не указан.
Ищет текст «было» (а для замечаний без правки сам текст блока) сначала
в файле страницы и в файле-источнике из пометки, потом во всех текстовых
файлах папки. Теги, &nbsp;, \\u00a0 и переносы при поиске не мешают.
Для замечаний к блоку целиком ищет id из строки «где:», для картинок
имя файла. Строки сдвига («сдвиг:», «размер:», «выровнено:») печатает как есть.

Печатает по записи на строку: номер, адрес, файл:строка и кусок строки.
Ничего не меняет.
"""

import argparse
import html
import os
import re
import sys

TEXT_EXT = ('.html', '.htm', '.js', '.mjs', '.css', '.py', '.json', '.md', '.txt', '.svg', '.csv')
SKIP_DIR = re.compile(r'^(\.|_deploy$|deploy_|node_modules|__pycache__|архив|Архив|archive)', re.I)
INLINE = {'a', 'b', 'i', 'em', 'strong', 'span', 'small', 'sup', 'sub', 'mark', 'u', 's', 'code',
          'abbr', 'nobr', 'wbr', 'q', 'cite', 'time', 'label', 'font', 'del', 'ins', 'kbd'}
TOKEN = re.compile(r'<[a-zA-Z/!][^<>]{0,400}>|&#?[a-zA-Z0-9]{1,10};|\\u[0-9a-fA-F]{4}|\\n|\s+|.', re.S)


def normalize(text):
    """Текст без тегов и сущностей, пробелы схлопнуты. Плюс карта: символ → смещение в исходнике."""
    out, pos = [], []
    for m in TOKEN.finditer(text):
        t = m.group()
        if t[0] == '<' and len(t) > 2:
            name = re.match(r'</?\s*([a-zA-Z0-9]+)', t)
            ch = '' if name and name.group(1).lower() in INLINE else ' '
        elif t[0] == '&':
            ch = html.unescape(t)
        elif t.startswith('\\u'):
            ch = chr(int(t[2:], 16))
        elif t == '\\n' or t.isspace():
            ch = ' '
        else:
            ch = t
        for c in ch:
            if c in '\u00ad\u200b':
                continue
            if c.isspace() or c == '\u00a0':
                c = ' '
                if not out or out[-1] == ' ':
                    continue
            out.append(c)
            pos.append(m.start())
    return ''.join(out), pos


def needle_of(s):
    s = s.replace('&nbsp;', ' ').replace('<br>', ' ')
    s = html.unescape(s).replace('\u00a0', ' ')
    return re.sub(r'\s+', ' ', s).strip()


def parse(pack):
    root, page, page_src, recs, cur = None, None, None, [], None
    for line in pack.splitlines():
        s = line.strip()
        if s.startswith('папка:'):
            root = s.split(':', 1)[1].split(' (открыта на сайте пакета')[0].strip()
        elif s.startswith('═══'):
            page = s.strip('═ ').split('  ·  ')[0].strip()
            page_src = None
        elif s.startswith('собирается:'):
            page_src = s.split(':', 1)[1].strip()
        elif re.match(r'^\[\d+\]\s', s):
            num, rest = s.split(']', 1)
            parts = [p.strip() for p in rest.split('  · ')]
            cur = {'n': num.strip('['), 'addr': parts[0], 'flags': parts[1:], 'page': page,
                   'page_src': page_src, 'before': None, 'after': None, 'text': None, 'where': None, 'note': [],
                   'move': []}
            recs.append(cur)
        elif cur is None:
            continue
        elif line.startswith('- '):
            cur['before'] = line[2:]
        elif line.startswith('+ '):
            cur['after'] = line[2:]
        elif line.startswith('! '):
            cur['note'].append(line[2:])
        elif s.startswith('где:'):
            cur['where'] = s.split(':', 1)[1].strip()
        elif re.match(r'^(сдвиг|размер|выровнено):', s):
            cur['move'].append(s)
        elif line.startswith('  ') and s and cur['text'] is None:
            cur['text'] = s
    return root, recs


class Index:
    def __init__(self, root, exclude):
        self.root, self.cache, self.exclude = root, {}, exclude
        self.all = None

    def files(self):
        if self.all is None:
            self.all = []
            for d, dirs, files in os.walk(self.root):
                dirs[:] = sorted(x for x in dirs if not SKIP_DIR.match(x))
                for f in sorted(files):
                    p = os.path.join(d, f)
                    if f.lower().endswith(TEXT_EXT) and os.path.getsize(p) < 3_000_000 and p != self.exclude:
                        self.all.append(p)
        return self.all

    def get(self, path):
        if path not in self.cache:
            try:
                raw = open(path, encoding='utf-8', errors='replace').read()
            except OSError:
                raw = ''
            self.cache[path] = (raw,) + normalize(raw)
        return self.cache[path]

    def find_raw(self, path, needle, limit=3):
        """Поиск как есть, без разбора тегов: для имени файла картинки в src."""
        raw = self.get(path)[0]
        hits, i = [], raw.find(needle)
        while i != -1 and len(hits) < limit:
            start = raw.rfind('\n', 0, i) + 1
            end = raw.find('\n', i)
            hits.append((raw.count('\n', 0, i) + 1, raw[start:end if end != -1 else None].strip()[:110]))
            i = raw.find(needle, i + 1)
        return hits

    def find(self, path, needle, limit=3):
        raw, norm, pos = self.get(path)
        hits, i = [], norm.find(needle)
        while i != -1 and len(hits) < limit:
            off = pos[i]
            line_no = raw.count('\n', 0, off) + 1
            start = raw.rfind('\n', 0, off) + 1
            end = raw.find('\n', off)
            snippet = raw[start:end if end != -1 else None].strip()
            hits.append((line_no, snippet[:110]))
            i = norm.find(needle, i + 1)
        return hits


def candidates(root, rec, idx):
    first = []
    for rel in (rec['page'], rec['page_src'], *rec['flags']):
        if not rel:
            continue
        rel = re.split(r'\s+[(·]', rel)[0].strip()          # «app.js (GLOSSARY)» → app.js
        p = os.path.join(root, rel)
        if os.path.isfile(p) and p not in first:
            first.append(p)
    return first + [p for p in idx.files() if p not in first]


def search(root, rec, idx, needle):
    found = []
    for p in candidates(root, rec, idx):
        for line_no, snip in idx.find(p, needle):
            found.append((os.path.relpath(p, root), line_no, snip))
        if len(found) >= 3:
            break
    return found


def read_pack(path):
    """Пакет правок в UTF-8 или UTF-16: так его сохраняет PowerShell 5.1 через >. BOM не мешает"""
    data = open(path, 'rb').read()
    if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return data.decode('utf-16')
    return data.decode('utf-8-sig', errors='replace')


def main():
    # Консоль Windows бывает не в UTF-8: лишний знак лучше заменить, чем упасть.
    # Вывод в UTF-8: агенты на Windows читают его из трубы, а не из консоли.
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument('pack', help='файл с пакетом или - для чтения из stdin')
    ap.add_argument('--root', help='папка проекта (если в пакете нет строки «папка:»)')
    args = ap.parse_args()

    pack = sys.stdin.read() if args.pack == '-' else read_pack(args.pack)
    root, recs = parse(pack)
    root = args.root or root
    if not root or not os.path.isdir(root):
        # Пакет из «Открыть папку» на сайте пакета знает только имя папки, а не путь к ней
        sys.exit('Папку сайта не нашёл%s. Запусти ещё раз с --root <папка сайта>'
                 % ((' по строке «папка: %s»' % root) if root else ''))
    exclude = None if args.pack == '-' else os.path.realpath(args.pack)
    idx = Index(root, exclude)

    print('папка: %s · записей: %d\n' % (root, len(recs)))
    for r in recs:
        head = '[%s] %s' % (r['n'], r['addr'])
        if r['page']:
            head += '  (%s)' % r['page']
        src = r['before'] if r['before'] is not None else r['text']
        if src and any('блок целиком' in f for f in r['flags']):
            # У блока в выгрузке не исходный текст, а склейка подписей через « / »:
            # ищем самый длинный кусок, он почти всегда стоит в разметке целиком.
            src = max(src.split(' / '), key=len)
        lines = []
        if src and not src.startswith('<'):
            needle = needle_of(src)
            found = search(root, r, idx, needle)
            kind = 'точно'
            # Текст мог собираться скриптом из кусков: ищем начало и конец по отдельности.
            if not found and len(needle) > 36:
                for part, label in ((needle[:30], 'по началу'), (needle[-30:], 'по концу')):
                    found = search(root, r, idx, part.strip())
                    if found:
                        kind = label
                        break
            for f, ln, snip in found:
                lines.append('    %s:%d  %s  │ %s' % (f, ln, kind, snip))
            if not found:
                lines.append('    текст не найден: возможно, собирается скриптом или уже изменён')
        elif src:
            # Картинка или видео: ищем имя файла из описания блока.
            m = re.search(r'(\S+\.(?:png|jpe?g|webp|gif|svg|avif|mp4|webm|mov))\b', src, re.I)
            if m:
                found = []
                for p in candidates(root, r, idx):
                    for ln, snip in idx.find_raw(p, m.group(1)):
                        found.append('    %s:%d  по файлу  │ %s' % (os.path.relpath(p, root), ln, snip))
                    if len(found) >= 3:
                        break
                lines.extend(found or ['    файл %s в исходниках не найден' % m.group(1)])
        if r['where']:
            ids = re.findall(r'#([\w-]+)', r['where'])
            lines.append('    где: ' + r['where'])
            for i in ids[:1]:
                pat = re.compile(r'id\s*=\s*["\']%s["\']' % re.escape(i))
                for p in candidates(root, r, idx):
                    raw = idx.get(p)[0]
                    m = pat.search(raw)
                    if m:
                        lines.append('    id="%s" → %s:%d' % (i, os.path.relpath(p, root), raw.count('\n', 0, m.start()) + 1))
                        break
        lines.extend('    ' + m for m in r['move'])
        print(head)
        print('\n'.join(lines) if lines else '    (нечего искать: только замечание)')
        print()


if __name__ == '__main__':
    main()
