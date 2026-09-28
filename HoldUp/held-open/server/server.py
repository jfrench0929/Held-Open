#!/usr/bin/env python3
"""Held Open web server.

Serves the pages in ../public, a small JSON API, and a live stream
(Server-Sent Events) that pushes the leaderboard to every open browser the
moment anybody counts a door. Standard library only, so there is nothing to
install.

Settings come from environment variables:
  PORT              port to listen on (default 3000)
  HOST              address to bind (default 0.0.0.0, reachable from your network)
  DATA_DIR          folder for db.json (default ../data). Point this at a
                    persistent disk when you host the site.
  COOLDOWN_SECONDS  wait between taps for each person (default 60)
  LEADERBOARD_TZ    IANA zone such as America/Chicago that defines "a day"
                    (default: the server's own time zone)
  TRUST_PROXY       set to 1 when running behind a proxy that sets X-Forwarded-For
"""

import json
import os
import queue
import socket
import sys
import threading
import time
import traceback
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from store import Store, StoreError

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = (ROOT / "public").resolve()
DATA_DIR = Path(os.environ.get("DATA_DIR") or ROOT / "data")
PORT = int(os.environ.get("PORT", 3000))
HOST = os.environ.get("HOST", "0.0.0.0")
COOLDOWN_MS = int(float(os.environ.get("COOLDOWN_SECONDS", 60)) * 1000)
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}

CSP = (
    "default-src 'self'; script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


def load_timezone():
    name = os.environ.get("LEADERBOARD_TZ")
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception as exc:  # Windows has no tz database unless `pip install tzdata`
        print(f"[config] Could not load LEADERBOARD_TZ={name!r} ({exc}). Using the server's local time.")
        return None


class RateLimiter:
    """Sliding-window limiter kept in memory. Enough to slow down abuse."""

    def __init__(self):
        self.hits = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key, limit, window_s):
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > window_s:
                q.popleft()
            if len(q) >= limit:
                retry = int((window_s - (now - q[0])) * 1000)
                raise StoreError(429, "rate_limited", "Too many tries. Wait a bit and try again.",
                                 retryAfterMs=retry)
            q.append(now)


class Hub:
    """Keeps track of open live streams and pushes fresh snapshots to them."""

    def __init__(self, store):
        self.store = store
        self.clients = set()
        self.lock = threading.Lock()
        self.dirty = threading.Event()
        self.last_day = store.day_key(store.now_ms())

    def add(self, q):
        with self.lock:
            self.clients.add(q)
        self.dirty.set()

    def remove(self, q):
        with self.lock:
            self.clients.discard(q)
        self.dirty.set()

    def online(self):
        with self.lock:
            return len(self.clients)

    def message(self):
        snap = self.store.snapshot(online=self.online())
        return ("event: state\ndata: " + json.dumps(snap, separators=(",", ":")) + "\n\n").encode("utf-8")

    def publish(self):
        self.dirty.set()

    def _broadcast(self):
        self.last_day = self.store.day_key(self.store.now_ms())
        msg = self.message()
        with self.lock:
            targets = list(self.clients)
        for q in targets:
            while True:
                try:
                    q.put_nowait(msg)
                    break
                except queue.Full:  # slow client: drop the stale snapshot, keep the newest
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        pass

    def run(self):
        while True:
            fired = self.dirty.wait(timeout=10)
            if fired:
                time.sleep(0.15)  # let a burst of changes collapse into one broadcast
                self.dirty.clear()
                self._broadcast()
            elif self.store.day_key(self.store.now_ms()) != self.last_day:
                self._broadcast()  # midnight passed: everyone's "today" resets


class Handler(BaseHTTPRequestHandler):
    server_version = "HeldOpen/1.0"
    store = None
    hub = None
    limiter = RateLimiter()

    # ---------- plumbing ----------

    def log_request(self, code="-", size="-"):
        if self.command != "GET" or (str(code).isdigit() and int(code) >= 400):
            print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path.split('?')[0]} {code}")

    def log_error(self, fmt, *args):
        pass

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def _dispatch(self):
        try:
            url = urlsplit(self.path)
            if url.path.startswith("/api/"):
                self._api(url.path, parse_qs(url.query))
            elif self.command in ("GET", "HEAD"):
                self._static(unquote(url.path))
            else:
                raise StoreError(405, "method_not_allowed", "That request is not supported.")
        except StoreError as exc:
            self._json(exc.status, {"error": exc.code, "message": exc.message, **exc.extra})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._json(500, {"error": "server_error", "message": "Something went wrong on our side."})
            except OSError:
                pass

    def _headers(self, content_type, length, cache):
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", CSP)

    def _send(self, status, content_type, body, cache="no-cache"):
        self.send_response(status)
        self._headers(content_type, len(body), cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", body, cache="no-store")

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0 or length > 4096:
            raise StoreError(400, "bad_request", "Send a small JSON body.")
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise StoreError(400, "bad_request", "That request was not valid JSON.")
        if not isinstance(data, dict):
            raise StoreError(400, "bad_request", "That request was not valid JSON.")
        return data

    def _ip(self):
        if TRUST_PROXY:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def _user(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise StoreError(401, "unauthorized", "Sign in to continue.")
        return self.store.authenticate(header[7:])

    # ---------- API ----------

    def _api(self, path, query):
        get = self.command in ("GET", "HEAD")
        post = self.command == "POST"

        if path == "/api/state" and get:
            return self._json(200, self.store.snapshot(online=self.hub.online()))

        if path == "/api/stream" and self.command == "GET":
            return self._stream()

        if path == "/api/nickname" and get:
            self.limiter.check(("nick", self._ip()), 60, 60)
            name = self.store.check_nickname((query.get("name") or [""])[0])
            return self._json(200, {"ok": True, "nickname": name})

        if path == "/api/register" and post:
            self.limiter.check(("register", self._ip()), 20, 3600)
            user, code = self.store.register(self._read_json().get("nickname"))
            return self._json(201, {"code": code, "me": self.store.me(user)})

        if path == "/api/login" and post:
            self.limiter.check(("login", self._ip()), 20, 900)
            body = self._read_json()
            user, code = self.store.login(body.get("nickname"), body.get("code"))
            return self._json(200, {"code": code, "me": self.store.me(user)})

        if path == "/api/me" and get:
            return self._json(200, {"me": self.store.me(self._user())})

        if path == "/api/tick" and post:
            self.limiter.check(("tick", self._ip()), 60, 60)
            me = self.store.tick(self._user())
            self.hub.publish()
            return self._json(200, {"me": me})

        raise StoreError(404, "not_found", "There is nothing at that address.")

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")  # stop nginx buffering the stream
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        q = queue.Queue(maxsize=4)
        self.hub.add(q)
        try:
            self.wfile.write(b"retry: 2000\n\n" + self.hub.message())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=20)
                except queue.Empty:
                    msg = b": ping\n\n"  # keeps proxies from closing an idle stream
                self.wfile.write(msg)
                self.wfile.flush()
        except OSError:
            pass  # the browser closed the tab
        finally:
            self.hub.remove(q)

    # ---------- static files ----------

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        elif path == "/welcome":
            path = "/welcome.html"
        elif path == "/healthz":
            return self._send(200, "text/plain; charset=utf-8", b"ok")
        try:
            target = (PUBLIC / path.lstrip("/\\")).resolve()
        except (OSError, ValueError):
            target = None
        if target is None or PUBLIC not in target.parents or not target.is_file():
            return self._send(404, "text/plain; charset=utf-8", b"Not found")
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        self._send(200, ctype, target.read_bytes())


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    store = Store(DATA_DIR / "db.json", COOLDOWN_MS, load_timezone())
    hub = Hub(store)
    Handler.store = store
    Handler.hub = hub
    threading.Thread(target=hub.run, daemon=True).start()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True

    print("Held Open is running.")
    print(f"  On this computer:  http://localhost:{PORT}")
    lan = lan_address()
    if HOST in ("0.0.0.0", "") and lan:
        print(f"  On your network:   http://{lan}:{PORT}")
    print(f"  Saving to:         {store.path}")
    print(f"  Cooldown:          {COOLDOWN_MS // 1000} seconds   Day resets: {store.tz_label(store.now_ms())} midnight")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
