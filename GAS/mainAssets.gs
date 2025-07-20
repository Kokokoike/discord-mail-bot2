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
  for (const row of data) {
    const fullName = row[0];
    if (fullName && plainBody.includes(fullName.replace(/\s/g, ''))) {
      return `<@${row[2]}>`;
    }
  }

  // 3. 受信メール本文から「苗字＋様」を検索
  for (const row of data) {
    const lastName = row[1];
    if (lastName && plainBody.includes(lastName + '様')) {
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