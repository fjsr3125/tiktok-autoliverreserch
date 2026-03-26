function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return Number.parseInt(normalized, 10);
}

function normalizeTitle(value) {
  if (!value) {
    return null;
  }

  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUniqueIdFromUrl(liveUrl) {
  const match = liveUrl.match(/tiktok\.com\/@([^/?#]+)\/live/i);
  return match ? match[1] : null;
}

function tryExtractSigiState(html) {
  const match = html.match(/<script\s+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractFromStructuredData(data) {
  const liveRoom = data.LiveRoom || (data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__.LiveRoom) || {};
  const owner = liveRoom.owner || (liveRoom.liveRoomUserInfo && liveRoom.liveRoomUserInfo.user) || {};
  const stats = liveRoom.stats || liveRoom.liveRoomStats || {};

  return {
    uniqueId: owner.uniqueId || null,
    nickname: owner.nickname || null,
    followerCount: typeof owner.followerCount === "number" ? owner.followerCount : null,
    roomId: liveRoom.roomId || null,
    viewerCount: typeof stats.viewerCount === "number" ? stats.viewerCount :
                 typeof stats.userCount === "number" ? stats.userCount : null,
    title: liveRoom.title || null,
    coverUrl: liveRoom.coverUrl || null
  };
}

function extractMetadataFromHtml(html, liveUrl) {
  // SIGI_STATE から構造化データを優先抽出
  const sigiState = tryExtractSigiState(html);
  if (sigiState) {
    const s = extractFromStructuredData(sigiState);
    if (s.uniqueId || s.followerCount !== null) {
      return {
        uniqueId: s.uniqueId || extractUniqueIdFromUrl(liveUrl),
        nickname: s.nickname,
        followerCount: s.followerCount,
        roomId: s.roomId,
        viewerCount: s.viewerCount,
        title: s.title,
        coverUrl: s.coverUrl
      };
    }
  }

  // フォールバック: 正規表現抽出
  const uniqueId =
    firstMatch(html, [
      /"uniqueId"\s*:\s*"([^"]+)"/,
      /"ownerUniqueId"\s*:\s*"([^"]+)"/
    ]) || extractUniqueIdFromUrl(liveUrl);

  const nickname = firstMatch(html, [
    /"nickname"\s*:\s*"([^"]+)"/
  ]);

  const followerCount = toNumber(
    firstMatch(html, [
      /"followerCount"\s*:\s*(\d+)/,
      /"fans"\s*:\s*(\d+)/,
      /"follower_count"\s*:\s*(\d+)/
    ])
  );

  const roomId = firstMatch(html, [
    /"roomId"\s*:\s*"?(\\d+|\d+)"?/,
    /"room_id"\s*:\s*"?(\\d+|\d+)"?/
  ]);

  const viewerCount = toNumber(
    firstMatch(html, [
      /"viewerCount"\s*:\s*(\d+)/,
      /"userCount"\s*:\s*(\d+)/,
      /"liveRoomStats"\s*:\s*\{[^}]*"userCount"\s*:\s*(\d+)/s
    ])
  );

  const title = normalizeTitle(
    firstMatch(html, [
      /"title"\s*:\s*"((?:\\.|[^"\\])*)"/,
      /<title>([^<]+)<\/title>/i
    ])
  );

  const coverUrl = firstMatch(html, [
    /"coverUrl"\s*:\s*"(https?:[^"]+)"/,
    /"cover"\s*:\s*\{[^}]*"url_list"\s*:\s*\["(https?:[^"]+)"/,
    /<meta\s+property="og:image"\s+content="(https?:[^"]+)"/i,
    /<meta\s+content="(https?:[^"]+)"\s+property="og:image"/i
  ]);

  return {
    uniqueId,
    nickname,
    followerCount,
    roomId,
    viewerCount,
    title,
    coverUrl
  };
}

module.exports = {
  extractMetadataFromHtml,
  extractUniqueIdFromUrl
};
