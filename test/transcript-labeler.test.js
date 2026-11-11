import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLabeledTranscript, overlapScore } from '../lib/transcript-labeler.js';

test('overlapScore ignora pontuação e acentos', () => {
  assert.ok(overlapScore('Integração técnica está pronta?', 'a integracao tecnica esta pronta') > 0.7);
});

test('buildLabeledTranscript distingue microfone do restante no modo combinado', () => {
  const meeting = [
    { text: 'Qual foi a última chamada bem-sucedida?', receivedAt: 10_000 },
    { text: 'Nós testamos o endpoint de pedidos ontem.', receivedAt: 15_000 },
  ];
  const microphone = [
    { text: 'Qual foi a ultima chamada bem sucedida', receivedAt: 10_200 },
  ];
  const result = buildLabeledTranscript(meeting, microphone, { matchWindowMs: 2_000 });
  assert.match(result, /^\[Usuário\] Qual foi/m);
  assert.match(result, /^\[Interlocutor\] Nós testamos/m);
});

test('buildLabeledTranscript marca todo o áudio de microfone como o usuário', () => {
  const result = buildLabeledTranscript(['Vou enviar o contrato.'], [], { audioMode: 'microphone' });
  assert.equal(result, '[Usuário] Vou enviar o contrato.');
});
