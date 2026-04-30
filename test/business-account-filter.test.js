const test = require("node:test");
const assert = require("node:assert/strict");

const { isBusinessAccount } = require("../src/business-account-filter");

test("isBusinessAccount checks uniqueId and displayName for shop accounts", () => {
  assert.equal(
    isBusinessAccount({
      uniqueId: "sample_shop_official",
      displayName: "Sample",
      bio: ""
    }),
    true
  );
});

test("isBusinessAccount filters VTuber accounts", () => {
  assert.equal(
    isBusinessAccount({
      uniqueId: "10000subscribers.vtuber",
      displayName: "登録者1万人でデビュー",
      bio: ""
    }),
    true
  );
});

test("isBusinessAccount avoids broad keyword false positives", () => {
  assert.equal(
    isBusinessAccount({
      uniqueId: "hxx_x22",
      displayName: "個人配信",
      bio: "ゲーム配信が好きです"
    }),
    false
  );

  assert.equal(
    isBusinessAccount({
      uniqueId: "miyu8597",
      displayName: "みゆ",
      bio: "20時から配信します。定休日は水曜"
    }),
    false
  );
});

test("isBusinessAccount still filters commercial context", () => {
  assert.equal(
    isBusinessAccount({
      uniqueId: "daisy.studiojp",
      displayName: "Daisy Studio",
      bio: "ネイルチップ販売 ご予約はDMまで"
    }),
    true
  );
});
