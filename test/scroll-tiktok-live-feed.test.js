const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dedupeLiveCandidates,
  normalizeLiveUrl,
  parseBoolean,
  parseNumber
} = require("../src/scroll-tiktok-live-feed");

test("normalizeLiveUrl extracts uniqueId from relative live URL", () => {
  assert.deepEqual(normalizeLiveUrl("/@nozo.88y/live?lang=ja-JP", "https://www.tiktok.com/live"), {
    uniqueId: "nozo.88y",
    liveUrl: "https://www.tiktok.com/@nozo.88y/live"
  });
});

test("normalizeLiveUrl ignores non-live URLs", () => {
  assert.equal(normalizeLiveUrl("/@nozo.88y", "https://www.tiktok.com/live"), null);
});

test("dedupeLiveCandidates keeps one row per live URL", () => {
  assert.deepEqual(
    dedupeLiveCandidates([
      {
        uniqueId: "nozo.88y",
        liveUrl: "https://www.tiktok.com/@nozo.88y/live",
        label: "first"
      },
      {
        uniqueId: "nozo.88y",
        liveUrl: "https://www.tiktok.com/@nozo.88y/live",
        label: "second"
      }
    ]),
    [
      {
        uniqueId: "nozo.88y",
        liveUrl: "https://www.tiktok.com/@nozo.88y/live",
        label: "second"
      }
    ]
  );
});

test("parse helpers fall back to defaults on invalid input", () => {
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean("false", true), false);
  assert.equal(parseNumber(undefined, 5), 5);
  assert.equal(parseNumber("abc", 5), 5);
  assert.equal(parseNumber("7", 5), 7);
});
