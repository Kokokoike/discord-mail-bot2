function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const discordMessageId = params.discordMessageId;
    const status = params.status;

    // 要返信リスト
    if (params.action === 'get_pending_list') {
      const pendingList = getPendingListFromSheet();
      return ContentService.createTextOutput(JSON.stringify(pendingList))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ボタンインタラクション
    if (discordMessageId && status) {
      updateSheetByMessageId(discordMessageId, status);
      return ContentService.createTextOutput("Sheet updated successfully.");
    } else {
      return ContentService.createTextOutput("Invalid parameters.").setMimeType(ContentService.MimeType.TEXT);
    }
  } catch (err) {
    return ContentService.createTextOutput("Error: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  }
}

// DiscordメッセージIDを元にスプレッドシートのステータスを更新する関数
function updateSheetByMessageId(messageId, status) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    // B列がDiscordメッセージIDと一致するかチェック
    if (data[i][1] == messageId) {
      // C列のステータスを更新
      sheet.getRange(i + 1, 3).setValue(status);
      Logger.log(`Updated status to "${status}" for messageId: ${messageId}`);
      break; // 一致したらループを抜ける
    }
  }
}

// スプレッドシートから要返信のリストを取得する関数
function getPendingListFromSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const pendingList = [];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === '要返信') {
      pendingList.push({
        recipient: data[i][0], // A列: 相手のアドレス
        messageId: data[i][1], // B列: DiscordメッセージID
        mentionId: data[i][4], // メンションID
      });
    }
  }
  return pendingList;
}