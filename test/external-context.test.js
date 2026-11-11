import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchExternalMeeting, scanLocalContext } from '../lib/external-context.js';

test('contexto local retorna somente documentos relacionados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-context-'));
  fs.writeFileSync(path.join(dir, 'checkout.md'), 'Plano de bloqueio do checkout e comunicação.');
  fs.writeFileSync(path.join(dir, 'outro.txt'), 'Assunto sem relação.');
  const result = scanLocalContext(dir, ['checkout']);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'checkout.md');
});

test('Fireflies é relacionado por horário e assunto sem associação silenciosa', () => {
  const agenda = { title: 'Controle de acesso por IP', start: '2026-09-17T13:00:00Z' };
  const items = [
    { id: 'a', title: 'Controle de acesso por IP para parceiros', date: Date.parse('2026-09-17T13:30:00Z') },
    { id: 'b', title: 'Marketing', date: Date.parse('2026-08-01T10:00:00Z') },
  ];
  const matches = matchExternalMeeting(items, agenda);
  assert.equal(matches[0].id, 'a');
  assert.ok(matches[0].matchScore >= 5);
});
