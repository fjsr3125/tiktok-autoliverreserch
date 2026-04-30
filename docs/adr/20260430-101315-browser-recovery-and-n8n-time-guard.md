# ADR: CDPハングはChrome再起動APIで復旧しn8nにも時間ガードを置く

- Status: Accepted
- Date: 2026-04-30T10:13:15+09:00
- Supersedes: なし

## Context

`browser` サービスの Chrome に対する `connectOverCDP` が、WebSocket接続後に応答しない半フリーズ状態になることがある。

この状態では `collect` 側の `reloadBrowserPage()` も CDP に依存しているため、自己復旧できない。さらに、収集daemonは18時〜3時だけ動く一方、n8nワークフローは24時間15分間隔で未処理候補を処理するため、朝の時間帯にシート追記されるように見える。

## Decision

- `browser` コンテナ内に `browser-control` HTTP API を追加する
- `browser-control` は `supervisorctl restart chrome` で Chrome だけを再起動できるようにする
- `collect-daemon` はCDP接続タイムアウトなどのブラウザ系エラーを検知したら、Chrome再起動APIを呼び、1回だけ収集をリトライする
- n8nワークフローは Schedule Trigger の直後にJST 18時〜3時のみ通す時間ガードを置く

## Consequences

- CDPが詰まっても、CDPを使わない外側の経路でChromeを再起動できる
- `browser` コンテナ全体ではなくChromeだけを再起動するため、noVNCやdaemon proxyの影響を抑えられる
- n8n側の処理時刻も収集時刻と揃い、朝にシート追記される誤解を減らせる
- Chrome再起動後もTikTokログイン状態は named volume の Chrome profile に残る前提
