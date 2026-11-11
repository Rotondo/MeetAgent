import fs from 'node:fs';
import path from 'node:path';

export async function fetchFirefliesTranscripts(apiKey, { fetchFn = fetch, limit = 20 } = {}) {
  if (!apiKey) throw new Error('Configure a API Key do Fireflies.');
  const query = `query Transcripts($limit: Int) { transcripts(limit: $limit) { id title date duration participants organizer_email } }`;
  const response = await fetchFn('https://api.fireflies.ai/graphql', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { limit } }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors?.length) throw new Error(data.errors?.[0]?.message || `Fireflies HTTP ${response.status}`);
  return (data.data?.transcripts || []).map((item) => ({ ...item, source: 'fireflies' }));
}

export async function fetchFirefliesTranscript(apiKey, id, { fetchFn = fetch } = {}) {
  const query = `query Transcript($id: String!) { transcript(id: $id) { id title date participants sentences { speaker_name text start_time end_time } summary { overview action_items keywords } } }`;
  const response = await fetchFn('https://api.fireflies.ai/graphql', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { id } }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors?.length) throw new Error(data.errors?.[0]?.message || `Fireflies HTTP ${response.status}`);
  return data.data?.transcript || null;
}

export function scanLocalContext(folder, terms = [], { maxFiles = 12, maxChars = 30_000 } = {}) {
  if (!folder || !fs.existsSync(folder)) return [];
  const needles = terms.map((term) => String(term).toLocaleLowerCase('pt-BR')).filter((term) => term.length > 2);
  const allowed = new Set(['.md', '.txt', '.json', '.csv']);
  const found = [];
  const visit = (directory, depth = 0) => {
    if (depth > 2 || found.length >= maxFiles) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= maxFiles || entry.name.startsWith('.')) break;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (allowed.has(path.extname(entry.name).toLowerCase())) {
        const stat = fs.statSync(target);
        if (stat.size > 2_000_000) continue;
        const text = fs.readFileSync(target, 'utf8').slice(0, maxChars);
        const haystack = `${entry.name}\n${text}`.toLocaleLowerCase('pt-BR');
        if (!needles.length || needles.some((needle) => haystack.includes(needle))) found.push({ source: 'local-file', path: target, title: entry.name, text });
      }
    }
  };
  visit(folder);
  return found;
}

export function matchExternalMeeting(items, agenda) {
  if (!agenda) return [];
  const title = String(agenda.title || '').toLocaleLowerCase('pt-BR');
  const start = agenda.start ? Date.parse(agenda.start) : NaN;
  return items.map((item) => {
    const itemTitle = String(item.title || '').toLocaleLowerCase('pt-BR');
    const titleScore = title && itemTitle ? title.split(/\s+/).filter((word) => word.length > 3 && itemTitle.includes(word)).length : 0;
    const numericDate = Number(item.date);
    const itemDate = Number.isFinite(numericDate)
      ? (numericDate > 10_000_000_000 ? numericDate : numericDate * 1000)
      : Date.parse(item.date);
    const hours = Number.isFinite(start) && Number.isFinite(itemDate) ? Math.abs(start - itemDate) / 3_600_000 : Infinity;
    return { ...item, matchScore: titleScore * 2 + (hours <= 2 ? 5 : hours <= 24 ? 2 : 0) };
  }).filter((item) => item.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore);
}
