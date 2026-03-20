const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProfileUrl, getLiveUrls } = require("../src/collect-tiktok-live");

test("buildProfileUrl returns TikTok profile URL for a uniqueId", () => {
  assert.equal(
    buildProfileUrl("nozo.88y"),
    "https://www.tiktok.com/@nozo.88y"
  );
});

test("buildProfileUrl returns null when uniqueId is null", () => {
  assert.equal(buildProfileUrl(null), null);
});

test("buildProfileUrl returns null when uniqueId is undefined", () => {
  assert.equal(buildProfileUrl(undefined), null);
});

test("getLiveUrls parses comma-separated URLs", () => {
  const original = process.env.TIKTOK_LIVE_URLS;
  try {
    process.env.TIKTOK_LIVE_URLS =
      "https://www.tiktok.com/@a/live, https://www.tiktok.com/@b/live";
    assert.deepEqual(getLiveUrls(), [
      "https://www.tiktok.com/@a/live",
      "https://www.tiktok.com/@b/live"
    ]);
  } finally {
    if (original === undefined) {
      delete process.env.TIKTOK_LIVE_URLS;
    } else {
      process.env.TIKTOK_LIVE_URLS = original;
    }
  }
});

test("getLiveUrls removes duplicates", () => {
  const original = process.env.TIKTOK_LIVE_URLS;
  try {
    process.env.TIKTOK_LIVE_URLS =
      "https://www.tiktok.com/@a/live,https://www.tiktok.com/@a/live";
    assert.deepEqual(getLiveUrls(), ["https://www.tiktok.com/@a/live"]);
  } finally {
    if (original === undefined) {
      delete process.env.TIKTOK_LIVE_URLS;
    } else {
      process.env.TIKTOK_LIVE_URLS = original;
    }
  }
});

test("getLiveUrls returns empty array when env is unset", () => {
  const original = process.env.TIKTOK_LIVE_URLS;
  try {
    delete process.env.TIKTOK_LIVE_URLS;
    assert.deepEqual(getLiveUrls(), []);
  } finally {
    if (original === undefined) {
      delete process.env.TIKTOK_LIVE_URLS;
    } else {
      process.env.TIKTOK_LIVE_URLS = original;
    }
  }
});
