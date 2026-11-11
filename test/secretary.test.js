import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, addTurn, applyOperations, followUp, ledgerBoard } from '../lib/meeting-ledger.js';
import { gateCandidate, OUTCOMES } from '../lib/intervention-gate.js';
import { Secretary } from '../lib/secretary.js';
import { saveAgenda, reviewRecord, buildBrief, archiveMeeting, atomicSave, loadAgendas, correctMemory, importLegacyReport } from '../lib/agenda-memory.js';

const time = 1_000_000;
function fixture() {
  let ledger = addTurn(createLedger('session-test'), { text: 'Eu vou enviar a documentação amanhã. O piloto não mede devoluções depois da entrega.', at: time, channel: 'microphone' });
  const ops = [{ kind: 'commitments', text: 'Enviar documentação', status: 'open', turnId: 't1', quote: 'Eu vou enviar a documentação amanhã.', owner: 'Usuário', ownerQuote: 'Eu vou', due: 'amanhã' },
    { kind: 'risks', text: 'Piloto sem medição após entrega', status: 'open', turnId: 't1', quote: 'O piloto não mede devoluções depois da entrega.' }];
  return { ledger: applyOperations(ledger, ops).ledger, ops };
}
const scores = { specificity: 2, novelty: 2, relevance: 2, timing: 2, speakability: 2, evidence: 2, impact: 2, reliability: 2 };
const candidate = { say: 'Como vamos observar as devoluções dos pedidos entregues depois do fim do piloto?', whyNow: 'Janela de medição insuficiente', riskIfSilent: 'Concluir sem observar devoluções', evidenceIds: ['i2'], topicKey: 'janela-devolucoes', target: 'self', type: 'risk', conflictQuotes: ['O piloto não mede devoluções', 'depois da entrega.'] };

test('ledger requires exact evidence and never invents owner or deadline', () => {
  const { ledger } = fixture(); assert.equal(ledger.items.length, 2); assert.equal(ledger.items[0].owner, 'Usuário');
  const invalid = applyOperations(ledger, [{ kind: 'decisions', text: 'Integrar agora', status: 'confirmed', turnId: 't1', quote: 'Decidimos integrar agora' }]);
  assert.equal(invalid.accepted.length, 0);
  const owner = applyOperations(ledger, [{ kind: 'facts', text: 'Nova informação', status: 'open', turnId: 't1', quote: ledger.turns[0].text, owner: 'Pessoa Inventada', ownerQuote: 'Eu vou', due: 'sexta-feira' }]);
  assert.equal(owner.accepted[0].owner, null); assert.equal(owner.accepted[0].due, null);
});
test('mixed-channel first person cannot establish Usuário as owner', () => {
  const { ops } = fixture(); const ledger = addTurn(createLedger('mixed'), { text: ops[0].quote, channel: 'meeting' });
  assert.equal(applyOperations(ledger, ops).ledger.items[0].owner, null);
});
test('mention is not decision and suggestions are not commitments', () => {
  const ledger = addTurn(createLedger('x'), { text: 'Talvez o parceiro envie o documento na sexta.' });
  for (const kind of ['decisions', 'commitments']) assert.equal(applyOperations(ledger, [{ kind, text: 'Enviar', quote: ledger.turns[0].text, turnId: 't1', status: 'open' }]).accepted.length, 0);
});

test('ledger separa anúncio operacional de proposta', () => {
  let ledger = createLedger('kinds');
  ledger = addTurn(ledger, { text: 'A nova rotina começa na próxima semana.' });
  ledger = addTurn(ledger, { text: 'Podemos testar uma comunicação com os lojistas.' });
  const result = applyOperations(ledger, [
    { id: null, kind: 'announcements', text: 'Nova rotina começa na próxima semana', status: 'confirmed', turnId: 't1', quote: 'A nova rotina começa na próxima semana.', owner: null, ownerQuote: null, due: null },
    { id: null, kind: 'proposals', text: 'Testar comunicação com lojistas', status: 'open', turnId: 't2', quote: 'Podemos testar uma comunicação com os lojistas.', owner: null, ownerQuote: null, due: null },
  ]);
  const board = ledgerBoard(result.ledger);
  assert.equal(board.anuncios.length, 1);
  assert.equal(board.propostas.length, 1);
  assert.equal(board.compromissos.length, 0);
});
test('ledger supports correction/retraction and follow-up excludes retracted items', () => {
  let { ledger } = fixture(); ledger = addTurn(ledger, { text: 'Retiro o compromisso de enviar a documentação amanhã.', at: time + 1 });
  const result = applyOperations(ledger, [{ id: 'i1', kind: 'facts', text: 'Retirado', status: 'retracted', turnId: 't2', quote: ledger.turns[1].text }]);
  assert.equal(result.ledger.items[0].status, 'retracted'); assert.doesNotMatch(followUp(result.ledger), /Enviar documentação/);
});
test('quality gate rejects obvious, repeated, late, uncertain and low-value advice', () => {
  const { ledger } = fixture(); const context = { ledger, critique: scores, now: time + 1000 };
  assert.equal(gateCandidate(candidate, context).approved, true);
  for (const change of [{ say: 'Defina quem é o responsável e qual o prazo.' }, { target: 'partner' }, { evidenceIds: ['missing'] }]) assert.equal(gateCandidate({ ...candidate, ...change }, context).approved, false);
  assert.equal(gateCandidate(candidate, { ...context, history: [{ ...candidate, at: time }] }).approved, false);
  assert.equal(gateCandidate(candidate, { ...context, now: time + 121_000 }).approved, false);
  assert.equal(gateCandidate(candidate, { ...context, critique: { ...scores, reliability: 0 } }).approved, false);
  assert.equal(gateCandidate(candidate, { ...context, mode: 'silent' }).approved, false);
  assert.equal(gateCandidate({ ...candidate, say: candidate.conflictQuotes[0] }, context).reason, 'alerta sem pergunta acionável');
  assert.equal(gateCandidate({ ...candidate, say: `${candidate.conflictQuotes[0]}?` }, context).reason, 'apenas repete a evidência');
});
test('feedback recognizes expiry as neutral and limits automatic attention', () => {
  assert.ok(OUTCOMES.includes('ignorada'));
  const { ledger } = fixture();
  const history = [1, 2, 3].map(n => ({ say: `Assunto anterior ${n}`, topicKey: `other-${n}`, at: time - n * 300000 }));
  assert.equal(gateCandidate(candidate, { ledger, critique: scores, now: time, history }).reason, 'orçamento de atenção');
});
test('approved memory follows initiative and never leaks to another project', () => {
  let store = saveAgenda({ schemaVersion: 1, agendas: [], records: [] }, { title: 'Piloto', scope: 'empresa-a', objective: 'Validar impacto' });
  const agenda = store.agendas[0]; const { ledger } = fixture();
  store = archiveMeeting(store, { ledger, agenda, followUp: followUp(ledger) });
  assert.doesNotMatch(buildBrief(store, agenda), /Enviar documentação/);
  store = reviewRecord(store, ledger.sessionId, ['i1']);
  assert.match(buildBrief(store, agenda), /Enviar documentação/);
  assert.doesNotMatch(buildBrief(store, { ...agenda, scope: 'empresa-b' }), /Enviar documentação/);
  store = reviewRecord(store, ledger.sessionId, []);
  assert.doesNotMatch(buildBrief(store, agenda), /Enviar documentação/);
});
test('memory correction records provenance and legacy import requires evidence', () => {
  let store = saveAgenda({ schemaVersion: 1, agendas: [], records: [] }, { title: 'Parceria', scope: 'empresa-a' });
  const agenda = store.agendas[0]; const { ledger } = fixture();
  store = archiveMeeting(store, { ledger, agenda, followUp: followUp(ledger) });
  store = correctMemory(store, ledger.sessionId, 'i1', { owner: 'Tiago', due: 'sexta', status: 'confirmed' }, new Date('2026-09-16T12:00:00Z'));
  const corrected = store.records[0].items[0];
  assert.equal(corrected.owner, 'Tiago'); assert.equal(corrected.due, 'sexta'); assert.equal(corrected.review, 'approved');
  assert.deepEqual(corrected.corrections[0].previous, { text: 'Enviar documentação', owner: 'Usuário', due: 'amanhã', status: 'open' });
  const report = '## Próximos passos\n- Enviar API (responsável: Tiago, prazo: amanhã) — evidência: "Eu vou enviar a API amanhã."\n';
  store = importLegacyReport(store, { markdown: report, filename: 'antigo.md', agenda });
  assert.equal(store.records.at(-1).source, 'legacy-report-not-verified-transcript');
  assert.equal(store.records.at(-1).items[0].review, 'unreviewed');
  assert.throws(() => importLegacyReport(store, { markdown: '## Próximos passos\n- Enviar API', filename: 'sem-evidencia.md', agenda }), /sem compromissos com evidência/);
});
test('corrupt memory is preserved rather than silently overwritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-test-')); const file = path.join(directory, 'memory.json');
  try { atomicSave(file, { invalid: true }); assert.throws(() => loadAgendas(file)); assert.deepEqual(JSON.parse(fs.readFileSync(file)), { invalid: true }); }
  finally { fs.rmSync(directory, { recursive: true }); }
});
test('pipeline extracts, critiques and remains silent in shadow; manual request is explicit', async () => {
  const { ops } = fixture(); const calls = [];
  const secretary = new Secretary({ sessionId: 'pipeline', now: () => time + 1000, runFn: async (_, options) => {
    calls.push(options.purpose); return JSON.stringify(options.purpose === 'observer' ? { operations: ops } : options.purpose === 'strategist' ? candidate : scores);
  } });
  let cards = 0; secretary.on('card', () => cards++); secretary.add(fixture().ledger.turns[0]); await secretary.observe(true);
  assert.equal(cards, 0); assert.deepEqual(calls, ['observer', 'strategist', 'critic']); assert.equal(secretary.history.length, 1);
  secretary.history = []; await secretary.suggest(true); assert.equal(cards, 1);
  assert.equal((await secretary.finish()).ledger.items.length, 2);
});
test('observer retries failed batch; concurrent new turns are not lost', async () => {
  let fail = true; const secretary = new Secretary({ sessionId: 'retry', mode: 'silent', runFn: async () => { if (fail) throw new Error('offline'); return JSON.stringify({ operations: [] }); } });
  secretary.add({ text: 'Primeiro turno.' }); await secretary.observe(true); assert.equal(secretary.cursor, 0);
  fail = false; secretary.add({ text: 'Segundo turno.' }); await secretary.observe(true); assert.equal(secretary.cursor, 2);
});
test('observer batches short transcript windows and keeps user markers for closing', async () => {
  let current = time; const calls = [];
  const secretary = new Secretary({ sessionId: 'batched', now: () => current, mode: 'silent', runFn: async (_prompt, options) => { calls.push(options.purpose); return JSON.stringify({ operations: [], phase: 'exploring' }); } });
  secretary.add({ text: 'Trecho curto ainda sem contexto.', at: current }); await secretary.observe();
  assert.equal(calls.length, 0);
  assert.equal(secretary.mark('next-step').turnIndex, 1);
  current += 60_001; await secretary.observe();
  assert.deepEqual(calls, ['observer']);
  assert.equal((await secretary.finish()).marks[0].kind, 'next-step');
});
test('no late card escapes during shutdown', async () => {
  const secretary = new Secretary({ sessionId: 'closing', shadow: false, runFn: async () => JSON.stringify({ operations: [] }) });
  secretary.add({ text: 'Vamos encerrar.' }); await secretary.finish(); assert.equal(await secretary.suggest(true), null);
});
