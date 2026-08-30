"""Increment the public app version and synchronize user-facing version labels."""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
DOCUMENTS = (ROOT / "README.md", ROOT / "使用说明.md")
VERSION_LINE = re.compile(r"(?m)^> 当前版本：v\d+$")


def main() -> int:
    current = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not current.isdecimal() or int(current) < 1:
        raise SystemExit("VERSION must contain one positive integer")

    next_version = str(int(current) + 1)
    replacement = f"> 当前版本：v{next_version}"
    replacements: list[tuple[Path, str]] = []
    for document in DOCUMENTS:
        text = document.read_text(encoding="utf-8")
        updated, count = VERSION_LINE.subn(replacement, text)
        if count != 1:
            raise SystemExit(f"Expected exactly one current-version marker in {document.name}, found {count}")
        replacements.append((document, updated))

    VERSION_FILE.write_text(next_version + "\n", encoding="utf-8")
    for document, updated in replacements:
        document.write_text(updated, encoding="utf-8")
    print(f"Bumped version: V{current} -> V{next_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
