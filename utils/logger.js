const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
const RETENTION_DAYS = 7;
fs.mkdirSync(LOG_DIR, { recursive: true });

let lastCleanupDay = null;

function removeOldLogs(today) {
  const cutoff = new Date(Date.parse(today) - (RETENTION_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  for (const name of fs.readdirSync(LOG_DIR)) {
    const day = name.match(/^error-(\d{4}-\d{2}-\d{2})\.log$/)?.[1];
    if (day && day < cutoff) fs.rmSync(path.join(LOG_DIR, name), { force: true });
  }
}

// Sync write so entries survive a crash right before process.exit
function logError(message, { error, ...meta } = {}) {
  const entry = { time: new Date().toISOString(), message, ...meta };
  if (error) {
    entry.error = error?.message || error;
    if (error?.response?.data) entry.response = error.response.data;
    if (error?.stack) entry.stack = error.stack;
  }
  try {
    const day = entry.time.slice(0, 10);
    if (day !== lastCleanupDay) {
      lastCleanupDay = day;
      removeOldLogs(day);
    }
    fs.appendFileSync(path.join(LOG_DIR, `error-${day}.log`), JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[logger] write failed:", err.message);
  }
}

module.exports = { logError, LOG_DIR };
