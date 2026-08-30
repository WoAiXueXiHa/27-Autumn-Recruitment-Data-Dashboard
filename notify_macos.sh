#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  printf '%s\n' 'Usage: notify_macos.sh <title> <message>' >&2
  exit 2
fi

if ! command -v osascript >/dev/null 2>&1; then
  printf '%s\n' 'osascript is not available on this system.' >&2
  exit 1
fi

osascript - "$1" "$2" <<'APPLESCRIPT'
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT

printf '%s\n' '{"ok":true,"method":"macos-notification-center"}'
