import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ profiles: [] });
function safe(value) { return String(value ?? '').trim(); }
function key(profile) { return `${safe(profile.company).toLowerCase()}|${safe(profile.person).toLowerCase()}`; }

export function loadRelationshipMemory(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed?.profiles) ? parsed : EMPTY();
  } catch { return EMPTY(); }
}

export function upsertRelationship(memory, input, now = new Date()) {
  const profile = {
    id: input.id || key(input) || `profile-${now.getTime()}`,
    company: safe(input.company), person: safe(input.person), role: safe(input.role), influence: safe(input.influence),
    signals: Array.isArray(input.signals) ? input.signals.map(safe).filter(Boolean) : [],
    hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses.map(safe).filter(Boolean) : [],
    openQuestions: Array.isArray(input.openQuestions) ? input.openQuestions.map(safe).filter(Boolean) : [],
    sources: Array.isArray(input.sources) ? input.sources.filter((source) => source?.url && source?.title) : [],
    updatedAt: now.toISOString(), origin: input.origin || 'meeting-agent',
  };
  const profiles = [...(memory?.profiles ?? [])];
  const index = profiles.findIndex((item) => key(item) === key(profile));
  if (index >= 0) profiles[index] = { ...profiles[index], ...profile };
  else profiles.push(profile);
  return { profiles };
}

export function saveRelationshipMemory(memory, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf8');
  return memory;
}

// A transcrição pode sugerir nomes incorretos. Somente a interface chama esta
// função depois de uma confirmação explícita do usuário.
export function confirmRelationship(memory, candidate, filePath, now = new Date()) {
  return saveRelationshipMemory(upsertRelationship(memory, { ...candidate, confirmed: true }, now), filePath);
}

export function deleteRelationship(memory, id) {
  return { profiles: (memory?.profiles ?? []).filter((profile) => profile.id !== id) };
}
