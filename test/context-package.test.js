import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExternalContextPrompt, validateContextPackage } from '../lib/context-package.js';
import { composeMeetingPlaybook, getContext, getDirectional, upsertContext, upsertDirectional, seedRecommendedContexts } from '../lib/contexts.js';

const PACKAGE = `---
type: meeting-agent-context
context_name: Parcerias
directional_name: Apresentação de Soluções
description: Avaliação de parceiros.
audience_defaults: parceiro
objective_defaults: apresentação, decisão
live_analysis: true
analysis_interval_seconds: 60
---
# Direcional
Conduzir avaliação.
## Resultado esperado
Decidir o próximo passo.
## Atos
1. Qualificar.
## Perguntas prioritárias
- Qual é o ICP?
## Gatilhos de intervenção
- Afirmação sem evidência.
## Regras e limites
- Não prometer canal.
## Conhecimento de referência
- FAQ oficial.
## Critérios de encerramento
- Dono, prazo e aceite.`;

test('valida pacote Markdown completo sem chamar provedor', () => {
  const result = validateContextPackage(PACKAGE);
  assert.equal(result.valid, true);
  assert.deepEqual(result.audiences, ['parceiro']);
  assert.deepEqual(result.objectives, ['apresentação', 'decisão']);
  assert.equal(result.analysisIntervalSeconds, 60);
});

test('rejeita cadência de consulta que o aplicativo não suporta', () => {
  const result = validateContextPackage(PACKAGE.replace('analysis_interval_seconds: 60', 'analysis_interval_seconds: 17'));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /analysis_interval_seconds/);
});

test('rejeita pacote sem estrutura mínima', () => {
  const result = validateContextPackage('# Direcional\ntexto livre');
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});

test('prompt externo exige pacote e inclui briefing sem chamar IA', () => {
  const prompt = buildExternalContextPrompt({ contextName: 'Parcerias', directionalName: 'Negociação', brief: 'Não prometer desconto.' });
  assert.match(prompt, /meeting-agent-context/);
  assert.match(prompt, /Não prometer desconto/);
  assert.match(prompt, /## Critérios de encerramento/);
});

test('compõe playbook com contexto, direcional, público e objetivo', () => {
  let store = { contexts: [] };
  store = upsertContext(store, { name: 'Parcerias', description: 'Programa de parceiros.', directions: [] });
  store = upsertDirectional(store, 'parcerias', { name: 'Negociação', status: 'ativo', packageMarkdown: PACKAGE });
  const context = getContext(store, 'parcerias');
  const text = composeMeetingPlaybook({ context, directional: getDirectional(context, 'negociacao'), audience: 'parceiro', objective: 'decisão' });
  assert.match(text, /Contexto: Parcerias/);
  assert.match(text, /Público: parceiro/);
  assert.match(text, /Objetivo: decisão/);
  assert.match(text, /Avaliação de parceiros/);
});

test('biblioteca inicial adiciona contextos recomendados sem duplicar existentes', () => {
  const seeded = seedRecommendedContexts({ contexts: [{ id: 'lideranca', name: 'Liderança', directions: [] }] });
  assert.ok(seeded.contexts.some((item) => item.name === 'Parcerias'));
  assert.ok(seeded.contexts.some((item) => item.name === 'Produto e Projetos'));
  assert.ok(seeded.contexts.some((item) => item.name === 'Cliente e Prospect'));
  assert.equal(seeded.contexts.filter((item) => item.name === 'Liderança').length, 1);
});
