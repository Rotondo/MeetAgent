const VALID_COVERAGE = new Set(['não abordado', 'em progresso', 'validado', 'adiado']);
const VALID_LENSES = ['descoberta', 'apresentação', 'venda', 'negociação', 'alinhamento', 'decisão', 'execução', 'feedback', 'liderança'];

export const DEFAULT_LENSES = VALID_LENSES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));

const DEFAULT_AGENDAS = {
  alinhamento: [
    ['topicos', 'Tópicos e prioridades', 'Quais frentes realmente precisam de atenção nesta reunião?'],
    ['decisoes', 'Decisões tomadas', 'O que foi decidido, inclusive o que foi explicitamente adiado?'],
    ['pendencias', 'Pendências e bloqueios', 'O que ainda impede cada frente de avançar?'],
    ['responsaveis', 'Responsáveis', 'Quem assumiu cada entrega ou validação?'],
    ['prazos', 'Prazos e checkpoints', 'Quando cada entrega volta a ser verificada?'],
    ['dependencias', 'Dependências e comunicação', 'Quem precisa ser envolvido ou informado para o trabalho avançar?'],
  ],
  decisão: [
    ['resultado', 'Decisão esperada', 'Qual escolha precisa sair desta conversa?'],
    ['fatos', 'Fatos e restrições', 'Quais evidências e limites devem orientar a escolha?'],
    ['opcoes', 'Opções e critérios', 'Quais alternativas existem e como serão comparadas?'],
    ['decisao', 'Decisão registrada', 'Qual opção foi escolhida e por quê?'],
    ['compromissos', 'Execução da decisão', 'Quem faz o quê e quando a decisão será revisada?'],
  ],
  execução: [
    ['status', 'Estado atual', 'O que está concluído, em andamento e parado?'],
    ['bloqueios', 'Bloqueios', 'O que impede o próximo avanço?'],
    ['prioridades', 'Prioridades', 'Qual é a próxima entrega de maior valor?'],
    ['responsaveis', 'Responsáveis', 'Quem assume cada ação?'],
    ['prazos', 'Prazos e checkpoints', 'Qual é a data ou condição da próxima verificação?'],
  ],
  feedback: [
    ['contexto', 'Contexto observado', 'Qual situação concreta motivou o feedback?'],
    ['impacto', 'Impacto', 'Que efeito observável esse comportamento produziu?'],
    ['perspectiva', 'Perspectiva da pessoa', 'Como a outra pessoa interpreta a situação?'],
    ['acordo', 'Acordo de mudança', 'O que deve continuar ou mudar daqui para frente?'],
    ['checkpoint', 'Acompanhamento', 'Quando e como o progresso será revisto?'],
  ],
  apresentação: [
    ['contexto', 'Contexto e objetivo', 'Qual problema e resultado justificam esta conversa?'],
    ['necessidade', 'Necessidade / ICP', 'Para quem isso gera mais valor e por quê?'],
    ['precificacao', 'Precificação', 'Qual modelo, base de cálculo e condição comercial fazem sentido?'],
    ['contrato', 'Contrato e condições', 'Que escopo, restrição ou condição precisa constar?'],
    ['prazo', 'Prazo e homologação', 'Qual marco, dependência e critério de aceite definem o avanço?'],
    ['proximo_passo', 'Próximo passo verificável', 'Quem entrega o quê, até quando, e como saberemos que terminou?'],
  ],
  venda: [
    ['dor', 'Problema e impacto', 'Qual problema tem prioridade e qual impacto ele produz hoje?'],
    ['stakeholders', 'Processo decisório', 'Quem usa, influencia e aprova esta decisão?'],
    ['valor', 'Proposta de valor', 'Qual resultado precisa ser provado para justificar o investimento?'],
    ['comercial', 'Condição comercial', 'Qual modelo de preço, contrato e condição viabiliza o avanço?'],
    ['proximo_passo', 'Próximo passo verificável', 'Quem entrega o quê, até quando, e qual é o checkpoint?'],
  ],
  liderança: [
    ['resultado', 'Resultado esperado', 'O que esta conversa precisa destravar?'],
    ['escuta', 'Perspectiva da pessoa', 'O que você está vendo que eu ainda não entendi?'],
    ['fatos', 'Fatos e bloqueios', 'Qual fato ou bloqueio explica melhor a situação?'],
    ['decisao', 'Decisão ou apoio', 'Que decisão, apoio ou remoção de obstáculo é necessária?'],
    ['compromissos', 'Compromissos', 'Qual é o próximo passo, dono e data?'],
  ],
};

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const OBJECTIVE_ALIASES = new Map([
  ['escuta/descoberta', 'descoberta'],
  ['escuta', 'descoberta'],
  ['1:1', 'liderança'],
  ['gestao', 'alinhamento'],
  ['gestão', 'alinhamento'],
]);

export function resolveMeetingLens(objective = '') {
  const normalized = normalize(objective).trim();
  const alias = OBJECTIVE_ALIASES.get(normalized);
  if (alias) return alias;
  return VALID_LENSES.find((lens) => normalize(lens) === normalized) ?? 'alinhamento';
}

const ADAPTATION_SIGNALS = {
  alinhamento: ['prioridade', 'status', 'essa semana', 'pendencia', 'pendência', 'bloqueio', 'responsavel', 'responsável', 'prazo', 'agenda', 'alinhamento', 'proximo passo', 'próximo passo'],
  execução: ['implementar', 'entrega', 'rodando', 'deploy', 'corrigir', 'resolver', 'teste', 'dashboard', 'fluxo operacional'],
  decisão: ['decidir', 'escolher', 'alternativa', 'opcao', 'opção', 'criterio', 'critério', 'aprovar'],
  negociação: ['contrapartida', 'negociar', 'proposta comercial', 'desconto', 'comissao', 'comissão', 'contrato', 'condicao comercial', 'condição comercial'],
  apresentação: ['apresentar', 'demonstracao', 'demonstração', 'demo', 'mostrar a solucao', 'mostrar a solução'],
  descoberta: ['entender a necessidade', 'qual problema', 'como funciona hoje', 'dor', 'perfil ideal', 'descoberta'],
  feedback: ['feedback', 'comportamento', 'impacto em voce', 'impacto em você', 'desenvolvimento pessoal'],
};

function signalScore(text, signals) {
  return signals.reduce((score, signal) => score + (text.includes(normalize(signal)) ? 1 : 0), 0);
}

export function inferMeetingLens({ text = '', currentLens = '', objective = '', audience = '' } = {}) {
  const source = normalize(text);
  const configuredLens = resolveMeetingLens(currentLens || objective);
  const scores = Object.fromEntries(Object.entries(ADAPTATION_SIGNALS).map(([lens, signals]) => [lens, signalScore(source, signals)]));
  scores[configuredLens] = (scores[configuredLens] ?? 0) + 2;
  if (normalize(audience) === 'interna') scores.alinhamento += 2;
  const [bestLens, bestScore] = Object.entries(scores).sort((left, right) => right[1] - left[1])[0];
  const currentScore = scores[configuredLens] ?? 0;
  const evidenceCount = signalScore(source, ADAPTATION_SIGNALS[bestLens] ?? []);
  if (bestLens !== configuredLens && evidenceCount >= 3 && bestScore >= currentScore + 2) {
    return { lens: bestLens, changed: true, confidence: Math.min(0.95, 0.65 + evidenceCount * 0.05), scores };
  }
  return { lens: configuredLens, changed: false, confidence: Math.min(0.9, 0.6 + currentScore * 0.04), scores };
}

const MODE_SIGNALS = {
  decisao: ['decidir', 'decisao', 'aprovar', 'escolher', 'fechar', 'bater o martelo'],
  execucao: ['status', 'prazo', 'bloqueio', 'responsavel', 'andamento', 'entrega', 'proximo passo'],
  apresentacao: ['vou mostrar', 'apresentar', 'relatorio', 'passar por', 'explicar', 'material', 'dashboard'],
  discovery: ['entender', 'explorar', 'hipotese', 'ideia', 'problema', 'como funciona', 'oportunidade'],
  oneToOne: ['feedback', 'desenvolvimento', 'carreira', 'como voce esta', 'um a um'],
};

export function inferAdaptiveMeeting({ text = '', objective = '', meetingWords = 0, microphoneWords = 0, participantCount = 0 } = {}) {
  const source = normalize(text);
  const scores = Object.fromEntries(Object.entries(MODE_SIGNALS)
    .map(([mode, signals]) => [mode, signalScore(source, signals)]));
  const configured = resolveMeetingLens(objective);
  const configuredMode = configured === 'alinhamento' ? 'execucao'
    : configured === 'descoberta' ? 'discovery'
      : configured === 'feedback' ? 'oneToOne' : normalize(configured);
  if (scores[configuredMode] != null) scores[configuredMode] += 1;
  const share = meetingWords > 0 ? Math.min(1, microphoneWords / meetingWords) : 0;
  if (meetingWords >= 120 && share < 0.05) scores.apresentacao += 3;
  if (participantCount > 3) scores.apresentacao += 1;
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [mode, bestScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const enoughEvidence = meetingWords >= 80 && bestScore >= 2;
  const confidence = enoughEvidence ? Math.min(0.96, 0.58 + bestScore * 0.06 + Math.max(0, bestScore - secondScore) * 0.04) : 0.45;
  let role = 'participante';
  if (meetingWords >= 120 && share < 0.05) role = 'ouvinte';
  else if (share >= 0.45) role = mode === 'apresentacao' ? 'apresentador' : 'facilitador';
  return { mode: enoughEvidence ? mode : configuredMode, configuredMode,
    changed: enoughEvidence && mode !== configuredMode, confidence, role,
    participationShare: share, meetingWords, microphoneWords, scores };
}

export function defaultAgenda(lens = 'descoberta') {
  const source = DEFAULT_AGENDAS[resolveMeetingLens(lens)] ?? DEFAULT_AGENDAS.alinhamento;
  return source.map(([id, label, question], index) => ({
    id, label, priority: index + 1, triggers: [id, ...label.split(/\s+/)], question, completion: `Evidência explícita para ${label.toLowerCase()}.`,
  }));
}

export function buildMeetingModel({ directional = {}, objective = '', skills = [], lenses = null } = {}) {
  const lens = resolveMeetingLens(objective);
  const rawAgenda = Array.isArray(directional.agenda) && directional.agenda.length ? directional.agenda : defaultAgenda(lens);
  const agenda = rawAgenda.map((item, index) => ({
    id: item.id || `item-${index + 1}`,
    label: item.label || item.name || `Item ${index + 1}`,
    priority: Number(item.priority) || index + 1,
    triggers: Array.isArray(item.triggers) ? item.triggers : [],
    question: item.question || item.pergunta || '',
    completion: item.completion || item.conclusao || '',
  }));
  return {
    lenses: lenses ?? (Array.isArray(directional.lenses) && directional.lenses.length ? directional.lenses : DEFAULT_LENSES),
    activeLens: lens,
    agenda,
    coverage: Object.fromEntries(agenda.map((item) => [item.id, { status: 'não abordado', evidence: null, updatedAt: null }])),
    skills: skills.slice(0, 5),
  };
}

export function adaptMeetingModel(model, lens, now = Date.now()) {
  const nextLens = resolveMeetingLens(lens);
  if (!model || nextLens === model.activeLens) return model;
  const agenda = defaultAgenda(nextLens);
  return {
    ...model,
    activeLens: nextLens,
    agenda,
    coverage: Object.fromEntries(agenda.map((item) => [
      item.id,
      model.coverage?.[item.id] ?? { status: 'não abordado', evidence: null, updatedAt: now },
    ])),
    adaptedAt: now,
  };
}

export function agendaPlaybook(model) {
  const items = (model?.agenda ?? []).map((item) => `- ${item.label}: ${item.question}`).join('\n');
  return `## Modo adaptativo\nLente atual: ${model?.activeLens ?? 'alinhamento'}. A configuração inicial é uma hipótese; siga a conversa real.\n\n## Quadro vivo\n${items}\n\nRegistre decisões, pendências, responsáveis, prazos e dependências. Interrompa somente se uma informação importante estiver prestes a se perder.`;
}

export function updateCoverage(model, itemId, status, evidence = null, now = Date.now()) {
  if (!model?.coverage?.[itemId] || !VALID_COVERAGE.has(status)) return model;
  return {
    ...model,
    coverage: { ...model.coverage, [itemId]: { status, evidence: evidence || null, updatedAt: now } },
  };
}

export function inferCoverage(model, text, now = Date.now()) {
  const source = normalize(text);
  let next = model;
  for (const item of model?.agenda ?? []) {
    if (next.coverage[item.id]?.status !== 'não abordado') continue;
    const terms = [item.label, ...(item.triggers ?? [])].map(normalize).filter((term) => term.length > 3);
    if (terms.some((term) => source.includes(term))) next = updateCoverage(next, item.id, 'em progresso', 'Tema mencionado na conversa.', now);
  }
  return next;
}

export function coverageSummary(model) {
  const values = Object.values(model?.coverage ?? {});
  return { total: values.length, validated: values.filter((item) => item.status === 'validado').length, pending: values.filter((item) => item.status === 'não abordado').length };
}

export function validateIntervention(value, { now = Date.now(), minConfidence = 0.78 } = {}) {
  if (!value || typeof value !== 'object') return null;
  const type = String(value.tipo ?? '').trim();
  const suggestion = String(value.sugestao ?? value.frase ?? '').trim();
  const evidence = String(value.evidencia ?? '').trim();
  const impact = String(value.impacto ?? value.motivo ?? '').trim();
  const act = String(value.ato ?? '').trim();
  const confidence = Number(value.confidence ?? value.confiança);
  if (!['pergunta', 'alerta', 'proximo_passo', 'oportunidade'].includes(normalize(type)) || !suggestion || !evidence || !impact || !act || !Number.isFinite(confidence) || confidence < minConfidence) return null;
  if (suggestion.length > 220 || /você (está |fala|falou) (demais|muito)/i.test(suggestion)) return null;
  return { tipo: type, proposta: suggestion, evidence, impact, act, confidence, expiresAt: now + 45_000 };
}
