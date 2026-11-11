import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../lib/dispatcher.js';

const reply = (obj) => async () => JSON.stringify(obj);

test('urgência alta emite suggestion; baixa vai para fila silenciosa', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'Buscar dado', skill: 'busca', argumento: 'X', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'Registrar depois', skill: 'crm', argumento: 'Y', depende_de: null, urgencia: 'baixa' },
      ],
      alerta: null,
      summaryUpdate: 'Discutindo X.',
    }),
    skillsCardapio: '- busca: b\n- crm: c',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('falando sobre X');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].skill, 'busca');
  assert.equal(d.filaSilenciosa.length, 1);
  assert.equal(d.meetingSummary.trim(), 'Discutindo X.');
});

test('cadeia: aprovar resolve {{output_N}}; uma suggestion por vez', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'Buscar', skill: 'busca', argumento: 'Empresa Exemplo', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'Atualizar', skill: 'atualiza', argumento: '{{output_1}}', depende_de: 1, urgencia: 'alta' },
        { ordem: 3, proposta: 'Independente', skill: 'outra', argumento: 'Z', depende_de: null, urgencia: 'alta' },
      ],
      alerta: null,
      summaryUpdate: 's',
    }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1); // uma por vez

  const a1 = d.resolveDecision(suggestions[0].id, true);
  assert.equal(a1.skill, 'busca');
  d.recordResult(suggestions[0].id, 'dados do parceiro');
  assert.equal(suggestions.length, 2); // próxima da fila emitida
  const a2 = d.resolveDecision(suggestions[1].id, true);
  assert.equal(a2.argumento, 'dados do parceiro'); // {{output_1}} resolvido
  d.recordResult(suggestions[1].id, 'ok');
  assert.equal(suggestions.length, 3);
});

test('recusar N cancela dependentes transitivos, independentes seguem', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'A', skill: 'a', argumento: 'x', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'B', skill: 'b', argumento: '{{output_1}}', depende_de: 1, urgencia: 'alta' },
        { ordem: 3, proposta: 'C', skill: 'c', argumento: '{{output_2}}', depende_de: 2, urgencia: 'alta' },
        { ordem: 4, proposta: 'D', skill: 'd', argumento: 'w', depende_de: null, urgencia: 'alta' },
      ],
      alerta: null,
      summaryUpdate: 's',
    }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(d.resolveDecision(suggestions[0].id, false), null); // recusa A
  // B e C cancelados; próxima emitida é D
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[1].skill, 'd');
});

test('JSON inválido e erro do runFn não lançam', async () => {
  const bad = new Dispatcher({ runFn: async () => 'não é json', skillsCardapio: '' });
  await bad.handleChunk('x');
  const err = new Dispatcher({ runFn: async () => { throw new Error('timeout'); }, skillsCardapio: '' });
  await err.handleChunk('x');
  assert.ok(true);
});

test('alerta emite suggestion com urgencia alerta', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: 'Risco contratual sendo discutido', summaryUpdate: 's' }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'alerta');
  assert.equal(suggestions[0].skill, null);
});

test('coaching emite card passivo sem skill', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: null, coaching: 'Você revelou o preço cedo demais.', summaryUpdate: 's' }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'coaching');
  assert.equal(suggestions[0].skill, null);
  assert.equal(suggestions[0].proposta, 'Você revelou o preço cedo demais.');
});

test('dispensar card passivo libera o próximo feedback da fila', () => {
  const d = new Dispatcher({ runFn: reply({ acoes: [], summaryUpdate: 's' }), skillsCardapio: '' });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  d.enqueueCoaching('Primeiro feedback.');
  d.enqueueCoaching('Segundo feedback.');
  assert.equal(suggestions.length, 1);
  d.resolveDecision(suggestions[0].id, false);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[1].proposta, 'Segundo feedback.');
});

test('aprovar card passivo também não produz ação executável', () => {
  const d = new Dispatcher({ runFn: reply({ acoes: [], summaryUpdate: 's' }), skillsCardapio: '' });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  d.enqueueCoaching('Feedback informativo.');
  assert.equal(d.resolveDecision(suggestions[0].id, true), null);
  assert.equal(d.approved.size, 0);
});

test('insight emite card passivo com urgencia insight', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: null, insight: 'Empresa fundada em 1997, capital fechado.', summaryUpdate: 's' }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'insight');
  assert.equal(suggestions[0].skill, null);
});

test('pesquisa dispara skill pesquisa-empresa com argumento correto', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: null, pesquisa: 'Transcourier', summaryUpdate: 's' }),
    skillsCardapio: '- pesquisa-empresa: pesquisa pública',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].skill, 'pesquisa-empresa');
  assert.equal(suggestions[0].argumento, 'Transcourier');
  assert.equal(suggestions[0].urgencia, 'alta');
  assert.ok(suggestions[0].proposta.includes('Transcourier'));
});

test('deadline salva em deadlines e emite alerta', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: null, deadline: '2026-08-01: Envio do contrato assinado', summaryUpdate: 's' }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(d.deadlines.length, 1);
  assert.equal(d.deadlines[0], '2026-08-01: Envio do contrato assinado');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'alerta');
  assert.ok(suggestions[0].proposta.includes('PRAZO'));
});

test('tipoReuniao padrão é exploratória', () => {
  const d = new Dispatcher({ runFn: async () => '{}', skillsCardapio: '' });
  assert.equal(d.tipoReuniao, 'exploratória');
});

test('tipoReuniao personalizado é mantido', () => {
  const d = new Dispatcher({ runFn: async () => '{}', skillsCardapio: '', tipoReuniao: 'contratual' });
  assert.equal(d.tipoReuniao, 'contratual');
});

test('múltiplos cards na mesma janela são enfileirados sequencialmente', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [{ ordem: 1, proposta: 'Executar skill', skill: 'busca', argumento: 'x', depende_de: null, urgencia: 'alta' }],
      alerta: null,
      coaching: 'Fale menos.',
      insight: 'Empresa tem 500 funcionários.',
      summaryUpdate: 's',
    }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1); // apenas o primeiro emitido
  assert.equal(d.pendingQueue.length, 2); // coaching e insight na fila
});

test('chunks recebidos durante análise são preservados e processados em fila', async () => {
  const received = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const d = new Dispatcher({
    runFn: async (prompt) => {
      received.push(prompt);
      if (received.length === 1) await firstGate;
      return JSON.stringify({ acoes: [], alerta: null, summaryUpdate: `resumo ${received.length}` });
    },
    skillsCardapio: '',
  });
  const first = d.handleChunk('primeiro trecho');
  const second = d.handleChunk('segundo trecho');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(received.length, 2);
  assert.match(received[1], /segundo trecho/);
  assert.deepEqual(d.transcriptLog, ['primeiro trecho', 'segundo trecho']);
});

test('feedback do Coach entra na fila como card passivo', () => {
  const d = new Dispatcher({ runFn: async () => '{}', skillsCardapio: '' });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  d.enqueueCoaching('Reduza o ritmo e faça uma pausa.', { category: 'ritmo', source: 'métrica-local' });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'coaching');
  assert.equal(suggestions[0].category, 'ritmo');
  assert.equal(suggestions[0].source, 'métrica-local');
});

test('modo playbook usa prompt especializado e gera um único card acionável', async () => {
  let capturedPrompt = '';
  const d = new Dispatcher({
    runFn: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        intervencao: {
          tipo: 'pergunta',
          ato: 'Entendimento da integração',
          sugestao: 'Qual foi a última chamada que funcionou e o que ainda falta validar?',
          motivo: 'Transforma uma percepção genérica em evidência técnica verificável.',
          evidencia: 'O parceiro disse apenas que a integração está quase pronta.',
          confidence: 0.91,
        },
        summaryUpdate: 'O parceiro apresentou a solução e afirmou que a integração está quase pronta.',
      });
    },
    skillsCardapio: '',
    playbook: 'Confirme o estado real da integração antes de avançar.',
    now: () => 1_000,
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  await d.handleChunk('A integração está quase pronta, falta pouca coisa.');

  assert.match(capturedPrompt, /Confirme o estado real da integração/);
  assert.match(capturedPrompt, /escuta ativa/i);
  assert.doesNotMatch(capturedPrompt, /\bWPM\b|palavras por minuto|quantidade de palavras/i);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'copilot');
  assert.equal(suggestions[0].act, 'Entendimento da integração');
  assert.match(suggestions[0].rationale, /evidência técnica/);
  assert.match(suggestions[0].evidence, /quase pronta/);
  assert.equal(suggestions[0].confidence, 0.91);
  assert.equal(suggestions[0].expiresAt, 76_000);
  assert.equal(d.meetingSummary, 'O parceiro apresentou a solução e afirmou que a integração está quase pronta.');
});

test('modo playbook substitui o resumo por atualização canônica', async () => {
  const responses = [
    { intervencao: null, summaryUpdate: 'Primeiro estado canônico.' },
    { intervencao: null, summaryUpdate: 'Segundo estado canônico, já atualizado.' },
  ];
  const d = new Dispatcher({
    runFn: async () => JSON.stringify(responses.shift()),
    skillsCardapio: '',
    playbook: 'Roteiro',
  });

  await d.handleChunk('primeiro');
  await d.handleChunk('segundo');

  assert.equal(d.meetingSummary, 'Segundo estado canônico, já atualizado.');
  assert.doesNotMatch(d.meetingSummary, /Primeiro estado/);
});

test('modo playbook exige confiança, ato, sugestão, motivo e evidência', async () => {
  const responses = [
    {
      intervencao: {
        tipo: 'pergunta',
        ato: 'Qualificação',
        sugestao: 'Qual é o perfil ideal?',
        motivo: 'Esclarece o foco.',
        evidencia: 'O perfil não foi dito.',
        confidence: 0.74,
      },
      summaryUpdate: 's1',
    },
    {
      intervencao: {
        tipo: 'pergunta',
        ato: 'Qualificação',
        sugestao: 'Qual é o perfil ideal?',
        motivo: 'Esclarece o foco.',
        evidencia: '',
        confidence: 0.99,
      },
      summaryUpdate: 's2',
    },
  ];
  const d = new Dispatcher({
    runFn: async () => JSON.stringify(responses.shift()),
    skillsCardapio: '',
    playbook: 'Roteiro',
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  await d.handleChunk('primeiro');
  await d.handleChunk('segundo');

  assert.equal(suggestions.length, 0);
  assert.equal(d.meetingSummary, 's2');
});

test('modo playbook aplica cooldown global, dedupe e não cria backlog', async () => {
  let currentTime = 10_000;
  let calls = 0;
  const interventions = [
    {
      tipo: 'pergunta',
      ato: 'Qualificação',
      sugestao: 'Qual resultado define um piloto bem-sucedido?',
      motivo: 'Cria condição de satisfação.',
      evidencia: 'O piloto foi citado sem critério de sucesso.',
      confidence: 0.9,
    },
    {
      tipo: 'pergunta',
      ato: 'Modelo comercial',
      sugestao: 'Sobre qual base incide a comissão?',
      motivo: 'Evita compromisso comercial ambíguo.',
      evidencia: 'A comissão foi citada sem definir a base.',
      confidence: 0.93,
    },
    {
      tipo: 'pergunta',
      ato: 'Qualificação',
      sugestao: 'Qual resultado define um piloto bem-sucedido?',
      motivo: 'Cria condição de satisfação.',
      evidencia: 'O piloto segue sem critério.',
      confidence: 0.95,
    },
  ];
  const d = new Dispatcher({
    runFn: async () => {
      calls += 1;
      return JSON.stringify({
        intervencao: interventions.shift(),
        summaryUpdate: 'Resumo canônico.',
      });
    },
    skillsCardapio: '',
    playbook: 'Roteiro',
    cooldownMs: 75_000,
    ttlMs: 300_000,
    now: () => currentTime,
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  await d.handleChunk('piloto sem sucesso definido');
  assert.equal(suggestions.length, 1);

  currentTime += 76_000;
  await d.handleChunk('comissão sem base');
  assert.equal(suggestions.length, 1, 'card ativo impede backlog mesmo após o cooldown');
  assert.equal(calls, 1, 'não deve pagar uma chamada cujo card seria descartado');

  d.resolveDecision(suggestions[0].id, false);
  currentTime += 76_000;
  await d.handleChunk('piloto ainda sem critério');
  assert.equal(calls, 2);
  assert.equal(suggestions.length, 2, 'o contexto adiado deve ser analisado quando a fila estiver livre');
  assert.match(suggestions[1].proposta, /base incide a comissão/);
});

test('modo playbook não chama IA durante cooldown e preserva o trecho para a próxima análise', async () => {
  let currentTime = 1_000;
  const prompts = [];
  const responses = [
    {
      intervencao: {
        tipo: 'pergunta',
        ato: 'Qualificação',
        sugestao: 'Qual evidência comprova esse resultado?',
        motivo: 'Evita tratar afirmação como fato.',
        evidencia: 'O resultado foi citado sem prova.',
        confidence: 0.9,
      },
      summaryUpdate: 'Resultado citado sem evidência.',
    },
    { intervencao: null, summaryUpdate: 'A evidência foi apresentada.' },
  ];
  const d = new Dispatcher({
    runFn: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify(responses.shift());
    },
    skillsCardapio: '',
    playbook: 'Roteiro',
    cooldownMs: 75_000,
    ttlMs: 10_000,
    now: () => currentTime,
  });
  const shown = [];
  d.on('suggestion', (item) => shown.push(item));

  await d.handleChunk('Temos muito resultado.');
  d.resolveDecision(shown[0].id, false);
  currentTime += 30_000;
  await d.handleChunk('A prova é o estudo publicado.');
  assert.equal(prompts.length, 1);

  currentTime += 50_000;
  await d.handleChunk('Podemos seguir.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /A prova é o estudo publicado/);
  assert.match(prompts[1], /Podemos seguir/);
});

test('alerta do playbook usa urgência alerta e continua sendo passivo', async () => {
  const d = new Dispatcher({
    runFn: reply({
      intervencao: {
        tipo: 'alerta',
        ato: 'Próximos passos',
        sugestao: 'Antes de encerrar, podemos definir responsável e data para essa entrega?',
        motivo: 'Evita um compromisso sem dono.',
        evidencia: 'A entrega foi combinada sem responsável nem prazo.',
        confidence: 0.97,
      },
      summaryUpdate: 'Há uma entrega combinada sem responsável e prazo.',
    }),
    skillsCardapio: '',
    playbook: 'Roteiro',
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  await d.handleChunk('Depois alguém envia isso.');

  assert.equal(suggestions[0].urgencia, 'alerta');
  assert.equal(d.resolveDecision(suggestions[0].id, true), null);
  assert.equal(d.approved.size, 0);
});

test('emitNext descarta cards expirados antes de exibir o próximo', () => {
  let currentTime = 1_000;
  const d = new Dispatcher({
    runFn: async () => '{}',
    skillsCardapio: '',
    ttlMs: 500,
    now: () => currentTime,
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  d.enqueueCoaching('Primeiro.');
  d.enqueueCoaching('Segundo.');
  assert.equal(suggestions.length, 1);
  assert.equal(d.pendingQueue.length, 1);

  currentTime = 1_501;
  d.emitNext();

  assert.equal(d.active, null);
  assert.equal(d.pendingQueue.length, 0);
  assert.equal(suggestions.length, 1);
});

test('enqueueCoaching preserva metadados e evita feedback após intervenção recente do playbook', async () => {
  let currentTime = 5_000;
  const d = new Dispatcher({
    runFn: reply({
      intervencao: {
        tipo: 'proximo_passo',
        ato: 'Próximos passos',
        sugestao: 'Vamos sair com responsável, prazo e critério de conclusão.',
        motivo: 'Fecha o compromisso de forma verificável.',
        evidencia: 'O próximo passo foi dito sem definição.',
        confidence: 0.96,
      },
      summaryUpdate: 'Próximo passo ainda indefinido.',
    }),
    skillsCardapio: '',
    playbook: 'Roteiro',
    cooldownMs: 75_000,
    now: () => currentTime,
  });
  const suggestions = [];
  d.on('suggestion', (suggestion) => suggestions.push(suggestion));

  await d.handleChunk('Depois vemos quem faz.');
  d.resolveDecision(suggestions[0].id, false);
  d.enqueueCoaching('Defina quem fará a entrega.', {
    category: 'compromisso',
    source: 'coach',
    rationale: 'Falta um responsável.',
    act: 'Próximos passos',
    evidence: 'Foi dito "depois vemos".',
    confidence: 0.9,
    custom: 'preservado',
  });
  assert.equal(suggestions.length, 1, 'feedback concorrente deve ser descartado durante o cooldown');

  currentTime += 76_000;
  d.enqueueCoaching('Confirme também a data.', {
    category: 'compromisso',
    source: 'coach',
    rationale: 'Falta prazo.',
    act: 'Próximos passos',
    evidence: 'Nenhuma data foi citada.',
    confidence: 0.88,
    expiresAt: currentTime + 10_000,
    custom: 'preservado',
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[1].rationale, 'Falta prazo.');
  assert.equal(suggestions[1].act, 'Próximos passos');
  assert.equal(suggestions[1].evidence, 'Nenhuma data foi citada.');
  assert.equal(suggestions[1].confidence, 0.88);
  assert.equal(suggestions[1].custom, 'preservado');
  assert.equal(suggestions[1].expiresAt, currentTime + 10_000);
});

test('dispatcher aguarda contexto suficiente antes da primeira chamada paga', async () => {
  const prompts = [];
  const d = new Dispatcher({
    runFn: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ intervencao: null, summaryUpdate: 'Resumo.' });
    },
    skillsCardapio: '',
    playbook: 'Roteiro adaptativo',
    warmupWords: 8,
  });
  await d.handleChunk('pouco contexto agora');
  assert.equal(prompts.length, 0);
  await d.handleChunk('mais palavras para entender a conversa real');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /pouco contexto agora/);
});

test('dedupe semântico bloqueia reformulações sobre o mesmo tópico', async () => {
  let currentTime = 1_000;
  const responses = [
    {
      intervencao: { tipo: 'pergunta', ato: 'Indicadores', sugestao: 'Quem validará a divergência do indicador de conversão?', motivo: 'Falta dono.', evidencia: 'Os números divergem.', confidence: 0.95 },
      summaryUpdate: 'Indicador divergente.',
    },
    {
      intervencao: { tipo: 'pergunta', ato: 'Indicadores', sugestao: 'Além do prazo, quem fará a validação da divergência no indicador de conversão?', motivo: 'Falta dono.', evidencia: 'A divergência continua.', confidence: 0.96 },
      summaryUpdate: 'Indicador ainda divergente.',
    },
  ];
  const d = new Dispatcher({
    runFn: async () => JSON.stringify(responses.shift()),
    skillsCardapio: '',
    playbook: 'Roteiro',
    cooldownMs: 0,
    semanticDedupeMs: 600_000,
    now: () => currentTime,
  });
  const shown = [];
  d.on('suggestion', (item) => shown.push(item));
  await d.handleChunk('primeiro trecho');
  d.resolveDecision(shown[0].id, false);
  currentTime += 120_000;
  await d.handleChunk('segundo trecho');
  assert.equal(shown.length, 1);
});

test('dispatcher mantém quadro canônico para decisões e compromissos', async () => {
  const d = new Dispatcher({
    runFn: async () => JSON.stringify({
      intervencao: null,
      summaryUpdate: 'Fluxo definido; prazo ainda aberto.',
      stateUpdate: {
        decisoes: ['O fluxo usará voucher individual.'],
        pendencias: ['Definir prazo de lançamento.'],
        compromissos: [{ acao: 'Validar voucher', responsavel: 'Usuário', prazo: null }],
        riscos: ['Vazamento de voucher.'],
      },
    }),
    skillsCardapio: '',
    playbook: 'Roteiro',
  });
  const states = [];
  d.on('state', (state) => states.push(state));
  await d.handleChunk('Vamos usar vouchers individuais.');
  assert.equal(states.length, 1);
  assert.equal(d.liveState.decisoes[0], 'O fluxo usará voucher individual.');
  assert.equal(d.liveState.compromissos[0].responsavel, 'Usuário');
  assert.match(d.buildPrompt('novo trecho'), /QUADRO VIVO ATUAL/);
  assert.match(d.buildPrompt('novo trecho'), /voucher individual/);
});
