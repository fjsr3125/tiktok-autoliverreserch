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
  const player = page.locator('[data-e2e="live-room-content"]').first();
  await player.waitFor({ state: "visible", timeout: 10000 });

  const box = await player.boundingBox();
  if (!box) {
    throw new Error("LIVEプレイヤー領域を取得できませんでした。");
  }

  // hoverしてオーバーレイを出す
  await page.mouse.move(
    Math.round(box.x + box.width * 0.82),
    Math.round(box.y + box.height * 0.55)
  );
  await page.waitForTimeout(300);

  const target = await page.evaluate(() => {
    const room = document.querySelector('[data-e2e="live-room-content"]');
    if (!room) return null;

    const roomRect = room.getBoundingClientRect();
    const excludedSelector = [
      '[data-e2e="control-bar-id-v2"]',
      '[data-e2e="live-chat-container"]',
      '[data-e2e="live-second-screen-container"]'
    ].join(",");

    const candidates = Array.from(document.querySelectorAll("div, button"))
      .filter((element) => {
        const cn = typeof element.className === "string" ? element.className : "";
        if (!cn.includes("rounded-full") || !cn.includes("bg-UIImageOverlayBlackA25")) return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 28 && rect.width <= 64 && rect.height >= 28 && rect.height <= 64;
      })
      .filter((element) => {
        // SVG path で下向き矢印を識別 (path d="m24 28.75...")
        const svg = element.querySelector("svg");
        if (!svg) return false;
        const pathD = svg.querySelector("path")?.getAttribute("d") || "";
        return pathD.includes("28.75");
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      });

    return candidates[0] || null;
  });

  const clickPoint = target
    ? { x: Math.round(target.x), y: Math.round(target.y), strategy: "dom-candidate" }
    : { x: Math.round(box.x + box.width * 0.89), y: Math.round(box.y + box.height * 0.68), strategy: "player-relative-fallback" };

  await page.mouse.click(clickPoint.x, clickPoint.y);

  return clickPoint;
}

async function waitForProfileChange(page, previousState) {
  const changed = await page
    .waitForFunction(
      (prev) => {
        if (location.href !== prev.url) return true;
        const anchor =
          document.querySelector('[data-e2e="room-header-anchor-name"]');
        if (anchor) {
          const name = (anchor.textContent || "").trim();
          if (name && name !== prev.creatorName) return true;
        }
        return false;
      },
      previousState,
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(1500);
  return changed;
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
  pickLowestButton,
  waitForProfileChange
};
