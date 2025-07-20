const SHEET_NAME = 'シート1';

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
    lastSentId: properties.getProperty("LAST_SENT_ID") || '0',
  };

  const inboxThreads = GmailApp.getInboxThreads(0, 20);
  let latestId = config.lastId;
  for (let i = 0; i < inboxThreads.length; i++) {
    const messages = inboxThreads[i].getMessages();

    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      const messageId = message.getId();

      if (messageId > config.lastId) {
        // 自分宛でなければ除外
        const recipients = message.getTo() + message.getCc() + message.getBcc();
        if (!recipients.includes(config.mailAddress)) continue;
        // 自分自身からのメールは処理しない
        if (message.getFrom().includes(config.mailAddress)) continue;
            
        processIncomingMail(message, config, data);

        if (messageId > latestId) {
          latestId = messageId;
        }
      } else {
        break; // 処理済みのメールに到達したらループを抜ける
      }
    }
  }

  // --- 2. 送信トレイのチェック ---
  // Gmailと連携したアカウントの場合in:sentは使えないので要変更
  const sentThreads = GmailApp.search('in:sent', 0, 20);
  let latestSentId = config.lastSentId;
  for (let i = 0; i < sentThreads.length; i++) {
    const messages = sentThreads[i].getMessages();

    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      const messageId = message.getId();

      if (messageId > config.lastSentId) {
        // 自分自身からでないメールは処理しない
        if (!message.getFrom().includes(config.mailAddress)) continue;

        processSentMail(message, config);
        if (messageId > latestSentId) {
          latestSentId = messageId;
        }
      } else {
        break; // 処理済みのメールに到達したらループを抜ける
      }
    }
  }

  // 最後に処理したIDを保存
  if (latestId > config.lastId) {
    properties.setProperty("LAST_ID", latestId);
  } else if (latestSentId > config.lastSentId) {
    properties.setProperty("LAST_SENT_ID", latestSentId);
  } else {
    Logger.log('No new emails found.');
  }
}