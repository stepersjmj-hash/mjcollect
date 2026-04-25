// background.js — 다중 페이지 자동 순회를 담당하는 service worker

const STATE = {
  running: false,
  cancel: false,
};

// ----- 툴바 아이콘 클릭 → 새창으로 popup.html 열기 -----
const POPUP_URL = chrome.runtime.getURL("popup.html");

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    for (const w of wins) {
      if (w.tabs && w.tabs.some((t) => t.url === POPUP_URL)) {
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
    await chrome.windows.create({
      url: POPUP_URL,
      type: "popup",
      width: 600,
      height: 780,
    });
  } catch (e) {
    console.error("[MJC] open popup window failed", e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "MJC_START") {
    if (STATE.running) {
      sendResponse({ ok: false, error: "이미 실행 중입니다." });
      return true;
    }
    STATE.running = true;
    STATE.cancel = false;
    runCrawl(msg.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
      .finally(() => { STATE.running = false; });
    return true;
  }
  if (msg && msg.type === "MJC_STOP") {
    STATE.cancel = true;
    sendResponse({ ok: true });
    return true;
  }
});

async function runCrawl(payload) {
  const {
    tabId,
    scope,
    rowSelector,
    fields,
    urlPattern,
    pageStart,
    pageEnd,
    pageDelay,
    nextSelector,
    maxPages,
    nextDelay,
    pageclickSelector,
    pageclickStart,
    pageclickEnd,
    pageclickDelay,
  } = payload;

  if (scope === "pattern") {
    return await crawlByPattern(tabId, urlPattern, pageStart, pageEnd, pageDelay, rowSelector, fields);
  } else if (scope === "next") {
    return await crawlByNext(tabId, nextSelector, maxPages, nextDelay, rowSelector, fields);
  } else if (scope === "pageclick") {
    return await crawlByPageClick(tabId, pageclickSelector, pageclickStart, pageclickEnd, pageclickDelay, rowSelector, fields);
  } else {
    const data = await extractOnce(tabId, rowSelector, fields);
    return { rows: data, pages: 1 };
  }
}

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function extractOnce(tabId, rowSelector, fields) {
  await ensureContent(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [rowSelector, fields],
    func: (sel, fs) => (window.__mjc ? window.__mjc.extract(sel, fs) : []),
  });
  return (results && results[0] && results[0].result) || [];
}

async function clickNextOnce(tabId, nextSelector) {
  await ensureContent(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [nextSelector],
    func: (sel) => (window.__mjc ? window.__mjc.clickNext(sel) : false),
  });
  return !!(results && results[0] && results[0].result);
}

function postProgress(progress) {
  chrome.runtime.sendMessage({ type: "MJC_PROGRESS", progress }).catch(() => {});
}

async function crawlByPattern(tabId, pattern, start, end, delayMs, rowSelector, fields) {
  if (!pattern || !pattern.includes("{N}")) {
    throw new Error("URL 패턴에는 {N} 자리표시자가 필요합니다.");
  }
  const s = Math.max(1, parseInt(start, 10) || 1);
  const e = Math.max(s, parseInt(end, 10) || s);
  const total = e - s + 1;
  const all = [];

  for (let n = s; n <= e; n++) {
    if (STATE.cancel) break;
    const url = pattern.replace(/\{N\}/g, String(n));
    postProgress({ stage: "navigate", page: n - s + 1, total, count: all.length, url });
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    if (delayMs > 0) await sleep(delayMs);
    if (STATE.cancel) break;
    postProgress({ stage: "extract", page: n - s + 1, total, count: all.length });
    const rows = await extractOnce(tabId, rowSelector, fields);
    rows.forEach((r) => (r.__page = n));
    all.push(...rows);
    postProgress({ stage: "page-done", page: n - s + 1, total, count: all.length });
  }
  return { rows: all, pages: total, canceled: STATE.cancel };
}

async function crawlByNext(tabId, nextSelector, maxPages, delayMs, rowSelector, fields) {
  if (!nextSelector) throw new Error("다음 버튼 셀렉터를 입력해 주세요.");
  const total = Math.max(1, parseInt(maxPages, 10) || 1);
  const all = [];

  for (let i = 1; i <= total; i++) {
    if (STATE.cancel) break;
    postProgress({ stage: "extract", page: i, total, count: all.length });
    const rows = await extractOnce(tabId, rowSelector, fields);
    rows.forEach((r) => (r.__page = i));
    all.push(...rows);
    postProgress({ stage: "page-done", page: i, total, count: all.length });

    if (i === total || STATE.cancel) break;
    postProgress({ stage: "navigate", page: i + 1, total, count: all.length });
    const ok = await clickNextOnce(tabId, nextSelector);
    if (!ok) {
      postProgress({ stage: "no-next", page: i, total, count: all.length });
      break;
    }
    await Promise.race([waitForTabComplete(tabId, 5000).catch(() => {}), sleep(delayMs || 1000)]);
    if (delayMs > 0) await sleep(delayMs);
  }
  return { rows: all, pages: Math.min(total, all.length > 0 ? total : 0), canceled: STATE.cancel };
}

/**
 * 페이지 번호 클릭 모드 (SPA 페이지네이션용).
 * URL이 안 바뀌고 jQuery/React 등이 AJAX로 페이지를 갈아끼우는 사이트 대응.
 *
 * 동작:
 *   for n in [start..end]:
 *     템플릿의 {N} → n 치환한 셀렉터로 클릭
 *     로딩 대기
 *     추출
 *
 * 주의:
 *  - 첫 페이지(보통 .active)는 클릭이 무시될 수 있음. 그래도 추출은 진행.
 *  - 첫 페이지가 아닌데 클릭이 실패하면(셀렉터에 매칭 없음) 페이지 끝으로 보고 중단.
 */
async function crawlByPageClick(tabId, selectorTpl, start, end, delayMs, rowSelector, fields) {
  if (!selectorTpl || !selectorTpl.includes("{N}")) {
    throw new Error("페이지 셀렉터 템플릿에 {N}이 필요합니다.");
  }
  const s = Math.max(1, parseInt(start, 10) || 1);
  const e = Math.max(s, parseInt(end, 10) || s);
  const total = e - s + 1;
  const all = [];

  for (let n = s; n <= e; n++) {
    if (STATE.cancel) break;
    const sel = selectorTpl.replace(/\{N\}/g, String(n));
    postProgress({ stage: "navigate", page: n - s + 1, total, count: all.length });

    // 첫 반복은 클릭 실패해도 OK(이미 그 페이지에 있을 수 있음).
    // 이후 반복에서 실패하면 페이지 끝으로 간주.
    const clicked = await clickNextOnce(tabId, sel);
    if (!clicked && n !== s) {
      postProgress({ stage: "no-next", page: n - s + 1, total, count: all.length });
      break;
    }

    // 클릭이 성공했거나 첫 페이지면 로딩 대기.
    if (clicked) {
      await Promise.race([waitForTabComplete(tabId, 5000).catch(() => {}), sleep(delayMs || 1500)]);
      if (delayMs > 0) await sleep(delayMs);
    } else {
      // 첫 페이지 클릭 실패: 짧게만 대기
      await sleep(300);
    }

    if (STATE.cancel) break;
    postProgress({ stage: "extract", page: n - s + 1, total, count: all.length });
    const rows = await extractOnce(tabId, rowSelector, fields);
    rows.forEach((r) => (r.__page = n));
    all.push(...rows);
    postProgress({ stage: "page-done", page: n - s + 1, total, count: all.length });
  }
  return { rows: all, pages: total, canceled: STATE.cancel };
}

function waitForTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("페이지 로딩 대기 시간 초과"));
    }, timeout);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
