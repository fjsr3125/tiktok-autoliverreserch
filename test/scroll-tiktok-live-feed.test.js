const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dedupeLiveCandidates,
  normalizeLiveUrl,
  navigateAndCollect
} = require("../src/scroll-tiktok-live-feed");
const {
  parseBoolean,
  parseNumber
} = require("../src/live-navigation-runner");

function createNavigateMockPage(streams) {
  let index = -1;
  let gotoCalls = 0;
  const screenshotPaths = [];

  return {
    screenshotPaths,
    get gotoCalls() {
      return gotoCalls;
    },
    url() {
      if (index < 0) {
        return "https://www.tiktok.com/live";
      }
      return streams[index].url;
    },
    locator() {
      return {
        first() {
          return {
            async waitFor() {},
            async click() {
              index = 0;
            }
          };
        }
      };
    },
    async waitForLoadState() {},
    async waitForFunction() {},
    async waitForTimeout() {},
    async content() {
      return streams[index].html;
    },
    async screenshot(options) {
      screenshotPaths.push(options.path);
    },
    async goto() {
      gotoCalls += 1;
      throw new Error("page.goto should not be used in navigateAndCollect");
    },
    async evaluate(fn) {
      const source = fn.toString();

      // extractLiveMetadataFromDom: DOMからメタデータ取得
      if (source.includes("viewer-count") || source.includes("live-title")) {
        // テスト環境ではDOMがないのでnullを返す（HTMLフォールバックに任せる）
        return { uniqueId: null, nickname: null, viewerCount: null, title: null };
      }

      if (source.includes("creatorProfileUrl")) {
        const current = streams[index];
        return {
          url: current.url,
          title: current.title || "",
          creatorProfileUrl: `https://www.tiktok.com/@${current.uniqueId}`,
          creatorName: current.nickname || current.uniqueId
        };
      }

      if (source.includes("bg-UIImageOverlayBlackA25")) {
        if (index + 1 >= streams.length) {
          return null;
        }

        index += 1;
        return {
          className: "rounded-full cursor-pointer bg-UIImageOverlayBlackA25",
          x: 1000,
          y: 600,
          width: 40,
          height: 40
        };
      }

      throw new Error(`Unexpected evaluate call: ${source}`);
    }
  };
}

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

test("navigateAndCollect captures live metadata and screenshots without page.goto", async () => {
  const page = createNavigateMockPage([
    {
      uniqueId: "first.live",
      url: "https://www.tiktok.com/@first.live/live?lang=ja-JP",
      html: `
        <script id="SIGI_STATE" type="application/json">
          {
            "LiveRoom": {
              "roomId": "111",
              "title": "最初の配信",
              "owner": {
                "uniqueId": "first.live",
                "nickname": "配信者1",
                "followerCount": 1200
              },
              "stats": {
                "viewerCount": 45
              }
            }
          }
        </script>
      `
    },
    {
      uniqueId: "second.live",
      url: "https://www.tiktok.com/@second.live/live",
      html: `
        <script id="SIGI_STATE" type="application/json">
          {
            "LiveRoom": {
              "roomId": "222",
              "title": "次の配信",
              "owner": {
                "uniqueId": "second.live",
                "nickname": "配信者2",
                "followerCount": 3400
              },
              "stats": {
                "viewerCount": 88
              }
            }
          }
        </script>
      `
    }
  ]);
  const seenCandidates = [];

  const result = await navigateAndCollect(
    page,
    { maxCollect: 5, navFailLimit: 1 },
    "/tmp/screenshots",
    async (candidate) => {
      seenCandidates.push(candidate);
    }
  );

  assert.equal(page.gotoCalls, 0);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.uniqueId),
    ["first.live", "second.live"]
  );
  assert.deepEqual(
    page.screenshotPaths,
    ["/tmp/screenshots/first.live.png", "/tmp/screenshots/second.live.png"]
  );
  assert.equal(seenCandidates[0].displayName, "配信者1");
  assert.equal(seenCandidates[0].followerCount, 1200);
  assert.equal(seenCandidates[0].viewerCount, 45);
  assert.equal(seenCandidates[0].title, "最初の配信");
  assert.equal(
    seenCandidates[0].liveUrl,
    "https://www.tiktok.com/@first.live/live"
  );
  assert.equal(seenCandidates[1].displayName, "配信者2");
  assert.equal(seenCandidates[1].followerCount, 3400);
  assert.equal(seenCandidates[1].viewerCount, 88);
});
