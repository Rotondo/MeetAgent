import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coach } from '../lib/coach.js';

const FAST_TEXT = 'Vamos revisar os casos pendentes agora porque precisamos definir responsáveis e prazos claros para cada parceiro.';

test('Coach emite alerta local quando a fala do microfone está rápida', () => {
  let current = 1_000_000;
  const coach = new Coach({
    now: () => current,
    fastWpm: 150,
    minWords: 12,
    minDurationSeconds: 4,
  });
  const feedback = [];
  coach.on('feedback', (item) => feedback.push(item));
  coach.addPersonal({ text: FAST_TEXT, at: current, duration: 5 });
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].category, 'ritmo');
  assert.match(feedback[0].text, /Reduza um pouco o ritmo/);
  assert.doesNotMatch(feedback[0].text, /\d|palavras por minuto|WPM/i);

  coach.addPersonal({ text: FAST_TEXT, at: current + 1_000, duration: 5 });
  assert.equal(feedback.length, 1); // cooldown evita repetição
});

test('Coach analisa fala pessoal e contexto em janela rápida', async () => {
  let current = 2_000_000;
  const prompts = [];
  const coach = new Coach({
    now: () => current,
    fastWpm: 999,
    runFn: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({
        coaching: 'Confirme: “Vocês conseguem assumir esse prazo até sexta?”',
        categoria: 'pergunta_pendente',
        ato: 'Próximos passos',
        motivo: 'O prazo foi perguntado, mas ainda não houve aceite explícito.',
        evidencia: 'A conversa citou entrega até sexta sem confirmação.',
        confidence: 0.91,
      });
    },
  });
  const feedback = [];
  coach.on('feedback', (item) => feedback.push(item));
  coach.addPersonal({ text: FAST_TEXT, at: current, duration: 12 });
  coach.addContext({ text: 'Vocês conseguem entregar até sexta? Precisamos confirmar o prazo.', at: current });
  await coach.review();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /FALAS RECENTES DO USUÁRIO/);
  assert.match(prompts[0], /conseguem entregar até sexta/);
  assert.match(prompts[0], /Camada global de Linguagem de Alta Performance/);
  assert.doesNotMatch(prompts[0], /\d+\s*(?:palavras por minuto|WPM)/i);
  assert.equal(feedback[0].category, 'pergunta_pendente');

  current += 1_000;
  coach.addPersonal({ text: FAST_TEXT, at: current, duration: 12 });
  await coach.review();
  assert.equal(feedback.length, 1); // mesma categoria continua em cooldown
});

test('Coach mantém a fala na fila após falha transitória e limita feedback a 120 caracteres', async () => {
  let attempts = 0;
  const coach = new Coach({
    fastWpm: 999,
    runFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('timeout');
      return JSON.stringify({
        coaching: 'Reformule a pergunta para confirmar claramente o responsável, o prazo e o critério de sucesso antes de avançar para o próximo assunto sem uma decisão explícita.',
        categoria: 'pergunta',
        ato: 'Próximos passos',
        motivo: 'O compromisso ainda está incompleto.',
        evidencia: 'Foram citadas ações sem dono e prazo.',
        confidence: 0.88,
      });
    },
  });
  const feedback = [];
  coach.on('feedback', (item) => feedback.push(item));
  coach.addPersonal({ text: FAST_TEXT, duration: 12 });
  await coach.review();
  await coach.review();
  assert.equal(attempts, 2);
  assert.equal(feedback.length, 1);
  assert.ok(feedback[0].text.length <= 120);
});

test('Coach rejeita conselho sem confiança, motivo e evidência suficientes', async () => {
  const coach = new Coach({
    fastWpm: 999,
    runFn: async () => JSON.stringify({
      coaching: 'Faça mais perguntas.',
      categoria: 'pergunta',
      confidence: 0.5,
    }),
  });
  const feedback = [];
  coach.on('feedback', (item) => feedback.push(item));
  coach.addPersonal({ text: FAST_TEXT, duration: 12 });
  await coach.review();
  assert.equal(feedback.length, 0);
});

test('Coach não faz chamada paga enquanto outra intervenção está recente', async () => {
  let current = 5_000;
  let calls = 0;
  const coach = new Coach({
    now: () => current,
    fastWpm: 999,
    runFn: async () => {
      calls += 1;
      return '{}';
    },
  });
  coach.addPersonal({ text: FAST_TEXT, at: current, duration: 12 });
  coach.suppressFor(75_000);
  await coach.review();
  assert.equal(calls, 0);
  current += 76_000;
  coach.addPersonal({ text: FAST_TEXT, at: current, duration: 12 });
  await coach.review();
  assert.equal(calls, 1);
});
