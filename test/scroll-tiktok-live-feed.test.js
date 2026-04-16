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
  let currentUrl = "https://www.tiktok.com/live";
  const screenshotPaths = [];
  const streamsByUniqueId = new Map(streams.map((s) => [s.uniqueId, s]));

  function getCurrentStream() {
    for (const s of streams) {
      if (currentUrl.includes(`@${s.uniqueId}`)) return s;
    }
    return null;
  }

  return {
    screenshotPaths,
    url() {
      return currentUrl;
    },
    locator(selector) {
      return {
        first() {
          return {
            async waitFor() {},
            async boundingBox() { return null; },
            async click() {}
          };
        },
        async isVisible() {
          return false;
        },
        async waitFor() {},
        async count() { return 0; }
      };
    },
    async waitForLoadState() {},
    async waitForFunction() {},
    async waitForTimeout() {},
    async content() {
      const stream = getCurrentStream();
      return stream ? stream.html : "<html></html>";
    },
    async screenshot(options) {
      screenshotPaths.push(options.path);
    },
    async goto(url) {
      currentUrl = url;
    },
    async evaluate(fn) {
      const source = fn.toString();

      // extractLiveMetadataFromDom
      if (source.includes("room-header-anchor-name")) {
        const stream = getCurrentStream();
        return {
          uniqueId: stream ? stream.uniqueId : null,
          nickname: stream ? stream.nickname : null,
          followerCount: null,
          viewerCount: null,
          title: null
        };
      }

      // fetchProfileData
      if (source.includes("followers-count")) {
        const stream = getCurrentStream();
        return {
          followerCount: stream ? stream.followerCount : null,
          bio: stream ? (stream.bio || null) : null,
          linkUrl: null
        };
      }

      // collectFeedItems
      if (source.includes("live-side-nav-item")) {
        return streams.map((s) => ({
          uniqueId: s.uniqueId,
          href: `/@${s.uniqueId}/live`,
          viewerCount: null,
          source: "sidebar"
        }));
      }

      return null;
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

test("navigateAndCollect captures live metadata and fetches follower count from profile", async () => {
  const page = createNavigateMockPage([
    {
      uniqueId: "first.live",
      nickname: "配信者1",
      followerCount: 1200,
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
      nickname: "配信者2",
      followerCount: 3400,
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
  assert.equal(seenCandidates[0].title, "最初の配信");
  assert.equal(
    seenCandidates[0].liveUrl,
    "https://www.tiktok.com/@first.live/live"
  );
  assert.equal(seenCandidates[1].displayName, "配信者2");
  assert.equal(seenCandidates[1].followerCount, 3400);
});
