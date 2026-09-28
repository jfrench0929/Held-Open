#!/bin/sh
# Starts Held Open on macOS or Linux.
cd "$(dirname "$0")" || exit 1
exec python3 server/server.py
