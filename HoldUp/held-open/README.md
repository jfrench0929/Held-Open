# Held Open

A live tick counter for doors you hold for other people. Everyone picks a nickname, taps once per door, and
sees a leaderboard that updates on every open screen the moment somebody taps.

- New visitors land on a sign-up page, pick a nickname, and get a recovery key before entering the home screen.
- Counts, nicknames and cooldowns are saved on the server in `data/db.json`, so they survive restarts and work from any device.
- Each person can tap once per minute. The server enforces this, so refreshing or editing the page does not get around it.
- The leaderboard has a **Today** tab (resets at midnight) and an **All time** tab.

## Run it

You need Python 3.9 or newer. There is nothing to install.

**Windows:** double-click `start.bat`.
**macOS or Linux:** run `./start.sh`.
**Anywhere:** `python server/server.py`

Then open http://localhost:3000. The console also prints an address on your network (for example
`http://192.168.1.20:3000`). Open that on your phone while it is on the same Wi-Fi to see two devices update together.

## Making the link work any time

The site only works while the server is running. To get a link that works from any device at any time of day,
host the `held-open` folder on a service that runs Python and keeps a persistent disk (Render, Railway, Fly.io,
or any small VPS). The included `Procfile` (`web: python server/server.py`) is what most of these expect.

When you host it:

- Set `DATA_DIR` to the path of the persistent disk. Without one, the data resets every time the service redeploys.
- Set `TRUST_PROXY=1` so the rate limiter sees each visitor's real address.
- Run a single instance. Live updates are held in that process's memory.
- Use HTTPS. Hosting services do this for you.

## Settings

Set these as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Hosting services usually set this for you. |
| `HOST` | `0.0.0.0` | Address to bind. Use `127.0.0.1` to allow only this computer. |
| `DATA_DIR` | `./data` | Folder where `db.json` is saved. |
| `COOLDOWN_SECONDS` | `60` | Wait between taps for each person. |
| `LEADERBOARD_TZ` | server's time zone | Time zone that decides when "today" ends, such as `America/Chicago`. On Windows this needs `pip install tzdata`. |
| `TRUST_PROXY` | off | Set to `1` behind a proxy that sets `X-Forwarded-For`. |

## How sign-in works

There are no passwords. Signing up creates a nickname and a random recovery key. The browser remembers both, so
that device stays signed in. To use the same account on another phone or computer, choose **Sign in with your key**
on the welcome page and enter the nickname and key. People can find the key any time from the account menu (the
nickname in the top right). Anyone who has the key can act as that person, and the server cannot recover a lost one.

## What is in the folder

```
held-open/
  start.bat, start.sh, Procfile   ways to start the server
  server/
    server.py                     web server, JSON API, live stream
    store.py                      rules and saving (nicknames, cooldown, days, streaks)
  public/
    welcome.html                  sign-up page (first-time visitors)
    index.html                    home screen: counter, leaderboard, live feed
    css/styles.css                all styling, light and dark themes
    js/guard.js                   sends visitors to the right page before it paints
    js/common.js                  shared helpers (API calls, live stream, door icons)
    js/welcome.js                 sign-up and sign-in
    js/home.js                    counter, cooldown ring, leaderboard, feed
    assets/favicon.svg
  data/                           db.json is created here when the first person signs up
  tests/test_api.py               checks the API, live updates and saving
```

## How live updates work

Each open page holds a connection to `/api/stream` (Server-Sent Events). When someone taps, the server saves the
count and pushes a fresh leaderboard to every connected page within a fraction of a second. Pages reconnect on
their own if the connection drops.

## Tests

```
python tests/test_api.py -v
```

These start a real server on a spare port with a temporary data folder and cover sign-up rules, the cooldown,
signing in from a second device, live pushes, and that data survives a restart.

## Backing up or resetting

Stop the server and copy `data/db.json` to back it up. Delete it to start over with an empty leaderboard.
