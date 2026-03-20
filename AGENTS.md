# AGENTS.md

## このディレクトリの目的

TikTok ライバースカウト自動化の設計と実装を進めるための作業ディレクトリ。

現時点では、まず設計を固め、その後に以下の順で実装する。

1. TikTok LIVE から候補収集
2. 重複除外
3. follower 足切り
4. Backstage で所属確認
5. Vision API で女性判定
6. Google Sheets / Gmail 連携

## 参照すべきファイル

- `ARCHITECTURE.md`
  - この案件の基本方針
  - ワークフロー
  - 役割分担
  - コスト試算

## 現時点の重要判断

- `uniqueId` と `followerCount` は TikTok LIVE ページの埋め込みデータから取る前提
- `Vision API` は数値取得に使わない
- `Backstage` は `API or 画面裏通信` を先に確認し、無理なら UI 操作で対応する
- `Backstage` はリスクが高いので、なるべく後段で使う
- `Vision API` に送る件数を減らすことが重要

## 優先順位

### 高

- Backstage で所属確認をどこまで安全に自動化できるか
- TikTok LIVE から `uniqueId` と `followerCount` を安定取得できるか
- 重複除外の仕組みを先に決めること

### 中

- Vision API のモデル選定
- スプレッドシートの列設計
- n8n の実行タイミング

### 低

- Gmail 通知の見た目
- スコアの細かい調整

## 実装時の原則

- まず `安い条件` で絞る
- `Vision API` は最後に近い位置に置く
- `Backstage` は件数を絞った後に使う
- プロフィール直アクセスより `LIVEページ内で完結する取得` を優先する
- 取得ロジックは、見た目依存ではなく `埋め込みデータ` 優先で考える

## 避けること

- 最初から Backstage を大量自動巡回すること
- Vision API を前段で大量に使うこと
- TikTok の数値取得に画像判定を使うこと
- 設計未確定のまま n8n を大きく組み始めること

## 推奨の次アクション

1. Backstage の所属確認が API で取れるか調査する
2. TikTok LIVE から `uniqueId` / `followerCount` / `title` / `screenshot` を取る最小実装を作る
3. Google Sheets で重複除外の仕様を決める
4. Vision API の一次判定仕様を決める

## 補足

このディレクトリはローカル Git 管理済み。  
設計変更が入るたびに、`ARCHITECTURE.md` と `AGENTS.md` の整合を保つこと。
