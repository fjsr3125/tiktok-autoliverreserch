const BUSINESS_BIO_KEYWORDS = [
  "株式会社",
  "合同会社",
  "llc",
  "inc",
  "店舗",
  "ショップ",
  "shop",
  "store",
  "通販",
  "予約受付",
  "ご予約",
  "お問い合わせ",
  "採用",
  "求人",
  "agency",
  "ライバー事務所",
  "事務所代表",
  "代表取締役",
  "メイドカフェ",
  "ガールズバー",
  "girls bar",
  "コンカフェ",
  "pococha"
];

const BUSINESS_ACCOUNT_KEYWORDS = [
  "official",
  "公式",
  "shop",
  "store",
  "studio",
  "salon",
  "ネイル",
  "美容室",
  "エステ",
  "vtuber",
  "vライバー",
  "virtual",
  "バーチャル",
  "企業"
];

const RISKY_BIO_KEYWORDS = [
  "営業時間",
  "定休日",
  "bar",
  "studio",
  "担当",
  "指名",
  "アイドル",
  "ラウンドガール",
  "ゲーム配信"
];

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function includesKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function isBusinessAccount(candidate) {
  const bio = normalizeText(candidate.bio);
  const displayName = normalizeText(candidate.displayName);
  const uniqueId = normalizeText(candidate.uniqueId);
  const accountText = `${uniqueId} ${displayName}`;

  if (includesKeyword(accountText, BUSINESS_ACCOUNT_KEYWORDS)) {
    return true;
  }

  if (includesKeyword(bio, BUSINESS_BIO_KEYWORDS)) {
    return true;
  }

  // 汎用語は単独では誤爆しやすいので、販売・店舗文脈がある場合だけ除外する。
  const hasRiskyBioKeyword = includesKeyword(bio, RISKY_BIO_KEYWORDS);
  const hasCommercialContext = /予約|販売|通販|来店|出勤|営業中|dm|公式|店舗|店|cast|キャスト|事務所|agency|代表/i.test(bio);

  return hasRiskyBioKeyword && hasCommercialContext;
}

module.exports = {
  BUSINESS_ACCOUNT_KEYWORDS,
  BUSINESS_BIO_KEYWORDS,
  RISKY_BIO_KEYWORDS,
  isBusinessAccount
};
