import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionLog } from '../lib/session-log.js';

test('session log registra metadados sem conteúdo da reunião', () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-agent-log-'));
  const log = createSessionLog({ logsDir, now: new Date('2026-07-22T12:34:56Z') });
  log.write('coach-review', {
    status: 'skip', reason: 'cooldown', text: 'conteúdo confidencial', transcript: 'não salvar', prompt: 'nem isto',
  });

  const content = fs.readFileSync(log.filePath, 'utf8');
  assert.match(content, /"event":"coach-review"/);
  assert.match(content, /"reason":"cooldown"/);
  assert.doesNotMatch(content, /conteúdo confidencial|não salvar|nem isto/);
  fs.rmSync(logsDir, { recursive: true, force: true });
});

test('session log preserva a intervenção exibida, sem salvar transcrição bruta', () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-agent-log-'));
  const log = createSessionLog({ logsDir });
  log.write('intervention-shown', {
    suggestion: 'Pergunte pela última chamada bem-sucedida.',
    rationale: 'O status foi descrito como suposição.',
    act: 'Integração',
    transcript: 'conteúdo bruto confidencial',
  });
  const content = fs.readFileSync(log.filePath, 'utf8');
  assert.match(content, /última chamada bem-sucedida/);
  assert.match(content, /Integração/);
  assert.doesNotMatch(content, /conteúdo bruto confidencial/);
  fs.rmSync(logsDir, { recursive: true, force: true });
});
