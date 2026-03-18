const { google } = require("googleapis");

const HEADER = [
  "uniqueId",
  "profile_url",
  "live_url",
  "followerCount",
  "title",
  "screenshot",
  "collected_at",
  "duplicate_flag",
  "room_id",
  "viewer_count"
];

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getSheetName() {
  return process.env.GOOGLE_SHEETS_SOURCE_SHEET_NAME || "source_candidates";
}

async function createSheetsClient() {
  const clientEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({
    version: "v4",
    auth: await auth.getClient()
  });
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title"
  });

  const hasSheet = (response.data.sheets || []).some(
    (sheet) => sheet.properties && sheet.properties.title === sheetName
  );

  if (hasSheet) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }
      ]
    }
  });
}

async function ensureHeaderRow(sheets, spreadsheetId, sheetName) {
  await ensureSheetExists(sheets, spreadsheetId, sheetName);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`
  });

  const firstRow = response.data.values?.[0] || [];
  if (firstRow.length > 0) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!1:1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [HEADER]
    }
  });
}

async function getExistingUniqueIds() {
  const spreadsheetId = getRequiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = getSheetName();
  const sheets = await createSheetsClient();

  await ensureHeaderRow(sheets, spreadsheetId, sheetName);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:A`
  });

  const ids = new Set();
  for (const row of response.data.values || []) {
    if (row[0]) {
      ids.add(row[0].trim());
    }
  }
  return ids;
}

async function appendCandidates(candidates) {
  if (candidates.length === 0) {
    return;
  }

  const spreadsheetId = getRequiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = getSheetName();
  const sheets = await createSheetsClient();

  await ensureHeaderRow(sheets, spreadsheetId, sheetName);

  const values = candidates.map((candidate) => [
    candidate.uniqueId,
    candidate.profileUrl,
    candidate.liveUrl,
    candidate.followerCount,
    candidate.title,
    candidate.screenshotPath,
    candidate.collectedAt,
    candidate.duplicateFlag ? "TRUE" : "FALSE",
    candidate.roomId,
    candidate.viewerCount
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values
    }
  });
}

module.exports = {
  HEADER,
  appendCandidates,
  getExistingUniqueIds,
  getSheetName
};
