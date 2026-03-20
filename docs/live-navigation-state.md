# TikTok LIVE 導線検証メモ

## 目的

`/live` トップから配信画面へ入り、`次へ` 操作で別配信者へ進む導線を `Playwright` で安定再現する。

## 前提

- `agent-browser` で成功したブラウザ状態を基準にする
- `Playwright` は保存済み `storage state` を読む
- fresh セッションでの再現は狙わない

## 準備

1. `agent-browser` か `Playwright` で TikTok に必要な状態を作る
2. `playwright/.auth/tiktok-live-state.json` に state を保存する
3. `.env.local` に `TIKTOK_STORAGE_STATE_PATH` を入れる

## 実行

```bash
npm run live:navigation:test
```

## 期待する挙動

1. `/live` トップを開く
2. 最初の配信カードに入る
3. 右側の `次へ` を押す
4. URL またはプロフィールが変わる
5. 各ステップのスクショと JSON が `output/live-navigation-test/` に残る
