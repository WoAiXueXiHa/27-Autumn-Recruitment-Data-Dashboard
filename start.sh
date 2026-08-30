#!/bin/sh
set -u

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$project_root" || exit 1

python_bin=${PYTHON_BIN:-python3}
if ! command -v "$python_bin" >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 was not found. Install Python 3.10 or later and try again.' >&2
  exit 1
fi

if ! "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  printf '%s\n' 'Python 3.10 or later is required.' >&2
  exit 1
fi

"$python_bin" app.py --stop >/dev/null 2>&1 || true
mkdir -p logs
nohup "$python_bin" app.py >> logs/launcher.log 2>&1 &
server_pid=$!

attempt=0
while [ "$attempt" -lt 30 ]; do
  dashboard_url=$("$python_bin" -c 'import json, time, urllib.request; health=json.load(urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=0.5)); assert health.get("ok"); print("http://127.0.0.1:8765/?v={}&launch={}".format(health.get("version", "latest"), time.time_ns()))' 2>/dev/null) && {
    "$python_bin" -c 'import sys, webbrowser; webbrowser.open(sys.argv[1])' "$dashboard_url"
    printf '%s\n' 'Career War Room is running at http://127.0.0.1:8765/'
    exit 0
  }
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.2
  attempt=$((attempt + 1))
done

printf '%s\n' 'Career War Room did not start. Check logs/launcher.log for details.' >&2
exit 1
