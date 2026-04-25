/**
 * MJ Collect — 구글시트 동기화용 Apps Script
 *
 * 셋업 절차
 * ─────────────────────────────────────────────────────────────
 * 1) 데이터를 받을 구글시트를 엽니다.
 * 2) 메뉴: [확장 프로그램] → [Apps Script]
 * 3) 기본 Code.gs 내용을 모두 지우고 이 파일 전체 코드를 붙여넣습니다.
 * 4) 아래 TOKEN 값을 본인만 아는 긴 랜덤 문자열로 변경 후 저장(Ctrl+S).
 * 5) 우상단 [배포] → [새 배포]
 *      - 유형: ⚙️에서 [웹 앱] 선택
 *      - 설명: MJ Collect (자유)
 *      - 다음 사용자 인증으로 실행: 본인
 *      - 액세스 권한: "모든 사용자"
 *    [배포] 클릭 후 권한 승인.
 * 6) 발급된 [웹 앱 URL]을 복사하여 확장 프로그램 설정에 붙여넣고,
 *    같은 TOKEN 값을 함께 입력합니다.
 *
 * 코드 수정 후에는 [배포 관리] → [편집(연필)] → [새 버전] → [배포] 로
 * 같은 URL을 유지한 채 업데이트할 수 있습니다.
 *
 * 지원 모드 (확장 프로그램이 보내는 body)
 *  - 기본 (mode 없음): rows를 sheetName 시트에 append. 헤더 없으면 자동 생성.
 *  - mode: "test"  : 단순 연결 확인.
 *  - mode: "read"  : sheetName 시트의 전체 데이터를 객체 배열로 반환.
 */

const TOKEN = '여기에_긴_랜덤_문자열_입력_예시_mjc_2026_change_this';

function doPost(e) {
  return handle_(e, 'POST');
}

function doGet(e) {
  return handle_(e, 'GET');
}

function handle_(e, method) {
  try {
    let body = {};
    if (method === 'POST' && e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      body = e.parameter;
    }

    if (!body || body.token !== TOKEN) {
      return json_({ ok: false, error: 'Invalid token' });
    }

    // 연결 테스트
    if (body.test === true || body.test === 'true' || body.mode === 'test') {
      return json_({ ok: true, mode: 'test', message: 'MJ Collect 연결 OK' });
    }

    // 공통: 스프레드시트 결정
    const ss = body.spreadsheetId
      ? SpreadsheetApp.openById(body.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return json_({ ok: false, error: 'Spreadsheet not found. spreadsheetId를 입력하거나, 이 스크립트를 시트에 바인딩하세요.' });
    }
    const sheetName = (body.sheetName && String(body.sheetName).trim()) || 'MJ Collect';

    // ----- 읽기 모드 -----
    if (body.mode === 'read') {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        return json_({
          ok: true,
          rows: [],
          columns: [],
          total: 0,
          sheetName: sheetName,
          sheetUrl: ss.getUrl(),
          warning: '시트 탭 "' + sheetName + '"이(가) 존재하지 않습니다.'
        });
      }
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (lastRow === 0 || lastCol === 0) {
        return json_({
          ok: true,
          rows: [],
          columns: [],
          total: 0,
          sheetName: sheetName,
          sheetUrl: ss.getUrl()
        });
      }
      const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
      const headers = data[0].map(function (h, i) {
        const s = (h === undefined || h === null) ? '' : String(h);
        return s || ('column_' + (i + 1));
      });
      const rows = data.slice(1).map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) {
          const v = row[i];
          if (v === undefined || v === null) {
            obj[h] = '';
          } else if (v instanceof Date) {
            obj[h] = v.toISOString();
          } else {
            obj[h] = v;
          }
        });
        return obj;
      });
      return json_({
        ok: true,
        rows: rows,
        columns: headers,
        total: rows.length,
        sheetName: sheetName,
        sheetUrl: ss.getUrl()
      });
    }

    // GET 요청은 여기까지 (정보 응답)
    if (method !== 'POST') {
      return json_({ ok: true, message: 'MJ Collect endpoint. Use POST to write/read rows.' });
    }

    // ----- 쓰기(append) 모드 -----
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) {
      return json_({ ok: true, appended: 0, sheetName: sheetName, sheetUrl: ss.getUrl() });
    }

    const cols = (Array.isArray(body.columns) && body.columns.length > 0)
      ? body.columns
      : Object.keys(rows[0]);

    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    }

    const values = rows.map(function (r) {
      return cols.map(function (c) {
        const v = r[c];
        return (v === undefined || v === null) ? '' : v;
      });
    });

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, values.length, cols.length).setValues(values);

    return json_({
      ok: true,
      appended: values.length,
      sheetName: sheetName,
      sheetUrl: ss.getUrl(),
      startRow: startRow
    });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
