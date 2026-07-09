/* Claude+ v1.1 — 대화 네비게이터 (GPT 스타일 우측 바)
 * - 사용자 프롬프트마다 틱(가로 바) 생성, 클릭 시 해당 메시지로 스크롤
 * - 호버 시 프롬프트 미리보기 툴팁, 현재 화면 위치의 틱 강조
 * - claude.ai DOM 변경에 대비한 다중 셀렉터 폴백 + SPA 라우팅 대응
 * - claude.ai의 실제 배경색을 읽어 라이트/다크 자동 동화
 */
(() => {
  if (window.__claudePlusNavLoaded) return;
  window.__claudePlusNavLoaded = true;

  // ---------- claude.ai 사용자 메시지 탐지 (우선순위 폴백 체인)
  const USER_MSG_SELECTORS = [
    '[data-testid="user-message"]',
    '.font-user-message',
    'div[class*="user-message"]',
  ];
  function findUserMessages() {
    for (const sel of USER_MSG_SELECTORS) {
      try {
        const els = [...document.querySelectorAll(sel)];
        if (els.length) return els;
      } catch (_) { /* invalid selector 방어 */ }
    }
    return [];
  }

  // ---------- 테마 동화: claude.ai 실제 배경 밝기로 다크 판정
  function isDarkTheme() {
    try {
      const probe = document.querySelector("main") || document.body;
      const bg = getComputedStyle(probe).backgroundColor
        || getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/(\d+(?:\.\d+)?)/g);
      if (!m || m.length < 3) return false;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128; // 상대 휘도
    } catch (_) { return false; }
  }

  // ---------- 루트/틱 구성
  const rail = document.createElement("div");
  rail.className = "cpn-rail cpn-hidden";
  rail.setAttribute("role", "navigation");
  rail.setAttribute("aria-label", "대화 프롬프트 이동");
  const tip = document.createElement("div");
  tip.className = "cpn-tip cpn-hidden";
  document.body.append(rail, tip);

  let msgs = [];           // 현재 추적 중인 사용자 메시지 요소들
  let io = null;           // IntersectionObserver
  let activeIdx = -1;

  const preview = (elm) => {
    const t = (elm.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 72 ? t.slice(0, 72) + "…" : t || "(빈 메시지)";
  };

  function setActive(idx) {
    if (idx === activeIdx) return;
    activeIdx = idx;
    [...rail.children].forEach((c, i) => c.classList.toggle("cpn-active", i === idx));
  }

  function build() {
    const found = findUserMessages();
    // 사용자 메시지 2개 미만이거나 대화 화면이 아니면 숨김
    if (found.length < 2) {
      rail.classList.add("cpn-hidden");
      tip.classList.add("cpn-hidden");
      msgs = found;
      return;
    }
    // 개수 동일 + 동일 노드면 재구축 생략 (스트리밍 중 불필요 리빌드 방지)
    if (found.length === msgs.length &&
        found[0] === msgs[0] && found[found.length - 1] === msgs[msgs.length - 1]) {
      rail.classList.remove("cpn-hidden");
      return;
    }
    msgs = found;
    activeIdx = -1; // 리빌드 시 활성 인덱스 초기화 (미초기화 시 setActive 조기 반환 버그)
    rail.classList.toggle("cpn-dark", isDarkTheme());
    rail.innerHTML = "";
    if (io) io.disconnect();

    // 틱 개수에 따른 간격 자동 축소 (틱 히트영역 11px 기준, 최대 68vh 안에 수용)
    const maxPx = window.innerHeight * 0.68;
    const gap = Math.max(2, Math.min(14, Math.floor(maxPx / msgs.length) - 11));
    rail.style.setProperty("--cpn-gap", gap + "px");

    msgs.forEach((m, i) => {
      const tick = document.createElement("button");
      tick.className = "cpn-tick";
      tick.setAttribute("aria-label", `프롬프트 ${i + 1}로 이동`);
      tick.addEventListener("click", () => {
        try {
          m.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (_) {
          m.scrollIntoView(); // smooth 미지원 방어
        }
        setActive(i);
      });
      tick.addEventListener("mouseenter", () => {
        tip.textContent = `${i + 1}. ${preview(m)}`;
        const r = tick.getBoundingClientRect();
        tip.style.top = Math.max(8, r.top + r.height / 2 - 14) + "px";
        tip.style.right = (window.innerWidth - r.left + 10) + "px";
        tip.classList.remove("cpn-hidden");
      });
      tick.addEventListener("mouseleave", () => tip.classList.add("cpn-hidden"));
      rail.append(tick);
    });
    rail.classList.remove("cpn-hidden");

    // 현재 위치 강조: 화면 상단 40% 지점에 걸린 사용자 메시지를 활성 처리
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(msgs.indexOf(e.target));
        }
      },
      { rootMargin: "-10% 0px -60% 0px", threshold: 0 }
    );
    msgs.forEach((m) => io.observe(m));
  }

  // ---------- 리빌드 트리거: DOM 변화(디바운스) + SPA 라우팅 + 리사이즈
  let debounceTimer = null;
  let lastHref = location.href;
  const scheduleBuild = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(build, 400);
  };

  // 주의: MV3 콘텐츠 스크립트는 isolated world라 페이지(React 라우터)의
  // history.pushState 호출을 패치로 가로챌 수 없다.
  // → MutationObserver 콜백에서 URL 변화를 직접 감지해 강제 재구축한다.
  const mo = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      msgs = []; // 대화 전환 → 유령 틱 방지 위해 강제 재구축
    }
    scheduleBuild();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("popstate", () => { msgs = []; scheduleBuild(); });
  window.addEventListener("resize", scheduleBuild);

  scheduleBuild();
})();
