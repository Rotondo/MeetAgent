import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybook, parseFrontmatter } from '../lib/playbook.js';

test('parseFrontmatter lê perfil e ativação de análise ao vivo', () => {
  const parsed = parseFrontmatter('---\nprofile: solucoes\nlive_analysis: true\n---\n# Roteiro');
  assert.equal(parsed.attributes.profile, 'solucoes');
  assert.equal(parsed.attributes.live_analysis, 'true');
  assert.equal(parsed.body.trim(), '# Roteiro');
});

test('loadPlaybook carrega roteiro canônico do projeto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-agent-playbook-'));
  const dir = path.join(root, '.meeting-agent');
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'ROTEIRO.md'),
    '---\nprofile: apresentacao-solucoes\nlive_analysis: sim\n---\n# Agenda\nFechar decisão.',
    'utf8',
  );
  const playbook = loadPlaybook(root);
  assert.equal(playbook.profile, 'apresentacao-solucoes');
  assert.equal(playbook.liveAnalysis, true);
  assert.match(playbook.text, /Fechar decisão/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadPlaybook retorna null quando projeto não possui roteiro', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-agent-playbook-'));
  assert.equal(loadPlaybook(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});
