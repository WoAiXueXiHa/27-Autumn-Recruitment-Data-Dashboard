#!/bin/sh
set -u

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$project_root" || exit 1

python_bin=${PYTHON_BIN:-python3}
if ! command -v "$python_bin" >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 was not found.' >&2
  exit 1
fi

if "$python_bin" app.py --stop >/dev/null 2>&1; then
  printf '%s\n' 'Career War Room has stopped.'
else
  printf '%s\n' 'No running Career War Room service was found.'
fi
