import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../lib/executor.js';

test('executeSkill monta prompt com skill e argumento e usa cwd do projeto', async () => {
  const calls = [];
  const fakeRun = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return 'feito';
  };
  const out = await executeSkill(
    { skill: 'atualiza-crm', argumento: 'Empresa Exemplo' },
    { projectPath: 'C:/x/PRM', runFn: fakeRun, timeoutMs: 5000 },
  );
  assert.equal(out, 'feito');
  assert.match(calls[0].prompt, /atualiza-crm/);
  assert.match(calls[0].prompt, /Empresa Exemplo/);
  assert.equal(calls[0].opts.cwd, 'C:/x/PRM');
  assert.deepEqual(calls[0].opts.extraArgs, ['--permission-mode', 'acceptEdits']);
});
