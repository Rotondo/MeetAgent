export const OUTCOMES = ['usada', 'útil', 'óbvia', 'errada', 'atrasada', 'dispensada', 'ignorada'];
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = s => new Set(norm(s).split(/\W+/).filter(w => w.length > 3));
export function similar(a, b) {
  const x = tokens(a), y = tokens(b);
  return x.size && y.size ? [...x].filter(w => y.has(w)).length / Math.min(x.size, y.size) : 0;
}
export function gateCandidate(candidate, { ledger, history = [], critique, now = Date.now(), mode = 'protect', manual = false }) {
  const reject = reason => ({ approved: false, reason });
  if (!candidate || typeof candidate.say !== 'string' || candidate.say.length < 12 || candidate.say.length > 240) return reject('formato');
  if (/^(usuário[, :]|defina\b|confirme\b|alinhe\b|esclareça\b|reduza\b)/i.test(candidate.say)) return reject('instrução genérica');
  if (!candidate.whyNow || !candidate.riskIfSilent || !candidate.topicKey) return reject('sem justificativa');
  const evidence = (candidate.evidenceIds || []).map(id => ledger.items.find(i => i.id === id));
  if (!evidence.length || evidence.some(i => !i || ['resolved', 'retracted'].includes(i.status))) return reject('sem evidência ativa');
  if (!manual && evidence.every(i => now - i.evidence.at > 120_000)) return reject('evidência antiga');
  if (candidate.target !== 'self') return reject('destinatário incerto');
  if (!manual) {
    if (candidate.type === 'closing') {
      if (ledger.phase !== 'closing' || !evidence.some(i => i.kind === 'commitments' && (!i.owner || !i.due))) return reject('fechamento sem lacuna');
    } else {
      if (candidate.type !== 'risk') return reject('pergunta exploratória fica sob demanda');
      const quotes = candidate.conflictQuotes;
      if (!Array.isArray(quotes) || new Set(quotes).size < 2 || !quotes.every(q => typeof q === 'string' && q.length >= 12 && ledger.turns.some(t => t.text.includes(q)))) return reject('risco sem duas evidências concretas');
      if (!candidate.say.trim().endsWith('?')) return reject('alerta sem pergunta acionável');
      if (quotes.some(quote => similar(candidate.say, quote) >= 0.72)) return reject('apenas repete a evidência');
    }
  }
  if (history.some(h => h.topicKey === candidate.topicKey || similar(h.say, candidate.say) >= 0.65)) return reject('repetida');
  if (ledger.turns.slice(-12).some(t => t.text.includes('?') && similar(t.text, candidate.say) >= 0.7)) return reject('já perguntada');
  if (!manual && ledger.phase !== 'closing' && /respons[aá]vel|prazo|quem (vai|fica)/i.test(candidate.say) && candidate.type !== 'risk') return reject('administração prematura');
  const automatic = history.filter(h => !h.manual);
  if (!manual && mode === 'silent') return reject('modo silencioso');
  if (!manual && automatic.length >= (mode === 'coach' ? 5 : 3)) return reject('orçamento de atenção');
  if (!manual && automatic.length && now - automatic.at(-1).at < 240_000) return reject('intervalo de atenção');
  const keys = ['specificity', 'novelty', 'relevance', 'timing', 'speakability', 'evidence', 'impact', 'reliability'];
  if (!critique || critique.reject === true || !keys.every(k => Number.isInteger(critique[k]) && critique[k] >= 0 && critique[k] <= 2)) return reject('crítica inválida');
  if (['novelty', 'timing', 'speakability', 'evidence', 'reliability'].some(k => critique[k] === 0)) return reject('crítica insuficiente');
  const score = keys.reduce((sum, k) => sum + critique[k], 0);
  if (!manual && (critique.impact < 2 || critique.evidence < 2 || critique.reliability < 2)) return reject('não justifica interrupção');
  return score >= (manual ? 12 : 14) ? { approved: true, score } : reject('baixo valor');
}
