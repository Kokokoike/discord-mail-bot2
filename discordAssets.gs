const MANAGE_SHEET_NAME = 'EmailLog';

// スプレッドシートに情報を書き込む関数
function writeToSheet(fromAddress, discordMessageId, gmailMessageId, mentionId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  sheet.appendRow([fromAddress, discordMessageId, '要返信', gmailMessageId, mentionId]);
}

// スプレッドシートを検索し、条件に一致する全ての行を更新して、更新した全てのDiscordメッセージIDを配列で返す
function findAllAndUpdateSheet(recipientAddress, sentMessageId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const updatedMessageIds = []; // 更新したIDを格納する配列

  // シートの全ての行をチェック
  for (let i = 1; i < data.length; i++) {
    const rowData = data[i];
    
    // 条件：宛先が一致、ステータスが要返信、受信メールの方が古い
    if (rowData[0] == recipientAddress && rowData[2] == '要返信' && rowData[3] < sentMessageId) {
      updatedMessageIds.push(rowData[1]);
      sheet.getRange(i + 1, 3).setValue('返信済み');
    }
  }
  return updatedMessageIds; // 更新したIDの【配列】を返す
}

// WorkerにDiscordメッセージの更新を依頼する関数
function triggerDiscordUpdate(cloudflareURL, discordMessageId) {
  const payload = {
    action: 'update_as_replied',
    discordMessageId: discordMessageId,
  };
  UrlFetchApp.fetch(cloudflareURL, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  });
}

// "Name <email@addr>"形式から "email@addr" 部分だけを抽出する共通関数
function extractEmailAddress(fullAddress) {
    if (!fullAddress) return null;
    const match = fullAddress.match(/<(.+?)>/);
    return match ? match[1] : fullAddress.trim();
}