const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFiles } = require("./load-env");
const {
  appendCandidates,
  getExistingUniqueIds
} = require("./google-sheets-repository");
const { scrollCollectAndScreenshot } = require("./scroll-tiktok-live-feed");

const DEFAULT_CDP_URL = "http://localhost:9222";

async function connectBrowser() {
  const cdpUrl = process.env.TIKTOK_CDP_URL || DEFAULT_CDP_URL;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  return { browser, context };
}

function getLiveUrls() {
  const urls = (process.env.TIKTOK_LIVE_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(urls)];
}

function buildProfileUrl(uniqueId) {
  return uniqueId ? `https://www.tiktok.com/@${uniqueId}` : null;
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

  const { browser, context } = await connectBrowser();

  const page = context.pages().find((p) => p.url().includes("tiktok.com/live"));
  if (!page) {
    throw new Error(
      "agent-browserでTikTok LIVEページを開いてからスクリプトを実行してください。\n" +
      "例: agent-browser --args \"--remote-debugging-port=9222\" open https://www.tiktok.com/live"
    );
  }

  const options = {
    iterations: Number.parseInt(process.env.TIKTOK_SCROLL_ITERATIONS || "30", 10) || 30,
    distance: Number.parseInt(process.env.TIKTOK_SCROLL_DISTANCE || "500", 10) || 500,
    delayMs: Number.parseInt(process.env.TIKTOK_SCROLL_DELAY_MS || "3000", 10) || 3000,
    idleRounds: Number.parseInt(process.env.TIKTOK_SCROLL_IDLE_ROUNDS || "3", 10) || 3
  };

  let existingUniqueIds = new Set();
  const skipSheets = process.env.SKIP_SHEETS === "true";
  if (!skipSheets) {
    existingUniqueIds = await getExistingUniqueIds();
  }

  let results;
  try {
    const result = await scrollCollectAndScreenshot(page, options, screenshotDir);
    results = result.candidates;
  } finally {
    await browser.close();
  }

  for (const candidate of results) {
    candidate.duplicateFlag = Boolean(
      candidate.uniqueId && existingUniqueIds.has(candidate.uniqueId)
    );
  }

  const freshCandidates = results.filter((candidate) => !candidate.duplicateFlag);
  if (!skipSheets) {
    await appendCandidates(freshCandidates);
  }

  await writeRunSummary(outputDir, {
    collectedCount: results.length,
    appendedCount: freshCandidates.length,
    duplicatesCount: results.length - freshCandidates.length,
    results
  });

  console.log(
    JSON.stringify(
      {
        collectedCount: results.length,
        appendedCount: freshCandidates.length,
        duplicatesCount: results.length - freshCandidates.length
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

module.exports = { buildProfileUrl, getLiveUrls };
