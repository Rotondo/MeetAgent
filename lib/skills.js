import fs from 'node:fs';
import path from 'node:path';

export function scanSkills(projectPath) {
  if (!projectPath) return [];
  const skillsDir = path.join(projectPath, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name;
    const description = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const meta = (key, fallback = '') => fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? fallback;
    const hasMetadata = ['type', 'lenses', 'input', 'estimated_seconds', 'requires_approval'].some((key) => new RegExp(`^${key}:`, 'm').test(fm?.[1] ?? ''));
    if (!hasMetadata) { result.push({ name, description }); continue; }
    const type = meta('type', 'acao-externa').toLowerCase();
    result.push({ name, description, type: ['analise', 'pesquisa', 'acao-externa'].includes(type) ? type : 'acao-externa', lenses: meta('lenses').split(',').map((item) => item.trim()).filter(Boolean), input: meta('input'), estimatedSeconds: Number(meta('estimated_seconds', '0')) || null, requiresApproval: meta('requires_approval', 'true') !== 'false' });
  }
  return result;
}

export function buildCardapio(skills, enabledNames = null) {
  const filtered = enabledNames ? skills.filter((s) => enabledNames.includes(s.name)) : skills;
  return filtered.map((s) => `- ${s.name}${s.type ? ` (${s.type})` : ''}: ${s.description}`).join('\n');
}
