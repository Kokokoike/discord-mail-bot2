// 新着メール
function processIncomingMail(message, config, data) {
  Logger.log(`ProcessingIncomigMail: ${message.getSubject()}`);
  
  const body = message.getPlainBody().replace(/\s/g, '');
  const mentionId = findMentionTarget(message, data, config.mailAddress, body);

  const workersPayload = {
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
    payload: JSON.stringify(workersPayload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(config.cloudflareURL, options);
  if (response.getResponseCode() === 200) {
    const discordMessage = JSON.parse(response.getContentText());
    const fromAddress = extractEmailAddress(message.getFrom());
    if (fromAddress) {
      writeToSheet(fromAddress, discordMessage.id, message.getId(), mentionId);
    }
  } else {
    Logger.log(`Error notifying: ${response.getContentText()}`);
  }
}

//自分からの返信メール
function processSentMail(message, config) {
  Logger.log(`ProcessingSentMail: ${message.getSubject()}`);
  
  const recipients = (message.getTo() + "," + message.getCc()).split(',');
  for (let i = 0; i < recipients.length; i++) {
    const recipientAddress = extractEmailAddress(recipients[i]);
    if (recipientAddress) {
      // 更新されたDiscordメッセージIDの【配列】を取得
      const discordMessageIds = findAllAndUpdateSheet(recipientAddress, message.getId());
      // 配列内の全てのIDに対して更新を依頼
      for (let k = 0; k < discordMessageIds.length; k++) {
        triggerDiscordUpdate(config.cloudflareURL, discordMessageIds[k]);
      }
    }
  }
}
