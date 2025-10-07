// 【インタラクション用Workerコード】
const STATUS = {
  PENDING: 'pending', // 要返信
  DONE: 'done',       // 返信済み
};

// メイン関数
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

    // スラッシュコマンド
    if (interaction.type === 2) {
      if (interaction.data.name === 'reminder') {
        ctx.waitUntil(handleCheckCommand(interaction, env));
        // 遅延応答
        return new Response(JSON.stringify({ type: 5 }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ボタン
    if (interaction.type === 3) {
      return handleButtonInteraction(interaction, env, ctx);
    }
        
    return new Response('Unknown interaction type.', { status: 400 });
  }, 
};
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

// 元のメッセージを編集する関数
async function editMessage(interaction, newPayload) {
  const endpoint = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newPayload),
  });
}

// スプレッドシートのステータスを更新する関数
// 秘密鍵はheadersに入れるとなぜかうまくいかなかったのでbodyへ
async function updateSheetStatus(env, messageId, status) {
  if (!env.GAS_WEBAPP_URL || !env.AUTH_SECRET) return;
  const response = await fetch(env.GAS_WEBAPP_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
       discordId: messageId, 
       status: status, 
       authKey: env.AUTH_SECRET 
    }),
  });
  return response;
}

// /reminderコマンドを処理する関数
async function handleCheckCommand(interaction, env) {
  try {
    // 1. GASから要返信リストを取得
    const response = await fetch(env.GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'get_pending_list',
        authKey: env.AUTH_SECRET
      }),
    });

    // 2. GASからの応答が成功したか確認
    const result = await response.json();
    if (!response.ok || result.status !== 'success') {
      const errorMessage = result.message || '不明なエラー';
      await editMessage(interaction, { content: `エラー：リストを取得できませんでした。\n\`\`\`${errorMessage}\`\`\`` });
      return;
    }

    // 3. 取得したリストからメッセージを作成, 編集
    const pendingList = result.data;
    let content = '';
    if (!pendingList || pendingList.length === 0) {
      content += '現在、要返信のメールはありません。';
    } else {
      content = '### リマインド\n';

      const groupedByMention = pendingList.reduce((acc, item) => {
        const key = item.mentionId || 'その他';
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
      }, {});

      for (const mentionId in groupedByMention) {
        content += `\n${mentionId}\n`;
        groupedByMention[mentionId].forEach(item => {
          const messageLink = `https://discord.com/channels/${interaction.guild_id}/${env.DISCORD_CHANNEL_ID}/${item.messageId}`;
          content += `- from: ${item.recipient}\n`;
          content += `${messageLink}\n`;
        });
      }
    }
    await editMessage(interaction, { content: content });
    
  } catch (error) {
    console.error("Error in handleCheckCommand:", error);
    try {
      await editMessage(interaction, { content: 'エラーが発生しました。Workerのログを確認してください。' });
    } catch (e) {
      console.error("Failed to send error message to Discord:", e);
    }
  }
}

// ボタン操作の処理する関数
async function handleButtonInteraction(interaction, env, ctx) {
  const customId = interaction.data.custom_id;
  const originalEmbed = interaction.message.embeds[0];
  let newPayload;
  let newStatus;

  // メッセージ内容
  if (customId === 'mark_as_done') {
    newStatus = STATUS.DONE;
    newPayload = {
      embeds: [{ ...originalEmbed, color: 3447003 }], // 青
      components: [{ type: 1, components: [
        { type: 2, style: 2, label: '対応済み', custom_id: 'action_completed', disabled: true, emoji: { name: '☑️' } },
        { type: 2, style: 4, label: '元に戻す', custom_id: 'mark_as_undone', emoji: { name: '↩️' } }
      ]}]
    };
  } else if (customId === 'mark_as_undone') {
    newStatus = STATUS.PENDING;
    newPayload = {
      embeds: [{ ...originalEmbed, color: 15548997 }], // 赤
      components: [{ type: 1, components: [
        { type: 2, style: 1, label: '返信不要', custom_id: 'mark_as_done', emoji: { name: '☑️' } }
      ]}]
    };
  } else {
    return; // 関係ないボタンなら終了
  }

  // バックグラウンドで実行する処理
  const errorText = '\n\n**エラー：** スプレッドシートへの書き込みに失敗しました。';
  const backgroundTask = async () => {
    // スプレッドシートの更新を試みる
    const sheetUpdateResponse = await updateSheetStatus(env, interaction.message.id, newStatus);
    const sheetUpdateResult = await sheetUpdateResponse.json();

    if (sheetUpdateResponse.ok && sheetUpdateResult.status === 'success') {
      // 成功→Discordメッセージを編集
      let cleanDescription = interaction.message.embeds[0].description;
      if (cleanDescription.includes(errorText)) {
        cleanDescription = cleanDescription.replace(errorText, ''); // エラーメッセージを消去
        const finalPayload = {
          embeds: [{ 
            ...interaction.message.embeds[0], 
            description: cleanDescription, 
            color: newStatus === STATUS.DONE ? 3447003 : 15548997
          }],
          components: newPayload.components
        };
        await editMessage(interaction, finalPayload);
      }  else { 
        await editMessage(interaction, newPayload);
      }
    } else {
      // 失敗→エラーメッセージでDiscordメッセージを編集
      const errorPayload = {
        embeds: [{
          ...originalEmbed,
          description: originalEmbed.description + '\n\n**エラー：** スプレッドシートへの書き込みに失敗しました。',
        }],
        components: interaction.message.components,
      };
      await editMessage(interaction, errorPayload);
    }
  };

  // 処理中
  ctx.waitUntil(backgroundTask());

  const processingPayload = {
    embeds: [originalEmbed], // Embedはそのまま
    components: [{ type: 1, components: [
      { type: 2, style: 2, label: '処理中...', custom_id: 'action_processing', disabled: true, emoji: { name: '⏳' } }
    ]}]
  };
  
  // Discordに「ボタンを『処理中…』に」と即時応答 (type: 7 = UPDATE_MESSAGE)
  return new Response(JSON.stringify({
    type: 7,
    data: processingPayload
  }), { headers: { 'Content-Type': 'application/json' } });
}