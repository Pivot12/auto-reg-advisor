/**
 * Auto Reg Advisor — usage logger (Google Apps Script).
 * Receives one POST per question from the app and appends a row to your Google Sheet.
 * Free, no database. See analytics/README.md for the 5-minute setup.
 */
const SHEET_ID = "PASTE_YOUR_GOOGLE_SHEET_ID_HERE"; // from the sheet URL: /d/THIS_PART/edit
const SHEET_NAME = "Logs";

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sh.getLastRow() === 0) {
      sh.appendRow(["timestamp", "country", "region", "city", "question", "sources", "status", "answer_chars", "user_agent"]);
    }
    sh.appendRow([d.ts || "", d.country || "", d.region || "", d.city || "", d.question || "", d.sources || "", d.status || "", d.answer_chars || "", d.ua || ""]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}
