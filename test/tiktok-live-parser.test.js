const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractMetadataFromHtml,
  extractUniqueIdFromUrl
} = require("../src/tiktok-live-parser");

test("extractUniqueIdFromUrl reads uniqueId from TikTok LIVE URL", () => {
  assert.equal(
    extractUniqueIdFromUrl("https://www.tiktok.com/@nozo.88y/live"),
    "nozo.88y"
  );
});

test("extractMetadataFromHtml reads key values from embedded JSON", () => {
  const html = `
    <html>
      <head><title>配信タイトル</title></head>
      <body>
        <script id="SIGI_STATE" type="application/json">
          {
            "LiveRoom": {
              "roomId": "123456789",
              "title": "雑談ライブ",
              "owner": {
                "uniqueId": "nozo.88y",
                "followerCount": 901
              },
              "stats": {
                "viewerCount": 87
              }
            }
          }
        </script>
      </body>
    </html>
  `;

  const meta = extractMetadataFromHtml(html, "https://www.tiktok.com/@nozo.88y/live");
  assert.equal(meta.uniqueId, "nozo.88y");
  assert.equal(meta.followerCount, 901);
  assert.equal(meta.roomId, "123456789");
  assert.equal(meta.viewerCount, 87);
  assert.equal(meta.title, "雑談ライブ");
});

test("extractMetadataFromHtml extracts nickname from SIGI_STATE", () => {
  const html = `
    <html>
      <body>
        <script id="SIGI_STATE" type="application/json">
          {
            "LiveRoom": {
              "roomId": "999",
              "title": "トーク配信",
              "owner": {
                "uniqueId": "test_user",
                "nickname": "テストユーザー",
                "followerCount": 5000
              },
              "stats": {
                "viewerCount": 150
              }
            }
          }
        </script>
      </body>
    </html>
  `;

  const meta = extractMetadataFromHtml(html, "https://www.tiktok.com/@test_user/live");
  assert.equal(meta.nickname, "テストユーザー");
  assert.equal(meta.uniqueId, "test_user");
  assert.equal(meta.followerCount, 5000);
});

test("extractMetadataFromHtml falls back to URL when uniqueId is missing", () => {
  const html = `
    <html>
      <body>
        <script>{"followerCount": 1200, "title": "ライブ中"}</script>
      </body>
    </html>
  `;

  const metadata = extractMetadataFromHtml(
    html,
    "https://www.tiktok.com/@fallback.user/live"
  );

  assert.equal(metadata.uniqueId, "fallback.user");
  assert.equal(metadata.followerCount, 1200);
  assert.equal(metadata.title, "ライブ中");
  assert.equal(metadata.nickname, null);
});
