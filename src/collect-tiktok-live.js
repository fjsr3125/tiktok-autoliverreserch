const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFiles } = require("./load-env");
const {
  appendCandidates,
  getExistingUniqueIds
} = require("./google-sheets-repository");
const { scrollCollectAndScreenshot, navigateAndCollect } = require("./scroll-tiktok-live-feed");

const DEFAULT_CDP_URL = "http://localhost:9222";
const DEFAULT_STORAGE_STATE_PATH = "playwright/.auth/tiktok-live-state.json";

async function getStorageStatePath() {
  const statePath = process.env.STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH;
  try {
    await fs.access(statePath);
    return statePath;
  } catch {
    return null;
  }
}

async function connectBrowser() {
  const mode = process.env.BROWSER_MODE || "cdp";

  if (mode === "launch") {
    const statePath = await getStorageStatePath();
    const launchOptions = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    const browser = await chromium.launch(launchOptions);
    const contextOptions = {
      ...(statePath ? { storageState: statePath } : {}),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "ja-JP"
    };
    const context = await browser.newContext(contextOptions);
    return { browser, context, mode };
  }

  const cdpUrl = process.env.TIKTOK_CDP_URL || DEFAULT_CDP_URL;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  return { browser, context, mode };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeRunSummary(outputDir, summary) {
  const filePath = path.join(outputDir, "latest-run.json");
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2));
}

async function main() {
  loadEnvFiles();

  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
  const screenshotDir = path.join(outputDir, "screenshots");
  await ensureDir(screenshotDir);

  const { browser, context, mode } = await connectBrowser();

  let page;
  if (mode === "launch") {
    page = await context.newPage();
    await page.goto("https://www.tiktok.com/live", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForTimeout(3000);
  } else {
    page = context.pages().find((p) => /tiktok\.com\/(live|@[^/]+\/live)/.test(p.url()));
    // Accept-Language を日本語に設定
    if (page) {
      await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7" });
    }
    if (!page) {
      throw new Error(
        "TikTok LIVEページを開いてからスクリプトを実行してください。\n" +
        "CDPモード: ブラウザで https://www.tiktok.com/live を開いておく\n" +
        "Launchモード: BROWSER_MODE=launch で自動起動"
      );
    }
    // 個別LIVEページにいる場合はフィードに戻す
    if (!page.url().match(/tiktok\.com\/live\/?(\?|#|$)/)) {
      await page.goto("https://www.tiktok.com/live", {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      await page.waitForTimeout(3000);
    }
  }

  const collectMode = process.env.COLLECT_MODE || "navigate";
  const options = {
    iterations: Number.parseInt(process.env.TIKTOK_SCROLL_ITERATIONS || "30", 10) || 30,
    distance: Number.parseInt(process.env.TIKTOK_SCROLL_DISTANCE || "500", 10) || 500,
    delayMs: Number.parseInt(process.env.TIKTOK_SCROLL_DELAY_MS || "3000", 10) || 3000,
    idleRounds: Number.parseInt(process.env.TIKTOK_SCROLL_IDLE_ROUNDS || "3", 10) || 3,
    maxCollect: Number.parseInt(process.env.MAX_COLLECT || "100", 10) || 100,
    navFailLimit: Number.parseInt(process.env.NAV_FAIL_LIMIT || "3", 10) || 3
  };

  let existingUniqueIds = new Set();
  const skipSheets = process.env.SKIP_SHEETS === "true";
  if (!skipSheets) {
    existingUniqueIds = await getExistingUniqueIds();
  }

  const minFollowers = Number.parseInt(process.env.MIN_FOLLOWERS || "0", 10);
  const results = [];

  // 1件取得するたびにJSONに保存するコールバック
  const onCandidate = async (candidate) => {
    candidate.duplicateFlag = Boolean(
      candidate.uniqueId && existingUniqueIds.has(candidate.uniqueId)
    );

    // follower足切り（nullは取得失敗なので通す）
    if (minFollowers > 0 && candidate.followerCount !== null && candidate.followerCount < minFollowers) {
      candidate.skippedReason = "follower_count_below_threshold";
    }

    results.push(candidate);

    const appendable = results.filter((c) => !c.duplicateFlag && !c.skippedReason);
    await writeRunSummary(outputDir, {
      collectedCount: results.length,
      appendedCount: appendable.length,
      duplicatesCount: results.filter((c) => c.duplicateFlag).length,
      skippedCount: results.filter((c) => c.skippedReason).length,
      results
    });
    const followers = candidate.followerCount != null ? `${candidate.followerCount} followers` : "? followers";
    const skipped = candidate.skippedReason ? " [SKIP]" : "";
    console.log(`[${results.length}] ${candidate.uniqueId} (${followers}, ${candidate.viewerCount ?? "?"} viewers)${skipped}`);
  };

  try {
    if (collectMode === "navigate") {
      await navigateAndCollect(page, options, screenshotDir, onCandidate);
    } else {
      await scrollCollectAndScreenshot(page, options, screenshotDir, onCandidate);
    }
  } finally {
    await browser.close();
  }

  const appendable = results.filter((c) => !c.duplicateFlag && !c.skippedReason);
  if (!skipSheets) {
    await appendCandidates(appendable);
  }

  const summary = {
    collectedCount: results.length,
    appendedCount: appendable.length,
    duplicatesCount: results.filter((c) => c.duplicateFlag).length,
    skippedCount: results.filter((c) => c.skippedReason).length,
    minFollowers,
    results
  };

  await writeRunSummary(outputDir, summary);

  console.log(
    JSON.stringify(
      {
        collectedCount: summary.collectedCount,
        appendedCount: summary.appendedCount,
        duplicatesCount: summary.duplicatesCount,
        skippedCount: summary.skippedCount,
        minFollowers
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
