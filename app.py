from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
BACKUPS = ROOT / "backups"
LOGS = ROOT / "logs"
STATE_FILE = DATA / "state.json"
HOT100_FILE = DATA / "hot100.json"
NOTIFY_SCRIPT = ROOT / "notify.ps1"
VERSION_FILE = ROOT / "VERSION"
HOST = "127.0.0.1"
PORT = 8765


def read_app_version() -> str:
    """Read the single public version source and fail fast when it is invalid."""
    try:
        version = VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Unable to read {VERSION_FILE.name}") from exc
    if not version.isdecimal() or int(version) < 1:
        raise RuntimeError(f"{VERSION_FILE.name} must contain one positive integer")
    return version


APP_VERSION = read_app_version()
STATE_LOCK = threading.RLock()
STOP_EVENT = threading.Event()

JOB_FIELDS = [
    "company", "position", "city", "channel", "applyDate", "status",
    "writtenAt", "interviewAt", "priority", "salary", "link", "notes",
]
JOB_HEADERS = [
    "公司", "岗位", "城市", "投递渠道", "投递日期", "当前进度",
    "笔试时间", "面试时间", "优先级", "薪资", "链接", "备注",
]
HEADER_ALIASES = {
    "公司": "company", "公司名称": "company", "company": "company",
    "岗位": "position", "岗位名称": "position", "职位": "position", "position": "position",
    "城市": "city", "工作地点": "city", "city": "city",
    "投递渠道": "channel", "渠道": "channel", "channel": "channel",
    "投递日期": "applyDate", "投递时间": "applyDate", "applydate": "applyDate",
    "当前进度": "status", "进度": "status", "状态": "status", "status": "status",
    "笔试时间": "writtenAt", "笔试日期": "writtenAt", "writtenat": "writtenAt",
    "面试时间": "interviewAt", "面试日期": "interviewAt", "interviewat": "interviewAt",
    "优先级": "priority", "priority": "priority",
    "薪资": "salary", "薪酬": "salary", "salary": "salary",
    "链接": "link", "岗位链接": "link", "link": "link",
    "备注": "notes", "notes": "notes",
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def default_state() -> dict:
    source = json.loads(HOT100_FILE.read_text(encoding="utf-8"))
    problems = []
    for item in source:
        problems.append({
            **item,
            "id": f"lc-{item['number']}",
            "status": "未开始",
            "firstSolvedAt": "",
            "thoughts": "",
            "mistakes": "",
            "mastery": None,
            "reviewCount": 0,
            "nextReviewAt": "",
        })
    return {
        "version": 1,
        "updatedAt": now_iso(),
        "applications": [],
        "interviewReviews": [],
        "problems": problems,
        "settings": {"theme": "auto", "reminders": True, "reminderLeadHours": 24},
        "meta": {"notifications": {}},
    }


def ensure_dirs() -> None:
    for path in (DATA, BACKUPS, LOGS):
        path.mkdir(parents=True, exist_ok=True)


def read_state() -> dict:
    with STATE_LOCK:
        if not STATE_FILE.exists():
            state = default_state()
            write_state(state, backup=False)
            return state
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            damaged = BACKUPS / f"state-damaged-{dt.datetime.now():%Y%m%d-%H%M%S}.json"
            if STATE_FILE.exists():
                damaged.write_bytes(STATE_FILE.read_bytes())
            state = default_state()
            write_state(state, backup=False)
        # Merge newly added official questions without overwriting user notes.
        known = {p.get("number") for p in state.get("problems", [])}
        for problem in default_state()["problems"]:
            if problem["number"] not in known:
                state.setdefault("problems", []).append(problem)
        for problem in state.get("problems", []):
            if problem.get("mastery") not in (None, 1, 2, 3):
                problem["mastery"] = None
            else:
                problem.setdefault("mastery", None)
        state.setdefault("applications", [])
        state.setdefault("interviewReviews", [])
        state.setdefault("settings", {"theme": "auto", "reminders": True, "reminderLeadHours": 24})
        state.setdefault("meta", {}).setdefault("notifications", {})
        return state


def write_state(state: dict, backup: bool = True) -> None:
    with STATE_LOCK:
        ensure_dirs()
        state["updatedAt"] = now_iso()
        if backup and STATE_FILE.exists():
            stamp = dt.datetime.now().strftime("%Y%m%d")
            daily = BACKUPS / f"state-{stamp}.json"
            if not daily.exists():
                daily.write_bytes(STATE_FILE.read_bytes())
        temp = STATE_FILE.with_suffix(".tmp")
        temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(STATE_FILE)


def normalize_header(value: str) -> str:
    return "".join(str(value or "").strip().lower().split())


def rows_to_applications(rows: list[list[str]]) -> list[dict]:
    rows = [[str(cell or "").strip() for cell in row] for row in rows]
    rows = [row for row in rows if any(row)]
    if not rows:
        return []
    header_index = 0
    for i, row in enumerate(rows[:10]):
        recognized = sum(1 for cell in row if normalize_header(cell) in HEADER_ALIASES)
        if recognized >= 2:
            header_index = i
            break
    headers = rows[header_index]
    mapping = [HEADER_ALIASES.get(normalize_header(cell), "") for cell in headers]
    applications = []
    for row_index, row in enumerate(rows[header_index + 1 :], start=1):
        record = {field: "" for field in JOB_FIELDS}
        for i, cell in enumerate(row):
            if i < len(mapping) and mapping[i]:
                record[mapping[i]] = cell
        # Excel often stores dates as days since 1899-12-30.
        for field in ("applyDate", "writtenAt", "interviewAt"):
            raw = record[field]
            try:
                serial = float(raw)
            except (TypeError, ValueError):
                continue
            if 20000 <= serial <= 100000:
                converted = dt.datetime(1899, 12, 30) + dt.timedelta(days=serial)
                record[field] = converted.strftime("%Y-%m-%d" if field == "applyDate" else "%Y-%m-%dT%H:%M")
        if not record["company"] and not record["position"]:
            continue
        record["id"] = f"import-{int(time.time() * 1000)}-{row_index}"
        record["status"] = record["status"] or "待投递"
        record["priority"] = record["priority"] or "中"
        applications.append(record)
    return applications


def parse_csv_bytes(payload: bytes) -> list[dict]:
    text = payload.decode("utf-8-sig", errors="replace")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    return rows_to_applications(list(csv.reader(io.StringIO(text), dialect)))


def column_number(cell_ref: str) -> int:
    letters = "".join(char for char in cell_ref if char.isalpha()).upper()
    value = 0
    for char in letters:
        value = value * 26 + ord(char) - 64
    return max(value - 1, 0)


def parse_xlsx_bytes(payload: bytes) -> list[dict]:
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", ns):
                shared.append("".join(node.text or "" for node in item.iter() if node.tag.endswith("}t")))
        sheet_names = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
        if not sheet_names:
            return []
        root = ET.fromstring(archive.read(sorted(sheet_names)[0]))
        rows: list[list[str]] = []
        for row_node in root.findall(".//m:sheetData/m:row", ns):
            values: list[str] = []
            for cell in row_node.findall("m:c", ns):
                index = column_number(cell.attrib.get("r", "A1"))
                while len(values) <= index:
                    values.append("")
                cell_type = cell.attrib.get("t", "")
                if cell_type == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
                else:
                    node = cell.find("m:v", ns)
                    raw = node.text if node is not None and node.text else ""
                    if cell_type == "s" and raw.isdigit() and int(raw) < len(shared):
                        value = shared[int(raw)]
                    else:
                        value = raw
                values[index] = value
            rows.append(values)
    return rows_to_applications(rows)


def xlsx_bytes(applications: list[dict]) -> bytes:
    rows = [JOB_HEADERS] + [[str(item.get(field, "") or "") for field in JOB_FIELDS] for item in applications]
    sheet_rows = []
    for row_number, row in enumerate(rows, start=1):
        cells = []
        for col_number, value in enumerate(row, start=1):
            n, col = col_number, ""
            while n:
                n, rem = divmod(n - 1, 26)
                col = chr(65 + rem) + col
            cells.append(f'<c r="{col}{row_number}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        sheet_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
    sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' \
        f'<sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '</Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
        archive.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="秋招投递" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '</Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return output.getvalue()


def demote_markdown_headings(markdown: str) -> str:
    """Demote H1-H3 outside fenced code blocks without changing stored notes."""
    output: list[str] = []
    fence_character = ""
    fence_length = 0
    for line in markdown.splitlines(keepends=True):
        fence = re.match(r"^[ ]{0,3}(`{3,}|~{3,})", line)
        if fence:
            marker = fence.group(1)
            if not fence_character:
                fence_character = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_length:
                fence_character = ""
                fence_length = 0
            output.append(line)
            continue
        if not fence_character:
            line = re.sub(r"^(#{1,3})([ \t]+)", lambda match: "#" * (len(match.group(1)) + 3) + match.group(2), line)
        output.append(line)
    return "".join(output)


def markdown_heading(value: object) -> str:
    return " ".join(str(value or "").replace("#", "").split()) or "未分类"


def markdown_link_label(value: object) -> str:
    return str(value or "").replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("\r", " ").replace("\n", " ")


def hot100_markdown(state: dict) -> str:
    """Build a grouped, read-only Markdown view of problems with non-empty thoughts."""
    groups: dict[str, list[dict]] = {}
    for problem in state.get("problems", []):
        thoughts = str(problem.get("thoughts") or "")
        if not thoughts.strip():
            continue
        category = str(problem.get("category") or "未分类")
        groups.setdefault(category, []).append(problem)

    parts = ["# Hot 100 刷题思路", ""]
    for category, problems in groups.items():
        parts.extend([f"## {markdown_heading(category)}", ""])
        for problem in problems:
            number = problem.get("number", "")
            title = markdown_link_label(problem.get("title") or "未命名题目")
            slug = str(problem.get("slug") or "").strip("/")
            problem_url = f"https://leetcode.cn/problems/{slug}/" if slug else "https://leetcode.cn/problemset/"
            difficulty = str(problem.get("difficulty") or "未标注")
            parts.extend([
                f"### [{number}. {title}]({problem_url})",
                "",
                f"> 难度：{difficulty} · 类型：{category}",
                "",
                demote_markdown_headings(str(problem.get("thoughts") or "")),
                "",
                "---",
                "",
            ])
    return "\n".join(parts).rstrip() + "\n"


def send_notification(title: str, message: str) -> dict:
    if not NOTIFY_SCRIPT.exists():
        return {"ok": False, "error": "通知脚本不存在"}
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(NOTIFY_SCRIPT), title, message],
            check=False, timeout=15, creationflags=flags, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            return {"ok": False, "error": result.stderr.strip() or f"通知进程退出码 {result.returncode}"}
        try:
            payload = json.loads(result.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            return {"ok": False, "error": "通知脚本没有返回有效结果"}
        return {"ok": bool(payload.get("ok")), "method": payload.get("method", "unknown")}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "通知显示超时"}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": str(exc)}


def parse_local_datetime(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo:
            parsed = parsed.astimezone().replace(tzinfo=None)
        return parsed
    except ValueError:
        return None


def reminder_loop() -> None:
    while not STOP_EVENT.wait(30):
        try:
            state = read_state()
            settings = state.get("settings", {})
            if not settings.get("reminders", True):
                continue
            current = dt.datetime.now()
            lead = dt.timedelta(hours=max(1, int(settings.get("reminderLeadHours", 24))))
            sent = state.setdefault("meta", {}).setdefault("notifications", {})
            candidates: list[tuple[str, dt.datetime, str, str]] = []
            for job in state.get("applications", []):
                for field, label in (("writtenAt", "笔试"), ("interviewAt", "面试")):
                    moment = parse_local_datetime(job.get(field, ""))
                    if moment:
                        key = f"job:{job.get('id')}:{field}:{moment.isoformat()}"
                        title = f"{label}提醒 · {job.get('company', '待办')}"
                        body = f"{job.get('position', '')}｜{moment:%m月%d日 %H:%M}"
                        candidates.append((key, moment, title, body))
            for problem in state.get("problems", []):
                moment = parse_local_datetime(problem.get("nextReviewAt", ""))
                if moment:
                    key = f"review:{problem.get('number')}:{moment.isoformat()}"
                    title = "Hot 100 复习提醒"
                    body = f"#{problem.get('number')} {problem.get('title')} 已到复习时间"
                    candidates.append((key, moment, title, body))
            changed = False
            for key, moment, title, body in candidates:
                if current - dt.timedelta(days=30) <= moment <= current + lead and key not in sent:
                    send_notification(title, body)
                    sent[key] = now_iso()
                    changed = True
            # Retain only recent notification keys.
            if len(sent) > 500:
                state["meta"]["notifications"] = dict(list(sent.items())[-300:])
                changed = True
            if changed:
                write_state(state, backup=False)
        except Exception as exc:  # background safety net
            with (LOGS / "reminder.log").open("a", encoding="utf-8") as log:
                log.write(f"{now_iso()} {type(exc).__name__}: {exc}\n")


class Handler(SimpleHTTPRequestHandler):
    server_version = "CareerWarRoom/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        ensure_dirs()
        with (LOGS / "server.log").open("a", encoding="utf-8") as log:
            log.write(f"{now_iso()} {self.address_string()} {fmt % args}\n")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        # Ignore conditional cache headers so every local launch receives current files.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def send_bytes(self, payload: bytes, content_type: str, status: int = 200, filename: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if filename:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{filename}")
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, value, status: int = 200) -> None:
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            page = (STATIC / "index.html").read_text(encoding="utf-8")
            page = page.replace("{{APP_VERSION}}", APP_VERSION)
            self.send_bytes(page.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/health":
            self.send_json({"ok": True, "version": APP_VERSION, "time": now_iso()})
            return
        if path == "/api/state":
            self.send_json(read_state())
            return
        if path == "/api/export/json":
            payload = json.dumps(read_state(), ensure_ascii=False, indent=2).encode("utf-8")
            self.send_bytes(payload, "application/json; charset=utf-8", filename="career-board-backup.json")
            return
        if path == "/api/export/hot100.md":
            payload = hot100_markdown(read_state()).encode("utf-8")
            filename = f"hot100-notes-{dt.datetime.now():%Y%m%d}.md"
            self.send_bytes(payload, "text/markdown; charset=utf-8", filename=filename)
            return
        if path == "/api/export/csv":
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(JOB_HEADERS)
            for item in read_state().get("applications", []):
                writer.writerow([item.get(field, "") for field in JOB_FIELDS])
            self.send_bytes(("\ufeff" + output.getvalue()).encode("utf-8"), "text/csv; charset=utf-8", filename="applications.csv")
            return
        if path == "/api/export/xlsx":
            self.send_bytes(xlsx_bytes(read_state().get("applications", [])), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="applications.xlsx")
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length) if length else b""
        if path == "/api/state":
            try:
                incoming = json.loads(payload.decode("utf-8"))
                if not isinstance(incoming, dict) or not isinstance(incoming.get("applications"), list) or not isinstance(incoming.get("problems"), list):
                    raise ValueError("invalid state shape")
                if any(problem.get("mastery") not in (None, 1, 2, 3) for problem in incoming["problems"]):
                    raise ValueError("mastery must be null, 1, 2, or 3")
                write_state(incoming)
                self.send_json({"ok": True, "updatedAt": incoming["updatedAt"]})
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/import":
            filename = self.headers.get("X-Filename", "").lower()
            try:
                if filename.endswith(".xlsx"):
                    applications = parse_xlsx_bytes(payload)
                elif filename.endswith(".csv") or filename.endswith(".tsv"):
                    applications = parse_csv_bytes(payload)
                elif filename.endswith(".json"):
                    imported = json.loads(payload.decode("utf-8-sig"))
                    if isinstance(imported, dict) and "applications" in imported:
                        state = imported
                        write_state(state)
                        self.send_json({"ok": True, "kind": "full", "count": len(state.get("applications", []))})
                        return
                    applications = imported if isinstance(imported, list) else []
                else:
                    raise ValueError("请选择 .xlsx、.csv 或 .json 文件")
                self.send_json({"ok": True, "kind": "applications", "applications": applications, "count": len(applications)})
            except (ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, json.JSONDecodeError) as exc:
                self.send_json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/notify-test":
            result = send_notification("求职作战室", "后台提醒运行正常。愿每一次准备，都更接近理想 Offer。")
            self.send_json(result, HTTPStatus.OK if result.get("ok") else HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/shutdown":
            self.send_json({"ok": True})
            STOP_EVENT.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self.send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)


def server_is_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/health", timeout=1) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return False


def dashboard_url() -> str:
    """Use a unique launch URL so browsers navigate instead of reusing a stale tab."""
    return f"http://{HOST}:{PORT}/?v={APP_VERSION}&launch={time.time_ns()}"


def stop_server() -> int:
    try:
        request = urllib.request.Request(f"http://{HOST}:{PORT}/api/shutdown", data=b"{}", method="POST")
        with urllib.request.urlopen(request, timeout=3):
            pass
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if not server_is_running():
                return 0
            time.sleep(0.1)
        return 1
    except urllib.error.URLError:
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="求职作战室本地服务")
    parser.add_argument("--open", action="store_true", help="启动后打开看板")
    parser.add_argument("--stop", action="store_true", help="停止已运行服务")
    parser.add_argument("--no-reminder", action="store_true", help="不启动后台提醒")
    args = parser.parse_args()
    ensure_dirs()
    if args.stop:
        return stop_server()
    if server_is_running():
        if args.open:
            webbrowser.open(dashboard_url())
        return 0
    read_state()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    if not args.no_reminder:
        threading.Thread(target=reminder_loop, name="reminder", daemon=True).start()
    if args.open:
        threading.Timer(0.7, lambda: webbrowser.open(dashboard_url())).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        STOP_EVENT.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
