import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStore, saveStore, MODEL_PROFILES } from '../lib/projects.js';
import { upsertContext, deleteContext, getContext, upsertDirectional, migrateProjectsToContexts } from '../lib/contexts.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-')), 'projects.json');
}

test('loadStore retorna store vazio quando arquivo não existe', () => {
  const store = loadStore(tmpFile());
  assert.deepEqual(store, {
    settings: { opacity: 0.93, dispatcherModel: 'haiku', startBarCollapsed: false, audioMode: 'both', coachIntervalMs: 15_000, providerOrder: ['codex'], autoAnalysis: false,
      adaptiveMeeting: true, aiProfile: 'equilibrado', modelRouting: MODEL_PROFILES.equilibrado, localContextFolder: '' },
    contexts: [],
  });
});

test('rotas antigas são migradas para o catálogo dinâmico do Codex', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ settings: { modelRouting: { observer: { primary: 'openai:gpt-5-mini' }, closing: { primary: 'gemini:gemini-2.5-pro' } } } }));
  const store = loadStore(file);
  assert.equal(store.settings.modelRouting.observer.primary, 'codex:auto');
  assert.equal(store.settings.modelRouting.closing.primary, 'codex:auto');
});

test('loadStore preserva settings extras salvos (opacity, dispatcherModel)', () => {
  const file = tmpFile();
  const store = loadStore(file);
  store.settings.opacity = 0.75;
  store.settings.dispatcherModel = 'sonnet';
  store.settings.audioMode = 'microphone';
  saveStore(store, file);
  const loaded = loadStore(file);
  assert.equal(loaded.settings.opacity, 0.75);
  assert.equal(loaded.settings.dispatcherModel, 'sonnet');
  assert.equal(loaded.settings.audioMode, 'microphone');
});

test('migra projetos legados para contextos com direcional ativo', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ projects: [{ name: 'Liderança', path: 'C:/x', skills: ['a'] }] }));
  const store = loadStore(file);
  assert.equal(store.contexts[0].name, 'Liderança');
  assert.equal(store.contexts[0].directions[0].name, 'Condução geral');
  assert.equal(store.contexts[0].directions[0].status, 'ativo');
});

test('migração preserva o direcional homônimo de Apresentação de Soluções', () => {
  const store = migrateProjectsToContexts([{ id: 'solucoes', name: 'Apresentação de Soluções' }]);
  assert.equal(store[0].directions[0].id, 'apresentacao-de-solucoes');
  assert.equal(store[0].directions[0].name, 'Apresentação de Soluções');
});

test('upsert + save + load de contexto e direcional', () => {
  const file = tmpFile();
  let store = loadStore(file);
  store = upsertContext(store, { name: 'parcerias', path: 'C:/x/PRM', skills: ['a', 'b'], directions: [] });
  store = upsertDirectional(store, 'parcerias', { name: 'Apresentação', status: 'rascunho', packageMarkdown: '# Direcional' });
  saveStore(store, file);
  const loaded = loadStore(file);
  assert.equal(getContext(loaded, 'parcerias').path, 'C:/x/PRM');
  assert.deepEqual(getContext(loaded, 'parcerias').skills, ['a', 'b']);
  assert.equal(getContext(loaded, 'parcerias').directions[0].status, 'rascunho');
});

test('upsert substitui contexto de mesmo nome e delete remove', () => {
  let store = loadStore(tmpFile());
  store = upsertContext(store, { name: 'prm', path: 'C:/a', skills: [], directions: [] });
  store = upsertContext(store, { name: 'prm', path: 'C:/b', skills: [], directions: [] });
  assert.equal(store.contexts.length, 1);
  assert.equal(getContext(store, 'prm').path, 'C:/b');
  store = deleteContext(store, 'prm');
  assert.equal(getContext(store, 'prm'), null);
});
