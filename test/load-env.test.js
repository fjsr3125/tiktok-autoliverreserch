const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnvFiles } = require("../src/load-env");

function withTemporaryEnv(keys, fn) {
  const snapshot = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) {
      delete process.env[key];
    }
    fn();
  } finally {
    for (const key of keys) {
      if (snapshot.get(key) === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot.get(key);
      }
    }
  }
}

test("loadEnvFiles lets .env.local override .env", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const envPath = path.join(tmpDir, ".env");
  const envLocalPath = path.join(tmpDir, ".env.local");

  fs.writeFileSync(envPath, "SHARED_KEY=from-env\nLOCAL_ONLY=env-value\n", "utf8");
  fs.writeFileSync(
    envLocalPath,
    "SHARED_KEY=from-env-local\nLOCAL_ONLY=local-value\n",
    "utf8"
  );

  withTemporaryEnv(["SHARED_KEY", "LOCAL_ONLY"], () => {
    loadEnvFiles([envPath, envLocalPath]);

    assert.equal(process.env.SHARED_KEY, "from-env-local");
    assert.equal(process.env.LOCAL_ONLY, "local-value");
  });
});

test("loadEnvFiles does not override environment variables already set by the shell", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const envPath = path.join(tmpDir, ".env");
  const envLocalPath = path.join(tmpDir, ".env.local");

  fs.writeFileSync(envPath, "LOCKED_KEY=from-env\n", "utf8");
  fs.writeFileSync(envLocalPath, "LOCKED_KEY=from-env-local\n", "utf8");

  withTemporaryEnv(["LOCKED_KEY"], () => {
    process.env.LOCKED_KEY = "from-shell";

    loadEnvFiles([envPath, envLocalPath]);

    assert.equal(process.env.LOCKED_KEY, "from-shell");
  });
});
