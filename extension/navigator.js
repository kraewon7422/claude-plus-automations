/* Claude+ v1.4 — 대화 네비게이터 (구조화 버전)
 * 데이터 출처를 claude.ai 내부 대화 API로 교체:
 *   - 가상 스크롤(off-screen 메시지 언마운트)로 DOM 스크래핑이 개수를 놓치던 문제 해결
 *   - 틱은 항상 '전체 프롬프트 수'만큼 생성, 최대 5개만 보이고 부드럽게 슬라이드
 *   - 클릭 이동: 알려진 Y면 즉시 부드럽게, 미발견 프롬프트는 추정→정렬(snap)
 *   - 활성 표시: 현재 렌더된 메시지를 API 순서에 정렬해 판정(가상 스크롤 대응)
 *   - API 실패 시 렌더된 메시지 기반(구버전 방식)으로 자동 폴백
 */
(() => {
  if (window.__claudePlusNavLoaded) return;
  window.__claudePlusNavLoaded = true;

  // ---------- 레일 상수 (panel.css와 일치)
  const MAX_VISIBLE = 5, TICK_H = 11, GAP = 9, RAIL_PAD = 12;
  const USER_SEL = '[data-testid="user-message"], .font-user-message';
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
  const keyOf = (t) => norm(t).slice(0, 40);

  // ---------- UI 루트
  const rail = document.createElement("div");
  rail.className = "cpn-rail cpn-hidden";
  rail.setAttribute("role", "navigation");
  rail.setAttribute("aria-label", "대화 프롬프트 이동");
  const tip = document.createElement("div");
  tip.className = "cpn-tip cpn-hidden";
  document.body.append(rail, tip);
  rail.style.setProperty("--cpn-gap", GAP + "px");
  rail.style.maxHeight = (MAX_VISIBLE * TICK_H + (MAX_VISIBLE - 1) * GAP + RAIL_PAD) + "px";

  function isDarkTheme() {
    try {
      const p = document.querySelector("main") || document.body;
      const m = (getComputedStyle(p).backgroundColor || "").match(/(\d+(?:\.\d+)?)/g);
      if (!m || m.length < 3) return false;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    } catch (_) { return false; }
  }

  // ---------- 상태
  let orgId = null;
  let prompts = [];          // [{key,text}] — API(또는 렌더) 순서
  const yById = new Map();   // promptIndex -> Y(px, container 기준). 발견되는 대로 채움
  let container = null;
  let activeIdx = -1;
  let scrollHandler = null;

  function findContainer() {
    let e = document.querySelector(USER_SEL);
    while (e && e !== document.body) {
      const s = getComputedStyle(e);
      if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 50) return e;
      e = e.parentElement;
    }
    let best = null;
    document.querySelectorAll("div").forEach((el) => {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 200) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    });
    return best || document.scrollingElement;
  }
  const contTop = () => (container ? container.getBoundingClientRect().top : 0);
  const maxScroll = () => (container ? Math.max(0, container.scrollHeight - container.clientHeight) : 0);
  const yOf = (el) => Math.round(el.getBoundingClientRect().top - contTop() + container.scrollTop);

  // ---------- API로 전체 프롬프트 목록 확보
  async function fetchPrompts() {
    const cid = (location.pathname.split("/chat/")[1] || "").split(/[/?#]/)[0];
    if (!cid) return null;
    if (!orgId) {
      try {
        const orgs = await fetch("/api/organizations", { headers: { accept: "application/json" } }).then((r) => r.json());
        const o = Array.isArray(orgs) ? (orgs.find((x) => x.uuid) || orgs[0]) : orgs;
        orgId = o && o.uuid;
      } catch (_) { /* 아래에서 폴백 */ }
    }
    if (!orgId) return null;
    const url = `/api/organizations/${orgId}/chat_conversations/${cid}` +
      `?tree=True&rendering_mode=messages&render_all_tools=false`;
    const data = await fetch(url, { headers: { accept: "application/json" } }).then((r) => r.json());
    const msgs = data.chat_messages || data.messages || [];
    const humans = msgs.filter((m) => m.sender === "human" || m.role === "user");
    return humans.map((h) => {
      const txt = h.text || (Array.isArray(h.content) ? h.content.map((c) => c.text || "").join(" ") : "") || "";
      return { key: keyOf(txt), text: norm(txt) };
    });
  }

  // ---------- 렌더된 메시지를 API 순서에 정렬 (가상 스크롤 대응) + Y 수집
  function alignRendered() {
    const els = [...document.querySelectorAll(USER_SEL)];
    if (!els.length || !prompts.length) return [];
    const rk = els.map((el) => ({ el, key: keyOf(el.textContent), y: yOf(el) }));
    // 렌더 블록은 연속 구간 → prompts[s..]가 rk에 가장 잘 맞는 s 탐색
    let bestS = -1, bestScore = 0;
    for (let s = 0; s < prompts.length; s++) {
      let score = 0;
      for (let k = 0; k < rk.length && s + k < prompts.length; k++) {
        if (prompts[s + k].key === rk[k].key) score++;
      }
      if (score > bestScore) { bestScore = score; bestS = s; }
    }
    if (bestS < 0) return [];
    const map = [];
    for (let k = 0; k < rk.length && bestS + k < prompts.length; k++) {
      const pi = bestS + k;
      yById.set(pi, rk[k].y);
      map.push({ promptIdx: pi, el: rk[k].el, y: rk[k].y });
    }
    return map;
  }

  // ---------- 틱 렌더
  function renderTicks() {
    rail.classList.toggle("cpn-dark", isDarkTheme());
    rail.innerHTML = "";
    prompts.forEach((p, i) => {
      const tick = document.createElement("button");
      tick.className = "cpn-tick";
      tick.setAttribute("aria-label", `프롬프트 ${i + 1}로 이동`);
      tick.addEventListener("click", () => goTo(i));
      tick.addEventListener("mouseenter", () => {
        const shown = p.text.length > 72 ? p.text.slice(0, 72) + "…" : (p.text || "(빈 메시지)");
        tip.textContent = `${i + 1}. ${shown}`;
        const r = tick.getBoundingClientRect();
        tip.style.top = Math.max(8, r.top + r.height / 2 - 14) + "px";
        tip.style.right = (window.innerWidth - r.left + 10) + "px";
        tip.classList.remove("cpn-hidden");
      });
      tick.addEventListener("mouseleave", () => tip.classList.add("cpn-hidden"));
      rail.append(tick);
    });
    rail.classList.toggle("cpn-hidden", prompts.length < 2);
  }

  // 활성 틱을 레일 중앙으로 부드럽게 → 틱이 위/아래로 매끄럽게 이동
  function scrollRailToActive() {
    const t = rail.children[activeIdx];
    if (!t) return;
    const target = t.offsetTop - (rail.clientHeight - t.offsetHeight) / 2;
    const mx = rail.scrollHeight - rail.clientHeight;
    rail.scrollTo({ top: Math.max(0, Math.min(target, mx)), behavior: "smooth" });
  }
  function setActive(i) {
    if (i === activeIdx || i < 0) return;
    activeIdx = i;
    [...rail.children].forEach((c, k) => c.classList.toggle("cpn-active", k === i));
    scrollRailToActive();
  }

  // ---------- 활성 판정: 뷰포트 상단(15%)에 가장 가까운 렌더 메시지
  function updateActiveFromView() {
    if (!container) return;
    const map = alignRendered();
    if (!map.length) return;
    const line = contTop() + container.clientHeight * 0.15;
    let cur = map[0];
    for (const m of map) {
      if (m.el.getBoundingClientRect().top <= line) cur = m; else break;
    }
    setActive(cur.promptIdx);
  }

  // ---------- 추정 Y (알려진 앵커로 보간, 없으면 비례)
  function estimateY(i) {
    const anchors = [...yById.entries()].map(([idx, y]) => ({ idx, y })).sort((a, b) => a.idx - b.idx);
    if (!anchors.some((a) => a.idx === 0)) anchors.unshift({ idx: 0, y: 0 });
    let lo = null, hi = null;
    for (const a of anchors) { if (a.idx <= i) lo = a; if (a.idx >= i && !hi) hi = a; }
    if (lo && hi && hi.idx !== lo.idx) return lo.y + (hi.y - lo.y) * ((i - lo.idx) / (hi.idx - lo.idx));
    if (lo && lo.idx > 0) return Math.min(maxScroll(), lo.y + (lo.y / lo.idx) * (i - lo.idx));
    return Math.min(maxScroll(), (i / Math.max(1, prompts.length - 1)) * maxScroll());
  }

  // ---------- 특정 프롬프트로 이동 (미발견이면 추정→정렬)
  let seeking = false;
  async function goTo(i) {
    setActive(i);                       // 레일은 즉시 부드럽게 슬라이드
    if (!container) container = findContainer();
    if (yById.has(i)) { container.scrollTo({ top: Math.max(0, yById.get(i) - 12), behavior: "smooth" }); return; }
    if (seeking) return;
    seeking = true;
    try {
      let est = estimateY(i);
      for (let tries = 0; tries < 12; tries++) {
        container.scrollTop = est;                       // 빠른 탐색(즉시 점프)
        await new Promise((r) => setTimeout(r, 150));
        const map = alignRendered();                     // 렌더된 것 정렬 + Y 수집
        if (yById.has(i)) {                              // 목표가 마운트됨 → 정확히 안착
          container.scrollTo({ top: Math.max(0, yById.get(i) - 12), behavior: "smooth" });
          break;
        }
        const screen = container.clientHeight * 0.85;
        // 사용자 메시지가 하나도 안 보이면(=긴 답변 구간에 착지) 프롬프트는 위쪽에 있음 → 위로
        if (!map.length) { est = Math.max(0, est - screen); continue; }
        const lo = map[0].promptIdx, hi = map[map.length - 1].promptIdx;
        if (i < lo) est = Math.max(0, est - screen);
        else est = Math.min(maxScroll(), est + screen);  // i > hi (범위 내면 위 has(i)에서 처리)
      }
    } catch (_) { /* 무시 */ }
    seeking = false;
  }

  // ---------- 로드/재로드
  let reloadTimer = null;
  async function reload() {
    container = findContainer();
    let list = null;
    try { list = await fetchPrompts(); } catch (_) { list = null; }
    if (!list) {
      // 폴백: 렌더된 메시지 기반 (구버전 동작)
      const els = [...document.querySelectorAll(USER_SEL)]
        .map((el) => ({ el, key: keyOf(el.textContent), text: norm(el.textContent), y: yOf(el) }))
        .sort((a, b) => a.y - b.y);
      prompts = els.map((e) => ({ key: e.key, text: e.text }));
      yById.clear();
      els.forEach((e, i) => yById.set(i, e.y));
    } else {
      prompts = list;
      yById.clear();
    }
    activeIdx = -1;
    renderTicks();
    // 스크롤 활성 추적 재등록
    if (scrollHandler && container) container.removeEventListener("scroll", scrollHandler);
    let raf = null;
    scrollHandler = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = null; updateActiveFromView(); }); };
    if (container) container.addEventListener("scroll", scrollHandler, { passive: true });
    updateActiveFromView();
  }
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 500); };

  // ---------- 트리거: URL 변화(대화 전환) + 새 메시지 감지 (디바운스)
  let lastHref = location.href;
  let mutTimer = null;
  function onMutate() {
    if (location.href !== lastHref) { lastHref = location.href; scheduleReload(); return; }
    if (!prompts.length) { scheduleReload(); return; }
    // 목록에 없는 사용자 메시지가 렌더됐다면(새 프롬프트 전송) 재로드
    for (const el of document.querySelectorAll(USER_SEL)) {
      if (!prompts.some((p) => p.key === keyOf(el.textContent))) { scheduleReload(); return; }
    }
    updateActiveFromView();
  }
  const mo = new MutationObserver(() => { clearTimeout(mutTimer); mutTimer = setTimeout(onMutate, 250); });
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", scheduleReload);
  window.addEventListener("resize", () => updateActiveFromView());

  scheduleReload();
})();
