// content.js — 페이지 컨텍스트에 주입되어 추출/네비게이션 도우미를 등록합니다.
// 동일 페이지에 두 번 이상 주입되어도 안전하도록 idempotent 하게 작성.
(function () {
  if (window.__mjc && window.__mjc.__version === 2) return;

  // mousedown → mouseup → click 시퀀스 + native click() 모두 발사.
  // jQuery 위임 핸들러, React/Vue onclick 핸들러 등 다양한 케이스 호환.
  function fireClick_(el) {
    try {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) { /* ignore */ }
    try { el.click(); } catch (e) { /* ignore */ }
  }

  const api = {
    __version: 2,

    /**
     * 행 셀렉터로 매칭된 각 요소에 대해 필드 셀렉터들로 값을 추출합니다.
     */
    extract(rowSelector, fields) {
      const sel = (rowSelector || "").trim();
      const rows = sel
        ? Array.from(document.querySelectorAll(sel))
        : [document.body];
      const safeFields = Array.isArray(fields) ? fields : [];

      const getValue = (el, f) => {
        if (!el) return "";
        try {
          switch (f.attr) {
            case "text":
              return (el.textContent || "").replace(/\s+/g, " ").trim();
            case "html":
              return el.innerHTML;
            case "href":
              return el.href || el.getAttribute("href") || "";
            case "src":
              return el.src || el.currentSrc || el.getAttribute("src") || "";
            case "value":
              return typeof el.value === "string" ? el.value : "";
            case "custom":
              return el.getAttribute(f.attrName || "") || "";
            default:
              return (el.textContent || "").replace(/\s+/g, " ").trim();
          }
        } catch (e) {
          return "";
        }
      };

      return rows.map((row, idx) => {
        const item = { _idx: idx + 1 };
        if (safeFields.length === 0) {
          item["내용"] = (row.textContent || "").replace(/\s+/g, " ").trim();
          return item;
        }
        for (const f of safeFields) {
          const colName = f.name || f.selector || "필드";
          let target = row;
          if (f.selector && f.selector.trim()) {
            try {
              target = row.querySelector(f.selector);
            } catch (e) {
              target = null;
            }
          }
          item[colName] = getValue(target, f);
        }
        return item;
      });
    },

    /**
     * 페이지네이션 클릭. 다양한 프레임워크 호환:
     *  1) 셀렉터에 매칭된 요소를 직접 클릭
     *  2) 그 요소가 a/button이 아니면, 첫 자손 a/button도 함께 클릭 (jQuery 위임 대응)
     *  3) MouseEvent mousedown→mouseup→click 시퀀스 + native click() 모두 발사
     *
     * 비활성/숨김 처리된 요소는 false 반환 (페이지 끝 신호).
     */
    clickNext(selector) {
      try {
        const el = document.querySelector(selector);
        if (!el) return false;

        // 비활성 검사
        if (el.disabled) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        // 숨김 검사 (display:none, visibility:hidden, .hidden 클래스)
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        // 부모에 disabled/hidden 클래스가 있는 경우도 비활성으로 간주
        let p = el;
        while (p && p !== document.body) {
          if (p.classList && (p.classList.contains("disabled") || p.classList.contains("hidden"))) {
            return false;
          }
          p = p.parentElement;
        }

        try { el.scrollIntoView({ block: "center", behavior: "instant" }); }
        catch (e) { try { el.scrollIntoView(); } catch (e2) {} }

        // 1) 직접 클릭
        fireClick_(el);

        // 2) 자손 a/button도 한 번 더 클릭(이미 a/button이면 스킵)
        const tag = (el.tagName || "").toUpperCase();
        if (tag !== "A" && tag !== "BUTTON") {
          const inner = el.querySelector("a, button");
          if (inner && inner !== el) {
            fireClick_(inner);
          }
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * 셀렉터 매칭 개수 확인용.
     */
    probe(selector) {
      try {
        const list = document.querySelectorAll(selector);
        return { count: list.length, sample: list[0]?.outerHTML?.slice(0, 200) || "" };
      } catch (e) {
        return { count: 0, error: String(e.message || e) };
      }
    },
  };

  window.__mjc = api;
})();
