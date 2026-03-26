# TikTokライバースカウト自動化 アーキテクチャ

## 1. 目的

TikTok LIVE から候補ライバーを収集し、既存データとの重複を除外した上で、判定順の違う 2 つの運用プランを比較できる状態を作る。

最終的には `n8n` を司令塔にし、日次実行で候補を追加しながら、`Backstage` と `Gemini API` の使い方を運用で選べるようにする。

## 2. 現時点の設計方針

- 候補収集は `TikTok LIVE 公開画面` を使う
- ブラウザ操作は `Playwright` を使う
- `Playwright` の担当は `TikTok LIVE からの取得` までに絞る
- `Backstage` は自動化しない
- 元データの保存先は `Google Sheets` にする
- `Playwright` で取得した結果は、`Google Sheets` の既存データと照合して `uniqueId` ベースで重複チェックする
- その後の判定順は `Plan1` と `Plan2` の 2 パターンを持つ
- `Gemini API` は `性別判定` と `おしゃべり判定` に使う
- `n8n` は全体の順番管理と外部連携を持つ

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
- `duplicate_flag`
- `gemini_gender_label`
- `gemini_talk_label`
- `backstage_status`
- `review_plan`

## 4. 検証済みのこと

`agent-browser` で `https://www.tiktok.com/@nozo.88y/live` を確認した結果、以下を確認済み。

- `uniqueId` は URL と埋め込みデータの両方で確認できた
- `followerCount` は LIVE ページの埋め込みデータから取得できた
- 確認できた値
  - `uniqueId = nozo.88y`
  - `followerCount = 901`

このため、`uniqueId` と `followerCount` の取得には `Vision API` は不要と判断する。

### ブラウザ接続方式の検証結果（2026-03-20）

TikTok はbot検出が厳しく、Playwright単体では LIVE フィードが表示されない。以下を検証した。

| 方式 | 結果 | 理由 |
|------|------|------|
| Playwright + `storageState` (Cookie復元) | NG | Cookie だけでは不十分。IndexedDB 等のログインデータが必要 |
| Playwright + `channel: "chrome"` | NG | Chrome が起動直後にクラッシュ（macOS環境） |
| Patchright + `launchPersistentContext` | NG | Chrome for Testing が `EXC_BREAKPOINT` でクラッシュ |
| **常駐 Chrome + connectOverCDP** | **OK** | 採用。Docker 上の Chrome に Playwright が CDP 接続 |

#### 採用方式: 常駐 Chrome + connectOverCDP

```
browser service (Chrome起動・ログイン状態保持)
    ↓ CDP (http://browser:9222)
Playwright (connectOverCDP でページ操作・データ取得)
```

**制約:**
- CDP 経由で**新しいページを開くと**TikTok に検出される → 既存ページのみ操作可能
- browser service が開いた `/live` ページのサイドバーからLIVE配信者をクリック → 配信ページでスクショ → `goBack()` で戻る、のループで収集
- サイドバーの「See all」ボタンで表示件数を展開可能（12件→20件）
- `followerCount` は LIVE フィード上では取得不可（プロフィールページ遷移が必要）
- 初回だけ noVNC で Chrome に入り、TikTok ログイン状態を `chrome_profile` volume に保存する

#### 収集フロー（現行）

1. `docker compose up -d browser`
2. noVNC で `http://localhost:6080` を開き、Chrome で TikTok に 1 回ログインする
3. `Playwright` が `http://browser:9222` に CDP 接続し、既存の `/live` ページを取得
4. サイドバーの「See all」をクリックして展開
5. 各 `live-side-nav-item` をクリック → LIVE 配信ページに遷移
6. ページ全体のスクショ + メタデータ（uniqueId, displayName, viewerCount）取得
7. `goBack()` で `/live` に戻り、次の配信者へ
8. 結果を `output/latest-run.json` + `output/screenshots/` に出力

## 5. 共通フロー

どちらのプランでも、最初の入口は統一する。

1. `Playwright` で TikTok LIVE を巡回する
2. `uniqueId` `followerCount` `title` `URL` `screenshot` を取得する
3. `Google Sheets` の元データと照合して `uniqueId` ベースで重複チェックする
4. 重複でない候補だけを次の判定に渡す

## 6. 2つの運用プラン

### Plan1: 自動化プラン

重複を除いた候補に対して、先に `Gemini API` で判定をかける。

1. `Gemini API` で `性別判定`
2. `Gemini API` で `おしゃべり判定`
3. 条件を通過した候補だけを `Backstage` で確認する

狙いは以下。

- できるだけ自動で候補数を減らす
- `Backstage` を見る件数を減らす
- 人手確認の負荷を下げる

### Plan2: コスト削減プラン

重複を除いた候補に対して、先に `Backstage` を確認する。

1. `Backstage` で所属可否を確認する
2. 通過した候補だけを `Gemini API` に渡す
3. `Gemini API` で `性別判定`
4. `Gemini API` で `おしゃべり判定`

狙いは以下。

- `Gemini API` に送る件数を減らす
- API コストを抑える
- 事務所所属 NG を先に落とす

## 7. 各レイヤの役割

### Playwright

- TikTok LIVE ページ巡回
- `uniqueId` / `followerCount` / URL / タイトル取得
- スクリーンショット取得

### Google Sheets

- 既存候補の保持
- `uniqueId` 重複判定
- 後続判定に渡す対象の管理
- 重複でない候補の保存

### Gemini API

- `性別判定`
- `おしゃべり判定`

### Backstage

- 最終候補に近い段階での所属確認
- 自動化はせず、確認工程として扱う

### n8n

- 定時実行
- 各処理の順番管理
- データ受け渡し
- 通知とエラー監視

## 8. なぜ入口を統一するか

最初の `TikTok LIVE 取得` と `重複チェック` は、どちらのプランでも必須だから。

ここを共通化すると以下の利点がある。

- 比較対象が `Gemini` と `Backstage` の順番差だけになる
- 実装の分岐が後段だけで済む
- 収集処理の品質改善を両プランで再利用できる

## 9. Plan1 と Plan2 の使い分け

### Plan1 が向くケース

- `Backstage` の確認負荷を下げたい
- 先に自動で候補を絞りたい
- 運用担当の手間を減らしたい

### Plan2 が向くケース

- `Gemini API` のコストを最優先で抑えたい
- `Backstage` 確認の件数を先に処理できる
- 所属 NG が多く、先に落とした方が効率がよい

## 10. 実装フェーズ

### フェーズ1: 共通入口の実装

- LIVE ページから `uniqueId` と `followerCount` を取る
- スクショと URL を保存する
- `Google Sheets` と照合して重複チェックする
- 重複でない候補を `Google Sheets` に保存する

### フェーズ2: Plan1 の実装

- `Gemini API` で `性別判定`
- `Gemini API` で `おしゃべり判定`
- 残った候補を `Backstage` で確認する

### フェーズ3: Plan2 の実装

- 先に `Backstage` で確認する
- 通過候補だけ `Gemini API` に渡す

### フェーズ4: 運用比較

- 通過率
- 1日あたり処理件数
- `Gemini API` コスト
- `Backstage` 確認件数

## 11. 既知の注意点

- TikTok のプロフィール直アクセスではパズル認証に入ることがある
- そのため、`LIVE ページ内で完結できる取得` を優先する
- TikTok の UI 変更で取得処理が壊れる可能性がある
- `Backstage` は自動化しない前提なので、運用手順の明文化が必要
- `おしゃべり判定` は評価基準が曖昧だとブレやすい

## 12. 未確定事項

- `Backstage` の確認結果をどこに記録するか
- `Gemini API` の判定プロンプトをどう定義するか
- `おしゃべり判定` の閾値をどう置くか
- 1 回の巡回で何件集めれば十分か

## 13. 現時点の推奨判断

まずは `共通入口` を先に完成させる。

`Playwright 取得 -> Google Sheets 照合 -> 重複チェック`

この 3 つを安定させてから、後段で `Plan1` と `Plan2` を比較する。

理由は以下。

- 入口が不安定だと後段比較の意味がなくなる
- 重複除外まで共通化すれば、後段の比較がしやすい
- `Backstage` を自動化対象から外したことで、先に決めるべき範囲が明確になる
