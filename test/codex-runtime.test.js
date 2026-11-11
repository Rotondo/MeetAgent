import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRuntime } from '../lib/codex-runtime.js';

function fakeCodex() {
  const requests = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter();
  proc.stdout = stdout; proc.stderr = stderr; proc.killed = false;
  const reply = (message) => setImmediate(() => stdout.write(`${JSON.stringify(message)}\n`));
  proc.stdin = { writable: true, write(line) {
    const message = JSON.parse(line); requests.push(message);
    if (message.method === 'initialized') return true;
    if (message.method === 'initialize') reply({ id: message.id, result: { userAgent: 'test' } });
    if (message.method === 'account/read') reply({ id: message.id, result: { account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    if (message.method === 'account/login/start') reply({ id: message.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/login' } });
    if (message.method === 'account/rateLimits/read') reply({ id: message.id, result: { rateLimits: [] } });
    if (message.method === 'model/list') reply({ id: message.id, result: { data: [{ id: 'current-model', model: 'current-model', displayName: 'Current', hidden: false, isDefault: true, inputModalities: ['text'], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'fast' }] }], nextCursor: null } });
    if (message.method === 'thread/start') reply({ id: message.id, result: { thread: { id: 'thread-1', ephemeral: true } } });
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      setTimeout(() => {
        stdout.write(`${JSON.stringify({ method: 'item/completed', params: { turnId: 'turn-1', item: { type: 'agentMessage', text: '{"ok":true}' } } })}\n`);
        stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', model: 'current-model' } } })}\n`);
      }, 10);
    }
    return true;
  } };
  proc.kill = () => { proc.killed = true; };
  return { proc, requests };
}

test('CodexRuntime usa OAuth existente, catálogo dinâmico e thread efêmera sem ferramentas', async () => {
  const fake = fakeCodex();
  const runtime = new CodexRuntime({ executable: 'codex-test', spawnFn: () => fake.proc, homeDir: 'C:/Users/Test', cwd: 'C:/Temp', requestTimeoutMs: 1_000 });
  const account = await runtime.getAccount();
  assert.equal(account.account.type, 'chatgpt');
  assert.equal((await runtime.listModels())[0].id, 'current-model');
  const result = await runtime.run('responda json', { model: 'current-model', effort: 'low', schema: { type: 'object' }, timeoutMs: 1_000, purpose: 'closing' });
  assert.equal(result.text, '{"ok":true}');
  const thread = fake.requests.find((item) => item.method === 'thread/start');
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.deepEqual(thread.params.environments, []);
  const turn = fake.requests.find((item) => item.method === 'turn/start');
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.equal(turn.params.outputSchema.type, 'object');
  await runtime.stop();
});
