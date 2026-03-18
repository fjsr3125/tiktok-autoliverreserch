# ADR 運用ルール

このディレクトリでは、設計上の重要判断を ADR として管理する。

## 目的

- どの判断が、なぜ採用されたかを後から追えるようにする
- 設計変更時に、どの判断を差し替えたかを明確にする
- `ARCHITECTURE.md` と実装の整合を保つ

## 保存場所

- `docs/adr/`

## ファイル名

- 形式: `YYYYMMDD-HHMMSS-短い英語名.md`
- 時刻は JST で記録する

例:

- `20260318-133210-playwright-dedup-and-review-order.md`

## ステータス

- `Accepted`: 現在有効
- `Superseded`: 後続 ADR に置き換え済み
- `Deprecated`: 廃止済み
- `Proposed`: 検討中

## 更新ルール

- 既存 ADR は直接上書きしない
- 判断を変えるときは、新しい ADR を追加して `Supersedes` に旧 ADR を書く
- 置き換えられた側は `Status: Superseded` に更新する

## 最低限書く項目

- `Title`
- `Status`
- `Date`
- `Context`
- `Decision`
- `Consequences`

## 関連ドキュメント

- `ARCHITECTURE.md`
- 必要に応じて実装メモや検証結果
