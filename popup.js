// popup.js — UI, 프리셋 관리, 크롤링 트리거, 결과 표시 및 내보내기, 구글시트 연동(쓰기/읽기)

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const STORAGE_KEYS = {
  presets: "mjc_presets_v1",
  lastConfig: "mjc_last_config_v1",
  lastResult: "mjc_last_result_v1",
  sheetConfig: "mjc_sheet_config_v1",
};

let lastResult = []; // 표시 중인 결과

// ----- 초기화 -----
document.addEventListener("DOMContentLoaded", async () => {
  bindUI();
  await loadLastConfig();
  await refreshPresetSelect();
  await loadLastResult();
  await loadSheetConfigToUI();
});

function bindUI() {
  $("#addFieldBtn").addEventListener("click", () => addFieldRow());
  $("#fieldList").addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList.contains("del-field")) {
      t.closest(".field-row").remove();
    }
  });
  $("#fieldList").addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("f-attr")) {
      const row = t.closest(".field-row");
      const custom = row.querySelector(".f-attr-name");
      if (t.value === "custom") {
        custom.classList.remove("hidden");
        row.classList.add("has-custom");
      } else {
        custom.classList.add("hidden");
        row.classList.remove("has-custom");
      }
    }
  });

  // scope toggles
  $$('input[name="scope"]').forEach((r) =>
    r.addEventListener("change", () => {
      const v = $('input[name="scope"]:checked').value;
      $("#patternBox").classList.toggle("hidden", v !== "pattern");
      $("#nextBox").classList.toggle("hidden", v !== "next");
      $("#pageclickBox").classList.toggle("hidden", v !== "pageclick");
    })
  );

  $("#runBtn").addEventListener("click", run);
  $("#stopBtn").addEventListener("click", stop);

  $("#savePresetBtn").addEventListener("click", savePreset);
  $("#deletePresetBtn").addEventListener("click", deletePreset);
  $("#presetSelect").addEventListener("change", loadPreset);

  $("#csvBtn").addEventListener("click", () => exportCsv());
  $("#jsonBtn").addEventListener("click", () => exportJson());
  $("#copyTsvBtn").addEventListener("click", () => copyTsv());
  $("#clearBtn").addEventListener("click", clearResult);

  // 시트 연동
  $("#testSheetBtn").addEventListener("click", testSheet);
  $("#sendSheetBtn").addEventListener("click", sendToSheet);
  $("#fetchSheetBtn").addEventListener("click", fetchFromSheet);
  ["sheetUrl", "sheetToken", "sheetId", "sheetTab"].forEach((id) => {
    $("#" + id).addEventListener("change", saveSheetConfigFromUI);
  });

  // background -> popup 진행 메시지
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "MJC_PROGRESS") {
      const p = msg.progress || {};
      const stageMap = {
        navigate: "이동 중",
        extract: "추출 중",
        "page-done": "완료",
        "no-next": "다음 페이지 없음",
      };
      setStatus(`[${p.page}/${p.total}] ${stageMap[p.stage] || p.stage} · 누적 ${p.count}`);
    }
  });
}

// ----- 필드 행 -----
function addFieldRow(data) {
  const tpl = $("#fieldRowTpl");
  const node = tpl.content.firstElementChild.cloneNode(true);
  if (data) {
    node.querySelector(".f-name").value = data.name || "";
    node.querySelector(".f-sel").value = data.selector || "";
    const sel = node.querySelector(".f-attr");
    sel.value = data.attr || "text";
    if (sel.value === "custom") {
      const cn = node.querySelector(".f-attr-name");
      cn.classList.remove("hidden");
      cn.value = data.attrName || "";
      node.classList.add("has-custom");
    }
  }
  $("#fieldList").appendChild(node);
}

function readFields() {
  return $$("#fieldList .field-row").map((row) => {
    const attr = row.querySelector(".f-attr").value;
    return {
      name: row.querySelector(".f-name").value.trim(),
      selector: row.querySelector(".f-sel").value.trim(),
      attr,
      attrName: attr === "custom" ? row.querySelector(".f-attr-name").value.trim() : "",
    };
  });
}

function readConfig() {
  const scope = $('input[name="scope"]:checked').value;
  return {
    rowSelector: $("#rowSelector").value.trim(),
    fields: readFields(),
    scope,
    urlPattern: $("#urlPattern").value.trim(),
    pageStart: parseInt($("#pageStart").value, 10) || 1,
    pageEnd: parseInt($("#pageEnd").value, 10) || 1,
    pageDelay: parseInt($("#pageDelay").value, 10) || 0,
    nextSelector: $("#nextSelector").value.trim(),
    maxPages: parseInt($("#maxPages").value, 10) || 1,
    nextDelay: parseInt($("#nextDelay").value, 10) || 0,
    pageclickSelector: $("#pageclickSelector").value.trim(),
    pageclickStart: parseInt($("#pageclickStart").value, 10) || 1,
    pageclickEnd: parseInt($("#pageclickEnd").value, 10) || 1,
    pageclickDelay: parseInt($("#pageclickDelay").value, 10) || 0,
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  $("#rowSelector").value = cfg.rowSelector || "";
  $("#fieldList").innerHTML = "";
  (cfg.fields && cfg.fields.length ? cfg.fields : [{ name: "", selector: "", attr: "text" }]).forEach(addFieldRow);

  const scope = cfg.scope || "current";
  const r = $(`input[name="scope"][value="${scope}"]`);
  if (r) r.checked = true;
  $("#patternBox").classList.toggle("hidden", scope !== "pattern");
  $("#nextBox").classList.toggle("hidden", scope !== "next");
  $("#pageclickBox").classList.toggle("hidden", scope !== "pageclick");

  $("#urlPattern").value = cfg.urlPattern || "";
  $("#pageStart").value = cfg.pageStart || 1;
  $("#pageEnd").value = cfg.pageEnd || 3;
  $("#pageDelay").value = cfg.pageDelay ?? 800;
  $("#nextSelector").value = cfg.nextSelector || "";
  $("#maxPages").value = cfg.maxPages || 3;
  $("#nextDelay").value = cfg.nextDelay ?? 1200;
  $("#pageclickSelector").value = cfg.pageclickSelector || "";
  $("#pageclickStart").value = cfg.pageclickStart || 1;
  $("#pageclickEnd").value = cfg.pageclickEnd || 5;
  $("#pageclickDelay").value = cfg.pageclickDelay ?? 1500;
}

// ----- 프리셋 -----
async function getPresets() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.presets);
  return obj[STORAGE_KEYS.presets] || {};
}
async function setPresets(presets) {
  await chrome.storage.local.set({ [STORAGE_KEYS.presets]: presets });
}

async function refreshPresetSelect() {
  const presets = await getPresets();
  const sel = $("#presetSelect");
  sel.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "— 프리셋 선택 —";
  sel.appendChild(empty);
  Object.keys(presets)
    .sort()
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
}

async function savePreset() {
  const name = $("#presetName").value.trim();
  if (!name) {
    setStatus("프리셋 이름을 입력해 주세요.", "error");
    return;
  }
  const cfg = readConfig();
  const presets = await getPresets();
  presets[name] = cfg;
  await setPresets(presets);
  await refreshPresetSelect();
  $("#presetSelect").value = name;
  setStatus(`프리셋 "${name}" 저장됨`, "success");
}

async function deletePreset() {
  const name = $("#presetSelect").value;
  if (!name) {
    setStatus("삭제할 프리셋을 선택해 주세요.", "error");
    return;
  }
  if (!confirm(`프리셋 "${name}"을(를) 삭제할까요?`)) return;
  const presets = await getPresets();
  delete presets[name];
  await setPresets(presets);
  await refreshPresetSelect();
  setStatus(`프리셋 "${name}" 삭제됨`);
}

async function loadPreset() {
  const name = $("#presetSelect").value;
  if (!name) return;
  const presets = await getPresets();
  if (presets[name]) {
    applyConfig(presets[name]);
    $("#presetName").value = name;
    setStatus(`프리셋 "${name}" 불러옴`);
  }
}

async function loadLastConfig() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.lastConfig);
  if (obj[STORAGE_KEYS.lastConfig]) {
    applyConfig(obj[STORAGE_KEYS.lastConfig]);
  } else {
    addFieldRow({ name: "", selector: "", attr: "text" });
  }
}

async function saveLastConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastConfig]: cfg });
}

async function loadLastResult() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.lastResult);
  const rows = obj[STORAGE_KEYS.lastResult];
  if (Array.isArray(rows) && rows.length) {
    lastResult = rows;
    renderResult(rows);
  }
}
async function saveLastResult(rows) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastResult]: rows });
}

// ----- 활성 탭 조회 (새창 모드) -----
async function getActiveNormalTab() {
  try {
    const win = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
      populate: true,
    });
    if (win && win.tabs) {
      const t = win.tabs.find((x) => x.active);
      if (t) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    for (const w of wins) {
      const t = w.tabs && w.tabs.find((x) => x.active);
      if (t) return t;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ----- 실행 -----
async function run() {
  const cfg = readConfig();
  if (!cfg.rowSelector) {
    setStatus("행 컨테이너 셀렉터를 입력해 주세요.", "error");
    return;
  }
  if (cfg.scope === "pattern" && !cfg.urlPattern.includes("{N}")) {
    setStatus("URL 패턴에 {N}을 포함해 주세요.", "error");
    return;
  }
  if (cfg.scope === "next" && !cfg.nextSelector) {
    setStatus("다음 버튼 셀렉터를 입력해 주세요.", "error");
    return;
  }
  if (cfg.scope === "pageclick") {
    if (!cfg.pageclickSelector) {
      setStatus("페이지 셀렉터 템플릿을 입력해 주세요.", "error");
      return;
    }
    if (!cfg.pageclickSelector.includes("{N}")) {
      setStatus("페이지 셀렉터 템플릿에 {N}을 포함해 주세요.", "error");
      return;
    }
    if (cfg.pageclickEnd < cfg.pageclickStart) {
      setStatus("끝 페이지가 시작 페이지보다 작습니다.", "error");
      return;
    }
  }
  await saveLastConfig(cfg);

  const tab = await getActiveNormalTab();
  if (!tab) {
    setStatus("크롤링할 탭을 찾을 수 없습니다. 다른 일반 창에 페이지를 열어 두세요.", "error");
    return;
  }
  if (/^chrome:\/\//.test(tab.url) || /^chrome-extension:\/\//.test(tab.url)) {
    setStatus("크롬 내부 페이지에서는 실행할 수 없습니다.", "error");
    return;
  }

  toggleRunning(true);
  setStatus("실행 중…");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "MJC_START",
      payload: { ...cfg, tabId: tab.id },
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "알 수 없는 오류");
    }
    lastResult = res.rows || [];
    await saveLastResult(lastResult);
    renderResult(lastResult);
    setStatus(`완료 · 총 ${lastResult.length}개 (${res.pages || 1}페이지)${res.canceled ? " · 중지됨" : ""}`, "success");
  } catch (err) {
    setStatus("오류: " + (err?.message || String(err)), "error");
  } finally {
    toggleRunning(false);
  }
}

async function stop() {
  await chrome.runtime.sendMessage({ type: "MJC_STOP" });
  setStatus("중지 요청 보냄…");
}

function toggleRunning(running) {
  $("#runBtn").disabled = running;
  $("#stopBtn").disabled = !running;
}

function setStatus(text, kind) {
  const el = $("#status");
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// ----- 결과 표시 -----
function renderResult(rows) {
  const table = $("#resultTable");
  $("#rowCount").textContent = rows.length;
  table.innerHTML = "";
  if (!rows.length) return;

  const cols = collectColumns(rows);
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    cols.forEach((c) => {
      const td = document.createElement("td");
      const v = r[c];
      if (typeof v === "string" && /^https?:\/\//.test(v)) {
        const a = document.createElement("a");
        a.href = v;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = v;
        td.appendChild(a);
      } else {
        td.textContent = v == null ? "" : String(v);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function collectColumns(rows) {
  const set = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => set.add(k)));
  const cols = Array.from(set).filter((c) => c !== "_idx" && c !== "__page");
  if (set.has("_idx")) cols.unshift("_idx");
  if (set.has("__page")) cols.push("__page");
  return cols;
}

function clearResult() {
  lastResult = [];
  saveLastResult([]);
  renderResult([]);
  setStatus("결과 초기화됨");
}

// ----- 내보내기 -----
function escapeCsv(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function rowsToCsv(rows) {
  if (!rows.length) return "";
  const cols = collectColumns(rows);
  const lines = [cols.map(escapeCsv).join(",")];
  rows.forEach((r) => lines.push(cols.map((c) => escapeCsv(r[c])).join(",")));
  return lines.join("\n");
}
function rowsToTsv(rows) {
  if (!rows.length) return "";
  const cols = collectColumns(rows);
  const clean = (v) => (v == null ? "" : String(v).replace(/\t/g, " ").replace(/\r?\n/g, " "));
  const lines = [cols.join("\t")];
  rows.forEach((r) => lines.push(cols.map((c) => clean(r[c])).join("\t")));
  return lines.join("\n");
}

function downloadFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exportCsv() {
  if (!lastResult.length) return setStatus("내보낼 결과가 없습니다.", "error");
  const csv = "\uFEFF" + rowsToCsv(lastResult);
  downloadFile(`mjcollect_${timestamp()}.csv`, "text/csv", csv);
}
function exportJson() {
  if (!lastResult.length) return setStatus("내보낼 결과가 없습니다.", "error");
  downloadFile(`mjcollect_${timestamp()}.json`, "application/json", JSON.stringify(lastResult, null, 2));
}
async function copyTsv() {
  if (!lastResult.length) return setStatus("내보낼 결과가 없습니다.", "error");
  try {
    await navigator.clipboard.writeText(rowsToTsv(lastResult));
    setStatus("TSV 복사 완료 — 구글시트/엑셀에 붙여넣기 하세요.", "success");
  } catch (e) {
    setStatus("클립보드 복사 실패: " + e.message, "error");
  }
}

// ----- 구글시트 연동 -----
function readSheetUI() {
  let sid = $("#sheetId").value.trim();
  const idMatch = sid.match(/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (idMatch) sid = idMatch[1];
  return {
    url: $("#sheetUrl").value.trim(),
    token: $("#sheetToken").value,
    spreadsheetId: sid,
    sheetName: $("#sheetTab").value.trim() || "MJ Collect",
  };
}

function applySheetUI(cfg) {
  if (!cfg) return;
  $("#sheetUrl").value = cfg.url || "";
  $("#sheetToken").value = cfg.token || "";
  $("#sheetId").value = cfg.spreadsheetId || "";
  $("#sheetTab").value = cfg.sheetName || "MJ Collect";
}

async function loadSheetConfigToUI() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.sheetConfig);
  applySheetUI(obj[STORAGE_KEYS.sheetConfig] || {});
}
async function saveSheetConfigFromUI() {
  const cfg = readSheetUI();
  await chrome.storage.local.set({ [STORAGE_KEYS.sheetConfig]: cfg });
}

async function postToSheet(extra) {
  const cfg = readSheetUI();
  if (!cfg.url) throw new Error("웹 앱 URL을 입력해 주세요.");
  if (!cfg.token) throw new Error("토큰을 입력해 주세요.");
  if (!/^https:\/\/script\.google\.com\//.test(cfg.url)) {
    throw new Error("웹 앱 URL이 https://script.google.com/... 형태가 아닙니다.");
  }

  const body = {
    token: cfg.token,
    spreadsheetId: cfg.spreadsheetId || undefined,
    sheetName: cfg.sheetName,
    ...(extra || {}),
  };

  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("네트워크 오류: " + e.message);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error("응답 파싱 실패. 웹앱이 JSON을 반환하지 않습니다. 배포 권한이 '모든 사용자'인지 확인하세요.");
  }
  if (!data.ok) throw new Error(data.error || "알 수 없는 오류");
  return data;
}

async function testSheet() {
  await saveSheetConfigFromUI();
  const el = $("#sheetTestStatus");
  el.textContent = "테스트 중…";
  el.className = "status";
  try {
    const data = await postToSheet({ test: true });
    el.textContent = "✓ 연결 OK · " + (data.message || "");
    el.className = "status success";
  } catch (e) {
    el.textContent = "✗ " + (e.message || String(e));
    el.className = "status error";
  }
}

async function sendToSheet() {
  if (!lastResult.length) return setStatus("보낼 결과가 없습니다.", "error");
  await saveSheetConfigFromUI();
  setStatus("시트에 전송 중…");
  $("#sendSheetBtn").disabled = true;
  try {
    const cols = collectColumns(lastResult);
    const data = await postToSheet({ columns: cols, rows: lastResult });
    const linkPart = data.sheetUrl ? ` · 시트 열기: ${data.sheetUrl}` : "";
    setStatus(`✓ 시트에 ${data.appended}행 추가됨 (${data.sheetName})${linkPart}`, "success");
  } catch (e) {
    setStatus("✗ 시트 전송 실패: " + (e.message || String(e)), "error");
  } finally {
    $("#sendSheetBtn").disabled = false;
  }
}

async function fetchFromSheet() {
  await saveSheetConfigFromUI();
  setStatus("시트에서 가져오는 중…");
  $("#fetchSheetBtn").disabled = true;
  try {
    const data = await postToSheet({ mode: "read" });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    lastResult = rows;
    await saveLastResult(rows);
    renderResult(rows);
    if (data.warning) {
      setStatus("⚠ " + data.warning, "error");
    } else {
      const linkPart = data.sheetUrl ? ` · ${data.sheetUrl}` : "";
      setStatus(`✓ 시트에서 ${rows.length}행 가져옴 (${data.sheetName || "시트"})${linkPart}`, "success");
    }
  } catch (e) {
    setStatus("✗ 시트 가져오기 실패: " + (e.message || String(e)), "error");
  } finally {
    $("#fetchSheetBtn").disabled = false;
  }
}
