# TikTok LIVE スカウト自動化ツール

TikTok LIVEの配信者を自動収集し、Gemini Vision APIで性別判定、Google Sheetsへの記録、Gmailでの通知までを一括自動化するツール。

## 全体フロー

```
[Docker] collect スクリプト
  ↓ TikTok /live フィードに入る
  ↓ ↓ボタンで次のLIVEに順送り（Phase 1: URL収集）
  ↓ 各LIVEページにアクセスしてメタデータ+サムネイル取得（Phase 2）
  ↓ Google Sheets に候補を記録 + output/latest-run.json を出力
  ↓
[Docker] n8n ワークフロー
  ↓ latest-run.json を読み込み
  ↓ サムネイル画像を Gemini Vision API に送信 → 性別判定
  ↓ 女性と判定された候補を Google Sheets "scouted" タブに追記
  ↓ Gmail で通知
```

## 必要なもの

- Docker / Docker Compose
- Google Cloud プロジェクト（Sheets API, Gmail API 有効）
- Google サービスアカウント
- Gemini API キー
- Google OAuth クライアントID/シークレット（n8n用）

## セットアップ手順

### 1. Google Cloud 設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 以下のAPIを有効化:
   - Google Sheets API
   - Gmail API
3. **サービスアカウント**を作成:
   - IAM → サービスアカウント → 作成
   - JSON鍵をダウンロード
   - メールアドレスと秘密鍵を控える
4. **OAuthクライアント**を作成（n8n用）:
   - API → 認証情報 → OAuthクライアントID → ウェブアプリケーション
   - リダイレクトURI: `http://localhost:5678/rest/oauth2-credential/callback`
   - クライアントIDとシークレットを控える

### 2. Google Sheets 準備

1. スプレッドシートを作成
2. 「scouted」タブを追加
3. サービスアカウントのメールアドレスを**編集者**として共有
   - 例: `your-bot@project-id.iam.gserviceaccount.com`

### 3. Gemini API キー取得

1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. APIキーを作成

### 4. .env.local 作成

プロジェクトルートに `.env.local` を作成:

```env
# Google Sheets（必須）
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-bot@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_SHEETS_SOURCE_SHEET_NAME=source_candidates

# Gemini Vision API（必須）
GEMINI_API_KEY=your_gemini_api_key

# 収集設定（任意）
COLLECT_MODE=navigate
MAX_COLLECT=100
MIN_FOLLOWERS=0
NAV_FAIL_LIMIT=3
```

### 5. Docker 起動

```bash
# 収集実行（テスト: 5件、Sheets書き込みスキップ）
docker compose run --rm -e SKIP_SHEETS=true -e MAX_COLLECT=5 collect

# 収集実行（本番: 100件）
docker compose run --rm collect

# n8n 起動
docker compose up -d n8n
```

### 6. n8n 設定（初回のみ）

1. http://localhost:5678 にアクセス
2. **Credentials** で以下を設定:
   - **Google Sheets account**: OAuth認証（手順1で作成したクライアントID/シークレットを使用）
   - **Gmail account**: OAuth認証（同じクライアントID/シークレットでOK）
3. ワークフロー「TikTok LIVE Scout Pipeline」を開く
4. 「Notify Gmail」ノードの送信先メールアドレスを確認
5. **Test workflow** ボタンで動作確認

## 使い方

### 通常の収集

```bash
# 100件収集してGoogle Sheetsに記録
docker compose run --rm collect

# n8nで性別判定→スカウト
# n8n UIでワークフローを手動実行、またはScheduleトリガーで自動化
```

### オプション

```bash
# 収集件数を変更
docker compose run --rm -e MAX_COLLECT=200 collect

# フォロワー1000人以上のみ収集
docker compose run --rm -e MIN_FOLLOWERS=1000 collect

# Sheets書き込みなしでテスト
docker compose run --rm -e SKIP_SHEETS=true -e MAX_COLLECT=5 collect
```

## 環境変数一覧

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | - | サービスアカウントのメール |
| `GOOGLE_PRIVATE_KEY` | Yes | - | サービスアカウントの秘密鍵 |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Yes | - | スプレッドシートのID |
| `GOOGLE_SHEETS_SOURCE_SHEET_NAME` | No | `source_candidates` | 書き込み先タブ名 |
| `GEMINI_API_KEY` | Yes | - | Gemini Vision APIキー |
| `COLLECT_MODE` | No | `navigate` | 収集モード（`navigate` / `scroll`） |
| `MAX_COLLECT` | No | `100` | 最大収集件数 |
| `MIN_FOLLOWERS` | No | `0` | フォロワー数の足切り |
| `NAV_FAIL_LIMIT` | No | `3` | ↓ボタン連続失敗の停止閾値 |
| `SKIP_SHEETS` | No | `false` | `true`でSheets書き込みスキップ |
| `BROWSER_MODE` | No | `launch` | ブラウザモード（通常は変更不要） |

## トラブルシューティング

### Google Sheets に書き込めない (403 Forbidden)
- サービスアカウントのメールアドレスがスプレッドシートに「編集者」として共有されているか確認
- Google Cloud プロジェクトで Sheets API が有効か確認

### n8n の Google Sheets / Gmail で認証エラー
- OAuth同意画面のスコープに `spreadsheets` と `gmail.send` が含まれているか確認
- n8n の Credentials で「Sign in with Google」を再実行

### サムネイルが取得できない
- TikTokのカバー画像URLが変更された可能性。`output/screenshots/` のファイルサイズが極端に小さい（<1KB）場合は取得失敗

### 性別判定が全て unknown になる
- Gemini API キーが有効か確認
- n8n ワークフローの Gemini Vision Gender ノードでAPI keyが正しいか確認
