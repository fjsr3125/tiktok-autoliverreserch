# ADR: TikTok LIVE の画面遷移検証は agent-browser の成功ルートを基準にする

- Status: Superseded
- Date: 2026-03-18T14:53:27+09:00
- Supersedes: なし

## Context

TikTok LIVE の候補収集では、`/live` トップを開き、配信画面に入り、そこから次の配信者へ進む導線を `Playwright` で再現したい。

ただし、空の `Playwright` セッションでは以下が起きた。

- `https://www.tiktok.com/live` でおすすめ LIVE 一覧が空表示になることがある
- LIVE 画面の `次へ` 操作に使う要素が、通常の `button` や安定した `aria-label` で取れない
- 座標ベースのクリックは一時的な検証には使えても、本番ロジックとしては弱い

一方で、`agent-browser` では実際の画面操作として同等の手順を成功させられている。

## Decision

- TikTok LIVE の画面遷移検証は、まず `agent-browser` で成功したルートを基準にする
- `Playwright` は空のセッションから DOM を推測して再現するのではなく、`agent-browser` で成功した操作順とブラウザ状態を移植する方針にする
- `次へ` 操作の要素特定は、可能な限り DOM 構造、状態、保存済みブラウザ状態を使って行い、座標ベースは最終手段に限定する
- `Playwright` 単体で挙動が不安定なときは、`cookie` `storage state` `URL遷移` `押した要素` を `agent-browser` 側で先に確認してから移植する

## Consequences

- TikTok 側の動的 UI や出し分けに対して、再現精度を上げやすい
- `Playwright` の実装は、単純な DOM 推測よりも `成功した実ルートの転写` に寄る
- `agent-browser` と `Playwright` の両方を使う前提になるため、初期検証の手順は少し増える
- 画面遷移の本実装に入る前に、`agent-browser` 側の成功手順を簡単に記録しておく必要がある
