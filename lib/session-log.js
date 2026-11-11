import fs from 'node:fs';
import path from 'node:path';

function pad(value) {
  return String(value).padStart(2, '0');
}

const SENSITIVE_KEYS = /^(text|transcript|prompt|apiKey|authorization|token|secret)$/i;

function safeData(data) {
  if (Array.isArray(data)) return data.map(safeData);
  if (!data || typeof data !== 'object') return data;
  return Object.fromEntries(Object.entries(data)
    .filter(([key]) => !SENSITIVE_KEYS.test(key))
    .map(([key, value]) => [key, safeData(value)]));
}

export function createSessionLog({ logsDir, now = new Date() }) {
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(
    logsDir,
    `session-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.jsonl`,
  );
  return {
    filePath,
    write(event, data = {}) {
      const record = { at: new Date().toISOString(), event, ...safeData(data) };
      try {
        fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
  };
}
