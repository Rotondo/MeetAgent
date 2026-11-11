import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CredentialStore } from '../lib/credential-store.js';

test('CredentialStore salva criptografado, carrega e remove', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-secret-')), 'key');
  const store = new CredentialStore({
    filePath,
    encrypt: (value) => Buffer.from(`enc:${value}`),
    decrypt: (value) => value.toString().replace('enc:', ''),
  });
  store.save('segredo');
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'enc:segredo');
  assert.equal(store.load(), 'segredo');
  store.clear();
  assert.equal(store.has(), false);
});

test('CredentialStore rejeita armazenamento inseguro', () => {
  const filePath = path.join(os.tmpdir(), 'nao-criar-chave');
  const store = new CredentialStore({ filePath, encrypt: () => Buffer.alloc(0), decrypt: () => '', available: () => false });
  assert.throws(() => store.save('x'), /indisponível/);
});
