import fs from 'node:fs';
import path from 'node:path';
import { runClaude, parseJsonLoose } from './claude-client.js';
import config from './config.js';
import { HIGH_PERFORMANCE_GUIDANCE } from './high-performance.js';

const CLOSING_PROMPT = `Você é uma secretária executiva. A reunião encerrou.
Gere o relatório de encerramento. Não execute ações nem altere sistemas externos.

TRANSCRIPT COMPLETO (os rótulos de fala são aproximações técnicas):
{transcriptCompleto}

AÇÕES EXECUTADAS DURANTE A REUNIÃO:
{acoesExecutadas}

FILA SILENCIOSA (registrada durante a reunião para revisão do usuário):
{filaSilenciosa}

ROTEIRO/PLAYBOOK DA REUNIÃO:
{playbook}

ORIENTAÇÃO GLOBAL DE CONDUÇÃO:
{guidance}

PERFIL DA AGENDA:
{meetingProfile}

ESTADO ESTRUTURADO CAPTURADO AO VIVO:
{liveState}

DATA DE HOJE: {dataHoje}

Gere um JSON com a seguinte estrutura:

{
  "sumario": "<3-5 frases objetivas: o que foi discutido, o que foi decidido>",
  "o_que_mudou": ["<mudança de processo, regra ou direcionamento>"],
  "decisoes_confirmadas": [{"decisao":"<decisão>","evidencia":"<evidência>"}],
  "anuncios_operacionais": [{"anuncio":"<mudança anunciada>","evidencia":"<evidência>"}],
  "tom_da_reuniao": "produtiva | tensa | inconclusiva",
  "proximos_passos": [
    {
      "acao": "<compromisso claro mencionado na reunião>",
      "responsavel": "<nome ou null>",
      "prazo": "<prazo mencionado ou null>",
      "evidencia": "<trecho curto/paráfrase que sustenta o passo>"
    }
  ],
  "encaminhamentos_sugeridos": [{"encaminhamento":"<proposta ainda não confirmada>","evidencia":"<evidência>","confirmacao_necessaria":true}],
  "relevancia_para_voce": ["<impacto considerando o papel inferido do usuário>"],
  "o_que_acompanhar": ["<sinal, data ou conversa futura>"],
  "fontes_utilizadas": ["reunião atual | agenda | documento | histórico"],
  "registro_crm": {
    "data": "{dataHoje}",
    "participantes": ["<somente nomes confirmados no transcript>"],
    "assunto": "<tema principal>",
    "outcome": "decidido | em andamento | sem conclusão",
    "notas": "<observações relevantes>"
  },
  "avaliacao_roteiro": [
    {
      "ato": "<ato previsto no roteiro>",
      "status": "concluido | parcial | ausente | nao_aplicavel",
      "evidencia": "<evidência curta ou null>",
      "lacuna": "<o que faltou ou null>"
    }
  ],
  "perguntas_abertas": [
    {
      "pergunta": "<pergunta ainda sem resposta>",
      "por_que_importa": "<impacto curto>"
    }
  ],
  "oportunidades": [
    {
      "oportunidade": "<oportunidade observada>",
      "evidencia": "<evidência curta>",
      "proxima_acao": "<ação sugerida ou null>"
    }
  ],
  "desvios_de_foco": [
    {
      "tema": "<tema que desviou do objetivo>",
      "evidencia": "<evidência curta>",
      "impacto": "<impacto na reunião>"
    }
  ]
}

Regras:
- O registro factual com evidências, quando estiver no playbook, é a fonte de verdade para próximos passos, decisões e perguntas. Não substitua uma citação por interpretação.
- Próximo passo só existe se houver um item do tipo commitments no registro factual ou uma frase literal de compromisso no transcript. Capacidade comercial, hipótese, sugestão e desejo não são próximo passo.
- Pergunta aberta só entra se permaneceu sem resposta. Não registre uma pergunta futura genérica (por exemplo, “depois volto com dúvidas”) como pendência concreta.
- Oportunidades e desvios são opcionais: use [] se não houver impacto explícito e relevante para o objetivo. Não transforme conversa informal em desvio de foco.
- Se não houver decisões ou compromissos claros, escreva isso no sumário e entregue listas vazias; não preencha lacunas com recomendações genéricas.
- Os rótulos [Usuário], [Interlocutor] e similares são aproximações de canal/fonte, não diarização perfeita.
- Participantes: use somente nome dito como apresentação própria ou rótulo nominal estável. Não transforme nomes apenas citados em participantes e nunca invente.
- Responsável: preencha somente quando houver aceite em primeira pessoa ("eu envio") associado a um rótulo nominal confiável, ou atribuição direta e explícita. Proximidade entre nome e ação não prova ownership. Na dúvida, use null.
- Prazo: copie somente data/período explicitamente combinado. Nunca calcule ou suponha uma data; na dúvida, use null.
- Próximos passos: inclua somente compromissos sustentados pelo transcript e uma evidência curta para cada item.
- Se não houver compromisso formal, mantenha próximos_passos vazio, mas preserve anúncios operacionais e encaminhamentos sugeridos nas listas próprias.
- Use o modo e o papel inferidos no estado ao vivo. Para ouvinte, explique mudanças e relevância; não critique sua baixa participação.
- A configuração inicial é hipótese. Se o modo inferido divergir do objetivo configurado, descreva o propósito real sem chamar a reunião de inconclusiva apenas por não haver decisão.
- Separe fatos observáveis de interpretações. Sinalize lacunas, perguntas e oportunidades sem tratá-las como decisões.
- Avalie o roteiro apenas quando ele tiver conteúdo. Os quatro campos analíticos finais são opcionais: use [] quando não houver evidência.
- Avalie também se o objetivo declarado no perfil da agenda foi alcançado; se não foi, registre a lacuna na avaliação do roteiro.
- Aplique a orientação global de forma sutil na avaliação, sem citar o nome do método nem moralizar.
- Sumário máximo 5 frases, objetivo
- Não invente ações, integrações ou atualizações em sistemas externos
- Responda sempre em português`;

function pad(n) { return String(n).padStart(2, '0'); }
function normalizeOrder(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function buildPendingActions(filaSilenciosa = []) {
  return filaSilenciosa
    .filter((item) => typeof item?.skill === 'string' && item.skill.trim())
    .map((item, index) => ({
      id: item.id ?? `closing-${index + 1}`,
      ordem: normalizeOrder(item.ordem, index + 1),
      depende_de: normalizeOrder(item.depende_de),
      skill: item.skill,
      argumento: item.argumento ?? '',
      proposta: item.proposta ?? `Executar ${item.skill}`,
    }));
}

function makeSavedPath(outputsDir, dataHoje, now, suffix = '') {
  fs.mkdirSync(outputsDir, { recursive: true });
  const stem = `${dataHoje}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}${suffix}`;
  let candidate = path.join(outputsDir, `${stem}.md`);
  let copy = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputsDir, `${stem}-${copy}.md`);
    copy += 1;
  }
  return candidate;
}

function normalizePromptContext(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value?.text === 'string' && value.text.trim()) return value.text.trim();
  return fallback;
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function sentence(value) {
  return present(value) ? String(value).trim() : null;
}

function normalizeClosingReport(value, dataHoje) {
  const source = value?.report && typeof value.report === 'object' ? value.report : value;
  if (!source || typeof source !== 'object') return null;
  const summary = sentence(source.sumario ?? source.summary ?? source.resumo);
  if (!summary) return null;
  const crmSource = source.registro_crm ?? source.crm ?? {};
  return {
    ...source,
    sumario: summary,
    o_que_mudou: Array.isArray(source.o_que_mudou) ? source.o_que_mudou : [],
    decisoes_confirmadas: Array.isArray(source.decisoes_confirmadas) ? source.decisoes_confirmadas : [],
    anuncios_operacionais: Array.isArray(source.anuncios_operacionais) ? source.anuncios_operacionais : [],
    tom_da_reuniao: sentence(source.tom_da_reuniao ?? source.tone) ?? 'não classificado',
    proximos_passos: Array.isArray(source.proximos_passos)
      ? source.proximos_passos
      : (Array.isArray(source.next_steps) ? source.next_steps : []),
    encaminhamentos_sugeridos: Array.isArray(source.encaminhamentos_sugeridos) ? source.encaminhamentos_sugeridos : [],
    relevancia_para_voce: Array.isArray(source.relevancia_para_voce) ? source.relevancia_para_voce : [],
    o_que_acompanhar: Array.isArray(source.o_que_acompanhar) ? source.o_que_acompanhar : [],
    fontes_utilizadas: Array.isArray(source.fontes_utilizadas) ? source.fontes_utilizadas : [],
    registro_crm: {
      data: sentence(crmSource.data ?? crmSource.date) ?? dataHoje,
      participantes: Array.isArray(crmSource.participantes ?? crmSource.participants)
        ? (crmSource.participantes ?? crmSource.participants) : [],
      assunto: sentence(crmSource.assunto ?? crmSource.subject) ?? 'Reunião',
      outcome: sentence(crmSource.outcome ?? crmSource.resultado) ?? 'em andamento',
      notas: sentence(crmSource.notas ?? crmSource.notes) ?? summary,
    },
    avaliacao_roteiro: Array.isArray(source.avaliacao_roteiro) ? source.avaliacao_roteiro : [],
    perguntas_abertas: Array.isArray(source.perguntas_abertas) ? source.perguntas_abertas : [],
    oportunidades: Array.isArray(source.oportunidades) ? source.oportunidades : [],
    desvios_de_foco: Array.isArray(source.desvios_de_foco) ? source.desvios_de_foco : [],
  };
}

function repairPrompt(raw, dataHoje) {
  return `Converta a resposta abaixo em JSON válido. Preserve apenas informações presentes; não invente fatos.\n\nA raiz precisa conter: sumario (string), tom_da_reuniao, proximos_passos (array) e registro_crm (objeto com data, participantes, assunto, outcome e notas). Use ${dataHoje} como data somente se ela estiver ausente.\n\nRESPOSTA A REPARAR:\n${String(raw ?? '').slice(0, 12_000)}\n\nResponda somente com JSON.`;
}

function renderEvaluation(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [
    '', '## Avaliação do roteiro',
    ...items.map((item) => {
      if (typeof item === 'string') return `- ${item}`;
      const ato = sentence(item?.ato) ?? 'Ato não identificado';
      const status = sentence(item?.status);
      const evidence = sentence(item?.evidencia);
      const gap = sentence(item?.lacuna);
      return `- **${ato}**${status ? ` — ${status}` : ''}${evidence ? `. Evidência: ${evidence}` : ''}${gap ? `. Lacuna: ${gap}` : ''}`;
    }),
  ];
}

function renderQuestions(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [
    '', '## Perguntas abertas',
    ...items.map((item) => {
      if (typeof item === 'string') return `- ${item}`;
      const question = sentence(item?.pergunta) ?? 'Pergunta não informada';
      const why = sentence(item?.por_que_importa ?? item?.motivo);
      return `- ${question}${why ? ` — ${why}` : ''}`;
    }),
  ];
}

function renderOpportunities(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [
    '', '## Oportunidades',
    ...items.map((item) => {
      if (typeof item === 'string') return `- ${item}`;
      const opportunity = sentence(item?.oportunidade) ?? 'Oportunidade não informada';
      const evidence = sentence(item?.evidencia);
      const nextAction = sentence(item?.proxima_acao);
      return `- ${opportunity}${evidence ? `. Evidência: ${evidence}` : ''}${nextAction ? `. Próxima ação: ${nextAction}` : ''}`;
    }),
  ];
}

function renderFocusDrifts(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [
    '', '## Desvios de foco',
    ...items.map((item) => {
      if (typeof item === 'string') return `- ${item}`;
      const subject = sentence(item?.tema) ?? 'Tema não informado';
      const evidence = sentence(item?.evidencia);
      const impact = sentence(item?.impacto);
      return `- ${subject}${evidence ? `. Evidência: ${evidence}` : ''}${impact ? `. Impacto: ${impact}` : ''}`;
    }),
  ];
}

function renderSimpleSection(title, items, key = null) {
  if (!Array.isArray(items) || !items.length) return [];
  return ['', `## ${title}`, ...items.map((item) => {
    if (typeof item === 'string') return `- ${item}`;
    const text = sentence(key ? item?.[key] : null) ?? sentence(item?.text) ?? 'Item não informado';
    const evidence = sentence(item?.evidencia);
    return `- ${text}${evidence ? ` — Evidência: ${evidence}` : ''}`;
  })];
}

export async function generateClosing(
  {
    transcript,
    executedActions,
    filaSilenciosa,
    projectPath,
    playbook = null,
    guidance = HIGH_PERFORMANCE_GUIDANCE,
    meetingProfile = null,
    liveState = null,
  },
  {
    runFn = runClaude,
    outputsDir = config.outputsDir,
    now = new Date(),
    timeoutMs = config.closingTimeoutMs,
  } = {},
) {
  const dataHoje = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const prompt = CLOSING_PROMPT
    .replaceAll('{dataHoje}', dataHoje)
    .replace('{transcriptCompleto}', transcript || '(sem transcript)')
    .replace('{acoesExecutadas}', JSON.stringify(executedActions ?? [], null, 2))
    .replace('{filaSilenciosa}', JSON.stringify(filaSilenciosa ?? [], null, 2))
    .replace('{playbook}', normalizePromptContext(playbook, '(sem roteiro específico)'))
    .replace('{guidance}', normalizePromptContext(guidance, HIGH_PERFORMANCE_GUIDANCE))
    .replace('{meetingProfile}', JSON.stringify(meetingProfile ?? {}, null, 2))
    .replace('{liveState}', JSON.stringify(liveState ?? {}, null, 2));

  const raw = await runFn(prompt, { timeoutMs, purpose: 'closing' });
  let report = normalizeClosingReport(parseJsonLoose(raw), dataHoje);
  if (!report) {
    const repairedRaw = await runFn(repairPrompt(raw, dataHoje), { timeoutMs: Math.min(timeoutMs, 20_000), purpose: 'closing-repair' });
    report = normalizeClosingReport(parseJsonLoose(repairedRaw), dataHoje);
  }
  if (!report) throw new Error('relatório inválido após tentativa de reparo');

  const pendingActions = buildPendingActions(filaSilenciosa);
  const savedPath = makeSavedPath(outputsDir, dataHoje, now);
  const md = [
    `# Reunião ${dataHoje} — ${report.registro_crm?.assunto ?? ''}`,
    ...(meetingProfile ? ['', `**Contexto:** ${meetingProfile.context ?? '—'} · **Direcional:** ${meetingProfile.directional ?? '—'} · **Público:** ${meetingProfile.audience ?? '—'} · **Objetivo:** ${meetingProfile.objective ?? '—'}`] : []),
    ``, `## Sumário`, report.sumario, ``, `**Tom:** ${report.tom_da_reuniao}`,
    ...renderSimpleSection('O que mudou', report.o_que_mudou),
    ...renderSimpleSection('Decisões confirmadas', report.decisoes_confirmadas, 'decisao'),
    ...renderSimpleSection('Anúncios operacionais', report.anuncios_operacionais, 'anuncio'),
    ``, `## Próximos passos`,
    ...((report.proximos_passos ?? []).length
      ? report.proximos_passos.map((p) => `- ${p.acao} (responsável: ${p.responsavel ?? '—'}, prazo: ${p.prazo ?? '—'})${present(p.evidencia) ? ` — evidência: ${String(p.evidencia).trim()}` : ''}`)
      : ['- Nenhum compromisso individual confirmado.']),
    ...renderSimpleSection('Encaminhamentos sugeridos — confirmação necessária', report.encaminhamentos_sugeridos, 'encaminhamento'),
    ...renderSimpleSection('Relevância para você', report.relevancia_para_voce),
    ...renderSimpleSection('O que acompanhar', report.o_que_acompanhar),
    ...renderEvaluation(report.avaliacao_roteiro),
    ...renderQuestions(report.perguntas_abertas),
    ...renderOpportunities(report.oportunidades),
    ...renderFocusDrifts(report.desvios_de_foco),
    ...renderSimpleSection('Fontes utilizadas', report.fontes_utilizadas),
    ``, `## Registro CRM`, '```json', JSON.stringify(report.registro_crm, null, 2), '```',
    ``, `## Ações pendentes de aprovação`,
    ...(pendingActions.length
      ? pendingActions.map((a) => `- [ ] ${a.proposta} — \`${a.skill}\``)
      : ['- Nenhuma']),
  ].join('\n');
  fs.writeFileSync(savedPath, md, 'utf8');

  return { report, pendingActions, executionResults: [], savedPath };
}

export function generateFallbackClosing(
  { transcript, fullTranscript = null, filaSilenciosa, liveState = null, meetingProfile = null },
  { outputsDir = config.outputsDir, now = new Date(), error = null } = {},
) {
  const dataHoje = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const warning = 'A análise por IA não foi concluída. A transcrição foi preservada para revisão e o encerramento não ficou travado.';
  const liveSummary = sentence(liveState?.summary);
  const board = liveState?.board && typeof liveState.board === 'object' ? liveState.board : {};
  const boardCount = Object.values(board).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
  const preservedSummary = boardCount
    ? `O registro factual preservou ${boardCount} item(ns) da reunião: ${(board.decisoes || []).length} decisão(ões), ${(board.compromissos || []).length} compromisso(s), ${(board.pendencias || []).length} pendência(s) e ${(board.riscos || []).length} risco(s). A síntese narrativa ficou pendente de reprocessamento.`
    : null;
  const coverage = liveState?.coverage && typeof liveState.coverage === 'object' ? liveState.coverage : {};
  const openItems = Object.entries(coverage).filter(([, state]) => state?.status !== 'validado');
  const report = {
    partial: true,
    warning,
    sumario: liveSummary || preservedSummary || 'Relatório parcial salvo sem análise automática. Consulte a transcrição preservada abaixo para revisar decisões e próximos passos.',
    tom_da_reuniao: boardCount ? 'registro factual parcial' : 'não analisado',
    decisoes_confirmadas: (board.decisoes || []).map((decisao) => ({ decisao })),
    anuncios_operacionais: (board.anuncios || []).map((anuncio) => ({ anuncio })),
    encaminhamentos_sugeridos: (board.propostas || []).map((encaminhamento) => ({ encaminhamento })),
    perguntas_abertas: (board.pendencias || []).map((pergunta) => ({ pergunta, por_que_importa: 'Requer confirmação na revisão.' })),
    oportunidades: (board.riscos || []).map((oportunidade) => ({ oportunidade, evidencia: 'Registro factual da reunião', proxima_acao: 'Revisar e confirmar.' })),
    proximos_passos: (board.compromissos || []).map((acao) => ({ acao, responsavel: null, prazo: null, evidencia: 'Ledger factual preservado' })),
    registro_crm: {
      data: dataHoje,
      participantes: [],
      assunto: meetingProfile?.context ? `${meetingProfile.context} — análise parcial` : 'Reunião — análise pendente',
      outcome: 'sem análise',
      notas: warning,
    },
  };
  const pendingActions = buildPendingActions(filaSilenciosa);
  const savedPath = makeSavedPath(outputsDir, dataHoje, now, '-parcial');
  const indentedTranscript = String(fullTranscript || transcript || '(sem transcrição)')
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
  const md = [
    `# Reunião ${dataHoje} — relatório parcial`,
    '',
    '> **Atenção:** a IA de encerramento falhou, mas a reunião foi encerrada com segurança.',
    '',
    '## Situação',
    warning,
    ...(liveSummary ? ['', '## Sumário preservado durante a reunião', liveSummary] : []),
    ...(preservedSummary && !liveSummary ? ['', '## Sumário factual preservado', preservedSummary] : []),
    ...renderSimpleSection('Decisões confirmadas no ledger', report.decisoes_confirmadas, 'decisao'),
    ...renderSimpleSection('Anúncios operacionais no ledger', report.anuncios_operacionais, 'anuncio'),
    ...(report.proximos_passos.length ? ['', '## Próximos passos preservados', ...report.proximos_passos.map((item) => `- ${item.acao}`)] : []),
    ...renderSimpleSection('Propostas preservadas', report.encaminhamentos_sugeridos, 'encaminhamento'),
    ...(board.pendencias?.length ? ['', '## Pendências preservadas', ...board.pendencias.map((item) => `- ${item}`)] : []),
    ...(board.riscos?.length ? ['', '## Riscos preservados', ...board.riscos.map((item) => `- ${item}`)] : []),
    ...(openItems.length ? ['', '## Itens ainda abertos', ...openItems.map(([id, state]) => `- ${id}: ${state?.status ?? 'não abordado'}${state?.evidence ? ` — ${state.evidence}` : ''}`)] : []),
    ...(error ? ['', `Motivo técnico: ${error.message || String(error)}`] : []),
    '',
    '## Transcrição preservada',
    '',
    indentedTranscript,
    '',
    '## Ações pendentes de aprovação',
    ...(pendingActions.length
      ? pendingActions.map((action) => `- [ ] ${action.proposta} — \`${action.skill}\``)
      : ['- Nenhuma']),
    '',
  ].join('\n');
  fs.writeFileSync(savedPath, md, 'utf8');
  return {
    report,
    pendingActions,
    executionResults: [],
    savedPath,
    partial: true,
    warning,
  };
}

export async function executeClosingActions(
  actions,
  { projectPath, allowedSkills, execFn },
) {
  const allowed = new Set(allowedSkills ?? []);
  const results = [];
  const outputs = new Map();
  const selectedOrders = new Set((actions ?? []).map((action) => action.ordem).filter((value) => value != null));
  for (const action of actions ?? []) {
    if (!allowed.has(action.skill)) {
      results.push({ ...action, error: `skill não permitida: ${action.skill}` });
      continue;
    }
    if (action.depende_de != null && !selectedOrders.has(action.depende_de)) {
      results.push({ ...action, error: `dependência não selecionada: ${action.depende_de}` });
      continue;
    }
    if (action.depende_de != null && !outputs.has(action.depende_de)) {
      results.push({ ...action, error: `dependência não executada: ${action.depende_de}` });
      continue;
    }
    const argumento = String(action.argumento ?? '').replace(
      /\{\{output_(\d+)\}\}/g,
      (_match, ordem) => outputs.get(Number(ordem)) ?? '',
    );
    try {
      const output = await execFn(
        { skill: action.skill, argumento },
        { projectPath },
      );
      if (action.ordem != null) outputs.set(action.ordem, output);
      results.push({ ...action, argumento, output });
    } catch (err) {
      results.push({ ...action, error: err.message });
    }
  }
  return results;
}

export function appendExecutionResults(savedPath, results) {
  if (!results?.length) return;
  const lines = [
    '',
    '## Execuções aprovadas',
    ...results.map((r) => `- ${r.skill}: ${r.error ? `ERRO — ${r.error}` : r.output}`),
    '',
  ];
  fs.appendFileSync(savedPath, lines.join('\n'), 'utf8');
}

export function appendUsageResults(savedPath, usageEvents) {
  const summary = summarizeUsage(usageEvents);
  const lines = [
    '', '## Consumo de IA',
    ...(summary.groups.length
      ? summary.groups.map((item) => `- ${item.provider}${item.model ? ` (${item.model})` : ''}${item.purpose ? ` — ${item.purpose}` : ''}: ${item.calls} ${item.calls === 1 ? 'chamada' : 'chamadas'}, entrada ${item.inputTokens ?? 'não informado'}, saída ${item.outputTokens ?? 'não informado'}, total ${item.totalTokens ?? 'não informado'} tokens${item.estimatedCostUsd == null ? '' : ` — ~US$ ${item.estimatedCostUsd.toFixed(6)}`}`)
      : ['- Nenhuma chamada de IA registrada.']),
    `- **Total informado:** entrada ${summary.inputTokens}, saída ${summary.outputTokens}, total ${summary.totalTokens} tokens.`,
    `- **Custo estimado de IA:** ${summary.estimatedCostUsd == null ? 'indisponível' : `~US$ ${summary.estimatedCostUsd.toFixed(6)}`}.`,
    '- Estimativa pelos preços de tabela configurados em 2026-07-23; créditos gratuitos, impostos e a cobrança real podem diferir. Confirme no painel de cada provedor.', '',
  ];
  fs.appendFileSync(savedPath, lines.join('\n'), 'utf8');
  return summary;
}

const MODEL_PRICING_USD_PER_MILLION = {
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
};

export function summarizeUsage(usageEvents = []) {
  const entries = usageEvents.map((item) => {
    const inputTokens = Number.isFinite(item.usage?.inputTokens) ? item.usage.inputTokens : null;
    const outputTokens = Number.isFinite(item.usage?.outputTokens) ? item.usage.outputTokens : null;
    const totalTokens = Number.isFinite(item.usage?.totalTokens)
      ? item.usage.totalTokens
      : (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
    const price = MODEL_PRICING_USD_PER_MILLION[item.model];
    const estimatedCostUsd = price && inputTokens != null && outputTokens != null
      ? ((inputTokens * price.input) + (outputTokens * price.output)) / 1_000_000
      : null;
    return {
      provider: item.provider,
      model: item.model ?? null,
      purpose: item.purpose ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
    };
  });
  const groupMap = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([
      entry.provider ?? null,
      entry.model ?? null,
      entry.purpose ?? null,
    ]);
    let group = groupMap.get(key);
    if (!group) {
      group = {
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose,
        calls: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
      };
      groupMap.set(key, group);
    }
    group.calls += 1;
    if (entry.inputTokens != null) group.inputTokens = (group.inputTokens ?? 0) + entry.inputTokens;
    if (entry.outputTokens != null) group.outputTokens = (group.outputTokens ?? 0) + entry.outputTokens;
    if (entry.totalTokens != null) group.totalTokens = (group.totalTokens ?? 0) + entry.totalTokens;
    if (entry.estimatedCostUsd != null) {
      group.estimatedCostUsd = (group.estimatedCostUsd ?? 0) + entry.estimatedCostUsd;
    }
  }
  const groups = [...groupMap.values()];
  const knownCosts = entries.filter((item) => item.estimatedCostUsd != null);
  return {
    entries,
    groups,
    inputTokens: entries.reduce((total, item) => total + (item.inputTokens ?? 0), 0),
    outputTokens: entries.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
    totalTokens: entries.reduce((total, item) => total + (item.totalTokens ?? 0), 0),
    estimatedCostUsd: knownCosts.length
      ? knownCosts.reduce((total, item) => total + item.estimatedCostUsd, 0)
      : null,
  };
}
