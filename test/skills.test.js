import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSkills, buildCardapio } from '../lib/skills.js';

function makeProject(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-skills-'));
  for (const [name, description] of skills) {
    const dir = path.join(root, '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\ncorpo`,
    );
  }
  return root;
}

test('scanSkills lê name/description do frontmatter', () => {
  const root = makeProject([['atualiza-crm', 'Atualiza o CRM'], ['busca-dado', 'Busca dado no banco']]);
  const found = scanSkills(root).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(found, [
    { name: 'atualiza-crm', description: 'Atualiza o CRM' },
    { name: 'busca-dado', description: 'Busca dado no banco' },
  ]);
});

test('scanSkills retorna [] quando não há pasta de skills', () => {
  assert.deepEqual(scanSkills(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-empty-'))), []);
});

test('buildCardapio formata e filtra por habilitadas', () => {
  const skills = [{ name: 'a', description: 'faz A' }, { name: 'b', description: 'faz B' }];
  assert.equal(buildCardapio(skills, null), '- a: faz A\n- b: faz B');
  assert.equal(buildCardapio(skills, ['b']), '- b: faz B');
});
