const SHEET_NAME = 'シート1';
const MANAGE_SHEET_NAME = 'EmailLog';
const STATUS = {
  PENDING: 'pending', // 要返信
  DONE: 'done',             // 返信済み
};

function checkMailAndNotify() {
  // キャッシュまたはスプレッドシートからデータを取得
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get("cachedData");
  let data;
  if (cachedData) {
    data = JSON.parse(cachedData);
  } else {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet(); // もしくは `openByName(SPREADSHEET_NAME)`
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    data = sheet.getDataRange().getValues();
    cache.put("cachedData", JSON.stringify(data), 3600);
  }

  // 諸々の設定情報を取得
  const properties = PropertiesService.getScriptProperties();
  const config = {
    cloudflareURL: properties.getProperty("CLOUDFLARE_URL"),
    mailAddress: properties.getProperty("MAIL_ADDRESS"),
    lastId: properties.getProperty("LAST_ID") || '0',
    lastTimestamp: properties.getProperty("LAST_TIMESTAMP") || null,
    authSecret: properties.getProperty("AUTH_SECRET"),
  };

  // 検索クエリ
  let query = 'is:inbox';
  if (config.lastTimestamp) {
    // 前回実行のタイムスタンプの60秒前からを検索範囲
    const searchTimestamp = Math.floor(parseInt(config.lastTimestamp) / 1000) - 60;
    query += ` after:${searchTimestamp}`;
  }

  const threads = GmailApp.search(query);
  let latestId = config.lastId;
  let latestTimestamp = config.lastTimestamp;
  mainLoop : for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();

    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      const messageId = message.getId();

      if (messageId > config.lastId) {
        let isSuccessInThisLoop = false;
        // 自分自身から→送信済み処理
        if (message.getFrom().includes(config.mailAddress)){
          isSuccessInThisLoop = processSentMail(message, config, messageId);
        } else{
          // 自分宛でない（Gmail宛）
          const recipients = message.getTo() + message.getCc() + message.getBcc();
          if (!recipients.includes(config.mailAddress)){
            isSuccessInThisLoop = true;
          } else {
            // 新着メール
            isSuccessInThisLoop = processIncomingMail(message, config, data, messageId);
          }
        }
        if (isSuccessInThisLoop) {
          if (messageId > latestId) {
            latestId = messageId;
            latestTimestamp = message.getDate();
          }
        } else {
          Logger.log(`An error occurred. Halting processing at message ID: ${messageId}`);
          break mainLoop;
        }
        
      } else {
        break; // 処理済みのメールに到達したらループを抜ける
      }
    }
  }

  // 最後に処理したIDを保存          
  if (latestId > config.lastId) {
    properties.setProperty("LAST_ID", latestId);
    properties.setProperty("LAST_TIMESTAMP", latestTimestamp.getTime().toString());
  } else {
    Logger.log('No new emails found.');
  }
}




// 新着メール
function processIncomingMail(message, config, data, messageId) {
  Logger.log(`ProcessingIncomigMail: ${message.getSubject()}`);
  
  const body = message.getPlainBody().replace(/\s/g, '');
  const mentionId = findMentionTarget(message, data, config.mailAddress, body);

  const payload = {
    mentionId: mentionId,
    subject: message.getSubject(),
    from: message.getFrom(),
    date: message.getDate().toLocaleString('ja-JP'),
    bodySnippet: getFirstFiveLines(message.getPlainBody()),
    gmailLink: message.getThread().getPermalink()
  };
  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {'Auth-Key': config.authSecret}
  };
  const response = UrlFetchApp.fetch(config.cloudflareURL, options);
  if (response.getResponseCode() === 200) {
    const discordMessage = JSON.parse(response.getContentText());
    const fromAddress = extractEmailAddress(message.getFrom());
    if (fromAddress) {
      writeToSheet(fromAddress, discordMessage.id, messageId, mentionId);
    }
    return true
  } else {
    Logger.log(`Error notifying: ${response.getContentText()}`);
    return false
  }
}

//自分からの返信メール
function processSentMail(message, config, messageId) {
  Logger.log(`ProcessingSentMail: ${message.getSubject()}`);
  let success = true;
  
  const recipients = (message.getTo() + "," + message.getCc()).split(',');
  for (let i = 0; i < recipients.length; i++) {
    const recipientAddress = extractEmailAddress(recipients[i]);
    if (recipientAddress) {
      // 更新対象を取得
      const pendingTasks = findPendingDiscordIds(recipientAddress, messageId);
      // 配列内の全てのIDに対して更新を依頼
      for (const task of pendingTasks) {
        const discordUpdateSuccess = triggerDiscordUpdate(config, task.discordId);
        if (discordUpdateSuccess) {
          updateStatusInSheet(task.rowNumber, STATUS.DONE);
        } else {
          // 一つでも失敗したら全体の処理結果を失敗とする
          success = false; 
        }
      }
    }
  }
  return success;
}

// スプレッドシートに情報を書き込む関数
function writeToSheet(fromAddress, discordId, mailId, mentionId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  sheet.appendRow([fromAddress, discordId, STATUS.PENDING, mailId, mentionId]);
}

//条件に合う未対応タスクをシートから検索し、DiscordIDと行番号のリストを返す関数
function findPendingDiscordIds(recipientAddress, sentMessageId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const pendingTasks = [];

  for (let i = 1; i < data.length; i++) {
    const rowData = data[i];
    // 条件：宛先が一致、ステータスが「要返信」、受信メールの方が古い
    if (rowData[0] == recipientAddress && rowData[2] == STATUS.PENDING && rowData[3] < sentMessageId) {
      pendingTasks.push({
        discordId: rowData[1], // B列: DiscordメッセージID
        rowNumber: i + 1       // 実際の行番号
      });
    }
  }
  return pendingTasks;
}

// 指定された行番号のステータスを更新する関数
function updateStatusInSheet(rowNumber, status) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  sheet.getRange(rowNumber, 3).setValue(status); // C列
}

// WorkerにDiscordメッセージの更新を依頼する関数
function triggerDiscordUpdate(config, discordMessageId) {
  const payload = {
    action: 'update_as_replied',
    discordMessageId: discordMessageId,
  };
  const response = UrlFetchApp.fetch(config.cloudflareURL, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {'Auth-Key': config.authSecret}, 
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() === 200) {
    return true;
  } else {
    sendErrorToDiscord(errorText, 'triggerDiscordUpdate');
    Logger.log(`Failed to update Discord message ${discordMessageId}. Response: ${response.getContentText()}`);
    return false;
  }
}





// メンションする人を探す
// 探索は見つかったら即時終了
function findMentionTarget(message, data, mailAddress, plainBody) {
  let mentionId = '';
  const fromAddress = message.getFrom();
  const messages = message.getThread().getMessages();
  // const plainBody = message.getPlainBody().replace(/\s/g, '');

  // 1. 直近の自分からの返信メールの本文を検索
  for (let i = messages.length - 1; i >= 0; i--) {
    const currentMessage = messages[i];
    if (currentMessage.getFrom().includes(mailAddress) && currentMessage.getTo().includes(fromAddress)) {
      const body = currentMessage.getPlainBody().replace(/\s/g, '');
      let baseIndex = body.length;
      data.forEach(row => {
        const fullName = row[0].replace(/\s/g, '');
        if (fullName && body.includes(fullName)) {
          const index = body.indexOf(fullName);
          if (index !== -1 && index < baseIndex) {
            baseIndex = index;
            mentionId = `<@${row[2]}>`;
          }
        }
      });
      if (mentionId) return mentionId;
      break; // 直近の1通だけチェック
    }
  }

  // 2. 受信メール本文からフルネームを検索
  let baseIndex2 = plainBody.length;
  for (const row of data) {
    const fullName = row[0].replace(/\s/g, '');
    if (fullName && plainBody.includes(fullName)) {
      const index = plainBody.indexOf(fullName);
      if (index !== -1 && index < baseIndex2) {
        baseIndex2 = index;
        mentionId = `<@${row[2]}>`;
      }
    }
  }
  if (mentionId) return mentionId;

  // 3. 受信メール本文から「苗字＋様」を検索
  for (const row of data) {
    const lastName = row[1];
    if (lastName && (plainBody.includes(lastName + '様') || plainBody.includes(lastName + 'さま'))) {
      return `<@${row[2]}>`;
    }
  }

  return mentionId;
}

// メールの最初の5行を取得する関数
function getFirstFiveLines(body) {
  return body
    .split('\n') // 1. 改行で全ての行を配列に分割する
    .map(line => line.trim()) // 2. 各行の前後の空白を削除する
    .filter(line => line !== '') // 3. 空行を除外する
    .slice(0, 5) // 4. 残った行の最初の5行を取得する
    .join('\n'); // 5. 再び改行で結合して文字列に戻す
}

// "Name <email@addr>"形式から "email@addr" 部分だけを抽出する関数
function extractEmailAddress(fullAddress) {
    if (!fullAddress) return null;
    const match = fullAddress.match(/<(.+?)>/);
    return match ? match[1] : fullAddress.trim();
}

/**
 * Discord Webhookにエラーメッセージを送信する関数
 * @param {string} errorMessage - 送信するエラーメッセージの内容
 * @param {string} functionName - エラーが発生した関数名
 */
function sendErrorToDiscord(errorMessage, functionName) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("DISCORD_WEBHOOK_URL");

  const payload = {
    embeds: [{
      title: "GAS Script Error Detected",
      color: 15548997, // Red
      fields: [
        { name: "Function", value: functionName, inline: true },
        { name: "Timestamp", value: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), inline: true }
      ],
      description: "```\n" + errorMessage.substring(0, 1500) + "\n```"
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  };

  UrlFetchApp.fetch(webhookUrl, options);
}





function doPost(e) { 
  try {
    const params = JSON.parse(e.postData.contents);
    let result = {};
    
    // 秘密鍵の検証
    const authSECRET = PropertiesService.getScriptProperties().getProperty("AUTH_SECRET");
    if (params.authKey !== authSECRET) {
      return ContentService.createTextOutput("Unauthorized").setMimeType(ContentService.MimeType.JSON);
    }

    // ボタン
    const discordId = params.discordId;
    const discordStatus = params.status;
    if (discordId && discordStatus) {
      const success = updateSheet(discordId, discordStatus);
      if (success) {
        result = { status: 'success' };
      } else {
        result = { status: 'error', message: '該当するメッセージIDが見つかりませんでした。' };
      }
    }
    // /checkコマンド
    else if (params.action === 'get_pending_list') {
      const pendingList = getPendingList();
      result = { status: 'success', data: pendingList };
    } else {
      result = { status: 'error', message: '無効なアクションです。' };
    }

    // Cloudflareへの返答
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    sendErrorToDiscord(err.stack, 'doPost');
    return ContentService.createTextOutput("Error: " + err.message).setMimeType(ContentService.MimeType.JSON);
  }
}

// DiscordメッセージIDを元にスプレッドシートのステータスを更新する関数
function updateSheet(discordId, status) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] == discordId) {
      sheet.getRange(i + 1, 3).setValue(status);
      return true;
    }
  }
  return false;
}

// スプレッドシートから要返信のリストを取得する関数
function getPendingList() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MANAGE_SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const pendingList = [];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === STATUS.PENDING) {
      pendingList.push({
        recipient: data[i][0], // A列: 相手のアドレス
        messageId: data[i][1], // B列: DiscordメッセージID
        mentionId: data[i][4], // E列：メンションID
      });
    }
  }
  return pendingList;
}

function checkMailAndNotify2() {
  // キャッシュまたはスプレッドシートからデータを取得
  const cache = CacheService.getScriptCache();
  const cachedData = cache.get("cachedData");
  let data;
  if (cachedData) {
    data = JSON.parse(cachedData);
  } else {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet(); // もしくは `openByName(SPREADSHEET_NAME)`
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    data = sheet.getDataRange().getValues();
    cache.put("cachedData", JSON.stringify(data), 3600);
  }

  // 諸々の設定情報を取得
  const properties = PropertiesService.getScriptProperties();
  const config = {
    mailAddress: properties.getProperty("MAIL_ADDRESS"),
    lastId: properties.getProperty("LAST_ID") || '0',
    lastTimestamp: properties.getProperty("LAST_TIMESTAMP") || null,
    webhookUrl: properties.getProperty("DISCORD_WEBHOOK_URL"),
  };

  // 検索クエリ
  let query = 'is:inbox';
  if (config.lastTimestamp) {
    // 前回実行のタイムスタンプの60秒前からを検索範囲
    const searchTimestamp = Math.floor(parseInt(config.lastTimestamp) / 1000) - 60;
    query += ` after:${searchTimestamp}`;
  }

  const threads = GmailApp.search(query);
  let latestId = config.lastId;
  let latestTimestamp = config.lastTimestamp;
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();

    smallLoop : for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      const messageId = message.getId();

      if (messageId > config.lastId) {
        processNewMail(message, data, config);
        if (messageId > latestId) {
          latestId = messageId;
          latestTimestamp = message.getDate();
        }
      } else {
        break smallLoop; // 処理済みのメールに到達したらループを抜ける
      }
    }
  }

  // 最後に処理したIDを保存          
  if (latestId > config.lastId) {
    properties.setProperty("LAST_ID", latestId);
    properties.setProperty("LAST_TIMESTAMP", latestTimestamp.getTime().toString());
  } else {
    Logger.log('No new emails found.');
  }
}

function processNewMail(message, data, config) {
  Logger.log(`Processing subject: ${message.getSubject()}`);

  // 自分自身からのメールは除外
  if (message.getFrom().includes(config.mailAddress)) return;
  
  // 自分宛でなければ除外
  const recipients = message.getTo() + message.getCc() + message.getBcc();
  if (!recipients.includes(config.mailAddress)) return;

  // 通知本文
  const body = message.getPlainBody().replace(/\s/g, '');
  const mentionId = findMentionTarget(message, data, config.mailAddress, body);
  const messageDate = message.getDate().toString().replace(/GMT.*/, '').trim();
  let messageContent;
  // 1. 本文のプレビューを先に取得する
  const bodySnippet = getFirstFiveLines(body);
  // 2. メッセージの基本部分を組み立てる
  messageContent = (mentionId || 'メールが届きました:') + '\n' + '```' +
                       '件名: ' + message.getSubject() + '\n' +
                       '送信者: ' + message.getFrom() + '\n' +
                       '受信日時: ' + messageDate + '\n' +
                       '文頭:';

  // 3. 本文プレビューがある場合のみ、改行とプレビュー内容を追加する
  if (bodySnippet) {
    messageContent += '\n' + bodySnippet;
  }
  messageContent += '```';

  // 長いときを処理
  if (messageContent.length > 300) {
    messageContent = messageContent.substring(0, 300) + '...```';
  }

  messageContent += `[Gmailでメール全文を表示](${message.getThread().getPermalink()})`;

  // 通知 flags:4でサムネイル表示オフ 
  const payload = JSON.stringify({ 
    content: messageContent,
    flags: 4 
  });

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: payload
  };

  UrlFetchApp.fetch(config.webhookUrl, options);
}


