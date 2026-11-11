// Pure, replayable state. Every accepted fact points to a real transcript turn.
export const KINDS = ['facts', 'announcements', 'proposals', 'hypotheses', 'decisions', 'commitments', 'openQuestions', 'risks', 'objections'];

function normalizedWords(value) {
  return String(value || '').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 2);
}

function isLowValue(text, quote) {
  const summary = String(text || '').trim().toLocaleLowerCase('pt-BR');
  if (/^(tchau|obrigad[oa]s?|bom dia|boa tarde|boa noite|ate mais|despedida)[!. ]*$/.test(summary)) return true;
  return normalizedWords(text).length < 2;
}

function similar(left, right) {
  const a = new Set(normalizedWords(left));
  const b = new Set(normalizedWords(right));
  if (!a.size || !b.size) return false;
  const overlap = [...a].filter((word) => b.has(word)).length;
  return overlap / Math.min(a.size, b.size) >= 0.75;
}
export function createLedger(sessionId) {
  return { sessionId, version: 0, turns: [], items: [], phase: 'exploring' };
}
export function addTurn(ledger, { text, at = Date.now(), channel = 'meeting' }) {
  if (!String(text || '').trim()) return ledger;
  return { ...ledger, turns: [...ledger.turns, { id: `t${ledger.turns.length + 1}`, text: String(text).trim(), at, channel }] };
}
export function applyOperations(ledger, operations) {
  const items = ledger.items.map(item => ({ ...item }));
  const accepted = [];
  for (const op of Array.isArray(operations) ? operations.slice(0, 30) : []) {
    if (!op || !KINDS.includes(op.kind) || typeof op.text !== 'string' || !op.text.trim()) continue;
    const turn = ledger.turns.find(t => t.id === op.turnId);
    const quote = String(op.quote || '').trim();
    if (!turn || quote.length < 8 || !turn.text.includes(quote)) continue;
    const existing = op.id ? items.find(i => i.id === op.id) : null;
    if (op.id && !existing) continue;
    if (!existing && isLowValue(op.text, quote)) continue;
    if (!['open', 'resolved', 'retracted', 'confirmed'].includes(op.status)) continue;
    // A quote validates provenance, not truth: decisions/commitments require explicit language.
    const terminal = ['resolved', 'retracted'].includes(op.status);
    if (!existing && terminal) continue;
    if (op.kind === 'commitments' && !terminal && (!/(vou |vamos |enviarei|farei|me comprometo|eu assumo|combinado|ficou com)/i.test(quote)
      || /(?:não|talvez|poderia|se der|quem)\s+(?:eu\s+)?(?:vou|vamos|enviarei|farei)|(?:vou|vamos)\s+ver\s+se/i.test(quote))) continue;
    if (op.kind === 'decisions' && !terminal && (!/(decid|combinado|aprovad|fechamos|vamos (seguir|usar|adotar|fazer)|ficou definido)/i.test(quote)
      || /não\s+(?:foi\s+)?(?:decid|combinado|aprovad)|ainda não/i.test(quote))) continue;
    if (op.kind === 'announcements' && !terminal && !/(a partir|come[cç]a|passa a|vai funcionar|estar[aá] dispon[ií]vel|nova rotina|foi implementad)/i.test(quote)) continue;
    if (op.kind === 'proposals' && !terminal && !/(sugir|podemos|poderia|ideia|proponho|testar|vale (a pena|tentar)|quem sabe)/i.test(quote)) continue;
    const ownerQuote = String(op.ownerQuote || '');
    const owner = op.owner && ownerQuote.length >= 3 && quote.includes(ownerQuote)
      && (ownerQuote.includes(op.owner) || (op.owner === 'Usuário' && turn.channel === 'microphone' && /\beu\b|\bvou\b/i.test(ownerQuote))) ? String(op.owner) : null;
    const due = op.due && quote.includes(String(op.due)) ? String(op.due) : null;
    const duplicate = !existing && items.find(i => i.kind === op.kind && similar(i.text, op.text));
    if (duplicate) continue;
    const item = { id: existing?.id || `i${items.length + 1}`, kind: existing?.kind || op.kind, text: op.text.trim().slice(0, 500),
      status: op.status, owner, due, evidence: { turnId: turn.id, quote, at: turn.at, channel: turn.channel },
      updatedAt: turn.at, review: 'unreviewed' };
    if (existing) items[items.indexOf(existing)] = item; else items.push(item);
    accepted.push(item);
  }
  return { ledger: { ...ledger, items, version: ledger.version + (accepted.length ? 1 : 0) }, accepted };
}
export function ledgerBoard(ledger) {
  const active = ledger.items.filter(i => !['resolved', 'retracted'].includes(i.status));
  const format = i => `${i.text}${i.kind === 'commitments' ? ` — ${i.owner || 'responsável não confirmado'} · ${i.due || 'sem prazo'}` : ''} [${i.evidence.turnId}]`;
  return { decisoes: active.filter(i => i.kind === 'decisions').map(format),
    anuncios: active.filter(i => i.kind === 'announcements').map(format),
    compromissos: active.filter(i => i.kind === 'commitments').map(format),
    propostas: active.filter(i => i.kind === 'proposals').map(format),
    pendencias: active.filter(i => ['openQuestions', 'objections'].includes(i.kind)).map(format),
    riscos: active.filter(i => i.kind === 'risks').map(format) };
}
export function followUp(ledger) {
  const board = ledgerBoard(ledger);
  return ['Rascunho para revisão — nada foi enviado.', ...Object.entries(board).flatMap(([name, rows]) => rows.length ? [`\n${name}:`, ...rows.map(r => `- ${r}`)] : []),
    '\nConfiram se este registro representa o combinado. Itens sem responsável ou prazo continuam em aberto.'].join('\n');
}
