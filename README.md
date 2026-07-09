# Claude+ — GPT-style automations for Claude

Give Claude the "automations" experience from GPT: **scheduled, recurring, and
condition-watching tasks** that run on your own computer and push the results to your
phone. It has two independent parts:

- A **Chrome extension** that adds a floating ⚡ control panel *and* a GPT-style
  conversation-navigator bar to claude.ai.
- A small **server** you run on an always-on computer that actually executes the
  automations (calls Claude on a schedule and sends you a phone notification).

The two parts are independent — **the navigator bar works on its own with zero setup.**

*[English](#english) · [한국어](#korean)*

<a name="english"></a>
## English

### ⚡ Just want the navigation bar? (2 minutes · no server · free)

The extension includes a **conversation navigator** — a strip of ticks on the right edge
of claude.ai, one per prompt, so you can jump around a long chat. This needs **no server,
no account, no payment**:

1. Get the files: green **Code → Download ZIP** at the top of this page, then unzip
   (or `git clone` if you know how).
2. In Chrome, open **`chrome://extensions`**.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and pick the **`extension`** folder from the files you unzipped.
5. Open claude.ai. In any chat with 2+ messages you'll see the ticks on the right —
   click one to jump, hover to preview.

That's the entire navigator. A ⚡ button also appears, but it stays idle until you set up
the server (below).

> **To keep it working forever:** leave Developer mode ON, and if Chrome ever shows a
> *"Disable developer-mode extensions"* popup, click **Keep**. Don't move or delete the
> `extension` folder. Loaded extensions survive Chrome restarts and reboots automatically.

---

### The full automations feature

#### What you need before you start — read this honestly

- ✅ **An always-on computer** (Windows / Mac / Linux). Scheduled tasks only fire while
  the server runs, so a laptop that sleeps or gets shut down won't work reliably.
- ✅ **Python 3.10 or newer** installed.
- 💳 **A paid Anthropic API key** from [console.anthropic.com](https://console.anthropic.com).
  **This costs money and is *separate* from your Claude Pro/Max subscription.** You add a
  small prepaid balance (about $5 minimum); with the `haiku` model each automation run
  costs a fraction of a cent, so $5 lasts a very long time.
- 📱 **The [ntfy](https://ntfy.sh) app** on your phone (free) to receive the notifications.
- 🌐 **A way to put the server on the internet over HTTPS.** claude.ai is a public website
  and browsers **block it from talking to a plain `localhost` server**, so you need a free
  tunnel (Tailscale or Cloudflare — see step 2).
- ⏱️ **About 30–60 minutes** and some comfort following technical steps.

If any of that is a dealbreaker, just use the **navigator bar** above — that part is free
and needs none of this.

#### 1. Run the server

**Windows (PowerShell):**
```powershell
cd server
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env        # then open .env in Notepad and fill in the values (below)

# load .env into the session and start the server:
Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
venv\Scripts\python.exe main.py
```

**Mac / Linux:**
```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # then edit .env (below)
set -a; source .env; set +a
python main.py                 # default port 8787
```

**Fill in `.env`:**
- `ANTHROPIC_API_KEY` — your paid key from console.anthropic.com
- `ANTHROPIC_MODEL` — leave as `claude-haiku-4-5-20251001` (cheap, fine for notifications)
- `CLAUDE_PLUS_TOKEN` — any long random string; it's the password the extension uses.
  Make one with `openssl rand -hex 24`, or just type a long random string.
- `NTFY_URL` — e.g. `https://ntfy.sh/some-unguessable-name`. Subscribe to that same
  topic name in the ntfy app on your phone. (Leave blank to run without phone pushes.)

**Check it's alive:** open `http://localhost:8787/api/health` — you should see
`{"ok":true, ...}`.

**Keep it running after you close the terminal / reboot:**
- **Windows:** add a **Task Scheduler** task set to run **at logon**. Important: launch it
  with `python.exe`, **not** `pythonw.exe` — the server's logging crashes without a
  console window (use a hidden-window launcher instead if you don't want to see it).
- **Mac / Linux:** use a `systemd` service (example in the Korean section below) or `pm2`.

#### 2. Put the server on the internet (HTTPS)

Because claude.ai can't reach `localhost`, give the server a public HTTPS address. Two
free options:

- **Tailscale Funnel** — install [Tailscale](https://tailscale.com), then:
  ```
  tailscale funnel --bg --set-path /my-long-random-path http://127.0.0.1:8787
  ```
  Your address becomes `https://<your-machine>.ts.net/my-long-random-path`. Use a long,
  random path and **treat the whole URL like a password** — the `/mcp` endpoint has no
  login of its own.
- **Cloudflare Tunnel** — if you own a domain, route
  `claude-plus.your-domain.com → http://localhost:8787`, ideally behind Cloudflare Access.

**Test from your phone's browser:** `https://<your-address>/api/health` should return
`{"ok":true, ...}`.

#### 3. Register it in claude.ai (create automations by chatting)

claude.ai → **Settings → Connectors → Add custom connector**:
- Name: `Claude+ Automations`
- URL: `https://<your-address>/mcp`

Now, in any chat, you can say things like *"remind me every morning at 7 to check the
news"* and Claude creates the automation for you.

#### 4. Connect the extension's ⚡ panel

Load the extension (see the navigator quick-start above). Click the ⚡ button → ⚙ Settings,
and enter your **server address** (`https://<your-address>`) and the **`CLAUDE_PLUS_TOKEN`**
you chose. The panel lets you create, run-now, pause, and delete automations and read
recent results.

### Using it

- **By chatting** (needs step 3): *"every weekday at 6pm, summarize AI news,"* *"tell me if
  it snows in Tahoe,"* *"what automations do I have? turn that one off."*
- **By panel** (needs step 4): ⚡ → ＋ create · ▶ run now · ⏸ pause · 🗑 delete.

### Schedule cheat sheet

| You want | schedule_type | schedule_value |
|---|---|---|
| Every day, 7am | `cron` | `0 7 * * *` |
| Weekdays, 6pm | `cron` | `0 18 * * 1-5` |
| Every 3 hours | `interval_minutes` | `180` |
| Once, at a set time | `once` | `2026-07-10T07:00:00` |

Minimum repeat interval is 1 hour.

### Troubleshooting

- **Extension not showing?** Developer mode must be ON; the `extension` folder must not
  have moved; refresh claude.ai with **F5**.
- **"Disable developer-mode extensions" popup:** click **Keep**.
- **Panel spins forever / "can't connect":** you pointed it at `http://localhost` —
  browsers block that from claude.ai. Use your public **HTTPS** address from step 2.
- **Windows: server starts then disappears with no window:** you launched `pythonw.exe`;
  use `python.exe` (the logging needs a console).
- **Automations error when they run:** almost always a missing/invalid `ANTHROPIC_API_KEY`,
  no API balance, or a wrong `ANTHROPIC_MODEL`.

### What's inside / how it works

| GPT feature | How Claude+ reproduces it |
|---|---|
| automations (schedule / repeat / condition-watch) | Self-hosted MCP + REST server (`server/`) |
| background result notifications | ntfy push (self-hosted or ntfy.sh) |
| UI button / panel | Chrome extension — floating ⚡ button on claude.ai (`extension/`) |
| conversation navigator | Chrome extension — right-edge tick bar (no server needed) |

- APScheduler runs each automation from a small SQLite file as a cron / interval /
  one-time trigger.
- A run = an Anthropic API call (web search allowed, up to 3 uses) → result pushed to ntfy.
- `condition_watch` mode: if the model's reply starts with `SKIP`, the notification is
  suppressed (GPT's condition-watch behavior).

**Layout:** `server/` (run on an always-on computer) · `extension/` (load into Chrome) ·
`mock/` (light/dark UI mockups you can open in a browser).

<a name="korean"></a>
## 한국어

GPT-5.5의 automations 경험을 Claude로 옮겨오는 패키지입니다. 두 부분으로 구성되며,
**네비게이터 바는 서버 없이 단독으로 동작**합니다.

### ⚡ 네비게이터 바만 쓰려면 (2분 · 서버 불필요 · 무료)

확장에는 claude.ai 우측에 프롬프트마다 틱을 만들어 대화를 빠르게 오가는 **대화 네비게이터**가
들어 있습니다. 서버·계정·결제가 전혀 필요 없습니다.

1. 이 페이지 상단 **Code → Download ZIP** 으로 내려받아 압축 해제 (또는 `git clone`).
2. Chrome에서 **`chrome://extensions`** 열기.
3. **개발자 모드** 켜기(우상단 토글).
4. **압축해제된 확장 프로그램 로드** → **`extension`** 폴더 선택.
5. claude.ai 접속 → 메시지 2개 이상인 대화에서 우측 틱이 보입니다.

> **계속 쓰려면:** 개발자 모드를 켠 상태로 두고, Chrome이 *"개발자 모드 확장 사용 중지"* 팝업을
> 띄우면 **유지**를 누르세요. `extension` 폴더를 옮기거나 지우지 마세요. 한 번 로드하면 재부팅
> 후에도 자동으로 다시 로드됩니다.

### 시작하기 전에 필요한 것 (자동화 기능)

- ✅ **항상 켜져 있는 컴퓨터** — 서버가 돌아가는 동안에만 예약 작업이 실행됩니다(잠자는 노트북 ✗).
- ✅ **Python 3.10 이상**.
- 💳 **유료 Anthropic API 키** ([console.anthropic.com](https://console.anthropic.com)). **Claude
  Pro/Max 구독과 별개이며 사용량만큼 과금**됩니다(최소 ~$5 선불; `haiku` 모델은 실행당 1센트 미만).
- 📱 **[ntfy](https://ntfy.sh) 앱**(무료) — 알림 수신용.
- 🌐 **서버를 HTTPS로 인터넷에 노출하는 수단** — claude.ai는 `localhost`에 직접 접근할 수 없어서
  무료 터널(Tailscale 또는 Cloudflare)이 필요합니다(아래 참고).

부담되면 위의 **네비게이터 바**만 쓰세요 — 그 부분은 무료·무설정입니다.

### 1. 서버 설치

**Windows (PowerShell):**
```powershell
cd server
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
Get-Content .env | ForEach-Object { if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
venv\Scripts\python.exe main.py
```

**Mac / Linux:**
```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a; source .env; set +a
python main.py              # 기본 포트 8787
```

`.env` 필수값:
- `ANTHROPIC_API_KEY` — 유료 키
- `ANTHROPIC_MODEL` — `claude-haiku-4-5-20251001` 권장(저렴)
- `CLAUDE_PLUS_TOKEN` — 확장 패널 인증용 긴 랜덤 문자열 (`openssl rand -hex 24`)
- `NTFY_URL` — 예: `https://ntfy.sh/추측불가한-토픽명` (앱에서 같은 토픽 구독; 비우면 푸시 없음)

상태 확인: 브라우저에서 `http://localhost:8787/api/health` → `{"ok":true, ...}`.

**재부팅 후 자동 실행:**
- **Windows:** 작업 스케줄러에 **로그온 시 실행** 작업 등록. 단, `pythonw.exe`가 아니라
  `python.exe`로 실행하세요(콘솔이 없으면 uvicorn 로깅이 죽습니다). 창을 숨기려면 숨김 실행
  래퍼(VBS 등)를 사용하세요.
- **Mac / Linux:** `systemd` 서비스 권장:
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

### 2. 인터넷 노출 (HTTPS)

claude.ai는 `localhost`에 접근할 수 없으므로 공개 HTTPS 주소가 필요합니다.

- **Tailscale Funnel** (쉬움): `tailscale funnel --bg --set-path /긴-랜덤-경로 http://127.0.0.1:8787`
  → `https://<기기>.ts.net/긴-랜덤-경로`. **URL 전체를 비밀번호처럼** 취급하세요(`/mcp`는 무인증).
- **Cloudflare Tunnel**: 도메인이 있으면 `claude-plus.your-domain.com → http://localhost:8787`
  라우트 추가(가능하면 Cloudflare Access 적용).

휴대폰 브라우저에서 `https://<주소>/api/health` → `{"ok":true, ...}` 확인.

### 3. claude.ai에 MCP 커넥터 등록 (대화로 자동화 만들기)

claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가:
```
이름: Claude+ Automations
URL : https://<주소>/mcp
```
이후 대화에서: "매일 아침 7시에 뉴스 브리핑 예약해줘", "타호에 눈 오면 알려줘",
"내 자동화 뭐 있어? 그거 꺼줘".

### 4. 크롬 확장 패널 연결

⚡ 버튼 → ⚙ 설정에서 **서버 주소**(`https://<주소>`)와 **`CLAUDE_PLUS_TOKEN`** 입력.
패널에서 목록/＋생성/▶즉시 실행/⏸토글/🗑삭제, 최근 결과 열람 가능.

### 5. 스케줄 값 치트시트

| 원하는 것 | schedule_type | schedule_value |
|---|---|---|
| 매일 아침 7시 | cron | `0 7 * * *` |
| 평일 18시 | cron | `0 18 * * 1-5` |
| 3시간마다 | interval_minutes | `180` |
| 특정 시각 1회 | once | `2026-07-10T07:00:00` |

최소 반복 간격 1시간.

### 6. 문제 해결

- **확장이 안 보임:** 개발자 모드 ON, `extension` 폴더 이동 금지, claude.ai에서 F5.
- **"개발자 모드 확장 사용 중지" 팝업:** **유지** 클릭.
- **패널이 계속 로딩/연결 실패:** `http://localhost`를 넣었기 때문 — 2단계의 공개 HTTPS 주소 사용.
- **Windows에서 서버가 창 없이 사라짐:** `pythonw.exe` 대신 `python.exe` 사용.
- **실행 시 오류:** 대개 `ANTHROPIC_API_KEY` 누락/무효, API 잔액 부족, `ANTHROPIC_MODEL` 오타.

### 7. 버전

- **v1 (2026-07-09)**: automations MCP+REST 서버, ntfy 푸시, condition_watch, 크롬 확장 플로팅 패널.
- **v1.1**: 대화 네비게이터 추가. 서버 결함 4종 수정(한글 제목 인코딩, once 중복 발화 차단,
  스케줄 선검증, `MCP_PATH` 비밀화). UI 테마 동화.
- **v1.2**: 개발자·디자이너·시스템 관점 점검(activeIdx 초기화 버그, URL 기반 SPA 감지, 틱 히트영역
  확대, 레일 휠 스크롤, SQLite busy timeout).
- **v1.3**: ⚡ 버튼을 화면 코너로 이동. 네비게이터 레일을 최대 5틱 고정·부드러운 슬라이딩으로 개선
  (틱 얇아짐/개수 깜빡임 제거).
- **v1.4**: 네비게이터를 **claude.ai 대화 API 기반**으로 재작성 — 가상 스크롤로 화면에서 언로드된
  프롬프트까지 전부 정확히 표시하고, 클릭 시 언로드된 프롬프트로도 위치 추정→정렬로 이동. 활성 틱은
  렌더된 메시지를 API 순서에 정렬해 판정.
