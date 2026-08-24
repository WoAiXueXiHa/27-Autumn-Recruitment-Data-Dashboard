"""Smoke tests that isolate every write in a temporary data directory."""
from __future__ import annotations

import copy
import json
import shutil
import threading
import urllib.error
import urllib.request
from pathlib import Path

import app


BASE = ""


def get(path: str) -> bytes:
    return urllib.request.urlopen(BASE + path, timeout=5).read()


def post(path: str, payload: bytes, headers: dict | None = None) -> bytes:
    request = urllib.request.Request(BASE + path, data=payload, headers=headers or {}, method="POST")
    return urllib.request.urlopen(request, timeout=5).read()


def post_state(state: dict) -> dict:
    return json.loads(post("/api/state", json.dumps(state, ensure_ascii=False).encode("utf-8"), {"Content-Type": "application/json"}))


def configure_temporary_storage(root: Path) -> None:
    app.DATA = root / "data"
    app.BACKUPS = root / "backups"
    app.LOGS = root / "logs"
    app.STATE_FILE = app.DATA / "state.json"
    app.ensure_dirs()


def run_checks() -> None:
    health = json.loads(get("/api/health"))
    assert health["ok"] is True and health["version"] == app.APP_VERSION == "12"

    source = json.loads(app.HOT100_FILE.read_text(encoding="utf-8"))
    assert len(source) == 100
    assert len({item["number"] for item in source}) == 100
    assert all(item["slug"] and item["title"] and item["difficulty"] and item["category"] for item in source)

    index = get("/").decode("utf-8")
    script = get("/app.js?v=12").decode("utf-8")
    style = get("/styles.css?v=12").decode("utf-8")
    assert "view-reviews" in index and "reviewDialog" in index
    assert "leetcode.cn/problems/${problem.slug}/" in script
    assert "renderReviews" in script and "retrospective-card" in style
    assert "2027 秋招计划 · v12" in index and "data-code-language" in index
    assert "exportHot100" in index and "exportHot100Markdown" in script and "flushPendingSave" in script
    assert 'id="contextSearch"' in index and 'id="topPrimaryAction"' in index
    assert "SEARCH_CONTEXTS" in script and "handleContextSearch" in script and "handleModuleSearch" in script
    assert "handleGlobalSearch" not in script and 'exactNumber ? String(item.number) === exactNumber' in script
    assert '.toolbar .module-search { display: none; }' in style and '.toolbar .module-search { display: flex; }' in style
    topbar_rule = style.split(".topbar {", 1)[1].split("}", 1)[0]
    assert "position: sticky" not in topbar_rule and "top: 0" not in topbar_rule
    assert "renderMarkdown" in script and "highlightGo" in script and "hasMarkdownNotes" in script
    assert "CODE_LANGUAGE_CONFIGS" in script and "highlightMarkup" in script and "highlightJson" in script
    assert "tok-property" in style and "tok-tag" in style and "code-language" in style
    assert "Windows 托盘" in script and "tray-balloon" in app.NOTIFY_SCRIPT.read_text(encoding="utf-8")

    original = json.loads(get("/api/state"))
    assert len(original["problems"]) == 100
    test_state = copy.deepcopy(original)
    test_state.setdefault("interviewReviews", []).append({
        "id": "smoke-review", "company": "回归测试公司", "position": "测试岗位",
        "round": "一面", "result": "通过", "rating": 4,
        "interviewDate": "2026-08-22T10:00", "questions": "测试问题",
        "strengths": "表达清晰", "gaps": "边界条件", "actions": "补充复盘",
    })
    test_state["applications"].append({
        "id": "smoke-job", "company": "回归测试公司", "position": "测试岗位",
        "status": "一面", "priority": "高", "applyDate": "2026-08-22",
    })
    for index, problem in enumerate(test_state["problems"]):
        problem["thoughts"] = ""
        if index < 14:
            problem["thoughts"] = "# 核心思路\n\n- 使用 `map`\n\n```python\n# code comment\nprint('ok')\n```"
    test_state["problems"][0]["mastery"] = 3

    saved = post_state(test_state)
    assert saved["ok"]
    loaded = json.loads(get("/api/state"))
    assert any(item["id"] == "smoke-review" for item in loaded["interviewReviews"])
    assert any(item["id"] == "smoke-job" for item in loaded["applications"])
    assert loaded["problems"][0]["mastery"] == 3
    assert loaded["problems"][0]["thoughts"] == test_state["problems"][0]["thoughts"]

    state_before_export = app.STATE_FILE.read_bytes()
    with urllib.request.urlopen(BASE + "/api/export/hot100.md", timeout=5) as response:
        markdown_payload = response.read()
        disposition = response.headers.get("Content-Disposition", "")
        assert response.headers.get_content_type() == "text/markdown"
    assert app.STATE_FILE.read_bytes() == state_before_export
    markdown = markdown_payload.decode("utf-8")
    assert markdown.startswith("# Hot 100 刷题思路\n")
    assert markdown.count("\n### [") == 14
    assert "## 哈希" in markdown
    assert "#### 核心思路" in markdown and "\n# 核心思路\n" not in markdown
    assert "```python\n# code comment\nprint('ok')\n```" in markdown
    assert "https://leetcode.cn/problems/two-sum/" in markdown
    assert "hot100-notes-" in disposition and disposition.endswith(".md")

    backup = json.loads(get("/api/export/json"))
    assert any(item["id"] == "smoke-review" for item in backup["interviewReviews"])

    xlsx = get("/api/export/xlsx")
    imported_jobs = app.parse_xlsx_bytes(xlsx)
    assert any(item["company"] == "回归测试公司" for item in imported_jobs)
    csv_payload = get("/api/export/csv")
    assert csv_payload.startswith(b"\xef\xbb\xbf")
    assert "回归测试公司" in csv_payload.decode("utf-8-sig")

    sample = app.xlsx_bytes([{"company": "导入测试", "position": "开发", "status": "笔试"}])
    imported = json.loads(post("/api/import", sample, {"X-Filename": "sample.xlsx"}))
    assert imported["count"] == 1 and imported["applications"][0]["company"] == "导入测试"

    try:
        post("/api/state", b"{}", {"Content-Type": "application/json"})
        raise AssertionError("invalid state should be rejected")
    except urllib.error.HTTPError as error:
        assert error.code == 400

    invalid_mastery = copy.deepcopy(test_state)
    invalid_mastery["problems"][0]["mastery"] = 4
    try:
        post_state(invalid_mastery)
        raise AssertionError("invalid mastery should be rejected")
    except urllib.error.HTTPError as error:
        assert error.code == 400


def run() -> None:
    global BASE
    temporary_root = app.ROOT / ".test-tmp" / "runtime"
    shutil.rmtree(temporary_root, ignore_errors=True)
    temporary_root.mkdir(parents=True, exist_ok=True)
    configure_temporary_storage(temporary_root)
    app.STOP_EVENT.clear()
    server = app.ThreadingHTTPServer((app.HOST, 0), app.Handler)
    port = server.server_address[1]
    BASE = f"http://{app.HOST}:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run_checks()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        shutil.rmtree(temporary_root, ignore_errors=True)
    print("All smoke tests passed (temporary data only).")


if __name__ == "__main__":
    run()
