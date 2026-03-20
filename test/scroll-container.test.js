const test = require("node:test");
const assert = require("node:assert/strict");

const { pickBestScrollContainer } = require("../src/scroll-tiktok-live-feed");

test("pickBestScrollContainer prefers large scrollable main content", () => {
  const result = pickBestScrollContainer([
    {
      overflowY: "scroll",
      scrollHeight: 748,
      clientHeight: 650,
      width: 240,
      height: 650
    },
    {
      overflowY: "auto",
      scrollHeight: 1312,
      clientHeight: 437,
      width: 990,
      height: 437
    }
  ]);

  assert.deepEqual(result, {
    overflowY: "auto",
    scrollHeight: 1312,
    clientHeight: 437,
    width: 990,
    height: 437
  });
});
