const fs = require("node:fs");
const fsp = require("node:fs/promises");
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

function getRequiredStorageStatePath() {
  const rawPath =
    process.env.TIKTOK_STORAGE_STATE_PATH || "playwright/.auth/tiktok-live-state.json";
  const resolvedPath = path.resolve(rawPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `TIKTOK_STORAGE_STATE_PATH が見つかりません: ${resolvedPath}`
    );
  }

  return resolvedPath;
}

function getLiveTopUrl() {
  return process.env.TIKTOK_LIVE_TOP_URL || "https://www.tiktok.com/live";
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function createContext(browser, options) {
  return browser.newContext({
    storageState: options.storageStatePath,
    viewport: { width: 1440, height: 960 }
  });
}

async function gotoLiveTop(page, liveTopUrl) {
  await page.goto(liveTopUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.waitForTimeout(5000);
}

async function inspectLiveTop(page) {
  return page.evaluate(() => {
    const liveLinks = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => ({
        href: anchor.getAttribute("href") || anchor.href || "",
        text: (anchor.textContent || "").replace(/\s+/g, " ").trim()
      }))
      .filter((item) => /\/@[^/]+\/live\/?$/i.test(item.href));

    const emptyState = document.body.innerText.includes("おすすめのLIVEはまだありません");

    return {
      title: document.title,
      url: location.href,
      liveLinkCount: liveLinks.length,
      firstLiveLink: liveLinks[0] || null,
      emptyState
    };
  });
}

async function openFirstLiveCard(page) {
  const firstCard = page.locator('a[href*="/@"][href*="/live"]').first();
  await firstCard.waitFor({ state: "visible", timeout: 15000 });
  const href = await firstCard.getAttribute("href");
  await firstCard.click();
  await page.waitForTimeout(5000);
  return href;
}

async function getCurrentLiveState(page) {
  return page.evaluate(() => {
    const url = location.href;
    const title = document.title;
    const creatorAnchor =
      document.querySelector('a[href^="/@"]') ||
      document.querySelector('a[href*="/@"]');

    return {
      url,
      title,
      creatorProfileUrl: creatorAnchor ? creatorAnchor.href : null,
      creatorName: creatorAnchor
        ? (creatorAnchor.textContent || "").replace(/\s+/g, " ").trim() || null
        : null
    };
  });
}

function pickLowestButton(candidates) {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => right.y - left.y)[0];
}

async function clickNextProfileButton(page) {
  const result = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));

    const candidates = elements
      .map((element) => {
        const className =
          typeof element.className === "string" ? element.className : "";
        const rect = element.getBoundingClientRect();

        return {
          element,
          className,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((item) => {
        const className = item.className;
        const looksLikeOverlayButton =
          className.includes("rounded-full") &&
          className.includes("cursor-pointer") &&
          className.includes("bg-UIImageOverlayBlackA25");
        const reasonableSize =
          item.width >= 30 && item.width <= 60 && item.height >= 30 && item.height <= 60;
        const inPlayerSide =
          item.x >= window.innerWidth * 0.6 &&
          item.x <= window.innerWidth * 0.9 &&
          item.y >= window.innerHeight * 0.2 &&
          item.y <= window.innerHeight * 0.8;

        return looksLikeOverlayButton && reasonableSize && inPlayerSide;
      })
      .sort((left, right) => right.y - left.y);

    if (candidates.length === 0) {
      return null;
    }

    const target = candidates[0];
    target.element.click();

    return {
      className: target.className,
      x: Math.round(target.x),
      y: Math.round(target.y),
      width: Math.round(target.width),
      height: Math.round(target.height)
    };
  });

  if (!result) {
    throw new Error("次プロフィール用の下ボタンを DOM 構造から見つけられませんでした。");
  }

  return result;
}

async function waitForProfileChange(page, previousState) {
  await page
    .waitForFunction(
      (previousUrl) => location.href !== previousUrl,
      previousState.url,
      { timeout: 15000 }
    )
    .catch(() => undefined);

  await page.waitForTimeout(4000);
}

async function saveScreenshot(page, outputDir, fileName) {
  const screenshotPath = path.join(outputDir, fileName);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  });
  return screenshotPath;
}

async function openLiveFromTop(browser, options) {
  let context = await createContext(browser, options);
  let page = await context.newPage();

  await gotoLiveTop(page, options.liveTopUrl);
  let liveTopState = await inspectLiveTop(page);

  if (liveTopState.emptyState || liveTopState.liveLinkCount === 0) {
    await context.close();
    context = await createContext(browser, options);
    page = await context.newPage();
    await gotoLiveTop(page, options.liveTopUrl);
    liveTopState = await inspectLiveTop(page);
  }

  if (liveTopState.emptyState || liveTopState.liveLinkCount === 0) {
    throw new Error("`/live` トップが空表示のままで、最初の配信カードを見つけられませんでした。");
  }

  const clickedHref = await openFirstLiveCard(page);
  await page.waitForTimeout(3000);

  return {
    context,
    page,
    liveTopState,
    clickedHref
  };
}

async function main() {
  loadEnvFiles();

  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
  const runDir = path.join(outputDir, "live-navigation-test");
  const options = {
    storageStatePath: getRequiredStorageStatePath(),
    liveTopUrl: getLiveTopUrl(),
    steps: parseNumber(process.env.TIKTOK_NEXT_PROFILE_STEPS, 3),
    headless: parseBoolean(process.env.TIKTOK_HEADLESS, true)
  };

  await ensureDir(runDir);

  const browser = await chromium.launch({
    headless: options.headless
  });

  try {
    const flow = await openLiveFromTop(browser, options);
    const { context, page, liveTopState, clickedHref } = flow;

    const initialScreenshotPath = await saveScreenshot(page, runDir, "step-0-entered-live.png");
    const history = [];

    for (let index = 0; index < options.steps; index += 1) {
      const before = await getCurrentLiveState(page);
      const button = await clickNextProfileButton(page);
      await waitForProfileChange(page, before);
      const after = await getCurrentLiveState(page);
      const screenshotPath = await saveScreenshot(page, runDir, `step-${index + 1}.png`);

      history.push({
        step: index + 1,
        button,
        before,
        after,
        changed: before.url !== after.url,
        screenshotPath
      });
    }

    const jsonPath = path.join(runDir, "latest-run.json");
    await fsp.writeFile(
      jsonPath,
      JSON.stringify(
        {
          options,
          liveTopState,
          clickedHref,
          initialScreenshotPath,
          history
        },
        null,
        2
      )
    );

    console.log(
      JSON.stringify(
        {
          liveTopUrl: options.liveTopUrl,
          clickedHref,
          initialScreenshotPath,
          history: history.map((item) => ({
            step: item.step,
            changed: item.changed,
            beforeUrl: item.before.url,
            afterUrl: item.after.url,
            screenshotPath: item.screenshotPath
          })),
          outputJson: jsonPath
        },
        null,
        2
      )
    );

    await context.close();
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
  clickNextProfileButton,
  getCurrentLiveState,
  getRequiredStorageStatePath,
  inspectLiveTop,
  parseBoolean,
  parseNumber,
  pickLowestButton
};
