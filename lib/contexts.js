import { slugify } from './context-package.js';
import { agendaPlaybook, buildMeetingModel } from './meeting-domain.js';

function nowIso() { return new Date().toISOString(); }

function defaultDirectional(name, legacy = true) {
  return { id: legacy ? 'conducao-geral' : slugify(name), name: legacy ? 'Condução geral' : name,
    description: legacy ? 'Direcional padrão migrado do projeto anterior.' : '', status: 'ativo',
    audienceDefaults: [], objectiveDefaults: [], liveAnalysis: false, analysisIntervalMs: null, packageMarkdown: '', sourceBrief: '',
    legacyPlaybook: legacy, agenda: [], lenses: [], createdAt: nowIso(), updatedAt: nowIso() };
}

export function normalizeContext(value) {
  const name = String(value?.name ?? '').trim() || 'Contexto sem nome';
  const directions = Array.isArray(value?.directions)
    ? value.directions : [defaultDirectional(name, Boolean(value?.legacyPlaybook ?? true))];
  return { id: value?.id || slugify(name), name, description: String(value?.description ?? ''),
    path: value?.path ?? null, skills: Array.isArray(value?.skills) ? value.skills : [],
    createdAt: value?.createdAt || nowIso(), updatedAt: value?.updatedAt || nowIso(),
    directions: directions.map((direction) => ({ ...defaultDirectional(direction?.name || 'Direcional', false), ...direction,
       id: direction?.id || slugify(direction?.name), status: direction?.status === 'rascunho' ? 'rascunho' : 'ativo',
       audienceDefaults: Array.isArray(direction?.audienceDefaults) ? direction.audienceDefaults : [],
       objectiveDefaults: Array.isArray(direction?.objectiveDefaults) ? direction.objectiveDefaults : [],
       analysisIntervalMs: Number.isFinite(Number(direction?.analysisIntervalMs)) ? Number(direction.analysisIntervalMs) : null })) };
}

export function migrateProjectsToContexts(projects = []) {
  return projects.map((project) => {
    const isSolutions = project.name === 'Apresentação de Soluções';
    return normalizeContext({ ...project, id: project.id || slugify(project.name), directions: [{
      ...defaultDirectional(isSolutions ? 'Apresentação de Soluções' : 'Condução geral', true),
      id: isSolutions ? 'apresentacao-de-solucoes' : 'conducao-geral',
      name: isSolutions ? 'Apresentação de Soluções' : 'Condução geral',
    }] });
  });
}

const RECOMMENDED_CONTEXTS = [
  { name: 'Parcerias', description: 'Relações, negociação e evolução de parceiros.', directional: 'Condução de parceria' },
  { name: 'Produto e Projetos', description: 'Decisões, alinhamento e execução de produto ou projeto.', directional: 'Alinhamento de projeto' },
  { name: 'Cliente e Prospect', description: 'Descoberta, apresentação e evolução comercial com clientes.', directional: 'Descoberta comercial' },
];

export function seedRecommendedContexts(store) {
  const existing = (store.contexts ?? []).map((context) => {
    if (context.name !== 'Apresentação de Soluções') return context;
    const directions = (context.directions ?? []).map((direction) => direction.id === 'apresentacao-de-solucoes'
      ? { ...direction, name: 'Apresentação de Soluções' }
      : direction);
    return { ...context, directions };
  });
  const missing = RECOMMENDED_CONTEXTS.filter((template) => !existing.some((item) => item.name === template.name));
  const repaired = JSON.stringify(existing) !== JSON.stringify(store.contexts ?? []);
  if (!missing.length && !repaired) return store;
  return {
    ...store,
    contexts: [...existing, ...missing.map((template) => normalizeContext({
      name: template.name,
      description: template.description,
      directions: [{ ...defaultDirectional(template.directional, false), status: 'ativo' }],
    }))],
  };
}

export function getContext(store, idOrName) { return (store.contexts ?? []).find((item) => item.id === idOrName || item.name === idOrName) ?? null; }
export function getDirectional(context, directionalId) { return context?.directions?.find((item) => item.id === directionalId || item.name === directionalId) ?? null; }

export function upsertContext(store, input) {
  const context = normalizeContext({ ...input, updatedAt: nowIso() });
  const contexts = (store.contexts ?? []).filter((item) => item.id !== context.id && item.name !== context.name);
  return { ...store, contexts: [...contexts, context] };
}
export function deleteContext(store, idOrName) { return { ...store, contexts: (store.contexts ?? []).filter((item) => item.id !== idOrName && item.name !== idOrName) }; }

export function upsertDirectional(store, contextId, input) {
  const context = getContext(store, contextId); if (!context) throw new Error('contexto não encontrado');
  const directional = { ...defaultDirectional(input?.name || 'Direcional', false), ...input,
    id: input?.id || slugify(input?.name), updatedAt: nowIso(), createdAt: input?.createdAt || nowIso() };
  const directions = context.directions.filter((item) => item.id !== directional.id && item.name !== directional.name);
  return upsertContext(store, { ...context, directions: [...directions, directional] });
}
export function cloneDirectional(store, contextId, directionalId, name) {
  const directional = getDirectional(getContext(store, contextId), directionalId);
  if (!directional) throw new Error('direcional não encontrado');
  return upsertDirectional(store, contextId, { ...directional, id: slugify(name), name, status: 'rascunho', createdAt: nowIso(), updatedAt: nowIso() });
}
export function composeMeetingPlaybook({ context, directional, audience, objective, legacyPlaybook = null }) {
  const generated = agendaPlaybook(buildMeetingModel({ directional, objective }));
  const base = directional.packageMarkdown || legacyPlaybook?.text || generated;
  return `# Contexto da reunião\n\n- Contexto: ${context.name}\n- Direcional: ${directional.name}\n- Público: ${audience}\n- Objetivo: ${objective}\n\n${context.description ? `## Conhecimento do contexto\n${context.description}\n\n` : ''}${base}`;
}
