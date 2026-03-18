const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFile } = require("./load-env");
const {
  appendCandidates,
  getExistingUniqueIds
} = require("./google-sheets-repository");
const {
  extractMetadataFromHtml,
  extractUniqueIdFromUrl
} = require("./tiktok-live-parser");

function parseBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

function getLiveUrls() {
  const urls = (process.env.TIKTOK_LIVE_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    throw new Error("Set TIKTOK_LIVE_URLS with at least one TikTok LIVE URL.");
  }

  return [...new Set(urls)];
}

function buildProfileUrl(uniqueId) {
  return uniqueId ? `https://www.tiktok.com/@${uniqueId}` : null;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function collectLiveCandidate(browser, liveUrl, screenshotDir) {
  const page = await browser.newPage();
  try {
    await page.goto(liveUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.waitForTimeout(5000);

    const html = await page.content();
    const metadata = extractMetadataFromHtml(html, liveUrl);
    const uniqueId = metadata.uniqueId || extractUniqueIdFromUrl(liveUrl);
    const collectedAt = new Date().toISOString();

    const safeUniqueId = uniqueId || `unknown-${Date.now()}`;
    const screenshotPath = path.join(screenshotDir, `${safeUniqueId}.png`);
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });

    return {
      uniqueId,
      profileUrl: buildProfileUrl(uniqueId),
      liveUrl,
      followerCount: metadata.followerCount,
      title: metadata.title,
      screenshotPath,
      collectedAt,
      duplicateFlag: false,
      roomId: metadata.roomId,
      viewerCount: metadata.viewerCount
    };
  } finally {
    await page.close();
  }
}

async function writeRunSummary(outputDir, summary) {
  const filePath = path.join(outputDir, "latest-run.json");
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2));
}

async function main() {
  loadEnvFile();

  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
  const screenshotDir = path.join(outputDir, "screenshots");
  await ensureDir(screenshotDir);

  const liveUrls = getLiveUrls();
  const existingUniqueIds = await getExistingUniqueIds();
  const browser = await chromium.launch({
    headless: parseBoolean(process.env.TIKTOK_HEADLESS, true)
  });

  const results = [];
  try {
    for (const liveUrl of liveUrls) {
      const candidate = await collectLiveCandidate(browser, liveUrl, screenshotDir);
      candidate.duplicateFlag = Boolean(
        candidate.uniqueId && existingUniqueIds.has(candidate.uniqueId)
      );
      results.push(candidate);
    }
  } finally {
    await browser.close();
  }

  const freshCandidates = results.filter((candidate) => !candidate.duplicateFlag);
  await appendCandidates(freshCandidates);

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
