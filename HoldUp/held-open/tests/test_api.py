"""End-to-end checks against a real server process.

Run from the project folder:  python tests/test_api.py -v
"""

import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "server.py"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, data_dir, cooldown="2"):
        self.port = free_port()
        env = dict(os.environ, PORT=str(self.port), HOST="127.0.0.1",
                   DATA_DIR=str(data_dir), COOLDOWN_SECONDS=cooldown)
        self.proc = subprocess.Popen([sys.executable, str(SERVER)], env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                self.request("GET", "/healthz")
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def request(self, method, path, body=None, auth=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = f"Bearer {auth}"
        conn.request(method, path, body=data, headers=headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = raw
        return res.status, payload

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = Server(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.tmp.cleanup()

    def register(self, name):
        status, body = self.server.request("POST", "/api/register", {"nickname": name})
        self.assertEqual(status, 201, body)
        return body["me"]["id"], body["code"], f"{body['me']['id']}:{body['code']}"

    def test_pages_are_served(self):
        for path in ("/", "/welcome.html", "/welcome", "/css/styles.css", "/js/home.js"):
            status, _ = self.server.request("GET", path)
            self.assertEqual(status, 200, path)
        self.assertEqual(self.server.request("GET", "/../server/store.py")[0], 404)
        self.assertEqual(self.server.request("GET", "/nope")[0], 404)

    def test_nickname_rules(self):
        for bad in ("a", "x" * 21, "-abc", "hi!", "  ", "<b>x</b>"):
            status, _ = self.server.request("POST", "/api/register", {"nickname": bad})
            self.assertEqual(status, 400, bad)
        self.register("Rule Tester")
        status, body = self.server.request("POST", "/api/register", {"nickname": "  rule   TESTER "})
        self.assertEqual(status, 409, body)
        status, _ = self.server.request("GET", "/api/nickname?name=Brand%20New")
        self.assertEqual(status, 200)
        status, _ = self.server.request("GET", "/api/nickname?name=rule%20tester")
        self.assertEqual(status, 409)

    def test_tick_cooldown_and_login(self):
        uid, code, auth = self.register("Ticker")
        status, body = self.server.request("POST", "/api/tick", auth=auth)
        self.assertEqual((status, body["me"]["today"], body["me"]["total"]), (200, 1, 1))
        status, body = self.server.request("POST", "/api/tick", auth=auth)
        self.assertEqual(status, 429)
        self.assertTrue(0 < body["retryAfterMs"] <= 2000)
        time.sleep(2.1)
        status, body = self.server.request("POST", "/api/tick", auth=auth)
        self.assertEqual((status, body["me"]["today"]), (200, 2))

        # a second device signs in with the nickname and key, and sees the same numbers
        status, body = self.server.request("POST", "/api/login", {"nickname": "ticker", "code": code.lower().replace("-", " ")})
        self.assertEqual(status, 200, body)
        status, body = self.server.request("GET", "/api/me", auth=f"{uid}:{body['code']}")
        self.assertEqual((status, body["me"]["total"]), (200, 2))

        status, _ = self.server.request("POST", "/api/login", {"nickname": "ticker", "code": "0000-0000-0000-0000"})
        self.assertEqual(status, 401)
        self.assertEqual(self.server.request("POST", "/api/tick", auth=f"{uid}:0000-0000-0000-0000")[0], 401)
        self.assertEqual(self.server.request("POST", "/api/tick")[0], 401)

    def test_leaderboard_and_live_stream(self):
        _, _, a = self.register("Alpha")
        _, _, b = self.register("Bravo")

        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=8)
        conn.request("GET", "/api/stream")
        res = conn.getresponse()
        self.assertEqual(res.status, 200)
        self.assertIn("text/event-stream", res.getheader("Content-Type"))

        def next_state():
            while True:
                line = res.fp.readline().decode()
                if line.startswith("data: "):
                    return json.loads(line[6:])

        first = next_state()
        before = first["totals"]["today"]

        self.server.request("POST", "/api/tick", auth=a)
        pushed = next_state()  # arrives without any polling
        self.assertEqual(pushed["totals"]["today"], before + 1)
        self.assertEqual(pushed["activity"][0]["nickname"], "Alpha")
        self.assertGreaterEqual(pushed["online"], 1)

        self.server.request("POST", "/api/tick", auth=b)
        pushed = next_state()
        names = [r["nickname"] for r in pushed["today"]]
        self.assertLess(names.index("Alpha"), names.index("Bravo"))  # tie goes to whoever got there first
        self.assertEqual(pushed["today"][0]["rank"], 1)
        conn.close()


class PersistenceTests(unittest.TestCase):
    def test_data_survives_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            s1 = Server(tmp)
            status, body = s1.request("POST", "/api/register", {"nickname": "Keeper"})
            auth = f"{body['me']['id']}:{body['code']}"
            s1.request("POST", "/api/tick", auth=auth)
            s1.stop()

            s2 = Server(tmp)
            status, body = s2.request("GET", "/api/me", auth=auth)
            self.assertEqual((status, body["me"]["total"], body["me"]["today"]), (200, 1, 1))
            self.assertEqual(s2.request("POST", "/api/tick", auth=auth)[0], 429)  # cooldown survives too
            s2.stop()


if __name__ == "__main__":
    unittest.main()
