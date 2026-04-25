// content.js — 페이지 컨텍스트에 주입되어 추출/네비게이션 도우미를 등록합니다.
// 동일 페이지에 두 번 이상 주입되어도 안전하도록 idempotent 하게 작성.
(function () {
  if (window.__mjc && window.__mjc.__version === 1) return;

  const api = {
    __version: 1,

    /**
     * 행 셀렉터로 매칭된 각 요소에 대해 필드 셀렉터들로 값을 추출합니다.
     * @param {string} rowSelector
     * @param {Array<{name:string, selector:string, attr:string, attrName?:string}>} fields
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
     * 다음 페이지 버튼 클릭. 성공하면 true.
     */
    clickNext(selector) {
      try {
        const el = document.querySelector(selector);
        if (!el) return false;
        if (el.disabled) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * 단일 셀렉터 후보 다수에서 첫 번째로 매칭되는 요소가 있는지 빠르게 확인.
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
