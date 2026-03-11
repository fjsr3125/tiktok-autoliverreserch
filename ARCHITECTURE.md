# TikTokライバースカウト自動化 アーキテクチャ

## 1. 目的

TikTok LIVE から候補ライバーを収集し、重複除外・条件絞り込み・Backstage確認・女性判定を通した上で、最終候補を一覧化する。

最終的には n8n を司令塔にし、定時実行で毎日候補を追加できる状態を目指す。

## 2. 現時点の設計方針

- 候補収集は `TikTok LIVE 公開画面` を使う
- 業務フロー全体の制御は `n8n` が持つ
- ブラウザ操作は `Playwright` を使う
- 初期調査では `agent-browser` を使って取得可否を検証する
- `Vision API` は数値取得には使わず、見た目判定だけに使う
- `Backstage` はエージェンシー登録済みかどうかの確認に使う

## 3. 取得対象データ

候補収集時に最低限ほしい項目は以下。

- `uniqueId`
- `profile_url`
- `live_url`
- `followerCount`
- `title`
- `screenshot`
- `collected_at`

必要に応じて追加する項目。

- `room_id`
- `viewer_count`
- `backstage_status`
- `vision_gender_score`
- `duplicate_flag`

## 4. 検証済みのこと

`agent-browser` で `https://www.tiktok.com/@nozo.88y/live` を確認した結果、以下を確認済み。

- `uniqueId` は URL と埋め込みデータの両方で確認できた
- `followerCount` は LIVE ページの埋め込みデータから取得できた
- 確認できた値
  - `uniqueId = nozo.88y`
  - `followerCount = 901`

このため、`uniqueId` と `followerCount` の取得には `Vision API` は不要と判断する。

## 5. 全体ワークフロー

処理順は以下を基本とする。

1. TikTok LIVE から候補を収集する
2. `uniqueId` ベースで重複除外する
3. `followerCount = 500〜10000` で足切りする
4. Backstage でエージェンシー未登録か確認する
5. 条件を通過した候補にだけ `Vision API` で女性判定をかける
6. 最終候補を Google Sheets に保存する
7. 必要なら Gmail で結果を通知する

## 6. 各レイヤの役割

### n8n

- 定時実行
- 各処理の順番管理
- スプレッドシート連携
- Gmail通知
- エラー通知

### Playwright

- TikTok LIVE ページ巡回
- `uniqueId` / `followerCount` / URL / タイトル取得
- スクリーンショット取得
- Backstage 画面操作

### Google Sheets

- 既存候補の保持
- `uniqueId` 重複判定
- 最終候補の保存

### Vision API

- 女性っぽいかの判定
- 必要なら顔出しかの補助判定

## 7. なぜこの順番にするか

`重複除外`、`フォロワー足切り`、`Backstage確認` を先に行うことで、最後に回す `Vision API` の件数を減らせる。

これにより以下の効果がある。

- AIコストを抑えられる
- 処理時間を短くできる
- 無駄な判定を避けられる

## 8. Backstage の扱い

Backstage は以下の優先順で確認する。

1. API または画面裏の通信で取得できるか確認する
2. 取れない場合は Playwright で画面操作する

まず確認したいのはこれ。

- `uniqueId` を渡したとき、エージェンシー登録状態を API で取得できるか
- 一括確認 API があるか
- 画面の検索結果に必要な状態が表示されるか

## 9. n8n 上の想定フロー

最低構成は以下。

1. `Schedule Trigger`
2. `Google Sheets` で既存ID読み込み
3. `Execute Command` または `HTTP Request` で Playwright 実行
4. `Code` で整形
5. `IF` で重複除外
6. `IF` でフォロワー数絞り込み
7. Backstage確認
8. `HTTP Request` で Vision API 判定
9. `Google Sheets` に保存
10. `Gmail` で通知

## 10. 実装フェーズ

### フェーズ1: TikTok候補収集

- LIVEページから `uniqueId` と `followerCount` を取る
- スクショと URL を保存する

### フェーズ2: 重複除外と足切り

- Google Sheets の既存候補と照合する
- `500〜10000` だけ残す

### フェーズ3: Backstage確認

- API取得可否を確認する
- 難しければ Playwright 操作に切り替える

### フェーズ4: Vision判定

- 女性判定を追加する
- 必要なら顔出し判定も追加する

### フェーズ5: 通知と運用

- Gmail通知
- エラー通知
- 実行時間の最適化

## 11. 既知の注意点

- TikTok のプロフィール直アクセスではパズル認証に入ることがある
- そのため、まずは `LIVEページ内で完結できる取得` を優先する
- ログイン自動化はアカウント停止リスクがあるため、本番では慎重に扱う
- TikTok の UI 変更で取得処理が壊れる可能性がある

## 12. 未確定事項

- Backstage で登録状態を API 取得できるか
- Vision API の判定基準をどこまで細かくするか
- スプレッドシートの最終列設計
- n8n の運用先をクラウドにするか VPS にするか
- 1回の巡回で何件集めれば最終 150 件になるか

## 13. 現時点の推奨判断

現時点では以下の流れで進める。

`TikTok LIVE収集 -> 重複除外 -> follower足切り -> Backstage確認 -> 女性判定 -> 出力`

この順であれば、コストと安定性のバランスがよい。

## 14. Vision API コスト試算

2026-03-11 時点では、女性判定コストは `1枚あたり数十万分の1ドル` のレンジで、件数次第で月額が変わる。

前提は以下。

- モデル候補
  - `Gemini 2.5 Flash-Lite`
  - `Gemini 2.5 Flash`
- 画像サイズ
  - `1024x1024`
- 画像入力
  - `1290 tokens / 枚`
- 出力
  - `label + score + short reason` の短い JSON

### 1枚あたりの概算

- `Gemini 2.5 Flash-Lite`
  - 約 `0.00014〜0.00016 USD / 枚`
- `Gemini 2.5 Flash`
  - 約 `0.00046〜0.00059 USD / 枚`

### 月額の目安

#### Flash-Lite

- `150枚 / 日`
  - 約 `0.63〜0.72 USD / 月`
- `300枚 / 日`
  - 約 `1.26〜1.44 USD / 月`
- `500枚 / 日`
  - 約 `2.10〜2.40 USD / 月`
- `1000枚 / 日`
  - 約 `4.20〜4.80 USD / 月`
- `2000枚 / 日`
  - 約 `8.40〜9.60 USD / 月`

#### Flash

- `150枚 / 日`
  - 約 `2.07〜2.66 USD / 月`
- `300枚 / 日`
  - 約 `4.14〜5.31 USD / 月`
- `500枚 / 日`
  - 約 `6.90〜8.85 USD / 月`
- `1000枚 / 日`
  - 約 `13.80〜17.70 USD / 月`
- `2000枚 / 日`
  - 約 `27.60〜35.40 USD / 月`

### 重要な見方

コスト差を作るのは `モデル選択` より `何枚 Vision に流すか` の方が大きい。

つまり以下の順で絞るほど安くなる。

1. `重複除外`
2. `followerCount 500〜10000`
3. `Backstageで事務所所属チェック`
4. `Vision判定`

### おすすめ運用

- 一次判定は `Gemini 2.5 Flash-Lite`
- `score` が低いものだけ `Gemini 2.5 Flash` に再判定
- Vision に送る前に `title / nickname / signature` の軽い足切りを入れる

### 例

もし `1000件 / 日` を候補収集しても、Backstage やテキスト足切りで `200件 / 日` まで減らせれば、
Vision コストはおおむね `5分の1` になる。

### 参考

- Google AI Gemini API Pricing
  - https://ai.google.dev/gemini-api/docs/pricing
- Vertex AI Gemini Pricing
  - https://cloud.google.com/vertex-ai/generative-ai/pricing
