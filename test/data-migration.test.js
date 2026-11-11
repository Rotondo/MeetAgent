import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyData } from '../lib/data-migration.js';

test('migra dados legados sem apagar nem sobrescrever', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-agent-migration-'));
  const legacyDataDir = path.join(root, 'legacy');
  const dataDir = path.join(root, 'new');
  fs.mkdirSync(path.join(legacyDataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(legacyDataDir, 'projects.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(legacyDataDir, 'logs', 'old.jsonl'), '{}');
  const migrated = migrateLegacyData({ legacyDataDir, dataDir });
  assert.deepEqual(migrated, ['projects.json', 'logs']);
  assert.equal(fs.existsSync(path.join(legacyDataDir, 'projects.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'old.jsonl')), true);

  fs.writeFileSync(path.join(dataDir, 'projects.json'), 'novo');
  migrateLegacyData({ legacyDataDir, dataDir });
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), 'novo');
  fs.rmSync(root, { recursive: true, force: true });
});
