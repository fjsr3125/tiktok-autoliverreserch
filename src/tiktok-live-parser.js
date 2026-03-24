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

function extractMetadataFromHtml(html, liveUrl) {
  const uniqueId =
    firstMatch(html, [
      /"uniqueId"\s*:\s*"([^"]+)"/,
      /"ownerUniqueId"\s*:\s*"([^"]+)"/
    ]) || extractUniqueIdFromUrl(liveUrl);

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
    /<meta\s+content="(https?:[^"]+)"\s+property="og:image"/i,
    /"avatar_thumb"\s*:\s*\{[^}]*"url_list"\s*:\s*\["(https?:[^"]+)"/
  ]);

  return {
    uniqueId,
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
