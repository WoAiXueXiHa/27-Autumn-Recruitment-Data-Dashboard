"""Non-destructive smoke tests for the local dashboard."""
from __future__ import annotations

import copy
import json
import urllib.error
import urllib.request

import app


BASE = "http://127.0.0.1:8765"


def get(path: str) -> bytes:
    return urllib.request.urlopen(BASE + path, timeout=5).read()


def post(path: str, payload: bytes, headers: dict | None = None) -> bytes:
    request = urllib.request.Request(BASE + path, data=payload, headers=headers or {}, method="POST")
    return urllib.request.urlopen(request, timeout=5).read()


def post_state(state: dict) -> dict:
    return json.loads(post("/api/state", json.dumps(state, ensure_ascii=False).encode("utf-8"), {"Content-Type": "application/json"}))


def run() -> None:
    health = json.loads(get("/api/health"))
    assert health["ok"] is True and health["version"] == app.APP_VERSION == "10"

    source = json.loads(app.HOT100_FILE.read_text(encoding="utf-8"))
    assert len(source) == 100
    assert len({item["number"] for item in source}) == 100
    assert all(item["slug"] and item["title"] and item["difficulty"] and item["category"] for item in source)

    index = get("/").decode("utf-8")
    script = get("/app.js?v=10").decode("utf-8")
    style = get("/styles.css?v=10").decode("utf-8")
    assert "view-reviews" in index and "reviewDialog" in index
    assert "leetcode.cn/problems/${problem.slug}/" in script
    assert "renderReviews" in script and "retrospective-card" in style
    assert "2027 秋招计划 · v10" in index and "data-code-language" in index
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
    test_state["problems"][0]["mastery"] = 3
    test_state["problems"][0]["thoughts"] = "# 核心思路\n\n- 使用哈希\n\n```go\nfunc twoSum() {}\n```"
    try:
        saved = post_state(test_state)
        assert saved["ok"]
        loaded = json.loads(get("/api/state"))
        assert any(item["id"] == "smoke-review" for item in loaded["interviewReviews"])
        assert any(item["id"] == "smoke-job" for item in loaded["applications"])
        assert loaded["problems"][0]["mastery"] == 3
        assert loaded["problems"][0]["thoughts"] == test_state["problems"][0]["thoughts"]
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
    finally:
        post_state(original)

    restored = json.loads(get("/api/state"))
    assert not any(item.get("id") == "smoke-review" for item in restored.get("interviewReviews", []))
    assert not any(item.get("id") == "smoke-job" for item in restored["applications"])
    print("All smoke tests passed (data restored).")


if __name__ == "__main__":
    run()
