// 【インタラクション用Workerコード】
// 検証用関数 by web crypto API
async function verifyRequest(request, publicKey) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.clone().text();
  if (!signature || !timestamp) { return false; }
  const hexToUint8Array = (hex) => new Uint8Array(hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
  try {
    const signatureBytes = hexToUint8Array(signature);
    const publicKeyBytes = hexToUint8Array(publicKey);
    const key = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, true, ['verify']);
    const dataToVerify = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, dataToVerify);
  } catch (e) { return false; }
}

// スプレッドシートのステータスを更新する関数
async function updateSheetStatus(env, messageId, status) {
  if (!env.GAS_WEBAPP_URL) return;

  await fetch(env.GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discordMessageId: messageId,
      status: status,
    }),
  });
}

// 元のメッセージを編集する関数
async function editMessage(interaction, newPayload) {
  const endpoint = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newPayload),
  });
}

// /checkコマンドを処理する関数
async function handleCheckCommand(interaction, env) {
  try {
    // 1. GASから「要返信」リストを取得
    const response = await fetch(env.GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_pending_list' }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      await editMessage(interaction, { content: `エラー：リストを取得できませんでした。\n\`\`\`${errorText}\`\`\`` });
      return;
    }
    const pendingList = await response.json();

    // 2. 取得したリストからメッセージを作成
    let content = '### リマインド\n';
    if (pendingList.length === 0) {
      content += '現在、要返信のメールはありません。';
    } else {
      pendingList.forEach(item => {
        const messageLink = `https://discord.com/channels/${interaction.guild_id}/${env.DISCORD_CHANNEL_ID}/${item.messageId}`;
        content += `・${item.mentionId||""} from:${item.recipient} - ${messageLink}\n`;
      });
    }

    // 3. 既存のeditMessage関数を使って、考え中のメッセージを最終的な内容に編集する
    await editMessage(interaction, { content: content });

  } catch (error) {
    // 予期せぬエラーが発生した場合
    console.error("Error in handleCheckCommand:", error);
    try {
      await editMessage(interaction, { content: 'エラーが発生しました。Workerのログを確認してください。' });
    } catch (e) {
      console.error("Failed to send error message to Discord:", e);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    // セキュリティ検証
    const isValidRequest = await verifyRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!isValidRequest) {
      return new Response('Bad request signature.', { status: 401 });
    }

    const interaction = await request.json(); // 送られてきたデータをJSONとして解釈

    // PING
    if (interaction.type === 1) { return new Response(JSON.stringify({ type: 1 })); }

    // スラッシュコマンド（APPLICATION_COMMAND）を処理
    if (interaction.type === 2) {
      if (interaction.data.name === 'check') {
        // GASからリスト取得をバックグラウンドで実行
        ctx.waitUntil(handleCheckCommand(interaction, env));
        // 「考え中...」と即時応答
        return new Response(JSON.stringify({ type: 5 }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ボタン
    if (interaction.type === 3) {
      const customId = interaction.data.custom_id;
      const originalEmbed = interaction.message.embeds[0];
      let newPayload;
      let newStatus;

      // 「返信不要」が押された場合
      if (customId === 'mark_as_done' || customId === 'mark_as_done_again') {
        newPayload = {
          embeds: [{ ...originalEmbed, color: 3447003 }], // 青
          components: [{
            type: 1,
            components: [
              { type: 2, style: 2, label: '対応済み', custom_id: 'action_completed', disabled: true, emoji: { name: '☑️' } },
              { type: 2, style: 4, label: '元に戻す', custom_id: 'mark_as_undone', emoji: { name: '↩️' } }
            ],
          }],
        };
        newStatus = '返信済み';
      } 
      // 「元に戻す」が押された場合
      else if (customId === 'mark_as_undone') {
        newPayload = {
          embeds: [{ ...originalEmbed, color: 15548997 }], // 赤
          components: [{
            type: 1,
            components: [
              { type: 2, style: 1, label: '返信不要', custom_id: 'mark_as_done', emoji: { name: '☑️' } },
            ],
          }],
        };
        newStatus = '要返信';
      }

      if (newPayload && newStatus) {
        // Discordメッセージ編集とスプレッドシート更新
        ctx.waitUntil(Promise.all([
          editMessage(interaction, newPayload),
          updateSheetStatus(env, interaction.message.id, newStatus)
        ]));
        // 遅延応答
        return new Response(JSON.stringify({ type: 6 }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    return new Response('Unknown interaction type.', { status: 400 });
  },
}; 