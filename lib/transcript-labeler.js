const STOPWORDS = new Set([
  'a', 'as', 'o', 'os', 'e', 'é', 'de', 'da', 'das', 'do', 'dos', 'em', 'no',
  'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'que', 'pra', 'para', 'por',
  'com', 'se', 'eu', 'voce', 'voces', 'ele', 'ela', 'isso', 'ai', 'ne', 'ta',
]);

function tokens(text) {
  const normalized = String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = normalized.filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return meaningful.length >= 2 ? meaningful : normalized;
}

function overlapScore(left, right) {
  const leftTokens = tokens(left);
  const rightSet = new Set(tokens(right));
  if (!leftTokens.length || !rightSet.size) return 0;
  const matches = leftTokens.filter((token) => rightSet.has(token)).length;
  return matches / leftTokens.length;
}

function segmentTime(segment) {
  const value = Number(segment?.receivedAt ?? segment?.at);
  return Number.isFinite(value) ? value : 0;
}

export function buildLabeledTranscript(
  meetingSegments = [],
  microphoneSegments = [],
  {
    audioMode = 'both',
    personalLabel = 'Usuário',
    otherLabel = 'Interlocutor',
    matchWindowMs = 8_000,
    matchThreshold = 0.45,
  } = {},
) {
  const meetings = meetingSegments
    .map((segment) => (typeof segment === 'string' ? { text: segment } : segment))
    .filter((segment) => segment?.text);
  const microphone = microphoneSegments
    .map((segment) => (typeof segment === 'string' ? { text: segment } : segment))
    .filter((segment) => segment?.text);
  const lines = [];
  let previous = '';

  for (const segment of meetings) {
    const currentTime = segmentTime(segment);
    let label = audioMode === 'microphone' ? personalLabel : otherLabel;
    if (audioMode === 'both' && microphone.length) {
      const nearby = microphone.filter((candidate) => (
        Math.abs(segmentTime(candidate) - currentTime) <= matchWindowMs
      ));
      const microphoneText = nearby.map((candidate) => candidate.text).join(' ');
      if (overlapScore(segment.text, microphoneText) >= matchThreshold) label = personalLabel;
    }
    const normalized = `${label}:${tokens(segment.text).join(' ')}`;
    if (normalized === previous) continue;
    previous = normalized;
    lines.push(`[${label}] ${String(segment.text).trim()}`);
  }
  return lines.join('\n');
}

export { overlapScore };
