// background.js — 다중 페이지 자동 순회를 담당하는 service worker

const STATE = {
  running: false,
  cancel: false,
};

// ----- 툴바 아이콘 클릭 → 새창으로 popup.html 열기 -----
const POPUP_URL = chrome.runtime.getURL("popup.html");

chrome.action.onClicked.addListener(async (tab) => {
  try {
    // 이미 열린 popup 창이 있으면 포커스만
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    for (const w of wins) {
      if (w.tabs && w.tabs.some((t) => t.url === POPUP_URL)) {
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
    // 새창 생성
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
      .finally(() => {
        STATE.running = false;
      });
    return true; // async response
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
  } = payload;

  if (scope === "pattern") {
    return await crawlByPattern(tabId, urlPattern, pageStart, pageEnd, pageDelay, rowSelector, fields);
  } else if (scope === "next") {
    return await crawlByNext(tabId, nextSelector, maxPages, nextDelay, rowSelector, fields);
  } else {
    // current tab
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
  // 팝업이 열려 있을 때만 수신됨. 닫혀 있으면 그냥 무시.
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
    // 페이지 로딩(또는 SPA 렌더) 대기. URL 변경이 동반되면 onUpdated complete를 짧게 기다리고,
    // SPA 라면 그냥 delay만 적용.
    await Promise.race([waitForTabComplete(tabId, 5000).catch(() => {}), sleep(delayMs || 1000)]);
    if (delayMs > 0) await sleep(delayMs);
  }
  return { rows: all, pages: Math.min(total, all.length > 0 ? total : 0), canceled: STATE.cancel };
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
