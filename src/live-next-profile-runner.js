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

function getSeedLiveUrl() {
  const first = (process.env.TIKTOK_LIVE_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);

  if (!first) {
    throw new Error("TIKTOK_LIVE_URLS に少なくとも1件の LIVE URL を入れてください。");
  }

  return first;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function waitForLivePage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);
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

async function findNextProfileButton(page) {
  return page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));

    const candidates = elements
      .map((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const className =
          typeof element.className === "string" ? element.className : "";

        return {
          className,
          cursor: style.cursor,
          pointerEvents: style.pointerEvents,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((item) => {
        const isArrowLike =
          item.className.includes("bg-UIImageOverlayBlackA25") ||
          item.className.includes("tiktok-wucdly");
        const inPlayerSide =
          item.x >= 900 && item.x <= 1150 && item.y >= 300 && item.y <= 600;
        const properSize =
          item.width >= 30 && item.width <= 60 && item.height >= 30 && item.height <= 60;
        const clickable =
          item.cursor === "pointer" || item.pointerEvents === "auto";

        return isArrowLike && inPlayerSide && properSize && clickable;
      })
      .sort((left, right) => left.y - right.y);

    if (candidates.length === 0) {
      return null;
    }

    const lower = candidates[candidates.length - 1];
    return {
      x: Math.round(lower.x + lower.width / 2),
      y: Math.round(lower.y + lower.height / 2),
      className: lower.className,
      width: Math.round(lower.width),
      height: Math.round(lower.height)
    };
  });
}

async function clickNextProfileButton(page) {
  const button = await findNextProfileButton(page);
  if (!button) {
    throw new Error("次プロフィール用の下ボタンが見つかりませんでした。");
  }

  await page.mouse.click(button.x, button.y);
  return button;
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

async function main() {
  loadEnvFiles();

  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
  const runDir = path.join(outputDir, "next-profile-test");
  const steps = parseNumber(process.env.TIKTOK_NEXT_PROFILE_STEPS, 3);
  const browser = await chromium.launch({
    headless: parseBoolean(process.env.TIKTOK_HEADLESS, true)
  });

  await ensureDir(runDir);

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const seedLiveUrl = getSeedLiveUrl();

    await page.goto(seedLiveUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await waitForLivePage(page);

    const history = [];
    for (let index = 0; index < steps; index += 1) {
      const before = await getCurrentLiveState(page);
      const button = await clickNextProfileButton(page);
      await waitForProfileChange(page, before);
      const after = await getCurrentLiveState(page);
      const screenshotPath = path.join(runDir, `step-${index + 1}.png`);

      await page.screenshot({
        path: screenshotPath,
        fullPage: true
      });

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
    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          seedLiveUrl,
          steps,
          history
        },
        null,
        2
      )
    );

    console.log(
      JSON.stringify(
        {
          seedLiveUrl,
          steps,
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
  findNextProfileButton,
  getCurrentLiveState,
  parseBoolean,
  parseNumber
};
