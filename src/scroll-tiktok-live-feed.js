const fs = require("node:fs/promises");
const https = require("node:https");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFiles } = require("./load-env");
const { extractMetadataFromHtml, extractUniqueIdFromUrl } = require("./tiktok-live-parser");
const {
  clickNextProfileButton,
  getCurrentLiveState,
  waitForProfileChange,
  parseBoolean,
  parseNumber
} = require("./live-navigation-runner");

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

async function downloadImage(url, destPath, timeoutMs = 10000) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location, destPath, timeoutMs).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", async () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) {
          reject(new Error("Image too small"));
          return;
        }
        await fs.writeFile(destPath, buffer);
        resolve(buffer.length);
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
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

async function collectLiveCardsFromPage(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const cards = [];
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/^\/@([^/]+)\/live\/?$/);
      if (!match) continue;

      const uniqueId = match[1];
      if (seen.has(uniqueId)) continue;

      // カードコンテナを探す（"watching" テキストを含む最寄りの親）
      let container = anchor;
      for (let i = 0; i < 8; i++) {
        if (!container.parentElement) break;
        container = container.parentElement;
        if ((container.textContent || "").includes("watching")) break;
      }

      const text = (container.textContent || "").replace(/\s+/g, " ").trim();
      const viewerMatch = text.match(/(\d[\d,]*)\s*watching/i);
      const viewerCount = viewerMatch
        ? Number.parseInt(viewerMatch[1].replace(/,/g, ""), 10)
        : null;

      // タイトル抽出: "LIVE" の後〜ユーザー名 or watching の前
      const titleMatch = text.match(/LIVE\s*(.+?)(?:\d[\d,]*\s*watching|Click to watch)/i);
      const displayName = titleMatch ? titleMatch[1].trim() : uniqueId;

      seen.add(uniqueId);
      cards.push({ uniqueId, href, displayName, viewerCount });
    }

    return cards;
  });
}

async function screenshotLiveCards(page, screenshotDir, seenUrls, onCandidate) {
  const cards = await collectLiveCardsFromPage(page);
  const results = [];
  const feedUrl = page.url();

  for (const info of cards) {
    if (seenUrls.has(info.uniqueId)) continue;
    seenUrls.add(info.uniqueId);

    const liveUrl = `https://www.tiktok.com${info.href}`;

    // LIVE配信ページに遷移してメタデータ抽出
    try {
      await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
    } catch {
      continue;
    }

    // 埋め込みデータからfollowerCount等を抽出
    let meta = {};
    try {
      const html = await page.content();
      meta = extractMetadataFromHtml(html, liveUrl);
    } catch {
      // 抽出失敗しても続行
    }

    // サムネイル画像をダウンロード（失敗時はスクショにフォールバック）
    const screenshotPath = path.join(screenshotDir, `${info.uniqueId}.png`);
    if (meta.coverUrl) {
      try {
        await downloadImage(meta.coverUrl, screenshotPath);
      } catch {
        try { await page.screenshot({ path: screenshotPath }); } catch { /* 続行 */ }
      }
    } else {
      try { await page.screenshot({ path: screenshotPath }); } catch { /* 続行 */ }
    }

    const candidate = {
      uniqueId: info.uniqueId,
      liveUrl,
      profileUrl: `https://www.tiktok.com/@${info.uniqueId}`,
      displayName: info.displayName,
      followerCount: meta.followerCount ?? null,
      viewerCount: meta.viewerCount ?? info.viewerCount,
      title: meta.title ?? null,
      roomId: meta.roomId ?? null,
      screenshotPath,
      collectedAt: new Date().toISOString()
    };
    results.push(candidate);

    // 1件ごとに保存コールバック
    if (onCandidate) {
      await onCandidate(candidate);
    }
  }

  // フィードに戻る
  if (results.length > 0) {
    await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
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

async function scrollCollectAndScreenshot(page, options, screenshotDir, onCandidate) {
  const seenIds = new Set();
  const allResults = [];
  const allRounds = [];

  // Phase 1: スクロールしながらLIVEカードのリンクを収集
  const scrollResult = await scrollAndCollect(page, options);
  allRounds.push(...scrollResult.rounds);
  console.log(`スクロール発見: ${scrollResult.candidates.length}件`);

  // Phase 2: 発見したカード + 現在表示中のカードからスクショ収集
  const results = await screenshotLiveCards(page, screenshotDir, seenIds, onCandidate);
  allResults.push(...results);

  // スクロールで見つけたがスクショ未取得の候補も処理
  for (const candidate of scrollResult.candidates) {
    const match = candidate.liveUrl.match(/\/@([^/]+)\/live/);
    if (!match || seenIds.has(match[1])) continue;
    seenIds.add(match[1]);

    try {
      await page.goto(candidate.liveUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
    } catch {
      continue;
    }

    let meta = {};
    try {
      const html = await page.content();
      meta = extractMetadataFromHtml(html, candidate.liveUrl);
    } catch {
      // 抽出失敗しても続行
    }

    const screenshotPath = path.join(screenshotDir, `${match[1]}.png`);
    if (meta.coverUrl) {
      try {
        await downloadImage(meta.coverUrl, screenshotPath);
      } catch {
        try { await page.screenshot({ path: screenshotPath }); } catch { /* 続行 */ }
      }
    } else {
      try { await page.screenshot({ path: screenshotPath }); } catch { /* 続行 */ }
    }

    const result = {
      uniqueId: match[1],
      liveUrl: candidate.liveUrl,
      profileUrl: `https://www.tiktok.com/@${match[1]}`,
      displayName: candidate.label || match[1],
      followerCount: meta.followerCount ?? null,
      viewerCount: meta.viewerCount ?? null,
      title: meta.title ?? null,
      roomId: meta.roomId ?? null,
      screenshotPath,
      collectedAt: new Date().toISOString()
    };
    allResults.push(result);

    if (onCandidate) {
      await onCandidate(result);
    }
  }

  console.log(`収集完了: ${allResults.length}件`);

  return {
    rounds: allRounds,
    candidates: allResults
  };
}

async function openFirstLiveCard(page) {
  const firstCard = page.locator('a[href*="/@"][href*="/live"]').first();
  await firstCard.waitFor({ state: "visible", timeout: 15000 });
  await firstCard.click();
  await page.waitForTimeout(5000);
}

async function navigateAndCollect(page, options, screenshotDir, onCandidate) {
  const maxCollect = options.maxCollect || 100;
  const navFailLimit = options.navFailLimit || 3;
  const seen = new Set();
  const discoveredUrls = [];
  let consecutiveFails = 0;

  // Phase 1: ↓ボタンでLIVE URLを高速収集
  await waitForLiveFeed(page, 3000);
  await openFirstLiveCard(page);
  await page.waitForTimeout(3000);
  console.log("最初のLIVEに入りました");
  console.log("Phase 1: ↓ボタンでURL収集中...");

  let duplicateStreak = 0;
  const maxDuplicateStreak = 10;

  for (let i = 0; i < maxCollect * 3; i++) {
    const currentUrl = page.url();
    const uniqueId = extractUniqueIdFromUrl(currentUrl);
    if (uniqueId && !seen.has(uniqueId)) {
      seen.add(uniqueId);
      discoveredUrls.push({ uniqueId, liveUrl: `https://www.tiktok.com/@${uniqueId}/live` });
      consecutiveFails = 0;
      duplicateStreak = 0;
    } else if (uniqueId) {
      duplicateStreak++;
    } else {
      consecutiveFails++;
    }

    if (discoveredUrls.length >= maxCollect) break;
    if (consecutiveFails >= navFailLimit) {
      console.log(`↓ボタン失敗が${navFailLimit}回連続 → 終了`);
      break;
    }
    if (duplicateStreak >= maxDuplicateStreak) {
      console.log(`重複が${maxDuplicateStreak}回連続 → 終了`);
      break;
    }

    // ↓ボタンで次へ
    try {
      const state = await getCurrentLiveState(page);
      await clickNextProfileButton(page);
      await waitForProfileChange(page, state);
    } catch (err) {
      consecutiveFails++;
      console.log(`↓ボタン失敗(${consecutiveFails}): ${err.message}`);
      if (consecutiveFails >= navFailLimit) break;
    }
  }

  console.log(`Phase 1完了: ${discoveredUrls.length}件のURL発見`);

  // Phase 2: 各URLにgotoしてメタデータ+サムネイル取得
  console.log("Phase 2: メタデータ+サムネイル収集中...");
  const allResults = [];

  for (const { uniqueId, liveUrl } of discoveredUrls) {
    // ページに直接遷移（SSR JSONが含まれる）
    try {
      await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
    } catch {
      continue;
    }

    let meta = {};
    try {
      const html = await page.content();
      meta = extractMetadataFromHtml(html, liveUrl);
    } catch { /* 続行 */ }

    // サムネイル画像をダウンロード（失敗時はスクショにフォールバック）
    const imagePath = path.join(screenshotDir, `${uniqueId}.png`);
    if (meta.coverUrl) {
      try {
        await downloadImage(meta.coverUrl, imagePath);
      } catch {
        try { await page.screenshot({ path: imagePath }); } catch { /* 続行 */ }
      }
    } else {
      try { await page.screenshot({ path: imagePath }); } catch { /* 続行 */ }
    }

    const candidate = {
      uniqueId,
      liveUrl,
      profileUrl: `https://www.tiktok.com/@${uniqueId}`,
      displayName: meta.uniqueId || uniqueId,
      followerCount: meta.followerCount ?? null,
      viewerCount: meta.viewerCount ?? null,
      title: meta.title ?? null,
      roomId: meta.roomId ?? null,
      screenshotPath: imagePath,
      collectedAt: new Date().toISOString()
    };
    allResults.push(candidate);

    if (onCandidate) {
      await onCandidate(candidate);
    }
  }

  console.log(`収集完了: ${allResults.length}件`);
  return { candidates: allResults };
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
  collectLiveCardsFromPage,
  pickBestScrollContainer,
  dedupeLiveCandidates,
  normalizeLiveUrl,
  scrollAndCollect,
  scrollCollectAndScreenshot,
  screenshotLiveCards,
  navigateAndCollect
};
