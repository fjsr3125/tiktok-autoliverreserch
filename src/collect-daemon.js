const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { main } = require("./collect-tiktok-live");

const PORT = Number.parseInt(process.env.DAEMON_PORT || "3000", 10);
const INTERVAL_MS = Number.parseInt(process.env.COLLECT_INTERVAL_MS || "1800000", 10);
const PROCESSING_LOCK_TTL_MS = Number.parseInt(
  process.env.PROCESSING_LOCK_TTL_MS || "1800000",
  10
);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "output");
const UNPROCESSED_PATH = path.join(OUTPUT_DIR, "unprocessed.json");

let isRunning = false;
let stopRequested = false;
let intervalId = null;
const daemonStartedAt = new Date().toISOString();
let lastRun = null;
let processingStartedAt = null;
const history = [];
const MAX_HISTORY = 20;

async function readUnprocessed() {
  try {
    const data = await fs.readFile(UNPROCESSED_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeUnprocessed(candidates) {
  await fs.writeFile(UNPROCESSED_PATH, JSON.stringify(candidates, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return null;
  }

  return JSON.parse(body);
}

function getProcessingState() {
  if (!processingStartedAt) {
    return {
      isProcessing: false,
      processingStartedAt: null,
      processingLockExpiresAt: null
    };
  }

  const startedAtMs = Date.parse(processingStartedAt);
  const expiresAtMs = startedAtMs + PROCESSING_LOCK_TTL_MS;

  if (Number.isNaN(startedAtMs) || Date.now() >= expiresAtMs) {
    if (processingStartedAt) {
      console.log("[daemon] 処理ロック期限切れのため解除");
    }
    processingStartedAt = null;
    return {
      isProcessing: false,
      processingStartedAt: null,
      processingLockExpiresAt: null
    };
  }

  return {
    isProcessing: true,
    processingStartedAt,
    processingLockExpiresAt: new Date(expiresAtMs).toISOString()
  };
}

function acquireProcessingLock() {
  processingStartedAt = new Date().toISOString();
  const { processingLockExpiresAt } = getProcessingState();
  console.log(
    `[daemon] 処理ロックを設定: startedAt=${processingStartedAt} expiresAt=${processingLockExpiresAt}`
  );
}

function releaseProcessingLock() {
  if (!processingStartedAt) {
    return;
  }
  processingStartedAt = null;
  console.log("[daemon] 処理ロックを解除");
}

async function accumulateResults() {
  try {
    const latestPath = path.join(OUTPUT_DIR, "latest-run.json");
    const data = await fs.readFile(latestPath, "utf8");
    const run = JSON.parse(data);
    const newCandidates = (run.results || []).filter(
      (r) => !r.duplicateFlag && !r.skippedReason
    );

    if (newCandidates.length === 0) return 0;

    const existing = await readUnprocessed();
    const existingIds = new Set(existing.map((c) => c.uniqueId));
    const toAdd = newCandidates.filter((c) => !existingIds.has(c.uniqueId));
    const merged = [...existing, ...toAdd];
    await writeUnprocessed(merged);

    console.log(`[daemon] 未処理に${toAdd.length}件追加 (合計${merged.length}件)`);
    return merged.length;
  } catch (err) {
    console.error(`[daemon] 蓄積エラー: ${err.message}`);
    return 0;
  }
}

async function runCollect() {
  if (isRunning) {
    console.log("[daemon] 収集中のためスキップ");
    return { skipped: true };
  }

  isRunning = true;
  const startedAt = new Date().toISOString();
  console.log(`[daemon] 収集開始: ${startedAt}`);

  try {
    await main();
    const unprocessedCount = await accumulateResults();

    const finishedAt = new Date().toISOString();
    lastRun = { startedAt, finishedAt, status: "success", error: null, unprocessedCount };
    console.log(`[daemon] 収集完了: ${finishedAt}`);
  } catch (err) {
    const finishedAt = new Date().toISOString();
    lastRun = { startedAt, finishedAt, status: "error", error: err.message };
    console.error(`[daemon] 収集エラー: ${err.message}`);
  } finally {
    isRunning = false;
    history.unshift({ ...lastRun });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }

  return lastRun;
}

async function getStatus() {
  const unprocessed = await readUnprocessed();
  const processingState = getProcessingState();
  return {
    daemonStartedAt,
    isRunning,
    isProcessing: processingState.isProcessing,
    processingStartedAt: processingState.processingStartedAt,
    processingLockExpiresAt: processingState.processingLockExpiresAt,
    stopRequested,
    intervalMs: INTERVAL_MS,
    nextRunAt: intervalId
      ? new Date(Date.now() + INTERVAL_MS).toISOString()
      : null,
    unprocessedCount: unprocessed.length,
    lastRun,
    historyCount: history.length,
    history: history.slice(0, 5)
  };
}

function startLoop() {
  if (intervalId) return;
  stopRequested = false;
  intervalId = setInterval(() => {
    if (stopRequested) return;
    runCollect();
  }, INTERVAL_MS);
  console.log(`[daemon] ループ開始 (間隔: ${INTERVAL_MS / 1000}秒)`);
}

function stopLoop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  stopRequested = true;
  console.log("[daemon] ループ停止");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/status") {
    const status = await getStatus();
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (req.method === "GET" && req.url === "/unprocessed") {
    const unprocessed = await readUnprocessed();
    acquireProcessingLock();
    res.end(JSON.stringify({ count: unprocessed.length, candidates: unprocessed }));
    return;
  }

  if (req.method === "POST" && req.url === "/processed") {
    let body = null;

    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "JSON body が不正です" }));
      return;
    }

    if (body && body.processedIds !== undefined && !Array.isArray(body.processedIds)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "processedIds は配列で指定してください" }));
      return;
    }

    if (Array.isArray(body?.processedIds)) {
      const processedIds = new Set(
        body.processedIds
          .filter((id) => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean)
      );
      const unprocessed = await readUnprocessed();
      const remaining = unprocessed.filter((candidate) => !processedIds.has(candidate.uniqueId));
      const removedCount = unprocessed.length - remaining.length;

      await writeUnprocessed(remaining);
      releaseProcessingLock();

      console.log(`[daemon] 未処理リストから${removedCount}件削除 (残り${remaining.length}件)`);
      res.end(
        JSON.stringify({
          message: "指定された候補を未処理リストから削除しました",
          removedCount,
          remainingCount: remaining.length
        })
      );
      return;
    }

    await writeUnprocessed([]);
    releaseProcessingLock();
    console.log("[daemon] 未処理リストをクリア");
    res.end(JSON.stringify({ message: "未処理リストをクリアしました" }));
    return;
  }

  if (req.method === "POST" && req.url === "/trigger") {
    if (isRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "収集実行中です" }));
      return;
    }
    res.end(JSON.stringify({ message: "収集を開始しました" }));
    runCollect();
    return;
  }

  if (req.method === "POST" && req.url === "/trigger-sync") {
    if (isRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "収集実行中です" }));
      return;
    }
    const result = await runCollect();
    res.end(JSON.stringify({ message: "収集完了", ...result }));
    return;
  }

  if (req.method === "POST" && req.url === "/start") {
    startLoop();
    res.end(JSON.stringify({ message: "ループ開始", intervalMs: INTERVAL_MS }));
    return;
  }

  if (req.method === "POST" && req.url === "/stop") {
    stopLoop();
    res.end(JSON.stringify({ message: "ループ停止" }));
    return;
  }

  if (req.method === "GET" && req.url === "/history") {
    res.end(JSON.stringify({ history }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[daemon] HTTP API起動 port=${PORT}`);
  console.log("[daemon] エンドポイント: GET /status, GET /unprocessed, POST /processed, POST /trigger, POST /trigger-sync, POST /start, POST /stop, GET /history");

  // 初回実行
  runCollect().then(() => {
    if (process.env.AUTO_START_LOOP !== "false") {
      startLoop();
    }
  });
});
