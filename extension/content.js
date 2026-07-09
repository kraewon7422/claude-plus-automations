/* Claude+ v1 — claude.ai 플로팅 자동화 패널
 * 우하단 ⚡ 버튼 → 패널 오픈 → 홈서버 REST API로 자동화 CRUD
 * 서버 URL/토큰은 첫 사용 시 ⚙ 설정에서 입력 (chrome.storage.sync 저장)
 */
(() => {
  if (window.__claudePlusLoaded) return;
  window.__claudePlusLoaded = true;

  let cfg = { serverUrl: "", token: "" };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------- 설정 로드/저장
  function loadCfg() {
    return new Promise((res) =>
      chrome.storage.sync.get(["serverUrl", "token"], (v) => {
        cfg.serverUrl = (v.serverUrl || "").replace(/\/+$/, "");
        cfg.token = v.token || "";
        res(cfg);
      }));
  }
  function saveCfg() {
    chrome.storage.sync.set({ serverUrl: cfg.serverUrl, token: cfg.token });
  }

  // ---------------- API
  async function api(path, opts = {}) {
    if (!cfg.serverUrl) throw new Error("서버 URL 미설정 — ⚙에서 설정하세요");
    const r = await fetch(cfg.serverUrl + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.token,
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
    return r.json();
  }

  // ---------------- UI 골격
  const fab = el("button", "cp-fab", "⚡");
  fab.title = "Claude+ 자동화";
  const panel = el("div", "cp-panel cp-hidden");
  panel.innerHTML = `
    <div class="cp-head">
      <span class="cp-title">⚡ Claude+ 자동화</span>
      <span class="cp-head-btns">
        <button class="cp-ib" data-act="new" title="새 자동화">＋</button>
        <button class="cp-ib" data-act="refresh" title="새로고침">↻</button>
        <button class="cp-ib" data-act="settings" title="설정">⚙</button>
        <button class="cp-ib" data-act="close" title="닫기">✕</button>
      </span>
    </div>
    <div class="cp-body"><div class="cp-empty">불러오는 중…</div></div>
  `;
  document.body.append(fab, panel);
  const body = $(".cp-body", panel);

  // claude.ai 실제 테마(배경 휘도) 판정 → 패널 다크모드 동화
  function isDarkTheme() {
    try {
      const probe = document.querySelector("main") || document.body;
      const m = getComputedStyle(probe).backgroundColor.match(/(\d+(?:\.\d+)?)/g);
      if (!m || m.length < 3) return false;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    } catch (_) { return false; }
  }

  fab.addEventListener("click", async () => {
    panel.classList.toggle("cp-hidden");
    if (!panel.classList.contains("cp-hidden")) {
      panel.classList.toggle("cp-dark", isDarkTheme());
      await loadCfg();
      cfg.serverUrl ? renderList() : renderSettings();
    }
  });
  $(".cp-head", panel).addEventListener("click", (e) => {
    const act = e.target?.dataset?.act;
    if (act === "close") panel.classList.add("cp-hidden");
    if (act === "refresh") renderList();
    if (act === "settings") renderSettings();
    if (act === "new") renderForm();
  });

  // ---------------- 화면: 설정
  function renderSettings() {
    body.innerHTML = `
      <div class="cp-form">
        <label>서버 URL <input id="cp-url" placeholder="https://claude-plus.your-domain.com" value="${esc(cfg.serverUrl)}"></label>
        <label>API 토큰 <input id="cp-token" type="password" value="${esc(cfg.token)}"></label>
        <div class="cp-row">
          <button class="cp-btn cp-primary" id="cp-save">저장 후 연결 테스트</button>
        </div>
        <div class="cp-note" id="cp-msg"></div>
      </div>`;
    $("#cp-save", body).onclick = async () => {
      cfg.serverUrl = $("#cp-url", body).value.trim().replace(/\/+$/, "");
      cfg.token = $("#cp-token", body).value.trim();
      saveCfg();
      const msg = $("#cp-msg", body);
      msg.textContent = "테스트 중…";
      try {
        await api("/api/automations");
        msg.textContent = "✅ 연결 성공";
        setTimeout(renderList, 600);
      } catch (e) {
        msg.textContent = "❌ " + e.message;
      }
    };
  }

  // ---------------- 화면: 목록
  const MODE_KO = {
    exact_schedule: "정시",
    flexible_schedule: "유연",
    condition_watch: "조건감시",
  };
  function schedDesc(a) {
    if (a.schedule_type === "cron") return `cron ${a.schedule_value}`;
    if (a.schedule_type === "interval_minutes") return `${a.schedule_value}분마다`;
    return `1회 ${a.schedule_value.replace("T", " ").slice(0, 16)}`;
  }
  async function renderList() {
    body.innerHTML = `<div class="cp-empty">불러오는 중…</div>`;
    let items;
    try {
      items = await api("/api/automations");
    } catch (e) {
      body.innerHTML = `<div class="cp-empty">❌ ${esc(e.message)}</div>`;
      return;
    }
    if (!items.length) {
      body.innerHTML = `<div class="cp-empty">자동화가 없습니다.<br>＋ 버튼 또는 Claude 대화에서<br>"매일 아침 7시에 ~ 브리핑해줘"라고 말해보세요.</div>`;
      return;
    }
    body.innerHTML = "";
    for (const a of items) {
      const card = el("div", "cp-card" + (a.enabled ? "" : " cp-off"));
      const st = a.last_status
        ? `<span class="cp-st cp-st-${a.last_status}">${
            { notified: "알림됨", skipped: "조건미충족", error: "오류" }[a.last_status] || a.last_status
          }</span>` : "";
      card.innerHTML = `
        <div class="cp-card-top">
          <b>${esc(a.title)}</b>
          <span class="cp-badges">
            <span class="cp-badge">${MODE_KO[a.timing_mode] || a.timing_mode}</span>${st}
          </span>
        </div>
        <div class="cp-sub">${esc(schedDesc(a))}${
          a.display_description ? " · " + esc(a.display_description) : ""}</div>
        ${a.last_result
          ? `<details class="cp-result"><summary>최근 결과 (${esc(
              (a.last_run_at || "").replace("T", " ").slice(5, 16))})</summary><pre>${esc(
              a.last_result)}</pre></details>` : ""}
        <div class="cp-row">
          <button class="cp-btn" data-a="toggle">${a.enabled ? "⏸ 끄기" : "▶ 켜기"}</button>
          <button class="cp-btn" data-a="run">⚡ 지금 실행</button>
          <button class="cp-btn cp-danger" data-a="del">🗑</button>
        </div>`;
      card.querySelector('[data-a="toggle"]').onclick = async () => {
        await api(`/api/automations/${a.id}`, {
          method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }),
        }).catch(alertErr);
        renderList();
      };
      card.querySelector('[data-a="run"]').onclick = async (ev) => {
        ev.target.textContent = "실행 중…";
        await api(`/api/automations/${a.id}/run`, { method: "POST" }).catch(alertErr);
        renderList();
      };
      card.querySelector('[data-a="del"]').onclick = async () => {
        if (!confirm(`'${a.title}' 자동화를 삭제할까요?`)) return;
        await api(`/api/automations/${a.id}`, { method: "DELETE" }).catch(alertErr);
        renderList();
      };
      body.append(card);
    }
  }
  const alertErr = (e) => alert("Claude+ 오류: " + e.message);

  // ---------------- 화면: 새 자동화
  function renderForm() {
    body.innerHTML = `
      <div class="cp-form">
        <label>제목 <input id="f-title" placeholder="아침 시장 브리핑"></label>
        <label>실행 명령 <textarea id="f-prompt" rows="3"
          placeholder="어제 밤사이 반도체·V2X 관련 주요 뉴스를 3줄로 요약해줘"></textarea></label>
        <label>모드
          <select id="f-mode">
            <option value="exact_schedule">정시 실행</option>
            <option value="flexible_schedule">유연 실행</option>
            <option value="condition_watch">조건 감시 (충족 시에만 알림)</option>
          </select></label>
        <label>스케줄 유형
          <select id="f-stype">
            <option value="cron">cron (반복)</option>
            <option value="interval_minutes">N분마다 (최소 60)</option>
            <option value="once">1회 (특정 시각)</option>
          </select></label>
        <label>스케줄 값 <input id="f-sval" placeholder="0 7 * * *"></label>
        <div class="cp-note">예) 매일 7시 = <code>0 7 * * *</code> · 평일 18시 = <code>0 18 * * 1-5</code> · 1회 = <code>2026-07-10T07:00:00</code></div>
        <div class="cp-row">
          <button class="cp-btn cp-primary" id="f-save">생성</button>
          <button class="cp-btn" id="f-cancel">취소</button>
        </div>
      </div>`;
    $("#f-cancel", body).onclick = renderList;
    $("#f-save", body).onclick = async () => {
      try {
        await api("/api/automations", {
          method: "POST",
          body: JSON.stringify({
            title: $("#f-title", body).value.trim(),
            prompt: $("#f-prompt", body).value.trim(),
            timing_mode: $("#f-mode", body).value,
            schedule_type: $("#f-stype", body).value,
            schedule_value: $("#f-sval", body).value.trim(),
          }),
        });
        renderList();
      } catch (e) { alertErr(e); }
    };
  }

  loadCfg();
})();
