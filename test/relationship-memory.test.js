import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertRelationship, deleteRelationship } from '../lib/relationship-memory.js';

test('perfil profissional só entra na memória pela operação explícita de upsert', () => {
  const memory = upsertRelationship({ profiles: [] }, { company: 'Empresa X', person: 'Joana', role: 'Diretora', sources: [{ title: 'Site', url: 'https://example.com' }] });
  assert.equal(memory.profiles.length, 1);
  assert.equal(deleteRelationship(memory, memory.profiles[0].id).profiles.length, 0);
});
