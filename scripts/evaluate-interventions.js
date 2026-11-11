import fs from 'node:fs';
import { gateCandidate } from '../lib/intervention-gate.js';
import { createLedger, addTurn, applyOperations } from '../lib/meeting-ledger.js';

const corpus = JSON.parse(fs.readFileSync(new URL('../test/fixtures/meetings/quality-cases.json', import.meta.url), 'utf8'));
const now = 1_000_000;
const ledger = applyOperations(addTurn(createLedger('evaluation'), { text: 'O teste termina antes da entrega dos pedidos e não mede devoluções.', at: now }), [
  { kind: 'risks', text: 'Janela de observação insuficiente', status: 'open', turnId: 't1', quote: 'O teste termina antes da entrega dos pedidos e não mede devoluções.' }
]).ledger;
const scores = { specificity: 2, novelty: 2, relevance: 2, timing: 2, speakability: 2, evidence: 2, impact: 2, reliability: 2 };
const base = { say: 'Como acompanharemos as devoluções dos pedidos entregues após o fim do teste?', whyNow: 'A janela não cobre entrega', riskIfSilent: 'Avaliação inconclusiva', topicKey: 'devolucoes', type: 'risk', target: 'self', evidenceIds: ['i1'], conflictQuotes: ['O teste termina antes da entrega dos pedidos', 'não mede devoluções.'] };
const cases = [
  ['specific', base, {}, true],
  ['obvious', { ...base, say: 'Defina o responsável e o prazo para validar.' }, {}, false],
  ['duplicate', base, { history: [{ ...base, at: now - 300000 }] }, false],
  ['wrong-target', { ...base, target: 'partner' }, {}, false],
  ['no-source', { ...base, evidenceIds: ['fake'] }, {}, false],
  ['late', base, { now: now + 121000 }, false],
  ['critic-rejected', base, { critique: { ...scores, reject: true } }, false],
  ['silence', base, { mode: 'silent' }, false]
];
const results = cases.map(([name, candidate, extra, expected]) => { const result = gateCandidate(candidate, { ledger, now, critique: scores, ...extra }); return { name, ...result, expected, pass: result.approved === expected }; });
console.log(JSON.stringify({ kind: 'deterministic-policy-evaluation-not-model-quality', corpusCases: corpus.cases.length, results }, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
