const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const { loadEnvFiles } = require("./load-env");
const { extractMetadataFromHtml, extractUniqueIdFromUrl } = require("./tiktok-live-parser");
const {
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

function buildLiveCandidate({
  uniqueId,
  liveUrl,
  meta = {},
  screenshotPath,
  fallbackDisplayName = null,
  fallbackViewerCount = null
}) {
  const resolvedUniqueId = uniqueId || meta.uniqueId || extractUniqueIdFromUrl(liveUrl);

  return {
    uniqueId: resolvedUniqueId,
    liveUrl,
    profileUrl: resolvedUniqueId ? `https://www.tiktok.com/@${resolvedUniqueId}` : null,
    displayName: meta.nickname || fallbackDisplayName || meta.uniqueId || resolvedUniqueId,
    followerCount: meta.followerCount ?? null,
    viewerCount: meta.viewerCount ?? fallbackViewerCount ?? null,
    title: meta.title ?? null,
    roomId: meta.roomId ?? null,
    bio: meta.bio ?? null,
    screenshotStatus: meta.screenshotStatus ?? null,
    screenshotPath,
    collectedAt: new Date().toISOString()
  };
}

function normalizeCurrentLiveUrl(currentUrl, uniqueId) {
  const normalized = normalizeLiveUrl(currentUrl, currentUrl);
  if (normalized) {
    return normalized.liveUrl;
  }

  if (uniqueId) {
    return `https://www.tiktok.com/@${uniqueId}/live`;
  }

  return currentUrl;
}

async function extractLiveMetadataFromDom(page) {
  return page.evaluate(() => {
    const url = location.href;
    const uniqueIdMatch = url.match(/\/@([^/?#]+)\/live/i);
    const uniqueId = uniqueIdMatch ? uniqueIdMatch[1] : null;

    // 配信者名: data-e2e="room-header-anchor-name"
    let nickname = null;
    const nameEl = document.querySelector('[data-e2e="room-header-anchor-name"]');
    if (nameEl) {
      nickname = (nameEl.textContent || "").trim() || null;
    }

    // NOTE: data-e2e="room-header-like-count" はTikTokのUI変更で廃止済み
    // フォロワー数はプロフィールページから取得する（fetchProfileFollowerCount）

    // 視聴者数: data-e2e="live-chat-container" 内の "Viewers · N"
    let viewerCount = null;
    const chatContainer = document.querySelector('[data-e2e="live-chat-container"]');
    if (chatContainer) {
      const text = (chatContainer.textContent || "");
      const vm = text.match(/Viewers?\s*[·:]?\s*(\d[\d,]*)/i);
      if (vm) viewerCount = Number.parseInt(vm[1].replace(/,/g, ""), 10);
    }

    return { uniqueId, nickname, followerCount: null, viewerCount, title: null };
  });
}

/**
 * プロフィールページからフォロワー数・bio・リンクを取得する
 * LIVEページのDOMからはフォロワー数が取れなくなったため、プロフィールに遷移して取得
 */
async function fetchProfileData(page, uniqueId) {
  const profileUrl = `https://www.tiktok.com/@${uniqueId}`;
  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator('[data-e2e="followers-count"]')
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});

    return page.evaluate(() => {
      const multipliers = { K: 1000, M: 1000000, B: 1000000000 };
      function parseCount(el) {
        if (!el) return null;
        const raw = (el.textContent || "").trim();
        const m = raw.match(/([\d.]+)\s*([KMBkmb])?/);
        if (!m) return null;
        const num = Number.parseFloat(m[1]);
        const mult = multipliers[(m[2] || "").toUpperCase()] || 1;
        return Math.round(num * mult);
      }
      const bioEl = document.querySelector('[data-e2e="user-bio"]');
      const linkEl = document.querySelector('[data-e2e="user-link"]');
      return {
        followerCount: parseCount(document.querySelector('[data-e2e="followers-count"]')),
        bio: bioEl ? (bioEl.textContent || "").trim() || null : null,
        linkUrl: linkEl ? (linkEl.textContent || "").trim() || null : null
      };
    });
  } catch (err) {
    console.log(`[profile] プロフィール取得失敗: ${uniqueId} - ${err.message}`);
    return { followerCount: null, bio: null, linkUrl: null };
  }
}

async function extractLiveMetadata(page, liveUrl) {
  try {
    // まずDOMから取得（SPA遷移後でも正確）
    const domMeta = await extractLiveMetadataFromDom(page);

    // HTMLのSIGI_STATEからも取得（followerCount等はDOMに無い場合がある）
    let htmlMeta = {};
    try {
      const html = await page.content();
      htmlMeta = extractMetadataFromHtml(html, liveUrl);
    } catch { /* フォールバック */ }

    return {
      uniqueId: domMeta.uniqueId || htmlMeta.uniqueId,
      nickname: domMeta.nickname || htmlMeta.nickname,
      // followerCountはプロフィールページから別途取得するため、ここではSIGI_STATEのみ
      followerCount: htmlMeta.followerCount ?? null,
      viewerCount: domMeta.viewerCount ?? htmlMeta.viewerCount ?? null,
      title: domMeta.title || htmlMeta.title,
      roomId: htmlMeta.roomId ?? null,
      coverUrl: htmlMeta.coverUrl ?? null
    };
  } catch {
    return {};
  }
}

async function waitForLiveMedia(page, timeoutMs = 10000) {
  try {
    await page.waitForFunction(
      () => {
        const videos = Array.from(document.querySelectorAll("video"));
        const readyVideo = videos.some((video) => {
          const rect = video.getBoundingClientRect();
          return video.readyState >= 2 && rect.width >= 160 && rect.height >= 120;
        });

        if (readyVideo) return true;

        const canvases = Array.from(document.querySelectorAll("canvas"));
        return canvases.some((canvas) => {
          const rect = canvas.getBoundingClientRect();
          return rect.width >= 160 && rect.height >= 120;
        });
      },
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

async function captureLiveCandidate(page, {
  uniqueId,
  liveUrl,
  screenshotDir,
  fallbackDisplayName = null,
  fallbackViewerCount = null
}) {
  const screenshotPath = path.join(screenshotDir, `${uniqueId}.png`);
  const liveMediaReady = await waitForLiveMedia(
    page,
    Number.parseInt(process.env.LIVE_MEDIA_WAIT_MS || "10000", 10)
  );

  try {
    // LIVE映像要素が取れる場合はそこを優先して、黒いコンテナやプロフィールだけの誤判定を減らす。
    const mediaEl = page.locator("video, canvas").first();
    const mediaBox = liveMediaReady ? await mediaEl.boundingBox().catch(() => null) : null;
    const contentEl = page.locator('[data-e2e="live-content-container"], [data-e2e="live-player-container"]').first();
    const contentBox = await contentEl.boundingBox().catch(() => null);
    const box = mediaBox || contentBox;
    if (box && box.width >= 160 && box.height >= 120) {
      await page.screenshot({ path: screenshotPath, clip: box });
    } else {
      await page.screenshot({ path: screenshotPath });
    }
  } catch {
    // スクショ失敗でも候補自体は返す
  }

  const meta = await extractLiveMetadata(page, liveUrl);

  // プロフィールページからフォロワー数・bio・リンクを取得
  const profileData = await fetchProfileData(page, uniqueId);
  if (profileData.followerCount != null) {
    meta.followerCount = profileData.followerCount;
  }
  meta.bio = profileData.bio;
  meta.screenshotStatus = liveMediaReady ? "live_media_ready" : "live_media_not_ready";

  return buildLiveCandidate({
    uniqueId,
    liveUrl,
    meta,
    screenshotPath,
    fallbackDisplayName,
    fallbackViewerCount
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
      await page.locator('[data-e2e="room-header-anchor-name"]')
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(5000);
    } catch {
      continue;
    }

    const candidate = await captureLiveCandidate(page, {
      uniqueId: info.uniqueId,
      liveUrl,
      screenshotDir,
      fallbackDisplayName: info.displayName,
      fallbackViewerCount: info.viewerCount
    });
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
      await page.locator('[data-e2e="room-header-anchor-name"]')
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(5000);
    } catch {
      continue;
    }

    const result = await captureLiveCandidate(page, {
      uniqueId: match[1],
      liveUrl: candidate.liveUrl,
      screenshotDir,
      fallbackDisplayName: candidate.label || match[1]
    });
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
  // 初回はフォロワー数要素が描画されるまで待つ
  await page.locator('[data-e2e="room-header-like-count"]')
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
}

async function collectFeedItems(page) {
  // "See all" で展開
  const seeAllBtn = page.locator('[data-e2e="live-side-more-button"]');
  if (await seeAllBtn.isVisible().catch(() => false)) {
    await seeAllBtn.click();
    await page.waitForTimeout(1000);
  }

  return page.evaluate(() => {
    const seen = new Set();
    const results = [];

    // サイドバーから取得
    const sideItems = Array.from(document.querySelectorAll('[data-e2e="live-side-nav-item"]'));
    for (const item of sideItems) {
      const nameEl = item.querySelector('[data-e2e="live-side-nav-name"]');
      const uniqueId = nameEl ? nameEl.textContent.trim() : null;
      if (!uniqueId || seen.has(uniqueId)) continue;
      const viewerEl = item.querySelector('[data-e2e="person-count"]');
      const viewerCount = viewerEl
        ? Number.parseInt(viewerEl.textContent.replace(/,/g, ""), 10)
        : null;
      seen.add(uniqueId);
      results.push({ uniqueId, href: `/@${uniqueId}/live`, viewerCount, source: "sidebar" });
    }

    // メインフィードのLIVEリンクから取得
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/^\/@([^/]+)\/live\/?$/);
      if (!match) continue;
      const uniqueId = match[1];
      if (seen.has(uniqueId)) continue;
      seen.add(uniqueId);
      results.push({ uniqueId, href: `/@${uniqueId}/live`, viewerCount: null, source: "feed" });
    }

    return results;
  });
}

async function navigateAndCollect(page, options, screenshotDir, onCandidate) {
  const maxCollect = options.maxCollect || 100;
  const allResults = [];
  const feedUrl = "https://www.tiktok.com/live";

  await waitForLiveFeed(page, 3000);

  // サイドバー + メインフィードから配信者リストを取得
  const feedItems = await collectFeedItems(page);
  console.log(`フィードから${feedItems.length}件発見`);

  if (feedItems.length === 0) {
    console.log("配信者が見つかりませんでした");
    return { candidates: allResults };
  }

  for (const item of feedItems) {
    if (allResults.length >= maxCollect) break;

    const liveUrl = `https://www.tiktok.com${item.href}`;

    try {
      await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      // フォロワー数要素の描画を待つ
      await page.locator('[data-e2e="room-header-anchor-name"]')
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
    } catch {
      console.log(`遷移失敗: ${item.uniqueId}`);
      continue;
    }

    const candidate = await captureLiveCandidate(page, {
      uniqueId: item.uniqueId,
      liveUrl,
      screenshotDir,
      fallbackDisplayName: item.uniqueId,
      fallbackViewerCount: item.viewerCount
    });
    allResults.push(candidate);

    if (onCandidate) {
      await onCandidate(candidate);
    }
  }

  // フィードに戻す
  await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});

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
  waitForLiveMedia,
  navigateAndCollect
};
