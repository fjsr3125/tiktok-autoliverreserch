# ADR: TikTok LIVE 収集は Docker 常駐 Chrome を CDP 接続先にする

- Status: Accepted
- Date: 2026-03-25T20:33:41+09:00
- Supersedes: 20260318-145327-agent-browser-baseline-for-live-navigation.md

## Context

TikTok LIVE の収集は `connectOverCDP` では成功する一方、`Playwright` の `launch` モードでは bot 判定で失敗する。

従来は `agent-browser` が起動した Chrome を基準にしていたが、この方式だと Docker 内の定常運用に乗せにくく、ログイン状態の保持も手順依存になりやすい。

今回ほしい運用は以下。

- `browser` サービスを常時起動して Chrome のログイン状態を保持する
- 初回だけ noVNC で人間がログインする
- 以後は `collect` から同じ Chrome へ `CDP` 接続して繰り返し収集する

## Decision

- TikTok LIVE 収集の接続先は、Docker Compose 上の `browser` サービスに固定する
- `browser` サービスは `Chrome Stable + Xvfb + x11vnc + noVNC + supervisord` で構成する
- Chrome のユーザーデータは named volume `chrome_profile` に保存し、ログイン状態をコンテナ再作成後も維持する
- `collect` は `BROWSER_MODE=cdp` とし、`TIKTOK_CDP_URL=http://browser:9222` へ接続する
- `storageState` ベースのログイン復元は、この運用の主経路としては使わない

## Consequences

- 収集処理が Docker 内で完結し、ローカル GUI や `agent-browser` 常駐に依存しなくなる
- 初回ログインだけ手動だが、その後の反復実行は単純になる
- noVNC と CDP を持つため、`browser` サービスの保護範囲は開発用ネットワーク内に限定する前提になる
- Chrome の起動フラグや TikTok 側の検出仕様が変わると、`browser` サービスの調整が必要になる
