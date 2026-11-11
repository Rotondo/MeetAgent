import fs from 'node:fs';
import path from 'node:path';

const FILES = ['projects.json', 'deepgram.key', 'openai.key', 'gemini.key'];
const DIRECTORIES = ['logs', 'outputs'];

export function migrateLegacyData({ legacyDataDir, dataDir }) {
  if (!legacyDataDir || path.resolve(legacyDataDir) === path.resolve(dataDir)) return [];
  fs.mkdirSync(dataDir, { recursive: true });
  const migrated = [];

  for (const name of FILES) {
    const source = path.join(legacyDataDir, name);
    const destination = path.join(dataDir, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.copyFileSync(source, destination);
    migrated.push(name);
  }
  for (const name of DIRECTORIES) {
    const source = path.join(legacyDataDir, name);
    const destination = path.join(dataDir, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: false });
    migrated.push(name);
  }
  return migrated;
}
