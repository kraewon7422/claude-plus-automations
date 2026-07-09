# Claude+ — GPT-style automations for Claude

*[English](#english) · [한국어](#korean)*

Bring GPT-5.5's best "automations" experience into Claude: **scheduled, recurring, and
condition-watching tasks** that run on your own home server and push results to your
phone. It plugs into claude.ai as an MCP connector (so you can create automations just by
chatting) and ships a Chrome extension for a floating control panel and a GPT-style
conversation navigator.

<a name="english"></a>
## English

### What's inside

| GPT feature | How Claude+ reproduces it |
|---|---|
| automations (schedule / repeat / condition-watch) | Self-hosted MCP + REST server (`server/`) — the core of this package |
| background result notifications | ntfy push (self-hosted or ntfy.sh) |
| UI button / panel | Chrome extension — floating ⚡ button on claude.ai (`extension/`) |
| account-aware auto-load | MCP connector (per account) + extension (per browser profile) |
| image generation | already covered by existing image MCPs — nothing to add |
| rich widgets | already covered by Claude's built-in Visualizer |

**Layout:** `server/` (deploy on a home server) + `extension/` (load into Chrome) + `mock/` (light/dark UI mockups).

### How it works

- APScheduler (Asia/Seoul) runs each automation from SQLite as a cron / interval / one-time trigger.
- A run = an Anthropic API call (web search allowed, up to 3 uses) → the result is pushed to ntfy.
- `condition_watch` mode: if the model's reply starts with `SKIP`, the notification is suppressed (GPT's condition-watch behavior).
- Minimum repeat interval is 1 hour (matches GPT's interval policy).

### Quick start

1. **Server** — `cd server`, create a venv, `pip install -r requirements.txt`, copy `.env.example` to `.env` and fill in your keys, then `python main.py` (default port 8787). Expose it (e.g. Cloudflare Tunnel) and, ideally, put it behind access control since the `/mcp` path is unauthenticated (or set a secret `MCP_PATH`).
2. **MCP connector** — in claude.ai → Settings → Connectors → add a custom connector pointing at `https://<your-host>/mcp`. Every new chat can now create automations by request.
3. **Chrome extension** — load `extension/` unpacked at `chrome://extensions`, open claude.ai, click the ⚡ button, and enter your server URL + `CLAUDE_PLUS_TOKEN` in the ⚙ settings.

Full setup details, the schedule cheat-sheet, and the changelog are in the Korean section below.

<a name="korean"></a>
## 한국어

GPT-5.5의 핵심 우위 기능을 Claude 환경에서 재현합니다.

| GPT 기능 | Claude+에서의 구현 |
|---|---|
| automations (예약·반복·조건감시) | 홈서버 MCP+REST 서버 (이 패키지의 핵심) |
| 백그라운드 결과 통지 | ntfy 푸시 (셀프호스트 또는 ntfy.sh) |
| UI 버튼/패널 | 크롬 확장 — claude.ai 우하단 플로팅 ⚡ 버튼 |
| 계정 인식 자동 로드 | MCP 커넥터(계정 단위) + 확장(브라우저 프로필 단위) |
| 이미지 생성 | 기존 Higgsfield MCP로 이미 커버 (추가 작업 불필요) |
| 리치 위젯 | Claude 내장 Visualizer로 이미 커버 |

구성: `server/`(홈서버에 배포) + `extension/`(크롬에 로드)

---

## 1. 서버 설치 (홈서버, 1회)

```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # 값 채우기 (아래 참고)
set -a; source .env; set +a
python main.py              # 기본 포트 8787
```

`.env` 필수값:
- `ANTHROPIC_API_KEY` — 자동화 실행 엔진용 (Fable 5 토큰 비용 절약을 위해 기본 모델은 Sonnet, 더 아끼려면 `ANTHROPIC_MODEL=claude-haiku-4-5-20251001`)
- `CLAUDE_PLUS_TOKEN` — 확장 패널 인증용 긴 랜덤 문자열 (`openssl rand -hex 24`)
- `NTFY_URL` — 알림 받을 ntfy 토픽 URL

상시 구동은 systemd 권장:

```ini
# /etc/systemd/system/claude-plus.service
[Unit]
Description=Claude+ automations server
After=network.target
[Service]
WorkingDirectory=/opt/claude-plus/server
EnvironmentFile=/opt/claude-plus/server/.env
ExecStart=/opt/claude-plus/server/venv/bin/python main.py
Restart=always
[Install]
WantedBy=multi-user.target
```

외부 노출은 Cloudflare Tunnel 권장:
`config.yml`에 `claude-plus.your-domain.com → http://localhost:8787` 라우트 추가.
(MCP 경로가 인증 없이 노출되므로, 기존 MCP들처럼 Cloudflare Access를 걸거나
터널 호스트명 자체를 추측 불가능하게 두는 것을 권장)

## 2. Claude.ai에 MCP 커넥터 등록 (계정 단위, 1회)

claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가:

```
이름: Claude+ Automations
URL : https://claude-plus.your-domain.com/mcp
```

등록 즉시 **모든 새 대화에 자동 로드**됩니다. 이후 대화에서:
- "매일 아침 7시에 반도체 뉴스 브리핑 예약해줘" → `create_automation`
- "타호에 눈 오면 알려줘" → `condition_watch` 모드로 생성
- "내 자동화 뭐 있어?" / "그거 꺼줘" → 조회·토글

## 3. 크롬 확장 설치 (플로팅 버튼)

1. `chrome://extensions` → 개발자 모드 ON → **압축해제된 확장 프로그램 로드** → `extension/` 폴더 선택
2. claude.ai 접속 → 우하단 ⚡ 버튼 클릭 → ⚙ 설정에서
   서버 URL(`https://claude-plus.your-domain.com`)과 `CLAUDE_PLUS_TOKEN` 입력 → 저장
3. 패널에서 목록 조회 / ＋생성 / ▶즉시 실행 / ⏸토글 / 🗑삭제, 최근 실행 결과 열람 가능

## 4. 동작 원리 요약

- APScheduler(Asia/Seoul)가 SQLite의 자동화를 cron/interval/1회 트리거로 실행
- 실행 = Anthropic API 호출(웹서치 최대 3회 허용) → 결과를 ntfy 푸시
- `condition_watch`: 모델 응답이 `SKIP`으로 시작하면 알림 생략 (GPT의 condition_watch 재현)
- 최소 반복 간격 1시간 (GPT와 동일 정책, interval 기준)

## 5. 스케줄 값 치트시트

| 원하는 것 | schedule_type | schedule_value |
|---|---|---|
| 매일 아침 7시 | cron | `0 7 * * *` |
| 평일 18시 | cron | `0 18 * * 1-5` |
| 일요일 22시 | cron | `0 22 * * 0` |
| 3시간마다 | interval_minutes | `180` |
| 특정 시각 1회 | once | `2026-07-10T07:00:00` |

## 6. 대화 네비게이터 (v1.1 신규)

GPT의 우측 대화 이동 바를 재현한 기능입니다. 확장을 로드하면 자동 동작합니다.
- 화면 우측 세로 바에 **사용자 프롬프트마다 틱** 생성 (2개 이상일 때만 표시)
- 틱 클릭 → 해당 프롬프트로 부드럽게 스크롤 / 호버 → 내용 미리보기 툴팁
- 현재 읽는 위치의 틱이 자동 강조 (IntersectionObserver)
- claude.ai DOM 변경 대비 3단 셀렉터 폴백, SPA 라우팅(pushState) 감지 재스캔,
  스트리밍 중 불필요 리빌드 방지(400ms 디바운스 + 개수 비교)
- 라이트/다크는 OS 설정이 아니라 **claude.ai 실제 배경 휘도**로 판정해 동화

## 7. 버전

- **v1 (2026-07-09)**: automations MCP+REST 서버, ntfy 푸시, condition_watch, 크롬 확장 플로팅 패널
- **v1.1 (2026-07-09)**: 대화 네비게이터 바 추가. 서버 결함 4종 수정 —
  ① ntfy 한글 제목 깨짐(RFC 2047 인코딩), ② once 작업 재기동 시 중복 발화(실행 후 자동 비활성화 + 과거 once 등록 차단),
  ③ 잘못된 스케줄 값이 DB에 저장되던 문제(기록 전 선검증), ④ MCP 경로 비밀화 옵션(`MCP_PATH`).
  UI 동화: 패널 폰트 claude.ai 상속, 테마 휘도 기반 다크 판정, 다크 전용 배지 색, reduced-motion 대응.
  `mock/` 폴더에 라이트/다크 검증용 목업 포함 (브라우저로 열어 육안 확인 가능).
- **v1.2 (2026-07-09)**: 3인 관점(개발자·디자이너·시스템) 전수 점검 반영 —
  [개발자] ① 네비게이터 리빌드 시 activeIdx 미초기화로 활성 틱이 사라지던 버그 수정,
  ② MV3 isolated world에서 pushState 패치가 무효라는 점을 반영해 SPA 감지를 URL 변화 감시로 교체.
  [디자이너] ③ 틱 히트 영역 3px→11px 확대(시각은 3px 유지, background-clip), ④ 장문 대화 시 레일 휠 스크롤 허용(스크롤바 숨김).
  [시스템] ⑤ SQLite busy timeout 10s (스케줄러/API 스레드 동시 접근 시 database is locked 방지).
- 로드맵: 실행 이력 페이지, 자동화별 모델/웹서치 개별 설정, 네비게이터 틱의 어시스턴트 답변 병기
