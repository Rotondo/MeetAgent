import { parseFrontmatter } from './playbook.js';

export const AUDIENCES = ['interna', 'cliente', 'parceiro', 'prospect', '1:1', 'mista'];
export const OBJECTIVES = ['escuta/descoberta', 'apresentação', 'alinhamento', 'decisão', 'execução', 'feedback', '1:1'];
export const ANALYSIS_INTERVAL_SECONDS = [15, 25, 40, 60, 90];

const REQUIRED_HEADINGS = [
  '# Direcional', '## Resultado esperado', '## Atos', '## Perguntas prioritárias',
  '## Regras e limites', '## Critérios de encerramento',
];

function list(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function slugify(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'direcional';
}

export function validateContextPackage(markdown) {
  const source = String(markdown ?? '').trim();
  const { attributes, body } = parseFrontmatter(source);
  const errors = [];
  if (attributes.type !== 'meeting-agent-context') errors.push('frontmatter type: meeting-agent-context é obrigatório');
  if (!attributes.context_name) errors.push('context_name é obrigatório');
  if (!attributes.directional_name) errors.push('directional_name é obrigatório');
  for (const heading of REQUIRED_HEADINGS) if (!body.includes(heading)) errors.push(`seção obrigatória ausente: ${heading}`);
  const audiences = list(attributes.audience_defaults);
  const objectives = list(attributes.objective_defaults);
  const invalidAudience = audiences.filter((item) => !AUDIENCES.includes(item));
  const invalidObjective = objectives.filter((item) => !OBJECTIVES.includes(item));
  const analysisIntervalSeconds = attributes.analysis_interval_seconds == null || attributes.analysis_interval_seconds === ''
    ? null : Number(attributes.analysis_interval_seconds);
  if (invalidAudience.length) errors.push(`público inválido: ${invalidAudience.join(', ')}`);
  if (invalidObjective.length) errors.push(`objetivo inválido: ${invalidObjective.join(', ')}`);
  if (analysisIntervalSeconds != null && !ANALYSIS_INTERVAL_SECONDS.includes(analysisIntervalSeconds)) {
    errors.push(`analysis_interval_seconds deve ser um de: ${ANALYSIS_INTERVAL_SECONDS.join(', ')}`);
  }
  return { valid: errors.length === 0, errors, attributes, body: body.trim(), audiences, objectives, analysisIntervalSeconds };
}

export function buildExternalContextPrompt({ contextName = '', directionalName = '', brief = '' } = {}) {
  return `Você é um arquiteto de agendas de reunião. Transforme o briefing abaixo em UM PACOTE DE CONTEXTO para o Meeting Agent.

Não invente fatos. Diferencie fatos, hipóteses, perguntas abertas e limites. Use linguagem prática, curta e em português. O pacote será revisado por uma pessoa antes de ser ativado.

BRIEFING ORIGINAL:
${brief || '(cole aqui o briefing completo, materiais, objetivos e restrições)'}

Responda somente com Markdown neste formato exato:
---
type: meeting-agent-context
context_name: ${contextName || '<nome do contexto>'}
directional_name: ${directionalName || '<nome do direcional>'}
description: <descrição em uma frase>
audience_defaults: interna, parceiro
objective_defaults: escuta/descoberta, decisão
live_analysis: true
analysis_interval_seconds: 60
---

# Direcional
<o que este direcional conduz>

## Resultado esperado
<decisão, clareza ou compromisso que a agenda deve produzir>

## Atos
1. <ato, objetivo e critério de saída>

## Perguntas prioritárias
- <pergunta pronta>

## Gatilhos de intervenção
- <situação observável que exige uma microintervenção>

## Regras e limites
- <o que não prometer, não assumir ou não repetir>

## Conhecimento de referência
- Fato confirmado: <dado explícito do briefing>
- Hipótese: <interpretação a validar, se houver>
- Pergunta aberta: <o que ainda precisa ser descoberto>
- Pendência: <informação, decisão ou insumo ausente>

## Critérios de encerramento
- <decisão, responsável, prazo, condição de satisfação e próximo checkpoint quando aplicável>

## Tom e condução
- Use escuta ativa, fatos versus interpretações, proposta/pedido/pergunta, alinhamento e compromissos claros. Não moralize nem gere métricas de fala.`;
}
