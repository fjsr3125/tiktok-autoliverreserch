# TikTok LIVE スカウト自動化ツール

TikTok LIVEの配信者を自動で収集し、AI（Gemini Vision）で性別を判定、Google Sheetsに記録、条件に合う人をGmailで通知するツールです。

## このREADMEでできること

このガイドに従うと、以下が動く状態になります：

1. **collect** — TikTok LIVEを巡回して配信者を自動収集（サムネイル画像+フォロワー数など）
2. **n8n** — 収集結果をAIで判定し、Google Sheetsに保存、Gmailで通知

UTM（ローカルVM）でもVPS（レンタルサーバー）でも、同じ手順で進められます。

### 成功の基準

- [ ] `collect` を実行して1件以上の配信者が取得できる
- [ ] Google Sheets に収集データが記録される
- [ ] n8n でワークフローを実行して、Gmailに通知が届く

> **大事**: 最初は「手動で1回成功」をゴールにしてください。自動化は最後のステップです。

---

## 始める前チェックリスト

先に進む前に、以下を全て揃えてください。

### 手元のPC

- [ ] ターミナル（Mac: Terminal.app / Windows: PowerShell or WSL）が使える
- [ ] SSH接続できる（Macなら標準で可能）
- [ ] ブラウザ（Chrome推奨）

### サーバー側

- [ ] Ubuntu 22.04 または 24.04 がインストール済み
  - UTMの場合: Ubuntu Serverをインストール済み
  - VPSの場合: 契約済み、IPアドレスとログイン情報がある

### Google アカウント

- [ ] Google アカウントを持っている
- [ ] Google Cloud Console（https://console.cloud.google.com/）にログインできる

> 全部チェックがつくまで次に進まないでください。

---

## メモしておく値

README全体で使う値です。先にメモしておくと、後のコマンドがコピペだけで進みます。

| 項目 | 値 | どこで使う |
|------|-----|-----------|
| サーバーIP | `___________` | SSH接続 |
| サーバーユーザー名 | `___________` | SSH接続 |
| スプレッドシートID | `___________` | .env.local |
| サービスアカウントメール | `___________` | .env.local |
| サービスアカウント秘密鍵 | `___________` | .env.local |
| Gemini APIキー | `___________` | .env.local |
| OAuthクライアントID | `___________` | n8n設定 |
| OAuthクライアントシークレット | `___________` | n8n設定 |
| 通知先メールアドレス | `___________` | n8nワークフロー |
| n8nログインパスワード | `___________` | .env.local |

---

## 全体の構成図

```
あなたのPC                          サーバー（UTM or VPS）
  │                                  ┌──────────────────────┐
  │  SSH接続                         │  Docker               │
  ├──────────────────────────────────►│                      │
  │                                  │  ┌─────────┐         │
  │                                  │  │ collect  │→ TikTok │
  │                                  │  │(収集)    │  LIVE   │
  │                                  │  └────┬────┘         │
  │                                  │       │ JSON+画像     │
  │  SSHトンネル                      │  ┌────▼────┐         │
  │  localhost:5678 ←─────────────────│  │  n8n    │         │
  │  （ブラウザでn8n操作）             │  │(判定)   │         │
  │                                  │  └────┬────┘         │
  │                                  │       │              │
  │                                  │  Gemini API          │
  │                                  │  Google Sheets       │
  │                                  │  Gmail               │
  │                                  └──────────────────────┘
```

### 進める順番

```
① Ubuntu初期設定 → ② Docker導入 → ③ プロジェクト配置
→ ④ Google設定 → ⑤ n8n起動 → ⑥ collect手動実行
→ ⑦ 全体テスト → ⑧ 自動実行
```

---

## UTM と VPS の違い

| | UTM（ローカルVM） | VPS（レンタルサーバー） |
|---|---|---|
| 用途 | 練習用 | 本番用 |
| IP確認方法 | VM内で `ip a` | 契約画面で確認 |
| SSH接続 | `ssh ユーザー名@ローカルIP` | `ssh ユーザー名@グローバルIP` |
| Ubuntu操作 | **全く同じ** | **全く同じ** |

> UTMで一通り成功したら、VPSでも同じ手順をやるだけです。

---

## ① Ubuntu に入る

### UTM の場合

VMを起動してログインします。ローカルIPを確認：

```bash
ip a
# 「inet 192.168.x.x」のような数字がIPアドレス
```

別のターミナルからSSHで接続：

```bash
ssh あなたのユーザー名@192.168.x.x
```

### VPS の場合

契約画面でIPアドレスとパスワードを確認し、SSHで接続：

```bash
ssh root@あなたのIPアドレス
```

### 接続できたら初期更新

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw
```

### 確認

```bash
hostnamectl
# 「Ubuntu 22.04」や「Ubuntu 24.04」と表示されればOK
```

---

## ② セキュリティ設定

> **なぜ必要？** サーバーはインターネットに公開されています。最低限の防御をしないと、他人にログインされる可能性があります。

### 作業用ユーザーを作る（VPSでrootログインの場合）

```bash
sudo adduser deploy
# パスワードを設定（他の質問はEnterでスキップ）
sudo usermod -aG sudo deploy
```

### SSH公開鍵を設定（手元のPCで実行）

```bash
# 鍵がまだ無い場合のみ実行
ssh-keygen -t ed25519
# 全部Enterでデフォルトのまま

# サーバーに鍵を送る
ssh-copy-id deploy@あなたのIPアドレス
```

### ファイアウォールを有効化（サーバーで実行）

```bash
sudo ufw allow OpenSSH
sudo ufw enable
# 「Command may disrupt existing SSH connections. Proceed?」→ y
```

### 確認

```bash
# 別ターミナルから接続できることを確認してから次へ
ssh deploy@あなたのIPアドレス

# ファイアウォール状態
sudo ufw status
# 「OpenSSH  ALLOW  Anywhere」と出ればOK
```

---

## ③ Docker を入れる

> **なぜDocker？** このツールはPlaywright（ブラウザ自動化）を使います。Dockerがないと、ブラウザや依存ライブラリを手動でインストールする必要があり非常に面倒です。

### Docker公式の手順でインストール

```bash
# 古いDockerがあれば削除
sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null

# 公式リポジトリを追加
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# インストール
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 自分のユーザーをdockerグループに追加（sudo不要になる）
sudo usermod -aG docker $USER
```

### **重要**: 一度ログアウトして再ログイン

```bash
exit
ssh deploy@あなたのIPアドレス
```

### 確認

```bash
docker version
# 「Server: Docker Engine」が表示されればOK

docker compose version
# 「Docker Compose version v2.x.x」が出ればOK

docker run hello-world
# 「Hello from Docker!」が出ればOK
```

---

## ④ プロジェクトを配置する

```bash
cd ~
git clone https://github.com/あなたのリポジトリURL.git tiktok-autoliverreserch
cd tiktok-autoliverreserch
```

### 確認

```bash
ls
# Dockerfile  docker-compose.yml  README.md  src/  ... が見えればOK
```

---

## ⑤ Google の設定

### 5-1. Google Cloud プロジェクトを作る

1. https://console.cloud.google.com/ にアクセス
2. 上部の「プロジェクトを選択」→「新しいプロジェクト」
3. 名前をつけて作成（例: `tiktok-scout`）

### 5-2. APIを有効化する

1. 左メニュー →「APIとサービス」→「ライブラリ」
2. 以下を検索して「有効にする」：
   - **Google Sheets API**
   - **Gmail API**

### 5-3. サービスアカウントを作る（collect用）

> **サービスアカウントとは？** プログラムが Google にアクセスするための専用アカウントです。あなた個人のアカウントとは別物です。

1. 左メニュー →「IAMと管理」→「サービスアカウント」
2. 「サービスアカウントを作成」
3. 名前: `tiktok-bot`、作成
4. 作成したアカウントをクリック →「鍵」タブ →「鍵を追加」→「新しい鍵を作成」→ JSON
5. ダウンロードされた JSON ファイルを開き、以下をメモ：
   - `client_email` → **サービスアカウントメール**
   - `private_key` → **秘密鍵**（`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----\n` まで全部）

### 5-4. スプレッドシートを準備する

1. Google Sheets で新しいスプレッドシートを作成
2. URLからIDをコピー（`https://docs.google.com/spreadsheets/d/ここがID/edit`）
3. 「scouted」という名前のタブ（シート）を追加
4. **共有** → サービスアカウントのメールアドレスを「編集者」として追加

### 5-5. Gemini API キーを取得する

1. https://aistudio.google.com/ にアクセス
2. 「Get API Key」→ APIキーを作成
3. キーをメモ

### 5-6. OAuth クライアントを作る（n8n用）

> **OAuthとは？** n8n があなたの代わりに Google Sheets / Gmail にアクセスするための許可の仕組みです。

1. Google Cloud Console →「APIとサービス」→「認証情報」
2. 「認証情報を作成」→「OAuthクライアントID」
3. アプリケーションの種類: **ウェブアプリケーション**
4. 名前: `n8n`
5. 承認済みリダイレクトURI: `http://localhost:5678/rest/oauth2-credential/callback`
6. 作成 → **クライアントID** と **クライアントシークレット** をメモ

> OAuth同意画面の設定を求められたら：ユーザーの種類「外部」、アプリ名を適当に入力、スコープは追加不要。

### 確認

「メモしておく値」の表が全部埋まっていること。

---

## ⑥ .env.local を作る

```bash
cd ~/tiktok-autoliverreserch
cp .env.example .env.local
nano .env.local
```

以下の値を書き換えます（`nano` エディタの使い方: 矢印キーで移動、書き換え後 `Ctrl+O` → `Enter` で保存、`Ctrl+X` で終了）：

```env
# --- 必須 ---
GOOGLE_SERVICE_ACCOUNT_EMAIL=あなたのサービスアカウントメール
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nここに秘密鍵\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEETS_SPREADSHEET_ID=あなたのスプレッドシートID
GEMINI_API_KEY=あなたのGemini APIキー

# --- 任意（変更しなくてもOK） ---
COLLECT_MODE=navigate
MAX_COLLECT=100
MIN_FOLLOWERS=0
```

> **注意**: `GOOGLE_PRIVATE_KEY` は改行を `\n` に置き換えた1行で書いてください。JSONファイルからコピーした値をそのまま貼ればOKです。

### 確認

```bash
grep -c "GOOGLE_SERVICE_ACCOUNT_EMAIL=.\+" .env.local
grep -c "GOOGLE_PRIVATE_KEY=.\+" .env.local
grep -c "GOOGLE_SHEETS_SPREADSHEET_ID=.\+" .env.local
grep -c "GEMINI_API_KEY=.\+" .env.local
# 全て「1」と表示されればOK
```

---

## ⑦ n8n を起動する

### n8n を安全に使う

> **重要**: n8n はワークフロー管理ツールで、Web画面があります。セキュリティのため、外部から直接アクセスせず、SSHトンネル経由で使います。

```bash
# サーバーで実行
docker compose up -d n8n
```

### 確認（サーバーで）

```bash
docker ps
# n8n が「Up」になっていればOK
```

### SSHトンネルでn8nにアクセス（手元のPCで実行）

```bash
ssh -L 5678:localhost:5678 deploy@あなたのIPアドレス
```

この状態でブラウザから `http://localhost:5678` を開くと、n8nのログイン画面が表示されます。

### n8n に Google 認証を設定

1. n8n にログイン
2. 左メニュー → **Credentials**
3. **Add Credential** → 「Google Sheets OAuth2 API」を選択
   - Client ID: メモしたOAuthクライアントID
   - Client Secret: メモしたOAuthクライアントシークレット
   - **Sign in with Google** をクリック → 許可
4. 同様に「Gmail OAuth2 API」も追加（同じID/Secretでも）

### 確認

Credentials 一覧で Google Sheets と Gmail の両方に緑のチェックがついていればOK。

---

## ⑧ collect を手動で1回動かす

> まず Sheets 書き込みなし・少量でテストします。

```bash
cd ~/tiktok-autoliverreserch
docker compose run --rm -e SKIP_SHEETS=true -e MAX_COLLECT=5 collect
```

### 確認

```bash
# 収集結果を確認
cat output/latest-run.json | head -20
# 「collectedCount」が1以上ならOK

# スクリーンショットを確認
ls -la output/screenshots/ | head -10
# ファイルが存在し、サイズが1KB以上ならOK
```

### Sheets書き込みも含めて実行

```bash
docker compose run --rm -e MAX_COLLECT=5 collect
```

Google Sheets を開いて `source_candidates` タブにデータが入っていればOK。

---

## ⑨ 全体テスト

n8n のワークフロー「TikTok LIVE Scout Pipeline」を開いて **Test workflow** をクリック。

### 確認

- [ ] n8n の実行履歴が全て緑（エラーなし）
- [ ] Google Sheets の「scouted」タブに女性と判定された候補が記録されている
- [ ] Gmail に通知メールが届いている

> 全部チェックがつけば**手動での全体テスト完了**です。

---

## ⑩ 自動実行にする

### collect を定期実行する（systemd timer）

> **systemd timer とは？** Linux の標準スケジューラーです。「30分ごとに collect を実行」のようなことができます。

#### サービスファイルを作成

```bash
sudo nano /etc/systemd/system/tiktok-collect.service
```

以下を貼り付け（`deploy` と パスは自分の環境に合わせてください）：

```ini
[Unit]
Description=TikTok LIVE Collect
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
User=deploy
WorkingDirectory=/home/deploy/tiktok-autoliverreserch
ExecStart=/usr/bin/docker compose run --rm collect
TimeoutStartSec=600
```

#### タイマーファイルを作成

```bash
sudo nano /etc/systemd/system/tiktok-collect.timer
```

```ini
[Unit]
Description=Run TikTok LIVE Collect every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

#### 有効化

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tiktok-collect.timer
```

### n8n のワークフローを自動実行にする

n8n UIで「TikTok LIVE Scout Pipeline」を開き：

1. 「Manual Trigger」ノードを「Schedule Trigger」に変更
2. 間隔を設定（例: 35分ごと — collectの30分より少し遅らせる）
3. ワークフローを **Active** にする

### 確認

```bash
# タイマーの状態を確認
systemctl list-timers | grep tiktok
# 「tiktok-collect.timer」が表示され、次回実行時刻が見えればOK

# 実行ログを確認
journalctl -u tiktok-collect.service -n 50 --no-pager
```

---

## 再起動・更新・バックアップ

### サーバー再起動後

```bash
# n8n は自動で復帰する（restart: unless-stopped）
docker ps
# n8n が Up になっていればOK

# timer も自動で動く
systemctl list-timers | grep tiktok
```

### コードを更新する時

```bash
cd ~/tiktok-autoliverreserch
git pull
docker compose build collect
sudo systemctl restart tiktok-collect.timer
```

### n8n のデータをバックアップ

```bash
docker run --rm -v tiktok-autoliverreserch_n8n_data:/data -v $PWD:/backup alpine tar czf /backup/n8n-backup.tar.gz /data
# n8n-backup.tar.gz が作成される
```

---

## 環境変数一覧

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | - | サービスアカウントのメール |
| `GOOGLE_PRIVATE_KEY` | Yes | - | サービスアカウントの秘密鍵 |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Yes | - | スプレッドシートのID |
| `GOOGLE_SHEETS_SOURCE_SHEET_NAME` | No | `source_candidates` | 書き込み先タブ名 |
| `GEMINI_API_KEY` | Yes | - | Gemini Vision APIキー |
| `COLLECT_MODE` | No | `navigate` | `navigate`（↓ボタン順送り）/ `scroll`（スクロール） |
| `MAX_COLLECT` | No | `100` | 1回の最大収集件数 |
| `MIN_FOLLOWERS` | No | `0` | フォロワー数の足切り |
| `NAV_FAIL_LIMIT` | No | `3` | ↓ボタン連続失敗の停止閾値 |
| `SKIP_SHEETS` | No | `false` | `true` でSheets書き込みスキップ |
| `BROWSER_MODE` | No | `launch` | ブラウザモード（通常変更不要） |

---

## よくあるエラーと対処

### SSH接続できない

**症状**: `Connection refused` または `Connection timed out`

**原因と対処**:
- UFWでSSHを許可する前にfirewallを有効化した → VPS管理画面のコンソールから `sudo ufw allow OpenSSH`
- IPアドレスが間違っている → VPS管理画面で確認
- UTMのネットワーク設定 → VM設定でネットワークを「ブリッジ」にする

### docker: permission denied

**症状**: `Got permission denied while trying to connect to the Docker daemon socket`

**原因**: ユーザーがdockerグループに入っていない

**対処**:
```bash
sudo usermod -aG docker $USER
exit  # ログアウト
# 再ログイン
```

### Google Sheets に書き込めない (403 Forbidden)

**症状**: `The caller does not have permission`

**原因と対処**:
- サービスアカウントのメールアドレスがスプレッドシートに**編集者**として共有されていない → 共有設定で追加
- Google Cloud プロジェクトで Sheets API が有効でない → 有効化する

### n8n の Google 認証でエラー

**症状**: `invalid_client` や認証画面が出ない

**原因と対処**:
- OAuthクライアントID/シークレットが間違っている → Google Cloud Console で再確認
- リダイレクトURIが違う → `http://localhost:5678/rest/oauth2-credential/callback` を正確に設定
- SSHトンネルが切れている → `ssh -L 5678:localhost:5678 ...` を再実行

### collect で 0件しか取れない

**症状**: `collectedCount: 0`

**原因と対処**:
- TikTok側が空表示 → 時間帯を変えて再実行（深夜は配信者が少ない）
- ネットワーク問題 → `docker compose run --rm collect curl -I https://www.tiktok.com` で接続確認

### 性別判定が全て unknown

**症状**: n8n の Gemini Vision Gender ノードが全て unknown を返す

**原因と対処**:
- Gemini API キーが無効 → Google AI Studio で再確認
- 画像が正しく送られていない → n8n の実行結果で Gemini ノードの出力を確認

---

## 用語集

| 用語 | 説明 |
|------|------|
| **VPS** | レンタルサーバー。インターネットに常時接続された Linux マシン |
| **SSH** | サーバーに安全にリモート接続する方法 |
| **公開鍵** | パスワードの代わりに使う、より安全なログイン方法 |
| **Docker** | アプリを「コンテナ」という箱に入れて、どの環境でも同じように動かす仕組み |
| **Docker Compose** | 複数のコンテナ（collect + n8n）をまとめて管理する仕組み |
| **サービスアカウント** | プログラムが Google にアクセスするための専用アカウント |
| **OAuth** | アプリが「あなたの代わりに」Google にアクセスする許可の仕組み |
| **リダイレクトURI** | OAuth認証後にブラウザが戻ってくるURL |
| **SSHトンネル** | サーバーのポートを自分のPCに安全に転送する方法 |
| **systemd timer** | Linux標準のスケジューラー。定期実行に使う |
| **ファイアウォール (UFW)** | サーバーへの不要な接続をブロックする仕組み |
