const fs = require("node:fs");
const path = require("node:path");

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return [];
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    entries.push([key, stripQuotes(rawValue)]);
  }

  return entries;
}

function loadEnvFiles(filePaths = [".env", ".env.local"]) {
  const protectedKeys = new Set(Object.keys(process.env));

  for (const filePath of filePaths) {
    for (const [key, value] of parseEnvFile(filePath)) {
      if (protectedKeys.has(key)) {
        continue;
      }
      process.env[key] = value;
    }
  }
}

function loadEnvFile(filePath = ".env") {
  loadEnvFiles([filePath]);
}

module.exports = {
  loadEnvFile,
  loadEnvFiles,
  parseEnvFile
};
