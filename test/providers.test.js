import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexRunner } from '../lib/providers.js';

test('runner usa modelo e esforço configurados para a finalidade', async () => {
  const calls = [];
  const runtime = { run: async (_prompt, options) => { calls.push(options); return { text: 'ok', turn: { model: options.model } }; } };
  const run = createCodexRunner({ runtime, purposeRouting: { closing: { primary: 'codex:modelo-atual', effort: 'high' } } });
  assert.equal(await run('x', { purpose: 'closing', timeoutMs: 2_000 }), 'ok');
  assert.equal(calls[0].model, 'modelo-atual');
  assert.equal(calls[0].effort, 'high');
});

test('runner usa o modelo padrão vivo quando a rota está em automático', async () => {
  const calls = [];
  const runtime = { run: async (_prompt, options) => { calls.push(options); return { text: 'ok', turn: { model: 'default' } }; } };
  const run = createCodexRunner({ runtime, purposeRouting: { observer: { primary: 'codex:auto', effort: 'low' } } });
  await run('x', { purpose: 'observer', timeoutMs: 2_000 });
  assert.equal(calls[0].model, null);
  assert.equal(calls[0].effort, 'low');
});

test('circuito Codex é isolado por finalidade e não deixa observer bloquear closing', async () => {
  const calls = [];
  const runtime = { run: async (_prompt, options) => {
    calls.push(options.purpose);
    if (options.purpose === 'observer') { const error = new Error('timeout'); error.code = 'CODEX_TIMEOUT'; throw error; }
    return { text: 'fechamento ok', turn: { model: 'modelo-atual' }, usage: null };
  } };
  const run = createCodexRunner({ runtime, purposeRouting: {
    observer: { primary: 'codex:modelo-atual', effort: 'low' },
    closing: { primary: 'codex:modelo-atual', effort: 'medium' },
  } });
  await assert.rejects(run('x', { purpose: 'observer', timeoutMs: 1_000 }), /timeout/);
  await assert.rejects(run('x', { purpose: 'observer', timeoutMs: 1_000 }), (error) => error.notAttempted === true);
  assert.equal(await run('x', { purpose: 'closing', timeoutMs: 1_000 }), 'fechamento ok');
  assert.deepEqual(calls, ['observer', 'closing']);
});

test('circuito aberto não registra nova chamada ao runtime', async () => {
  let calls = 0;
  const error = new Error('sem login'); error.code = 'CODEX_AUTH_REQUIRED';
  const run = createCodexRunner({ runtime: { run: async () => { calls++; throw error; } } });
  await assert.rejects(run('x', { purpose: 'chat' }));
  await assert.rejects(run('x', { purpose: 'chat' }), (caught) => caught.notAttempted === true);
  assert.equal(calls, 1);
});
