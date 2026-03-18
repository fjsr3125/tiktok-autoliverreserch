# ADR: Playwright 取得と重複チェックを共通入口にし、後段を 2 プランで分ける

- Status: Accepted
- Date: 2026-03-18T13:32:10+09:00
- Supersedes: なし

## Context

TikTok ライバースカウト自動化では、候補収集、重複除外、`Gemini API` 判定、`Backstage` 確認の順番をどう組むかが未確定だった。

当初は `Backstage` の自動化も候補に入っていたが、現時点ではそこまで自動化する必要はないと判断した。

一方で、`TikTok LIVE` からの取得と重複チェックは、どの運用案でも必ず必要になる。

## Decision

- `Playwright` の担当は `TikTok LIVE` からの取得までに限定する
- `Playwright` で取得した結果は、元データと照合して `uniqueId` ベースで重複チェックする
- `Backstage` は自動化対象から外し、確認工程として扱う
- 後段の判定順は以下の 2 プランを併存させる
- `Plan1`: `Gemini API` で `性別判定` と `おしゃべり判定` を先に行い、残った候補だけを `Backstage` で確認する
- `Plan2`: 先に `Backstage` で確認し、通過した候補だけに `Gemini API` を使う
- まずは `Playwright 取得 -> 元データ照合 -> 重複チェック` の共通入口を先に完成させる

## Consequences

- 入口処理の改善を 2 プランで共通利用できる
- `Backstage` 自動化の調査と保守を今は持たなくてよくなる
- `Plan1` は `Backstage` の確認件数を減らしやすい
- `Plan2` は `Gemini API` のコストを抑えやすい
- 後段比較のために、`Backstage` 確認結果と `Gemini` 判定結果の記録先を揃える必要がある
- `おしゃべり判定` は基準が曖昧だと運用がぶれるため、後で別 ADR または仕様メモで閾値を固める
