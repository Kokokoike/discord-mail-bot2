# 新着メールBot

Jizi渉外企業用のBotです。新着メールをDiscordへ通知します。

## 主な機能と使い方

  - 新着メールをDiscordの指定のチャンネルへ、メンション付きで通知します。
  - 各メール通知の対応状況を「要返信 (`pending`)」(赤色)「対応済み (`done`)」(青色)で管理します。
    - 返信が不要なメールへは「返信不要」のボタンを押すことで「対応済み」とします。
    - Jiziから返信した場合、自動で「対応済み」とします。
  - `/reminder` スラッシュコマンドを実行すると、要返信のメールの一覧をメンション付きで表示します。
  - スクリプトの実行中にエラーが発生した場合、指定したWebhook URLにエラー内容を通知します。

## 注意点

  - 通知は10分おき
  - Googleへメールアカウントを紐づけるとき、Googleがメールを取得するのが約1時間おき

## セットアップ

### 必要なもの
  - Discordサーバーとその管理権限
  - Googleアカウント
  - Cloudflare Workersアカウント

### ① Discordの準備

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセスし、ログインします。
    - 「New Application」より新しいアプリケーションを作成します。
    -「Bot」\>「Reset Token」より、トークンをコピーします。(③.2の`DISCORD_TOKEN`)
    - 「OAuth2」\>「URL Generator」で、「Scopes」\>`bot` `applications.commands`にチェックを入れた後、「Bot Permission」\>`Send Messages` `Manage Message`を選択します。
    - 「OAuth2」\>「Generated URL」にアクセスし、サーバーにBotを招待します。
2. Discordサーバー
    - サーバーIDと通知を送信したいチャンネルIDを取得します。(「開発者モード」をオンにする必要があります)
    - エラーログを投稿するチャンネルの「連携サービス」設定から、新しいWebhookを作成し、そのURLをコピーします。(#DISCORD_WEBHOOK_URL)

### ②使用するメールアドレスのGoogleアカウントへの紐づけ

1. 「Gmail」\>「設定」\>「すべての設定を表示」より詳細設定へ移動します。
2. 「アカウントとインポート」\>「他のアカウントのメールを確認」より対象のメールアドレスをGoogleアカウントへ紐づけます。

### ③ Google Workspaceの準備

1. 「ドライブ」\>「新規」\>「Googleスプレッドシート」より 新しいスプレッドシートを作成します。
2. 「シート1」「EmailLog」の2つのシートを作成します。
3. 「シート1」にメンションを行うメンバーのリストを入力します。(例：example.xlsx)
      - A列:：`フルネーム`
      - B列： `苗字`
      - C列： `ユーザーID`
4.  「拡張機能」\>「Apps Script」より、新しいプロジェクトを作成します。
      - 「エディタ」\>「コード.gs」へ、`Gas.gs`を貼り付けます。
      - 「プロジェクトの設定」\>「スクリプトプロパティ」に以下を追加・設定します。
          - `CLOUDFLARE_URL`:<a id=""></a>
          - `DISCORD_WEBHOOK_URL`:<a id="DISCORD_WEBHOOK_URL"></a>
          - `AUTH_SECRET`: WorkerとGAS間で共有する秘密の認証キー
          - `MAIL_ADDRESS`: 対象のメールアドレス
          - `LAST_ID`
          - `LAST_TIMESTAMP`
      - 「トリガー」\>「トリガーを追加」より、トリガーを設定します。
          - 「実行する関数を選択」:`checkMailAndNotify`
          - 「イベントのソースを選択」:`時間主導型`
          - 「時間ベースのトリガーのタイプを選択」「時間の間隔を選択」:通知させたい間隔
      - 「デプロイ」\>「新しいデプロイ」
          - 「種類の選択」:`ウェブアプリ`
          - **次のユーザーとして実行**: `自分`
          - **アクセスできるユーザー**: `全員`
          - デプロイ後、ウェブアプリのURLをコピーしておきます。

### 3\. Cloudflare Workersの準備

`wrangler` CLIを使用して、2つのWorkerプロジェクトを作成します。

#### A. 通知用Worker

1.  `wrangler init notification-worker` でプロジェクトを作成します。
2.  `src/index.js`に、通知用のWorkerコード (`code_worker1_2.txt`) を貼り付けます。
3.  `wrangler.toml`を設定し、`wrangler secret put`コマンドで以下のシークレットを設定します。
      - `DISCORD_TOKEN`: (Discord Botのトークン)
      - `DISCORD_CHANNEL_ID`: (通知用チャンネルID)
      - `AUTH_SECRET`: (GASと共有する認証キー)
4.  `wrangler deploy`でデプロイし、発行されたURLをGASの`CLOUDFLARE_WORKER_URL`に設定します。

#### B. インタラクション用Worker

1.  `wrangler init interaction-worker` でプロジェクトを作成します。
2.  `src/index.js`に、インタラクション用のWorkerコード (`code_worker2_2.txt`) を貼り付けます。
3.  `wrangler.toml`を設定し、`wrangler secret put`コマンドで以下のシークレットを設定します。
      - `DISCORD_PUBLIC_KEY`: (Discordアプリの公開鍵)
      - `DISCORD_TOKEN`: (Discord Botのトークン)
      - `DISCORD_CHANNEL_ID`: (通知用チャンネルID)
      - `GAS_WEBAPP_URL`: (GASのウェブアプリURL)
      - `AUTH_SECRET`: (GASと共有する認証キー)
4.  `wrangler deploy`でデプロイします。

### 4\. 最終接続

1.  **インタラクションエンドポイントの設定**: Discord Developer Portalのアプリケーション設定ページで、「Interactions Endpoint URL」に**インタラクション用Worker**のURLを設定し、保存します。
2.  **スラッシュコマンドの登録**: 以下のcurlコマンドを実行して、`/reminder`コマンドをDiscordに登録します。（`<YOUR_APP_ID>`と`<YOUR_BOT_TOKEN>`を置き換えてください）
    ```bash
    curl -X POST \
      -H "Authorization: Bot <YOUR_BOT_TOKEN>" \
      -H "Content-Type: application/json" \
      -d '{
            "name": "reminder",
            "description": "未対応のメール一覧をリマインドします。",
            "type": 1
          }' \
      "https://discord.com/api/v10/applications/<YOUR_APP_ID>/commands"
    ```

これで全てのセットアップは完了です！

## システム構成図

このシステムは、以下のサービスを連携させて動作します。

```
+----------------+      1. 1分ごとに受信/送信メールをチェック      +-------------------+
| Gmail Inbox    | <------------------------------------------+ Google Apps Script|
+----------------+                                            +-------------------+
        |                                                                | 2. 新着メールをWorkerに通知
        | 5. スプレッドシートを更新                                        | 3. ステータスを記録
        +----------------------------------------------------------------+
                                                                         |
+----------------+      4. Discordに通知投稿      +-----------------------+      +---------------+
| Discord Channel| <--------------------------+ Cloudflare Worker (Notif) |      | Google Sheet  |
+----------------+                            +-----------------------+      +---------------+
        |                                                                        ^
        | 6. ボタン/コマンド操作                                                 |
        v                                                                        |
+------------------------+     7. GAS Web Appにステータス更新を依頼      +------------+
|Cloudflare Worker (Interact)| ----------------------------------------> | GAS Web App|
+------------------------+                                             +------------+

```

  - **Google Apps Script (GAS)**: システムの中核。Gmailのチェック、Google Sheetへの記録、Cloudflare Workerへの通知トリガー、そしてWorkerからのリクエストを処理するAPIとして機能します。
  - **Google Sheets**: 各メールの対応状況を管理する簡易データベース。
  - **Cloudflare Workers (2つ)**:
    1.  **通知用Worker**: GASからのトリガーを受けて、Discordに新着メール通知を投稿します。
    2.  **インタラクション用Worker**: Discordからのスラッシュコマンドやボタン操作を受け取り、セキュリティ検証を行った上でGAS Web Appに処理を依頼します。
  - **Discord**: ユーザーとのインターフェース。通知の表示と操作を行います。

## ライセンス

This project is licensed under the MIT License.
