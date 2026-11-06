#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локальный сервер режима правок.

Раздаёт папку сайта как есть и на лету дописывает в каждую HTML-страницу
pravki.js. Файлы сайта не меняются, поэтому режим правок не может уехать
на прод. Заголовок Cache-Control: no-store, чтобы браузер не держал старые
страницы и скрипты: иначе кажется, что правка не применилась.

    python3 pravki_server.py [папка] [--port 4401] [--config файл.json] [--open | --safari]

Порт по умолчанию вычисляется из пути к папке: у каждого сайта свой и
постоянный, а значит, правки в localStorage браузера не теряются между
запусками и не смешиваются между сайтами. Если сервер этой же папки уже
работает, второй не поднимается, просто печатается адрес.

Настройки сайта берутся из .pravki.json в корне папки (точка в начале
имени: в Finder файл не виден и при выкладке не уедет). Поля описаны
в шапке pravki.js.

Служебные адреса: /__pravki/pravki.js, /__pravki/info, /__pravki/pages.
Страница с ?pravki-src в адресе отдаётся как есть, без режима: из неё
«Скачать с правками» собирает файл.

Строку запрета скриптов в самой странице (meta Content-Security-Policy, её
ставят некоторые ИИ) сервер снимает только в копии для браузера, иначе режим
не запустится. Файл на диске не меняется, в «Скачать с правками» она остаётся.
"""

import argparse
import functools
import http.server
import io
import json
import os
import re
import socket
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
JS_FILE = os.path.join(HERE, 'pravki.js')

# Папки, где страниц сайта не бывает: служебные, архивы, сборки на выкладку.
SKIP_DIR = re.compile(r'^(\.|_|deploy|node_modules|__pycache__|архив|Архив|archive)', re.I)


def load_config(root, path):
    path = path or os.path.join(root, '.pravki.json')
    if not os.path.isfile(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def scan_pages(root, cfg, limit=60):
    """Страницы сайта: сначала перечисленные в настройках, потом найденные в папке (на два уровня вглубь)."""
    pages = [p for p in (cfg.get('pages') or {}) if os.path.isfile(os.path.join(root, p))]
    found = []
    base_depth = root.rstrip(os.sep).count(os.sep)
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not SKIP_DIR.match(x))
        if d.count(os.sep) - base_depth >= 2:
            dirs[:] = []
        for f in sorted(files):
            if f.lower().endswith(('.html', '.htm')) and not f.startswith('.'):
                found.append(os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/'))
    found.sort(key=lambda p: (p.count('/'), p != 'index.html', p))
    if 'index.html' in found and 'index.html' not in pages:
        pages.insert(0, 'index.html')                  # главная всегда первой, если её не переставили в настройках
    for p in found:
        if p not in pages:
            pages.append(p)
    return [{'path': p, 'name': (cfg.get('pages') or {}).get(p, {}).get('name', '')} for p in pages[:limit]]


def make_snippet(cfg):
    js = json.dumps(cfg, ensure_ascii=False).replace('</', '<\\/')
    return ('\n<script>window.PRAVKI_CONFIG=%s;</script>\n'
            '<script src="/__pravki/pravki.js" data-auto="1"></script>\n' % js).encode('utf-8')


CSP_META = re.compile(rb'<meta\b[^>]*http-equiv\s*=\s*["\']?content-security-policy["\']?[^>]*>', re.I)


def inject(data, snippet):
    """Перед последним </body>, а если его нет, перед </html> или в конец.
    Строку запрета скриптов снимаем: с ней браузер не даст режиму запуститься."""
    data = CSP_META.sub(b'', data)
    for tag in (rb'</body\s*>', rb'</html\s*>'):
        found = list(re.finditer(tag, data, re.I))
        if found:
            pos = found[-1].start()
            return data[:pos] + snippet + data[pos:]
    return data + snippet


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = 'pravki'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _bytes(self, data, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        return io.BytesIO(data)

    def send_head(self):
        srv = self.server
        route = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

        if route == '/__pravki/pravki.js':
            with open(JS_FILE, 'rb') as f:
                return self._bytes(f.read(), 'application/javascript; charset=utf-8')
        if route == '/__pravki/info':
            info = {'root': srv.root, 'name': srv.cfg.get('name', '')}
            return self._bytes(json.dumps(info, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        if route == '/__pravki/pages':
            pages = scan_pages(srv.root, srv.cfg)
            return self._bytes(json.dumps(pages, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            if not route.endswith('/'):
                return super().send_head()          # штатный редирект на адрес со слешем
            for name in ('index.html', 'index.htm'):
                if os.path.isfile(os.path.join(path, name)):
                    path = os.path.join(path, name)
                    break
            else:
                return super().send_head()          # список файлов
        if path.lower().endswith(('.html', '.htm')) and os.path.isfile(path):
            with open(path, 'rb') as f:
                data = f.read()
            # Исходник как есть, со строкой запрета скриптов: из него «Скачать с правками» собирает файл
            if re.search(r'(^|&)pravki-src(=|&|$)', urllib.parse.urlsplit(self.path).query):
                return self._bytes(data, 'text/plain; charset=utf-8')
            return self._bytes(inject(data, srv.snippet), 'text/html; charset=utf-8')
        return super().send_head()


def probe(port, root):
    """'free', 'ours' (тот же сайт уже раздаётся) или 'busy'."""
    with socket.socket() as s:
        s.settimeout(0.3)
        if s.connect_ex(('127.0.0.1', port)) != 0:
            return 'free'
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/__pravki/info' % port, timeout=1) as r:
            return 'ours' if json.load(r).get('root') == root else 'busy'
    except Exception:
        return 'busy'


def start_url(port, root, cfg):
    start = cfg.get('start')
    if not start and os.path.isfile(os.path.join(root, 'index.html')):
        start = 'index.html'
    if not start:
        pages = scan_pages(root, cfg, limit=1)
        start = pages[0]['path'] if pages else ''
    return 'http://localhost:%d/%s' % (port, urllib.parse.quote(start))


def open_url(url, how):
    if how == 'safari' and sys.platform == 'darwin':
        subprocess.run(['open', '-a', 'Safari', url])
    elif how:
        webbrowser.open(url)                         # браузер по умолчанию, на Mac и на Windows


def main():
    # Консоль Windows бывает не в UTF-8: лишний знак лучше заменить, чем упасть.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='Режим правок для сайта из папки')
    ap.add_argument('root', nargs='?', default='.', help='папка сайта (по умолчанию текущая)')
    ap.add_argument('--port', type=int, help='порт (по умолчанию свой для каждой папки)')
    ap.add_argument('--config', help='файл настроек вместо .pravki.json в папке')
    ap.add_argument('--open', dest='how', action='store_const', const='default', help='открыть в браузере по умолчанию')
    ap.add_argument('--safari', dest='how', action='store_const', const='safari', help='открыть в Safari')
    args = ap.parse_args()

    root = os.path.realpath(args.root)
    if not os.path.isdir(root):
        sys.exit('Нет такой папки: ' + root)
    cfg = load_config(root, args.config)

    if args.port:
        candidates = [args.port]
    else:
        base = 4400 + zlib.crc32(root.encode('utf-8')) % 90
        candidates = list(range(base, base + 10))

    port = None
    for p in candidates:
        state = probe(p, root)
        if state == 'ours':
            url = start_url(p, root, cfg)
            print('Режим правок для этой папки уже работает: ' + url, flush=True)
            open_url(url, args.how)
            return
        if state == 'free':
            port = p
            break
    if port is None:
        sys.exit('Порт занят другим сервером: %s. Укажи другой через --port' % candidates)

    run_cfg = dict(cfg, root=root, server=True)
    run_cfg.setdefault('name', os.path.basename(root))

    handler = functools.partial(Handler, directory=root)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    srv.root, srv.cfg, srv.snippet = root, cfg, make_snippet(run_cfg)

    url = start_url(port, root, cfg)
    print()
    print('  Режим правок · ' + run_cfg['name'])
    print('  ' + url)
    print()
    print('  Тяните мышью, чтобы двигать. Двойной щелчок правит текст')
    print('  Alt + щелчок по чему угодно оставляет замечание')
    print('  Потом нажмите «Скопировать правки» и вставьте в чат')
    print('  Сервер работает, пока открыто это окно. Остановить: Ctrl+C или закрыть окно. Если сервер запустил агент, попросите агента его остановить')
    print(flush=True)
    open_url(url, args.how)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
