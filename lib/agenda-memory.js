import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicSave(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}
export function loadAgendas(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, agendas: [], records: [] };
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (store.schemaVersion !== 1 || !Array.isArray(store.agendas) || !Array.isArray(store.records)) throw new Error('Arquivo de agendas inválido; preservado para recuperação.');
  return store;
}
export function saveAgenda(store, input) {
  if (!String(input?.title || '').trim() || !String(input?.scope || '').trim()) throw new Error('Preencha título e iniciativa/série.');
  const agenda = { id: input.id || randomUUID(), title: String(input.title).trim().slice(0, 160), scope: String(input.scope).trim().toLocaleLowerCase('pt-BR').slice(0, 160),
    objective: String(input.objective || '').slice(0, 1000), participants: String(input.participants || '').slice(0, 500),
    start: input.start && Number.isFinite(Date.parse(input.start)) ? new Date(input.start).toISOString() : null,
    end: input.end && Number.isFinite(Date.parse(input.end)) ? new Date(input.end).toISOString() : null,
    status: input.status === 'completed' ? 'completed' : 'planned',
    source: String(input.source || 'manual').slice(0, 40), externalId: String(input.externalId || '').slice(0, 300) || null,
    description: String(input.description || '').slice(0, 4000), meetingUrl: String(input.meetingUrl || '').slice(0, 1000),
    suggestedScope: String(input.suggestedScope || '').slice(0, 160) || null,
    firefliesTranscriptId: String(input.firefliesTranscriptId || '').slice(0, 300) || null,
    firefliesTranscriptTitle: String(input.firefliesTranscriptTitle || '').slice(0, 300) || null };
  return { ...store, agendas: [...store.agendas.filter(a => a.id !== agenda.id), agenda] };
}

export function suggestInitiative(store, input) {
  const normalize = (value) => String(value || '').toLocaleLowerCase('pt-BR').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ');
  const words = new Set(normalize(`${input?.title || ''} ${input?.description || ''}`).split(/\s+/).filter((word) => word.length > 3));
  const people = new Set(normalize(input?.participants || '').split(/\s+/).filter((word) => word.includes('@') || word.length > 5));
  const scopes = [...new Set([...(store.agendas || []).map((item) => item.scope), ...(store.records || []).map((item) => item.scope)].filter(Boolean))];
  const ranked = scopes.map((scope) => {
    const scopeWords = normalize(scope).split(/\s+/).filter((word) => word.length > 3);
    const textScore = scopeWords.filter((word) => words.has(word)).length * 2;
    const related = (store.agendas || []).filter((item) => item.scope === scope);
    const peopleScore = related.some((item) => normalize(item.participants).split(/\s+/).some((word) => people.has(word))) ? 2 : 0;
    return { scope, score: textScore + peopleScore };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 2 ? ranked[0] : null;
}
export function correctMemory(store, sessionId, itemId, changes, now = new Date()) {
  const record = store.records.find(r => r.sessionId === sessionId);
  const item = record?.items.find(i => i.id === itemId);
  if (!item) throw new Error('Registro não encontrado.');
  const patch = {};
  if (typeof changes.text === 'string' && changes.text.trim()) patch.text = changes.text.trim().slice(0, 500);
  if (typeof changes.owner === 'string') patch.owner = changes.owner.trim().slice(0, 120) || null;
  if (typeof changes.due === 'string') patch.due = changes.due.trim().slice(0, 100) || null;
  if (['open', 'resolved', 'retracted', 'confirmed'].includes(changes.status)) patch.status = changes.status;
  return { ...store, records: store.records.map(r => r !== record ? r : { ...r, items: r.items.map(i => i !== item ? i : {
    ...i, ...patch, review: 'approved', corrections: [...(i.corrections || []), { at: now.toISOString(), source: 'user', previous: { text: i.text, owner: i.owner, due: i.due, status: i.status } }]
  }) }) };
}
export function importLegacyReport(store, { markdown, filename, agenda }) {
  if (!agenda) throw new Error('Escolha a agenda/iniciativa à qual este relatório pertence.');
  const sessionId = `legacy-${filename}`;
  if (store.records.some(r => r.sessionId === sessionId)) throw new Error('Este relatório já foi importado.');
  const section = markdown.split('## Próximos passos')[1]?.split(/\n## /)[0] || '';
  const items = section.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^- (.+?) \(responsável: (.*?), prazo: (.*?)\)(?: — evidência: (.*))?$/);
    if (!match || !match[4]) return [];
    return [{ id: `legacy-${line.length}-${section.indexOf(line)}`, kind: 'commitments', text: match[1], status: 'open',
      owner: match[2] === '—' ? null : match[2], due: match[3] === '—' ? null : match[3], review: 'unreviewed',
      evidence: { turnId: filename, quote: match[4], channel: 'legacy-report', at: null } }];
  });
  if (!items.length) throw new Error('Relatório sem compromissos com evidência. Preservado; consulte o original para revisão.');
  return { ...store, records: [...store.records, { sessionId, title: filename, scope: agenda.scope, endedAt: null,
    source: 'legacy-report-not-verified-transcript', items, followUp: 'Relatório anterior importado. Revise as evidências antes de aprovar a memória.', history: [], feedback: [] }] };
}
export function reviewRecord(store, sessionId, selectedIds) {
  const record = store.records.find(r => r.sessionId === sessionId);
  if (!record) throw new Error('Reunião não encontrada.');
  const ids = new Set(selectedIds);
  return { ...store, records: store.records.map(r => r !== record ? r : { ...r, reviewedAt: new Date().toISOString(),
    items: r.items.map(i => ({ ...i, review: ids.has(i.id) ? 'approved' : 'rejected' })) }) };
}
export function buildBrief(store, agenda) {
  if (!agenda) return 'Escolha ou prepare uma agenda para recuperar o histórico da iniciativa.';
  const records = store.records.filter(r => r.scope === agenda.scope).slice(-5);
  const items = records.flatMap(r => r.items.filter(i => i.review === 'approved' && !['resolved', 'retracted'].includes(i.status)).map(i => ({ ...i, source: r.title })));
  const pending = items.filter(i => ['commitments', 'openQuestions'].includes(i.kind));
  const decisions = items.filter(i => i.kind === 'decisions');
  return [`${agenda.title}\nResultado desejado: ${agenda.objective || 'Ainda não definido.'}\nParticipantes: ${agenda.participants || 'Não informados.'}`,
    '\nAcordos anteriores aprovados:', ...decisions.map(i => `- ${i.text} (${i.source})`),
    '\nPendências para retomar:', ...pending.map(i => `- ${i.text} — ${i.owner || 'dono não confirmado'}; ${i.due || 'sem prazo'} (${i.source})`),
    !items.length ? '\nSem memória aprovada para esta iniciativa. O agente usará apenas o briefing e esta conversa.' : '',
    records.some(r => r.items.some(i => i.review === 'unreviewed')) ? '\nHá registros anteriores aguardando sua revisão.' : ''].filter(Boolean).join('\n');
}
export function archiveMeeting(store, { ledger, agenda, title, followUp, history = [], feedback = [] }) {
  const record = { sessionId: ledger.sessionId, title: agenda?.title || title, scope: agenda?.scope || null,
    endedAt: new Date().toISOString(), items: ledger.items, followUp, history, feedback };
  return { ...store, agendas: store.agendas.map(a => a.id === agenda?.id ? { ...a, status: 'completed' } : a),
    records: [...store.records.filter(r => r.sessionId !== record.sessionId), record] };
}
