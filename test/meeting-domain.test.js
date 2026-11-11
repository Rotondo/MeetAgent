import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptMeetingModel,
  agendaPlaybook,
  buildMeetingModel,
  inferCoverage,
  inferMeetingLens,
  inferAdaptiveMeeting,
  resolveMeetingLens,
  updateCoverage,
  validateIntervention,
} from '../lib/meeting-domain.js';

test('objetivos oferecidos pela interface não caem silenciosamente em apresentação', () => {
  assert.equal(resolveMeetingLens('alinhamento'), 'alinhamento');
  assert.equal(resolveMeetingLens('decisão'), 'decisão');
  assert.equal(resolveMeetingLens('execução'), 'execução');
  assert.equal(resolveMeetingLens('feedback'), 'feedback');
  assert.equal(resolveMeetingLens('escuta/descoberta'), 'descoberta');
  assert.equal(resolveMeetingLens('objetivo desconhecido'), 'alinhamento');
});

test('alinhamento interno gera quadro de decisões, pendências, donos e prazos', () => {
  const model = buildMeetingModel({ objective: 'alinhamento' });
  assert.equal(model.activeLens, 'alinhamento');
  assert.ok(model.agenda.some((item) => item.id === 'decisoes'));
  assert.ok(model.agenda.some((item) => item.id === 'responsaveis'));
  assert.ok(model.agenda.some((item) => item.id === 'prazos'));
  assert.doesNotMatch(agendaPlaybook(model), /ICP|Precificação/);
});

test('motor adapta uma apresentação configurada quando a fala revela alinhamento interno', () => {
  const inference = inferMeetingLens({
    currentLens: 'apresentação',
    objective: 'apresentação',
    audience: 'interna',
    text: 'Vamos revisar status, prioridades, pendências, bloqueios, responsáveis, prazos e próximos passos desta semana.',
  });
  assert.equal(inference.changed, true);
  assert.equal(inference.lens, 'alinhamento');
  const adapted = adaptMeetingModel(buildMeetingModel({ objective: 'apresentação' }), inference.lens, 100);
  assert.equal(adapted.activeLens, 'alinhamento');
  assert.ok(adapted.coverage.pendencias);
  assert.equal(adapted.adaptedAt, 100);
});

test('agenda de apresentação começa com cobertura local e detecta tema mencionado', () => {
  const model = buildMeetingModel({ objective: 'apresentação' });
  assert.ok(model.agenda.some((item) => item.id === 'precificacao'));
  const next = inferCoverage(model, 'Vamos discutir a precificação e as condições comerciais.');
  assert.equal(next.coverage.precificacao.status, 'em progresso');
  assert.equal(model.coverage.precificacao.status, 'não abordado');
});

test('cobertura só aceita estados definidos', () => {
  const model = buildMeetingModel({ objective: 'apresentação' });
  assert.equal(updateCoverage(model, 'contrato', 'validado').coverage.contrato.status, 'validado');
  assert.equal(updateCoverage(model, 'contrato', 'inventado').coverage.contrato.status, 'não abordado');
});

test('intervenção sem evidência, impacto ou frase pronta é rejeitada', () => {
  assert.equal(validateIntervention({ tipo: 'pergunta', sugestao: 'Pergunte algo', ato: 'Preço', confidence: 0.95 }), null);
  const valid = validateIntervention({
    tipo: 'pergunta', sugestao: 'Qual condição comercial precisa constar no contrato?', ato: 'Contrato',
    evidencia: 'A comissão foi mencionada sem condição.', impacto: 'Evita avançar sem base comercial.', confidence: 0.9,
  }, { now: 100 });
  assert.equal(valid.proposta, 'Qual condição comercial precisa constar no contrato?');
  assert.equal(valid.expiresAt, 45100);
});

test('modo adaptativo reconhece apresentação e usuário ouvinte', () => {
  const inferred = inferAdaptiveMeeting({ objective: 'decisão', meetingWords: 800, microphoneWords: 12, participantCount: 6,
    text: 'Vou apresentar o novo relatório e explicar o material. A nova rotina começa na próxima semana.' });
  assert.equal(inferred.mode, 'apresentacao');
  assert.equal(inferred.role, 'ouvinte');
  assert.equal(inferred.changed, true);
  assert.ok(inferred.confidence >= 0.7);
});
