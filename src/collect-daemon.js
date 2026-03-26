const http = require("node:http");
const { main } = require("./collect-tiktok-live");

const PORT = Number.parseInt(process.env.DAEMON_PORT || "3000", 10);
const INTERVAL_MS = Number.parseInt(process.env.COLLECT_INTERVAL_MS || "1800000", 10); // 30分

let isRunning = false;
let stopRequested = false;
let intervalId = null;
const daemonStartedAt = new Date().toISOString();
let lastRun = null;
const history = [];
const MAX_HISTORY = 20;

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

    const finishedAt = new Date().toISOString();
    lastRun = { startedAt, finishedAt, status: "success", error: null };
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

function getStatus() {
  return {
    daemonStartedAt,
    isRunning,
    stopRequested,
    intervalMs: INTERVAL_MS,
    nextRunAt: intervalId
      ? new Date(Date.now() + INTERVAL_MS).toISOString()
      : null,
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
    res.end(JSON.stringify(getStatus(), null, 2));
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
  console.log(`[daemon] エンドポイント: GET /status, POST /trigger, POST /trigger-sync, POST /start, POST /stop, GET /history`);

  // 初回実行
  runCollect().then(() => {
    // 初回完了後にループ開始
    if (process.env.AUTO_START_LOOP !== "false") {
      startLoop();
    }
  });
});
