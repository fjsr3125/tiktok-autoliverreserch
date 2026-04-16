/**
 * 診断スクリプト: followerCount取得の正確性を検証
 *
 * 使い方: node src/diagnose-follower.js <uniqueId>
 * 例: node src/diagnose-follower.js mainiti.sake_____
 *
 * CDPブラウザが起動している前提
 */
const { chromium } = require("playwright");
const { loadEnvFiles } = require("./load-env");
const { extractMetadataFromHtml } = require("./tiktok-live-parser");

async function diagnose(uniqueId) {
  loadEnvFiles();

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "ja-JP"
  });
  const page = await context.newPage();

  const liveUrl = `https://www.tiktok.com/@${uniqueId}/live`;
  console.log(`\n=== 診断: ${uniqueId} ===`);
  console.log(`URL: ${liveUrl}\n`);

  // 1. LIVEページに遷移
  await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  // 2. DOM上の全data-e2e要素をダンプ
  const domInfo = await page.evaluate(() => {
    const result = {};

    // data-e2eの全属性を取得
    const e2eElements = document.querySelectorAll("[data-e2e]");
    const e2eMap = {};
    for (const el of e2eElements) {
      const key = el.getAttribute("data-e2e");
      const text = (el.textContent || "").trim().slice(0, 200);
      if (!e2eMap[key]) e2eMap[key] = [];
      e2eMap[key].push(text);
    }
    result.dataE2E = e2eMap;

    // room-header周辺を詳しく見る
    const likeCountEl = document.querySelector('[data-e2e="room-header-like-count"]');
    result.roomHeaderLikeCount = likeCountEl
      ? { text: likeCountEl.textContent.trim(), tagName: likeCountEl.tagName, parentText: (likeCountEl.parentElement?.textContent || "").trim().slice(0, 300) }
      : null;

    const anchorNameEl = document.querySelector('[data-e2e="room-header-anchor-name"]');
    result.roomHeaderAnchorName = anchorNameEl ? anchorNameEl.textContent.trim() : null;

    // フォロワー数が含まれそうな要素を広く探す
    const allText = document.body.innerText;
    const followerPatterns = [
      /(\d[\d,.]*[KMBkmb]?)\s*(?:フォロワー|Followers?)/gi,
      /(?:フォロワー|Followers?)\s*[：:]\s*(\d[\d,.]*[KMBkmb]?)/gi,
    ];
    const followerMatches = [];
    for (const pat of followerPatterns) {
      let m;
      while ((m = pat.exec(allText)) !== null) {
        followerMatches.push(m[0]);
      }
    }
    result.followerTextMatches = followerMatches;

    return result;
  });

  console.log("--- DOM data-e2e 属性一覧 ---");
  for (const [key, values] of Object.entries(domInfo.dataE2E)) {
    for (const val of values) {
      console.log(`  [${key}] = "${val.slice(0, 100)}"`);
    }
  }

  console.log("\n--- room-header-like-count の詳細 ---");
  if (domInfo.roomHeaderLikeCount) {
    console.log(`  テキスト: "${domInfo.roomHeaderLikeCount.text}"`);
    console.log(`  タグ: ${domInfo.roomHeaderLikeCount.tagName}`);
    console.log(`  親テキスト: "${domInfo.roomHeaderLikeCount.parentText}"`);
  } else {
    console.log("  要素が見つかりません");
  }

  console.log(`\n--- ページ内の「フォロワー」テキスト ---`);
  console.log(`  ${domInfo.followerTextMatches.length > 0 ? domInfo.followerTextMatches.join(", ") : "見つかりません"}`);

  // 3. SIGI_STATE からの抽出
  const html = await page.content();
  const htmlMeta = extractMetadataFromHtml(html, liveUrl);
  console.log("\n--- SIGI_STATE / HTML抽出 ---");
  console.log(`  uniqueId: ${htmlMeta.uniqueId}`);
  console.log(`  nickname: ${htmlMeta.nickname}`);
  console.log(`  followerCount: ${htmlMeta.followerCount}`);
  console.log(`  viewerCount: ${htmlMeta.viewerCount}`);
  console.log(`  roomId: ${htmlMeta.roomId}`);

  // 4. プロフィールページに遷移してフォロワー数を直接取得
  const profileUrl = `https://www.tiktok.com/@${uniqueId}`;
  console.log(`\n--- プロフィールページで検証 ---`);
  console.log(`URL: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const profileInfo = await page.evaluate(() => {
    const result = {};

    // data-e2e="followers-count"
    const followersEl = document.querySelector('[data-e2e="followers-count"]');
    result.followersCount = followersEl ? followersEl.textContent.trim() : null;

    // data-e2e="following-count"
    const followingEl = document.querySelector('[data-e2e="following-count"]');
    result.followingCount = followingEl ? followingEl.textContent.trim() : null;

    // data-e2e="likes-count"
    const likesEl = document.querySelector('[data-e2e="likes-count"]');
    result.likesCount = likesEl ? likesEl.textContent.trim() : null;

    return result;
  });

  const profileBio = await page.evaluate(() => {
    const bioEl = document.querySelector('[data-e2e="user-bio"]');
    return bioEl ? (bioEl.textContent || "").trim() : null;
  });

  console.log(`  フォロワー数 (data-e2e="followers-count"): ${profileInfo.followersCount}`);
  console.log(`  フォロー数 (data-e2e="following-count"): ${profileInfo.followingCount}`);
  console.log(`  いいね数 (data-e2e="likes-count"): ${profileInfo.likesCount}`);
  console.log(`  bio (data-e2e="user-bio"): ${profileBio || "(なし)"}`);

  // 5. 比較結果
  console.log("\n=== 比較結果 ===");
  const domValue = domInfo.roomHeaderLikeCount?.text || "N/A";
  const sigiValue = htmlMeta.followerCount;
  const profileValue = profileInfo.followersCount;
  console.log(`  LIVE DOM (room-header-like-count): ${domValue}`);
  console.log(`  LIVE SIGI_STATE (followerCount):   ${sigiValue}`);
  console.log(`  プロフィール (followers-count):     ${profileValue}`);
  console.log(`  プロフィール (likes-count):         ${profileInfo.likesCount}`);

  if (domValue === profileInfo.likesCount) {
    console.log("\n  ⚠️  room-header-like-countは「いいね数」を表示している可能性が高い！");
  } else if (domValue === profileValue) {
    console.log("\n  ✓  room-header-like-countはフォロワー数と一致");
  } else {
    console.log("\n  ?  どの値とも一致しない → DOMセレクタが変わっている可能性");
  }

  await browser.close();
}

const target = process.argv[2];
if (!target) {
  console.error("使い方: node src/diagnose-follower.js <uniqueId>");
  process.exit(1);
}

diagnose(target).catch(err => {
  console.error(err);
  process.exit(1);
});
