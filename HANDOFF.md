# 引き継ぎドキュメント（TikTok LIVE Scout Pipeline）

最終更新: 2026-04-28
前任: 藤巻空 (fujisora625@gmail.com)

## 案件構造

```
クライアント（現場担当: 山根さん）
       ↓
営業: 田村さん
       ↓
学生AIコミュニティ（案件管理: ふっくーさん）
       ↓
技術担当: 藤巻（前任）→ 後任の方
```

時間が取れず根本対応が難しいため、コミュニティ内でアサイン交代。

---

## 1. クライアントからの指摘（4件・未解決）

> あれから確認したのですが、改善どころか、逆に状況が悪化しているように見受けられます。

| # | 指摘 | 一次仮説 | 関連ファイル |
|---|---|---|---|
| ① | リストアップ件数が下がっている | 直近2コミットで除外キーワードを追加しすぎて誤爆。さらに**browserコンテナのCDPハングで2時間以上収集ゼロ**の事象も観測 | `src/collect-tiktok-live.js` L122-135<br>n8n `Filter & Dedup` ノード |
| ② | 稼働18-3時のはずが朝も稼働 | daemon収集は時間制限あり、しかし**n8nは24時間15分間隔で動く**。夜間に貯まったunprocessedが朝のn8n実行でシート追記される | `src/collect-daemon.js` L36-47<br>`n8n-workflow-export.json` Schedule Trigger |
| ③ | 顔出ししていないアカウントが混ざる | Geminiに渡す画像が**LIVEフィードのサムネ**で、本人が顔出ししてなくてもプロフ画像が顔ならisPerson=true | n8n `Gemini + Parse Gender` ノード |
| ④ | SHOPなど法人系が省けない | bio判定のみで `uniqueId` `displayName` を見てない。bio空のアカウントもスルー | `src/collect-tiktok-live.js` `isBusiness()` |

---

## 2. 直近の障害（最優先）

**症状**: `connectOverCDP: Timeout 30000ms exceeded` が**直近2時間以上連続発生**。
**影響**: 収集が完全停止 → ①の主犯。
**応急処置**:
```bash
ssh root@162.43.50.52 "cd /opt/tiktok-autoliverreserch && docker compose restart browser collect"
```
**根本対策**:
- daemonに連続エラー検知＋自動復旧の仕組みが無い
- VPS cronで定期再起動 or daemon側で `connectOverCDP` のリトライ＋健全性監視 が必要

---

## 3. アクセス情報

### GitHub
- リポジトリ: https://github.com/fjsr3125/tiktok-autoliverreserch
- ブランチ: `feature/no-login-collect`（現在の作業ブランチ）
- main相当: 同ブランチで運用（mainマージは未実施）
- アクセス権付与: 引き継ぎ先のGitHubユーザー名を教えてもらってCollaborator追加

### VPS（XServer）
- ホスト: `162.43.50.52`
- ユーザー: `root`
- 接続: `ssh root@162.43.50.52`
- パスワード: 別途共有（XServer VPS管理画面から再設定可）
- プロジェクトpath: `/opt/tiktok-autoliverreserch`
- noVNC（ブラウザ目視）: http://162.43.50.52:6080
- n8n UI: SSHトンネル経由 `ssh -L 5678:localhost:5678 root@162.43.50.52` → http://localhost:5678
- n8n Basic認証: `.env.local` の `N8N_USER` / `N8N_PASSWORD`

### Google系
- `.env.local` に Service Account の JSON 鍵が入っている（VPS上にもローカルにもある）
- スプレッドシート: クライアント所有のもの。シート名 `scouted` / `既スカウト済み`
- Gemini API key: `.env.local` の `GEMINI_API_KEY`

### 連絡経路（Slack）
- 後任の方 ↔ ふっくーさん（学生AIコミュニティ）: コミュニティのSlack
- ふっくーさん ↔ 田村さん（営業）: 学生AI ↔ 田村さんのチャンネル
- 田村さん ↔ 山根さん（クライアント現場）: 田村さん側のチャンネル
- **クライアントへの直接連絡はNG**。すべて田村さん経由

---

## 4. アーキテクチャ要点

```
[Schedule Trigger 15min]
       ↓
[n8n: status確認] → unprocessed >= 100 件かつ isProcessing=false
       ↓
[Read Already Scouted シート] → 重複IDセット作成
       ↓
[Get Unprocessed (daemonから取得)]
       ↓
[Filter & Dedup] ← followerCount 500-10000 かつ 既スカウトでない
       ↓
[Read Screenshot] → [Gemini判定: isPerson/gender/isJapanese]
       ↓
[Target Filter] → female かつ isJapanese != low
       ↓
[Append to Scouted Sheet]
       ↓
[Clear Processed]
       ↓
[300件到達したらGmail通知]
```

**コンテナ3本** (`docker-compose.yml`):
- `browser`: Chromium + CDP（port 9222 内部 / 6080 noVNC / 3001 daemon-HTTP）
- `collect`: collect-daemon.js（10分間隔ループ・port 3000）※networkは `service:browser` 共有
- `n8n`: n8nio/n8n（port 5678）

**フィルタリングが3層**:
1. L1 collect側: `BUSINESS_KEYWORDS` で bio フィルタ → `latest-run.json`
2. L2 n8n `Filter & Dedup`: followerCount + 既スカウト除去
3. L3 n8n `Target Filter`: Gemini判定で人物/性別/日本人判定

---

## 5. 改修方針メモ（仮説ベース、未実装）

### ① 件数低下
- daemon側のCDPタイムアウトを検知して自動復旧（最優先）
- `BUSINESS_KEYWORDS` の汎用語（「担当」「指名」「BAR」等）を見直し
- L1とL2のfollowerCount足切りを統一（現在は L1=0, L2=500 で二重）

### ② 朝の稼働
- n8nの `Schedule Trigger` の後ろに「JST 18-3時のみ通す」IFノードを追加
- もしくは daemon の `/unprocessed` エンドポイントで活動時間外は空配列を返す

### ③ 顔出し判定
- スクショ取得元を「フィードサムネ」から「LIVE個別ページの実画面」に変更
- Geminiプロンプトに「これはLIVE配信のスクショなので、配信中の人物の顔が映っているか」を明確化

### ④ 法人除外
- `isBusiness()` を bio だけでなく `uniqueId` `displayName` も対象に
- キーワード追加: `_official`, `_shop`, `_store`, カタカナ表記揺れ
- bio空 + フォロワー多のパターンに警戒フラグ

---

## 6. 引き継ぎ先に最初にやってほしいこと

1. **VPSにSSHして現状確認**
   ```bash
   ssh root@162.43.50.52
   cd /opt/tiktok-autoliverreserch
   docker ps
   docker exec tiktok-autoliverreserch-browser-1 curl -s http://localhost:3000/status | jq .
   ```
2. **直近のCDPハングを復旧**: `docker compose restart browser collect`
3. **GitHub clone & ブランチ切る**: `feature/no-login-collect` から派生
4. **n8nワークフローを自分のローカルでも見られる状態にする**: SSHトンネル
5. **指摘①〜④の優先順位を依頼者（田村さん経由）と確認**

---

## 7. 進行中の調査ログ

このセッションで確認済み:
- `docker-compose.yml` ・ `n8n-workflow-export.json` の構造把握
- collect-daemon の活動時間ロジック（JST 18-3時）
- BUSINESS_KEYWORDS の最近の変更履歴（コミット 3d2d7c7, 40577db）
- CDPハング事象の発生（直近2h以上タイムアウト継続中、未復旧）

未着手:
- 実際の `latest-run.json` で skippedReason の内訳確認
- スクリーンショット現物の目視確認（③検証）
- n8n実行履歴で朝の時間帯Append件数の確認（②検証）
- 既スカウト済みシートの実際のデータ形式確認

---

## 8. 連絡

- ふっくーさん（学生AIコミュニティ・案件管理）: 案件のやり取り窓口
- 田村さん（営業）: クライアント窓口。後任からは直接連絡しない
- 山根さん（クライアント現場担当）: 田村さん経由でのみ連絡
