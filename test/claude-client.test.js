import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaude, parseJsonLoose } from '../lib/claude-client.js';

test('parseJsonLoose extrai JSON de texto com cercas e ruído', () => {
  assert.deepEqual(parseJsonLoose('claro!\n```json\n{"a": 1}\n```\nfim'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"acoes": [], "alerta": null}'), { acoes: [], alerta: null });
  assert.equal(parseJsonLoose('nada de json aqui'), null);
  assert.equal(parseJsonLoose('{quebrado'), null);
});

test('runClaude envia prompt via stdin e captura stdout (cmd fake)', async () => {
  const out = await runClaude('ola mundo', {
    cmd: process.execPath,
    extraArgs: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d.toString().toUpperCase()))'],
    rawArgs: true,
    timeoutMs: 10_000,
  });
  assert.match(out, /OLA MUNDO/);
});

test('runClaude rejeita em timeout', async () => {
  await assert.rejects(
    runClaude('x', {
      cmd: process.execPath,
      extraArgs: ['-e', 'setTimeout(()=>{}, 60000)'],
      rawArgs: true,
      timeoutMs: 300,
    }),
    /timeout/,
  );
});
