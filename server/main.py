"""
Claude+ v1 — GPT-5.5 'automations' 기능의 Claude 이식 서버
===========================================================
하나의 프로세스에서 두 인터페이스를 제공한다:

  1) /mcp        : Claude.ai MCP 커넥터용 (Streamable HTTP)
                   → 대화 중 "매일 아침 브리핑 예약해줘" 같은 요청을 Claude가 직접 처리
  2) /api/*      : 크롬 확장(플로팅 패널)용 REST API (Bearer 토큰 인증)

실행 엔진:
  - APScheduler가 SQLite에 저장된 자동화를 스케줄대로 실행
  - 실행 = Anthropic API 호출(웹서치 도구 포함) → 결과를 ntfy로 푸시
  - GPT의 timing_mode 3종을 그대로 재현:
      exact_schedule    : 정확한 시각/주기 (cron)
      flexible_schedule : 하루 중 대략적 시간대 (내부적으로 cron으로 고정)
      condition_watch   : 주기적으로 확인하되, 조건 충족 시에만 알림
                          (모델 응답이 "SKIP"으로 시작하면 알림 생략)
"""

import json
import os
import sqlite3
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastmcp import FastMCP
from pydantic import BaseModel, Field

# ---------------------------------------------------------------- 설정
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
API_TOKEN = os.environ.get("CLAUDE_PLUS_TOKEN", "change-me")
NTFY_URL = os.environ.get("NTFY_URL", "")  # 예: https://ntfy.sh/your-secret-topic
DB_PATH = os.environ.get("CLAUDE_PLUS_DB", "claude_plus.db")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "2000"))
ENABLE_WEB_SEARCH = os.environ.get("ENABLE_WEB_SEARCH", "1") == "1"

_db_lock = threading.Lock()


# ---------------------------------------------------------------- DB
def db():
    # timeout: 스케줄러 스레드와 API 스레드 동시 접근 시 'database is locked' 방지
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS automations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            display_description TEXT DEFAULT '',
            timing_mode TEXT NOT NULL,          -- exact_schedule | flexible_schedule | condition_watch
            schedule_type TEXT NOT NULL,        -- cron | interval_minutes | once
            schedule_value TEXT NOT NULL,       -- cron식 | 분(정수) | ISO8601 시각
            enabled INTEGER DEFAULT 1,
            created_at TEXT,
            last_run_at TEXT,
            last_status TEXT DEFAULT '',        -- notified | skipped | error
            last_result TEXT DEFAULT ''
        )""")
        conn.execute("""
        CREATE TABLE IF NOT EXISTS run_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            automation_id TEXT,
            ran_at TEXT,
            status TEXT,
            result TEXT
        )""")


def row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["enabled"] = bool(d["enabled"])
    return d


# ---------------------------------------------------------------- 실행 엔진
CONDITION_SYSTEM = (
    "You are an automation runner. Execute the user's stored instruction. "
    "If the instruction is a condition-watch (notify only when a condition is met) "
    "and the condition is NOT met, reply with exactly 'SKIP' and nothing else. "
    "Otherwise reply with the notification content only — concise, Korean by default, "
    "no preamble, suitable for a push notification body (may be several sentences)."
)
NORMAL_SYSTEM = (
    "You are an automation runner. Execute the user's stored instruction and reply "
    "with the deliverable content only — concise, Korean by default, no preamble, "
    "suitable for a push notification body."
)


def call_claude(prompt: str, condition_mode: bool) -> str:
    """Anthropic API 호출. 웹서치 도구 허용(최신 정보 브리핑용)."""
    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": MAX_TOKENS,
        "system": CONDITION_SYSTEM if condition_mode else NORMAL_SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    }
    if ENABLE_WEB_SEARCH:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}]
    r = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
        timeout=180,
    )
    r.raise_for_status()
    data = r.json()
    return "\n".join(
        blk.get("text", "") for blk in data.get("content", []) if blk.get("type") == "text"
    ).strip()


def push_ntfy(title: str, message: str):
    if not NTFY_URL:
        return
    try:
        # HTTP 헤더는 ASCII만 안전 → 한글 제목은 RFC 2047(base64)로 인코딩 (ntfy 공식 지원)
        import base64
        if title.isascii():
            header_title = title
        else:
            b64 = base64.b64encode(title.encode("utf-8")).decode("ascii")
            header_title = f"=?UTF-8?B?{b64}?="
        httpx.post(
            NTFY_URL,
            content=message.encode("utf-8"),
            headers={"Title": header_title},
            timeout=15,
        )
    except Exception as e:
        print(f"[ntfy] push failed: {e}")


def run_automation(automation_id: str, manual: bool = False):
    with _db_lock, db() as conn:
        row = conn.execute("SELECT * FROM automations WHERE id=?", (automation_id,)).fetchone()
    if not row or (not row["enabled"] and not manual):
        return
    now = datetime.now(timezone.utc).isoformat()
    condition_mode = row["timing_mode"] == "condition_watch"
    try:
        result = call_claude(row["prompt"], condition_mode)
        if condition_mode and result.upper().startswith("SKIP"):
            status = "skipped"
        else:
            status = "notified"
            push_ntfy(f"⚡ {row['title']}", result)
    except Exception as e:
        status, result = "error", f"{type(e).__name__}: {e}"
    with _db_lock, db() as conn:
        conn.execute(
            "UPDATE automations SET last_run_at=?, last_status=?, last_result=? WHERE id=?",
            (now, status, result[:4000], automation_id),
        )
        # 1회성(once) 작업은 실행 후 자동 비활성화 → 서버 재시작 시 중복 발화 방지
        if row["schedule_type"] == "once" and not manual:
            conn.execute("UPDATE automations SET enabled=0 WHERE id=?", (automation_id,))
        conn.execute(
            "INSERT INTO run_log (automation_id, ran_at, status, result) VALUES (?,?,?,?)",
            (automation_id, now, status, result[:4000]),
        )
    print(f"[run] {row['title']} → {status}")


# ---------------------------------------------------------------- 스케줄러
scheduler = BackgroundScheduler(timezone="Asia/Seoul")


def build_trigger(schedule_type: str, schedule_value: str):
    if schedule_type == "cron":
        return CronTrigger.from_crontab(schedule_value, timezone="Asia/Seoul")
    if schedule_type == "interval_minutes":
        minutes = max(60, int(schedule_value))  # GPT와 동일: 최소 1시간 간격
        return IntervalTrigger(minutes=minutes)
    if schedule_type == "once":
        return DateTrigger(run_date=datetime.fromisoformat(schedule_value))
    raise ValueError(f"unknown schedule_type: {schedule_type}")


def register_job(a: dict):
    job_id = f"auto-{a['id']}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    if a["enabled"]:
        scheduler.add_job(
            run_automation, build_trigger(a["schedule_type"], a["schedule_value"]),
            args=[a["id"]], id=job_id, misfire_grace_time=3600,
        )


def load_all_jobs():
    with db() as conn:
        rows = [row_to_dict(r) for r in conn.execute("SELECT * FROM automations").fetchall()]
    for a in rows:
        try:
            # 과거 시각의 once 작업은 재등록하지 않고 비활성화 (재기동 중복 발화 방지)
            if a["schedule_type"] == "once":
                when = datetime.fromisoformat(a["schedule_value"])
                if when.tzinfo is None:
                    from zoneinfo import ZoneInfo
                    when = when.replace(tzinfo=ZoneInfo("Asia/Seoul"))
                if when <= datetime.now(when.tzinfo):
                    with _db_lock, db() as conn:
                        conn.execute("UPDATE automations SET enabled=0 WHERE id=?", (a["id"],))
                    continue
            register_job(a)
        except Exception as e:
            print(f"[scheduler] failed to register {a['id']}: {e}")


# ---------------------------------------------------------------- 공용 CRUD
class AutomationIn(BaseModel):
    title: str = Field(description="짧은 카드 제목 (2~5단어)")
    prompt: str = Field(description="미래 실행 시 모델에게 보낼 명령문 (명령형으로)")
    display_description: str = Field(default="", description="사용자에게 보여줄 한 줄 설명")
    timing_mode: str = Field(
        default="exact_schedule",
        description="exact_schedule | flexible_schedule | condition_watch",
    )
    schedule_type: str = Field(description="cron | interval_minutes | once")
    schedule_value: str = Field(
        description="cron이면 '0 7 * * *' 형식, interval_minutes면 분 숫자(최소 60), once면 ISO8601 시각"
    )


def create_automation_core(data: AutomationIn) -> dict:
    a = data.model_dump()
    a.update(
        id=uuid.uuid4().hex[:12],
        enabled=1,
        created_at=datetime.now(timezone.utc).isoformat(),
        last_run_at=None, last_status="", last_result="",
    )
    build_trigger(a["schedule_type"], a["schedule_value"])  # 유효성 검사
    with _db_lock, db() as conn:
        conn.execute(
            """INSERT INTO automations
               (id,title,prompt,display_description,timing_mode,schedule_type,
                schedule_value,enabled,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (a["id"], a["title"], a["prompt"], a["display_description"], a["timing_mode"],
             a["schedule_type"], a["schedule_value"], 1, a["created_at"]),
        )
    a["enabled"] = True
    register_job(a)
    return a


def list_automations_core() -> list[dict]:
    with db() as conn:
        return [row_to_dict(r) for r in
                conn.execute("SELECT * FROM automations ORDER BY created_at DESC").fetchall()]


def update_automation_core(automation_id: str, patch: dict) -> dict:
    allowed = {"title", "prompt", "display_description", "timing_mode",
               "schedule_type", "schedule_value", "enabled"}
    patch = {k: v for k, v in patch.items() if k in allowed and v is not None}
    if not patch:
        raise ValueError("no valid fields to update")
    if "enabled" in patch:
        patch["enabled"] = 1 if patch["enabled"] else 0
    # 스케줄 필드 변경 시: DB 기록 전에 트리거 유효성 선검증 (깨진 스케줄 저장 방지)
    if "schedule_type" in patch or "schedule_value" in patch:
        with db() as conn:
            cur_row = conn.execute("SELECT schedule_type, schedule_value FROM automations WHERE id=?",
                                   (automation_id,)).fetchone()
        if not cur_row:
            raise ValueError(f"automation not found: {automation_id}")
        build_trigger(patch.get("schedule_type", cur_row["schedule_type"]),
                      patch.get("schedule_value", cur_row["schedule_value"]))
    sets = ", ".join(f"{k}=?" for k in patch)
    with _db_lock, db() as conn:
        cur = conn.execute(f"UPDATE automations SET {sets} WHERE id=?",
                           (*patch.values(), automation_id))
        if cur.rowcount == 0:
            raise ValueError(f"automation not found: {automation_id}")
        row = conn.execute("SELECT * FROM automations WHERE id=?", (automation_id,)).fetchone()
    a = row_to_dict(row)
    register_job(a)
    return a


def delete_automation_core(automation_id: str):
    job = scheduler.get_job(f"auto-{automation_id}")
    if job:
        job.remove()
    with _db_lock, db() as conn:
        cur = conn.execute("DELETE FROM automations WHERE id=?", (automation_id,))
        if cur.rowcount == 0:
            raise ValueError(f"automation not found: {automation_id}")


# ---------------------------------------------------------------- MCP 인터페이스
mcp = FastMCP(
    "claude-plus",
    instructions=(
        "GPT 스타일 automations를 Claude에 제공하는 서버. 사용자가 '~할 때 알려줘', "
        "'매일/매주 ~해줘', '~시간 뒤에 리마인드' 같은 미래·반복·조건부 작업을 요청하면 "
        "이 도구들로 자동화를 생성한다. 결과는 사용자의 ntfy 앱으로 푸시된다. "
        "최소 실행 간격은 1시간이다."
    ),
)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False})
def create_automation(
    title: str, prompt: str, schedule_type: str, schedule_value: str,
    timing_mode: str = "exact_schedule", display_description: str = "",
) -> str:
    """새 자동화(예약/반복/조건감시 작업)를 생성한다.

    Args:
        title: 짧은 카드 제목 (예: '아침 시장 브리핑')
        prompt: 실행 시점에 모델에게 보낼 명령문. condition_watch면 '조건 미충족 시 알리지 말 것'을 명시.
        schedule_type: 'cron' | 'interval_minutes' | 'once'
        schedule_value: cron='분 시 일 월 요일'(예 '0 7 * * *'), interval_minutes='분 숫자(최소 60)', once=ISO8601
        timing_mode: 'exact_schedule' | 'flexible_schedule' | 'condition_watch'
        display_description: 사용자용 한 줄 설명
    """
    try:
        a = create_automation_core(AutomationIn(
            title=title, prompt=prompt, display_description=display_description,
            timing_mode=timing_mode, schedule_type=schedule_type, schedule_value=schedule_value,
        ))
        return json.dumps({"ok": True, "automation": a}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e),
                           "hint": "cron 형식은 '0 7 * * *'처럼 5필드, once는 '2026-07-10T07:00:00'"},
                          ensure_ascii=False)


@mcp.tool(annotations={"readOnlyHint": True})
def list_automations() -> str:
    """등록된 모든 자동화와 최근 실행 상태를 조회한다."""
    return json.dumps(list_automations_core(), ensure_ascii=False)


@mcp.tool(annotations={"readOnlyHint": False})
def update_automation(
    automation_id: str, title: str | None = None, prompt: str | None = None,
    schedule_type: str | None = None, schedule_value: str | None = None,
    timing_mode: str | None = None, enabled: bool | None = None,
    display_description: str | None = None,
) -> str:
    """기존 자동화를 수정하거나 켜고 끈다(enabled)."""
    try:
        a = update_automation_core(automation_id, {
            "title": title, "prompt": prompt, "schedule_type": schedule_type,
            "schedule_value": schedule_value, "timing_mode": timing_mode,
            "enabled": enabled, "display_description": display_description,
        })
        return json.dumps({"ok": True, "automation": a}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
def delete_automation(automation_id: str) -> str:
    """자동화를 영구 삭제한다."""
    try:
        delete_automation_core(automation_id)
        return json.dumps({"ok": True}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)


@mcp.tool(annotations={"readOnlyHint": False})
def run_automation_now(automation_id: str) -> str:
    """자동화를 즉시 1회 실행하고 결과를 반환한다(테스트용)."""
    run_automation(automation_id, manual=True)
    with db() as conn:
        row = conn.execute("SELECT title,last_status,last_result FROM automations WHERE id=?",
                           (automation_id,)).fetchone()
    if not row:
        return json.dumps({"ok": False, "error": "not found"}, ensure_ascii=False)
    return json.dumps({"ok": True, "status": row["last_status"],
                       "result": row["last_result"]}, ensure_ascii=False)


# ---------------------------------------------------------------- REST (확장 패널용)
def check_token(authorization: str = Header(default="")):
    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")


# MCP 경로 비밀화: 예) MCP_PATH=/x7Kp2...긴랜덤.../mcp  (무인증 엔드포인트 노출 완화)
MCP_PATH = os.environ.get("MCP_PATH", "/mcp")
mcp_app = mcp.http_app(path=MCP_PATH)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    load_all_jobs()
    scheduler.start()
    async with mcp_app.lifespan(app):
        yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Claude+ v1", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://claude.ai", "https://www.claude.ai"],
    allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "jobs": len(scheduler.get_jobs()),
            "ntfy": bool(NTFY_URL), "model": ANTHROPIC_MODEL}


@app.get("/api/automations", dependencies=[Depends(check_token)])
def api_list():
    return list_automations_core()


@app.post("/api/automations", dependencies=[Depends(check_token)])
def api_create(data: AutomationIn):
    try:
        return create_automation_core(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/automations/{automation_id}", dependencies=[Depends(check_token)])
def api_update(automation_id: str, patch: dict):
    try:
        return update_automation_core(automation_id, patch)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/automations/{automation_id}", dependencies=[Depends(check_token)])
def api_delete(automation_id: str):
    try:
        delete_automation_core(automation_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/automations/{automation_id}/run", dependencies=[Depends(check_token)])
def api_run(automation_id: str):
    run_automation(automation_id, manual=True)
    with db() as conn:
        row = conn.execute("SELECT last_status,last_result FROM automations WHERE id=?",
                           (automation_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    return {"status": row["last_status"], "result": row["last_result"]}


# MCP 앱은 REST 라우트 정의 이후 마지막에 마운트 (경로 우선순위 보장)
app.mount("/", mcp_app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8787")))
