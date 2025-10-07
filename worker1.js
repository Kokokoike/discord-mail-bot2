// 【通知用Workerコード】 
// Embedsを組み立てる関数
function buildDiscordEmbed(mailData) {
  const { subject, from, date, bodySnippet, gmailLink } = mailData;
  const descriptionString =
    `**件名\n** ${subject}\n` +
    `**送信者\n** ${from}\n` +
    `**受信日時\n** ${date}\n\n` +
    '**▼ 本文プレビュー** ' +`[Gmailでメール全文を表示](${gmailLink})\n` +
    bodySnippet;
  const embed = { type: 'rich', color: 15548997, description: descriptionString.substring(0, 4000) };
  return embed;
}

// ボタン
function buildDiscordComponents() {
  const buttons = [{ type: 2, style: 1, label: '返信不要', custom_id: 'mark_as_done', emoji: { name: '☑️' } }];
  return [{ type: 1, components: buttons }];
}

// 新規メッセージの投稿
async function sendToDiscord(channelId, botToken, payload) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages?wait=true`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// 既存メッセージの編集
async function editDiscordMessage(channelId, botToken, messageId, payload) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// 既存メッセージの取得
async function getOriginalMessage(channelId, botToken, messageId) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bot ${botToken}` },
    });
    if (!response.ok) return null;
    return await response.json();
}

// --- メインの処理 ---
export default {
  async fetch(request, env) {
    const { DISCORD_TOKEN, CHANNEL_ID } = env;
    if (!DISCORD_TOKEN || !CHANNEL_ID) {
      return new Response('BotのトークンまたはチャンネルIDが設定されていません。', { status: 500 });
    }
    if (request.method !== 'POST') {
      return new Response('POSTリクエストのみ受け付けます。', { status: 405 });
    }
    try {
      // GASから送られてきたJSONデータを取得
      const mailData = await request.json();

      // 返信済みにする処理
      if (mailData.action === 'update_as_replied') {
        // 元のメッセージを取得
        const originalMessage = await getOriginalMessage(CHANNEL_ID, DISCORD_TOKEN, mailData.discordMessageId);
        if (!originalMessage || !originalMessage.embeds || originalMessage.embeds.length === 0) {
          return new Response('Original message or its embed was not found.', { status: 404 });
        }
        const originalEmbed = originalMessage.embeds[0];
        
        // 「返信済み」に対応
        const repliedPayload = {
          embeds: [{
            ...originalEmbed,
            color: 3447003, // 青
          }],
          components: [{
            type: 1,
            components: [
                { type: 2, style: 2, label: '返信済み', custom_id: 'action_replied', disabled: true, emoji: { name: '📩' } },
            ],
          }],
        };
        
        //更新
        const res = await editDiscordMessage(CHANNEL_ID, DISCORD_TOKEN, mailData.discordMessageId, repliedPayload);
        if (!res.ok) {
          const errorText = await res.text();
          return new Response(`Discord API on edit failed: ${errorText}`, { status: res.status });
        }
        return new Response('Message updated successfully.', { status: 200 });

      } else { // 新規投稿処理
          const discordPayload = {
            content: mailData.mentionId || 'メールが届きました',
            embeds: [buildDiscordEmbed(mailData)],
            components: buildDiscordComponents(),
          };
          const res = await sendToDiscord(CHANNEL_ID, DISCORD_TOKEN, discordPayload);
          const responseBody = await res.json();
          if (!res.ok) {
            const errorText = await res.text();
            return new Response(`Discord API on edit failed: ${errorText}`, { status: res.status });
          }
          return new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('リクエストの処理中に内部エラーが発生しました。', { status: 500 });
    }
  },
};