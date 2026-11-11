import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Transcriber, buildUrl } from '../lib/transcriber.js';

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.readyState = 3; }
}

test('buildUrl configura PCM mono de 16 kHz', () => {
  const url = buildUrl({ model: 'nova-3', language: 'pt-BR', sampleRate: 16000 });
  assert.match(url, /model=nova-3/);
  assert.match(url, /language=pt-BR/);
  assert.match(url, /encoding=linear16/);
  assert.match(url, /sample_rate=16000/);
});

test('Transcriber conecta, envia áudio e acumula transcript final', async () => {
  FakeWebSocket.instances.length = 0;
  const transcriber = new Transcriber({ apiKey: 'k', WebSocketImpl: FakeWebSocket, windowMs: 60_000, finalizeWaitMs: 0 });
  const finals = [];
  const chunks = [];
  transcriber.on('transcript-final', (value) => finals.push(value.text));
  transcriber.on('transcript-chunk', (value) => chunks.push(value.text));
  await transcriber.start();
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.options.headers.Authorization, 'Token k');
  assert.equal(transcriber.feedAudio(new Uint8Array([1, 2])), true);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Olá mundo' }] } })));
  assert.deepEqual(finals, ['Olá mundo']);
  transcriber.flush();
  assert.deepEqual(chunks, ['Olá mundo']);
  await transcriber.stop();
  assert.ok(ws.sent.some((item) => typeof item === 'string' && item.includes('Finalize')));
});

test('Transcriber ignora resultados provisórios e JSON inválido', async () => {
  const transcriber = new Transcriber({ apiKey: 'k', WebSocketImpl: FakeWebSocket, windowMs: 60_000, finalizeWaitMs: 0 });
  const finals = [];
  transcriber.on('transcript-final', (value) => finals.push(value.text));
  await transcriber.start();
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit('message', Buffer.from('{'));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'rascunho' }] } })));
  assert.deepEqual(finals, []);
  await transcriber.stop();
});

test('Transcriber envia KeepAlive textual quando o fluxo está sem áudio', async () => {
  FakeWebSocket.instances.length = 0;
  const transcriber = new Transcriber({
    apiKey: 'k',
    WebSocketImpl: FakeWebSocket,
    windowMs: 60_000,
    keepAliveMs: 60_000,
    finalizeWaitMs: 0,
  });
  await transcriber.start();
  const ws = FakeWebSocket.instances[0];
  assert.equal(transcriber._sendKeepAlive(), true);
  assert.ok(ws.sent.some((item) => item === JSON.stringify({ type: 'KeepAlive' })));
  await transcriber.stop();
});

test('Transcriber reconecta depois de fechamento inesperado', async () => {
  FakeWebSocket.instances.length = 0;
  const transcriber = new Transcriber({
    apiKey: 'k', WebSocketImpl: FakeWebSocket, windowMs: 60_000,
    finalizeWaitMs: 0, reconnectDelays: [0],
  });
  await transcriber.start();
  FakeWebSocket.instances[0].close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1].readyState, FakeWebSocket.OPEN);
  await transcriber.stop();
});
