const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFiles } = require("./load-env");

function parseBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function normalizeLiveUrl(rawHref, baseUrl) {
  if (!rawHref) {
    return null;
  }

  try {
    const normalized = new URL(rawHref, baseUrl);
    const match = normalized.pathname.match(/^\/@([^/]+)\/live\/?$/i);
    if (!match) {
      return null;
    }

    normalized.search = "";
    normalized.hash = "";

    return {
      uniqueId: match[1],
      liveUrl: normalized.toString()
    };
  } catch {
    return null;
  }
}

function dedupeLiveCandidates(candidates) {
  const merged = new Map();

  for (const candidate of candidates) {
    if (!candidate || !candidate.liveUrl) {
      continue;
    }

    const current = merged.get(candidate.liveUrl) || {};
    merged.set(candidate.liveUrl, {
      uniqueId: candidate.uniqueId || current.uniqueId || null,
      liveUrl: candidate.liveUrl,
      label: candidate.label || current.label || null
    });
  }

  return [...merged.values()];
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function waitForLiveFeed(page, delayMs) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
        (anchor) => anchor.getAttribute("href") || anchor.href || ""
      );

      const hasLiveCard = hrefs.some((href) => /\/@[^/]+\/live\/?$/i.test(href));
      const hasEmptyState =
        document.body.innerText.includes("おすすめのLIVEはまだありません") ||
        document.body.innerText.includes("No LIVE videos");

      return hasLiveCard || hasEmptyState;
    },
    { timeout: Math.max(delayMs, 1000) * 4 }
  ).catch(() => undefined);
  await page.waitForTimeout(delayMs);
}

async function collectVisibleLiveCandidates(page) {
  const pageUrl = page.url();
  const rawItems = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    return anchors
      .map((anchor) => ({
        href: anchor.getAttribute("href") || anchor.href || "",
        label:
          anchor.getAttribute("aria-label") ||
          anchor.textContent ||
          anchor.getAttribute("title") ||
          ""
      }))
      .filter((item) => item.href.includes("/live"));
  });

  return dedupeLiveCandidates(
    rawItems.map((item) => {
      const normalized = normalizeLiveUrl(item.href, pageUrl);
      if (!normalized) {
        return null;
      }

      return {
        ...normalized,
        label: item.label.replace(/\s+/g, " ").trim() || null
      };
    })
  );
}

function pickBestScrollContainer(items) {
  if (items.length === 0) {
    return null;
  }

  return [...items].sort((left, right) => {
    const leftDelta = left.scrollHeight - left.clientHeight;
    const rightDelta = right.scrollHeight - right.clientHeight;
    const leftScore = leftDelta + left.width + left.height;
    const rightScore = rightDelta + right.width + right.height;
    return rightScore - leftScore;
  })[0];
}

async function markScrollContainer(page) {
  const result = await page.evaluate(() => {
    const main =
      document.querySelector("#tiktok-live-main-container-id") || document.body;
    const nodes = Array.from(main.querySelectorAll("div, section, main"));

    for (const node of nodes) {
      node.removeAttribute("data-codex-scroll-target");
    }

    const candidates = nodes
      .map((node, index) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          index,
          overflowY: style.overflowY,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
        };
      })
      .filter((item) => {
        const delta = item.scrollHeight - item.clientHeight;
        const scrollable = item.overflowY === "auto" || item.overflowY === "scroll";
        const largeEnough = item.width >= 400 && item.height >= 200;
        return largeEnough && (scrollable || delta > 50);
      });

    const best = candidates.sort((left, right) => {
      const leftDelta = left.scrollHeight - left.clientHeight;
      const rightDelta = right.scrollHeight - right.clientHeight;
      const leftScore = leftDelta + left.width + left.height;
      const rightScore = rightDelta + right.width + right.height;
      return rightScore - leftScore;
    })[0];

    if (!best) {
      return null;
    }

    nodes[best.index].setAttribute("data-codex-scroll-target", "true");

    return {
      overflowY: best.overflowY,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
      width: best.width,
      height: best.height,
      text: best.text
    };
  });

  return result;
}

async function scrollTarget(page, distance) {
  const container = page.locator('[data-codex-scroll-target="true"]').first();
  if ((await container.count()) > 0) {
    await container.evaluate((node, pixels) => {
      node.scrollBy(0, pixels);
    }, distance);
    return "container";
  }

  await page.mouse.wheel(0, distance);
  return "page";
}

async function collectDebugSnapshot(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const hrefs = anchors
      .map((anchor) => anchor.getAttribute("href") || anchor.href || "")
      .filter(Boolean);

    return {
      title: document.title,
      anchorCount: hrefs.length,
      liveHrefCount: hrefs.filter((href) => href.includes("/live")).length,
      sampleHrefs: hrefs.slice(0, 20)
    };
  });
}

async function screenshotLiveCards(page, screenshotDir, seenUrls) {
  const sidebarItems = await page.locator('[data-e2e="live-side-nav-item"]').all();
  const results = [];

  for (const item of sidebarItems) {
    const info = await item.evaluate((el) => {
      const link = el.closest("a[href]") || el.querySelector("a[href]");
      if (!link) return null;
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/@([^/]+)\/live/);
      if (!match) return null;

      const nameEl = el.querySelector('[data-e2e="live-side-nav-name"]');
      const countEl = el.querySelector('[data-e2e="person-count"]');
      return {
        uniqueId: match[1],
        href,
        displayName: nameEl ? nameEl.textContent.trim() : null,
        viewerCount: countEl ? Number.parseInt(countEl.textContent.trim(), 10) : null
      };
    });

    if (!info || seenUrls.has(info.uniqueId)) continue;
    seenUrls.add(info.uniqueId);

    // サイドバーの項目をクリックしてLIVE配信ページに遷移
    try {
      await item.click();
      await page.waitForTimeout(3000);
    } catch {
      continue;
    }

    // LIVE配信ページのスクショを撮る
    const screenshotPath = path.join(screenshotDir, `${info.uniqueId}.png`);
    try {
      await page.screenshot({ path: screenshotPath });
    } catch {
      // スクショ失敗しても戻る
    }

    // /live フィードに戻る
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    results.push({
      uniqueId: info.uniqueId,
      liveUrl: `https://www.tiktok.com${info.href}`,
      profileUrl: `https://www.tiktok.com/@${info.uniqueId}`,
      displayName: info.displayName,
      viewerCount: info.viewerCount,
      screenshotPath,
      collectedAt: new Date().toISOString()
    });
  }

  return results;
}

async function scrollAndCollect(page, options) {
  const seen = new Map();
  const rounds = [];
  let stagnantRounds = 0;
  const scrollContainer = await markScrollContainer(page);

  for (let index = 0; index < options.iterations; index += 1) {
    const beforeSize = seen.size;
    const items = await collectVisibleLiveCandidates(page);

    for (const item of items) {
      seen.set(item.liveUrl, item);
    }

    const afterSize = seen.size;
    rounds.push({
      round: index + 1,
      foundThisRound: items.length,
      totalFound: afterSize
    });

    if (afterSize === beforeSize) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    if (stagnantRounds >= options.idleRounds) {
      break;
    }

    const scrollMode = await scrollTarget(page, options.distance);
    await page.waitForTimeout(options.delayMs);
    rounds[rounds.length - 1].scrollMode = scrollMode;
  }

  return {
    scrollContainer,
    rounds,
    candidates: [...seen.values()]
  };
}

async function scrollCollectAndScreenshot(page, options, screenshotDir) {
  const seenIds = new Set();
  const allResults = [];

  // 「See all」ボタンがあれば押してサイドバーを展開
  const moreBtn = page.locator('[data-e2e="live-side-more-button"]');
  if (await moreBtn.count() > 0) {
    await moreBtn.click();
    await page.waitForTimeout(2000);
    console.log("サイドバー展開済み");
  }

  const results = await screenshotLiveCards(page, screenshotDir, seenIds);
  allResults.push(...results);

  console.log(`収集完了: ${results.length}件`);

  return {
    rounds: [{ round: 1, newThisRound: results.length, totalFound: seenIds.size }],
    candidates: allResults
  };
}

async function main() {
  loadEnvFiles();

  const discoveryUrl = process.env.TIKTOK_DISCOVERY_URL || "https://www.tiktok.com/live";
  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
  const scrollOutputDir = path.join(outputDir, "scroll-test");

  const options = {
    iterations: parseNumber(process.env.TIKTOK_SCROLL_ITERATIONS, 5),
    distance: parseNumber(process.env.TIKTOK_SCROLL_DISTANCE, 2200),
    delayMs: parseNumber(process.env.TIKTOK_SCROLL_DELAY_MS, 2500),
    idleRounds: parseNumber(process.env.TIKTOK_SCROLL_IDLE_ROUNDS, 2),
    headless: parseBoolean(process.env.TIKTOK_HEADLESS, true)
  };

  await ensureDir(scrollOutputDir);

  const browser = await chromium.launch({
    headless: options.headless
  });

  try {
    const page = await browser.newPage();
    await page.goto(discoveryUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await waitForLiveFeed(page, options.delayMs);
    const result = await scrollAndCollect(page, options);
    const debug = await collectDebugSnapshot(page);

    const screenshotPath = path.join(scrollOutputDir, "latest-scroll.png");
    const jsonPath = path.join(scrollOutputDir, "latest-scroll.json");

    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });

    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          discoveryUrl,
          ...options,
          pageTitle: debug.title,
          currentUrl: page.url(),
          anchorCount: debug.anchorCount,
          liveHrefCount: debug.liveHrefCount,
          scrollContainer: result.scrollContainer,
          sampleHrefs: debug.sampleHrefs,
          candidateCount: result.candidates.length,
          rounds: result.rounds,
          candidates: result.candidates,
          screenshotPath
        },
        null,
        2
      )
    );

    console.log(
      JSON.stringify(
          {
            discoveryUrl,
            pageTitle: debug.title,
            anchorCount: debug.anchorCount,
            liveHrefCount: debug.liveHrefCount,
            scrollContainer: result.scrollContainer,
            candidateCount: result.candidates.length,
            rounds: result.rounds,
            outputJson: jsonPath,
          screenshotPath
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  collectVisibleLiveCandidates,
  pickBestScrollContainer,
  dedupeLiveCandidates,
  markScrollContainer,
  normalizeLiveUrl,
  parseBoolean,
  parseNumber,
  collectDebugSnapshot,
  scrollTarget,
  scrollAndCollect,
  scrollCollectAndScreenshot,
  screenshotLiveCards
};
