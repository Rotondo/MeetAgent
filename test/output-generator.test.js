import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateClosing,
  generateFallbackClosing,
  executeClosingActions,
  appendExecutionResults,
  appendUsageResults,
  summarizeUsage,
} from '../lib/output-generator.js';

const REPORT = {
  sumario: 'Reunião sobre Empresa Exemplo.',
  o_que_mudou: ['A nova rotina começa na próxima semana.'],
  decisoes_confirmadas: [{ decisao: 'Usar o relatório novo.', evidencia: 'Ficou definido.' }],
  anuncios_operacionais: [{ anuncio: 'Relatório disponível.', evidencia: 'Está disponível.' }],
  encaminhamentos_sugeridos: [{ encaminhamento: 'Testar uma comunicação.', evidencia: 'Podemos testar.' }],
  relevancia_para_voce: ['Acompanhar a adoção da rotina.'],
  o_que_acompanhar: ['Primeira revisão semanal.'],
  fontes_utilizadas: ['reunião atual'],
  tom_da_reuniao: 'produtiva',
  proximos_passos: [{
    acao: 'Enviar contrato',
    responsavel: 'Usuário',
    prazo: null,
    evidencia: 'Usuário afirmou que enviaria o contrato.',
  }],
  registro_crm: { data: '2026-07-18', participantes: ['Usuário'], assunto: 'Empresa Exemplo', outcome: 'decidido', notas: 'ok' },
  avaliacao_roteiro: [{
    ato: 'Próximos passos',
    status: 'parcial',
    evidencia: 'Houve acordo sobre o envio.',
    lacuna: 'Não foi definido prazo.',
  }],
  perguntas_abertas: [{
    pergunta: 'Qual é a data do envio?',
    por_que_importa: 'Evita um compromisso sem prazo.',
  }],
  oportunidades: [{
    oportunidade: 'Validar o piloto.',
    evidencia: 'O piloto foi mencionado.',
    proxima_acao: 'Definir condição de sucesso.',
  }],
  desvios_de_foco: [{
    tema: 'Tema paralelo',
    evidencia: 'A conversa saiu do objetivo.',
    impacto: 'Consumiu tempo de qualificação.',
  }],
};

test('generateClosing salva relatório e devolve somente a fila silenciosa como pendente', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-out-'));
  const result = await generateClosing(
    {
      transcript: 'fala1\nfala2',
      executedActions: [],
      filaSilenciosa: [{ id: 9, proposta: 'Registrar depois', skill: 'crm', argumento: 'Empresa Exemplo' }],
      projectPath: 'C:/x',
    },
    { runFn: async () => JSON.stringify(REPORT), outputsDir, now: new Date('2026-07-18T14:30:00') },
  );
  assert.equal(result.pendingActions.length, 1);
  assert.equal(result.pendingActions[0].skill, 'crm');
  assert.equal(result.executionResults.length, 0);
  assert.ok(fs.existsSync(result.savedPath));
  const md = fs.readFileSync(result.savedPath, 'utf8');
  assert.match(md, /Reunião sobre Empresa Exemplo/);
  assert.match(md, /Ações pendentes de aprovação/i);
  assert.match(md, /evidência: Usuário afirmou/);
  assert.match(md, /## Avaliação do roteiro[\s\S]*Próximos passos/);
  assert.match(md, /## Perguntas abertas[\s\S]*Qual é a data/);
  assert.match(md, /## Oportunidades[\s\S]*Validar o piloto/);
  assert.match(md, /## Desvios de foco[\s\S]*Tema paralelo/);
  assert.match(md, /## O que mudou[\s\S]*nova rotina/);
  assert.match(md, /## Anúncios operacionais[\s\S]*Relatório disponível/);
  assert.match(md, /## Encaminhamentos sugeridos[\s\S]*Testar uma comunicação/);
  assert.match(md, /## Relevância para você[\s\S]*Acompanhar a adoção/);
});

test('generateClosing envia transcript rotulado, playbook e orientação global ao prompt', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-prompt-'));
  let capturedPrompt = '';
  await generateClosing(
    {
      transcript: '[Usuário] Eu envio o contrato.\n[Interlocutor] Combinado.',
      executedActions: [],
      filaSilenciosa: [],
      projectPath: 'C:/x',
      playbook: { text: 'ATO: confirmar próximos passos e condição de satisfação.' },
    },
    {
      runFn: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify(REPORT);
      },
      outputsDir,
      now: new Date('2026-07-18T14:30:01'),
    },
  );
  assert.match(capturedPrompt, /\[Usuário\] Eu envio o contrato/);
  assert.match(capturedPrompt, /rótulos de fala são aproximações técnicas/i);
  assert.match(capturedPrompt, /ATO: confirmar próximos passos/);
  assert.match(capturedPrompt, /Torne explícito o futuro\/resultado/);
  assert.match(capturedPrompt, /Responsável: preencha somente quando houver aceite em primeira pessoa/i);
  assert.match(capturedPrompt, /Prazo: copie somente data\/período explicitamente combinado/i);
});

test('generateClosing aceita orientação personalizada sem alterar a API existente', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-guidance-'));
  let capturedPrompt = '';
  await generateClosing(
    {
      transcript: 'Conversa',
      executedActions: [],
      filaSilenciosa: [],
      projectPath: 'C:/x',
      playbook: 'Roteiro curto',
      guidance: 'ORIENTAÇÃO PERSONALIZADA',
    },
    {
      runFn: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify(REPORT);
      },
      outputsDir,
      now: new Date('2026-07-18T14:30:02'),
    },
  );
  assert.match(capturedPrompt, /ORIENTAÇÃO PERSONALIZADA/);
});

test('generateClosing inclui perfil de contexto no prompt e no relatório', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-profile-'));
  let capturedPrompt = '';
  const result = await generateClosing(
    { transcript: 'Conversa', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x', meetingProfile: { context: 'Parcerias', directional: 'Negociação', audience: 'parceiro', objective: 'decisão' } },
    { runFn: async (prompt) => { capturedPrompt = prompt; return JSON.stringify(REPORT); }, outputsDir, now: new Date('2026-07-18T14:30:03') },
  );
  assert.match(capturedPrompt, /PERFIL DA AGENDA/);
  assert.match(capturedPrompt, /\"objective\": \"decisão\"/);
  assert.match(fs.readFileSync(result.savedPath, 'utf8'), /Contexto:\*\* Parcerias/);
});

test('generateClosing lança com relatório inválido', async () => {
  await assert.rejects(
    generateClosing(
      { transcript: 'x', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x' },
      { runFn: async () => 'lixo', outputsDir: os.tmpdir(), now: new Date() },
    ),
    /relatório inválido/,
  );
});

test('generateClosing repara resposta com chaves alternativas antes de desistir', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-repair-'));
  const responses = [
    'resposta incompleta',
    JSON.stringify({
      summary: 'Reunião operacional com pendências.',
      tone: 'produtiva',
      next_steps: [],
      crm: { subject: 'Operação', participants: [], outcome: 'em andamento' },
    }),
  ];
  const result = await generateClosing(
    { transcript: 'Conversa', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x' },
    { runFn: async () => responses.shift(), outputsDir, now: new Date('2026-09-14T10:00:00') },
  );
  assert.equal(result.report.sumario, 'Reunião operacional com pendências.');
  assert.equal(result.report.registro_crm.assunto, 'Operação');
});

test('fallback preserva o resumo ao vivo e os itens abertos', () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-live-fallback-'));
  const result = generateFallbackClosing(
    {
      transcript: 'Transcrição',
      filaSilenciosa: [],
      meetingProfile: { context: 'Parcerias' },
      liveState: {
        summary: 'Domínio pendente de definição do fluxo operacional.',
        coverage: { pendencias: { status: 'em progresso', evidence: 'Voucher ainda sem fluxo.' } },
      },
    },
    { outputsDir, now: new Date('2026-09-14T10:00:00'), error: new Error('JSON inválido') },
  );
  assert.equal(result.report.sumario, 'Domínio pendente de definição do fluxo operacional.');
  const md = fs.readFileSync(result.savedPath, 'utf8');
  assert.match(md, /Sumário preservado/);
  assert.match(md, /Itens ainda abertos[\s\S]*Voucher ainda sem fluxo/);
});

test('generateFallbackClosing preserva a transcrição quando a IA falha', () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-fallback-'));
  const result = generateFallbackClosing(
    {
      transcript: 'Discussão importante\nDecisão pendente',
      filaSilenciosa: [{ skill: 'crm', proposta: 'Revisar CRM' }],
    },
    {
      outputsDir,
      now: new Date('2026-07-23T09:30:00'),
      error: new Error('provedores indisponíveis'),
    },
  );
  assert.equal(result.partial, true);
  assert.equal(result.pendingActions.length, 1);
  const md = fs.readFileSync(result.savedPath, 'utf8');
  assert.match(md, /Discussão importante/);
  assert.match(md, /provedores indisponíveis/);
});

test('executeClosingActions permite somente skills cadastradas e continua após falha', async () => {
  const results = await executeClosingActions(
    [
      { id: 1, skill: 'quebra', argumento: 'a' },
      { id: 2, skill: 'funciona', argumento: 'b' },
      { id: 3, skill: 'desconhecida', argumento: 'c' },
    ],
    {
      projectPath: 'C:/x',
      allowedSkills: ['quebra', 'funciona'],
      execFn: async ({ skill }) => {
        if (skill === 'quebra') throw new Error('boom');
        return 'ok';
      },
    },
  );
  assert.match(results[0].error, /boom/);
  assert.equal(results[1].output, 'ok');
  assert.match(results[2].error, /não permitida/);
});

test('executeClosingActions respeita dependências e resolve outputs anteriores', async () => {
  const calls = [];
  const results = await executeClosingActions(
    [
      { id: 1, ordem: 1, depende_de: null, skill: 'busca', argumento: 'Empresa Exemplo' },
      { id: 2, ordem: 2, depende_de: 1, skill: 'crm', argumento: '{{output_1}}' },
    ],
    {
      projectPath: 'C:/x',
      allowedSkills: ['busca', 'crm'],
      execFn: async ({ skill, argumento }) => {
        calls.push({ skill, argumento });
        return skill === 'busca' ? 'dados encontrados' : 'crm atualizado';
      },
    },
  );
  assert.equal(calls[1].argumento, 'dados encontrados');
  assert.equal(results[1].output, 'crm atualizado');
});

test('executeClosingActions bloqueia ação cuja dependência não foi selecionada', async () => {
  const results = await executeClosingActions(
    [{ id: 2, ordem: 2, depende_de: 1, skill: 'crm', argumento: '{{output_1}}' }],
    { projectPath: 'C:/x', allowedSkills: ['crm'], execFn: async () => 'não deve executar' },
  );
  assert.match(results[0].error, /dependência não selecionada/);
});

test('appendExecutionResults acrescenta auditoria ao markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-append-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, '# Relatório\n');
  appendExecutionResults(file, [{ skill: 'crm', output: 'feito' }]);
  assert.match(fs.readFileSync(file, 'utf8'), /Execuções aprovadas[\s\S]*feito/);
});

test('summarizeUsage calcula tokens e custo estimado dos modelos conhecidos', () => {
  const result = summarizeUsage([
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      purpose: 'closing',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    },
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      purpose: 'closing',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    },
    {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      purpose: 'coach',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    },
  ]);
  assert.equal(result.entries.length, 3);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].calls, 2);
  assert.equal(result.groups[0].purpose, 'closing');
  assert.equal(result.groups[0].totalTokens, 4_000_000);
  assert.equal(result.totalTokens, 6_000_000);
  assert.equal(result.estimatedCostUsd, 6.8);
});

test('appendUsageResults grava grupos agregados, não uma linha por chamada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-usage-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, '# Relatório\n');
  appendUsageResults(file, [
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      purpose: 'closing',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      purpose: 'closing',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    },
  ]);
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /openai \(gpt-4\.1-mini\) — closing: 2 chamadas/);
  assert.equal([...md.matchAll(/openai \(gpt-4\.1-mini\) — closing/g)].length, 1);
  assert.match(md, /entrada 30, saída 15, total 45 tokens/);
});
