"""Data and rules for Held Open.

Everything that is saved lives in one JSON file. All access goes through the
Store class, which holds a lock so requests from different threads never
interleave. Times are milliseconds since the Unix epoch.
"""

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import date, datetime, timedelta

# Crockford base32: no I, L, O or U, so keys are easy to read out and retype.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 16
NICKNAME_MIN = 2
NICKNAME_MAX = 20
BOARD_SIZE = 100
FEED_SIZE = 12
ACTIVITY_KEPT = 50


class StoreError(Exception):
    """An error the API reports to the client as JSON."""

    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def format_code(raw):
    return "-".join(raw[i:i + 4] for i in range(0, CODE_LENGTH, 4))


def new_code():
    return format_code("".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH)))


def normalize_code(text):
    """Return the 16 character key hidden in whatever the user typed, or None."""
    s = "".join(ch for ch in str(text).upper() if ch.isalnum())
    s = s.replace("O", "0").replace("I", "1").replace("L", "1")
    if len(s) != CODE_LENGTH or any(ch not in ALPHABET for ch in s):
        return None
    return s


def hash_code(normalized):
    return hashlib.sha256(("heldopen:" + normalized).encode("utf-8")).hexdigest()


def clean_nickname(raw):
    if not isinstance(raw, str):
        raise StoreError(400, "invalid_nickname", "Enter a nickname.")
    name = " ".join(raw.split())
    if len(name) < NICKNAME_MIN or len(name) > NICKNAME_MAX:
        raise StoreError(400, "invalid_nickname",
                         f"Nicknames are {NICKNAME_MIN} to {NICKNAME_MAX} characters.")
    if not (name[0].isalnum() and name[-1].isalnum()):
        raise StoreError(400, "invalid_nickname", "Start and end with a letter or number.")
    if any(not (ch.isalnum() or ch in " ._-") for ch in name):
        raise StoreError(400, "invalid_nickname",
                         "Use letters, numbers, spaces, dots, dashes or underscores.")
    return name


class Store:
    def __init__(self, path, cooldown_ms, tz=None):
        self.path = str(path)
        self.cooldown_ms = cooldown_ms
        self.tz = tz  # None means the server's local time zone
        self.lock = threading.RLock()
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.db = self._load()
        self._by_key = {u["key"]: uid for uid, u in self.db["users"].items()}

    # ---------- persistence ----------

    def _load(self):
        if not os.path.exists(self.path):
            return {"version": 1, "users": {}, "activity": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                db = json.load(f)
            db.setdefault("users", {})
            db.setdefault("activity", [])
            return db
        except (json.JSONDecodeError, OSError) as exc:
            backup = f"{self.path}.corrupt-{int(time.time())}"
            os.replace(self.path, backup)
            print(f"[store] {self.path} could not be read ({exc}). Moved it to {backup} and started fresh.")
            return {"version": 1, "users": {}, "activity": []}

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.db, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    # ---------- time ----------

    @staticmethod
    def now_ms():
        return int(time.time() * 1000)

    def day_key(self, ms):
        return datetime.fromtimestamp(ms / 1000, self.tz).strftime("%Y-%m-%d")

    def next_midnight_ms(self, ms):
        d = datetime.fromtimestamp(ms / 1000, self.tz)
        nxt = (d + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return int(nxt.timestamp() * 1000)

    def tz_label(self, ms):
        d = datetime.fromtimestamp(ms / 1000, self.tz)
        if d.tzinfo is None:  # local time: ask the OS for the zone name
            d = d.astimezone()
        return d.tzname() or "server time"

    # ---------- accounts ----------

    def check_nickname(self, raw):
        name = clean_nickname(raw)
        with self.lock:
            if name.casefold() in self._by_key:
                raise StoreError(409, "nickname_taken", "That nickname is taken. Try another.")
        return name

    def register(self, raw):
        with self.lock:
            name = self.check_nickname(raw)
            uid = "u_" + secrets.token_hex(6)
            code = new_code()
            user = {
                "id": uid,
                "nickname": name,
                "key": name.casefold(),
                "token_hash": hash_code(normalize_code(code)),
                "created_at": self.now_ms(),
                "total": 0,
                "days": {},
                "last_tick_at": 0,
            }
            self.db["users"][uid] = user
            self._by_key[user["key"]] = uid
            self._save()
            return user, code

    def login(self, nickname, code):
        fail = StoreError(401, "bad_credentials", "That nickname and key do not match.")
        if not isinstance(nickname, str):
            raise fail
        norm = normalize_code(code)
        with self.lock:
            uid = self._by_key.get(" ".join(nickname.split()).casefold())
            user = self.db["users"].get(uid) if uid else None
            if not user or not norm or not hmac.compare_digest(hash_code(norm), user["token_hash"]):
                raise fail
            return user, format_code(norm)

    def authenticate(self, bearer):
        """bearer looks like '<user id>:<key>'."""
        uid, _, code = str(bearer).partition(":")
        norm = normalize_code(code)
        with self.lock:
            user = self.db["users"].get(uid)
            if not user or not norm or not hmac.compare_digest(hash_code(norm), user["token_hash"]):
                raise StoreError(401, "unauthorized", "Sign in again to continue.")
            return user

    # ---------- counting ----------

    def _streak(self, days, today):
        d = date.fromisoformat(today)
        if not days.get(d.isoformat()):
            d -= timedelta(days=1)  # today may not have started yet
        n = 0
        while days.get(d.isoformat()):
            n += 1
            d -= timedelta(days=1)
        return n

    def me(self, user):
        with self.lock:
            now = self.now_ms()
            today = self.day_key(now)
            return {
                "id": user["id"],
                "nickname": user["nickname"],
                "day": today,
                "today": user["days"].get(today, 0),
                "total": user["total"],
                "bestDay": max(user["days"].values(), default=0),
                "streak": self._streak(user["days"], today),
                "lastTickAt": user["last_tick_at"],
                "serverTime": now,
                "cooldownMs": self.cooldown_ms,
            }

    def tick(self, user):
        with self.lock:
            now = self.now_ms()
            remaining = min(user["last_tick_at"] + self.cooldown_ms - now, self.cooldown_ms)
            if remaining > 0:
                raise StoreError(429, "cooldown", "One door per minute. Give it a moment.",
                                 retryAfterMs=remaining, lastTickAt=user["last_tick_at"],
                                 serverTime=now, cooldownMs=self.cooldown_ms)
            today = self.day_key(now)
            user["total"] += 1
            user["days"][today] = user["days"].get(today, 0) + 1
            user["last_tick_at"] = now
            self.db["activity"].insert(0, {
                "id": secrets.token_hex(4),
                "userId": user["id"],
                "nickname": user["nickname"],
                "at": now,
            })
            del self.db["activity"][ACTIVITY_KEPT:]
            self._save()
            return self.me(user)

    # ---------- public snapshot ----------

    def snapshot(self, online=0):
        with self.lock:
            now = self.now_ms()
            today = self.day_key(now)
            users = list(self.db["users"].values())

            def order(pair):
                user, count = pair
                return (-count, user["last_tick_at"], user["key"])

            def board(pairs):
                out, prev, rank = [], None, 0
                for i, (user, count) in enumerate(sorted(pairs, key=order)[:BOARD_SIZE]):
                    if count != prev:
                        rank, prev = i + 1, count
                    out.append({
                        "id": user["id"],
                        "nickname": user["nickname"],
                        "rank": rank,
                        "count": count,
                        "today": user["days"].get(today, 0),
                        "total": user["total"],
                        "streak": self._streak(user["days"], today),
                    })
                return out

            today_pairs = [(u, u["days"].get(today, 0)) for u in users]
            today_pairs = [p for p in today_pairs if p[1] > 0]
            all_pairs = [(u, u["total"]) for u in users if u["total"] > 0]

            return {
                "serverTime": now,
                "cooldownMs": self.cooldown_ms,
                "day": today,
                "dayEndsAt": self.next_midnight_ms(now),
                "timezone": self.tz_label(now),
                "online": online,
                "totals": {
                    "today": sum(c for _, c in today_pairs),
                    "players": len(today_pairs),
                    "registered": len(users),
                },
                "today": board(today_pairs),
                "allTime": board(all_pairs),
                "activity": self.db["activity"][:FEED_SIZE],
            }
