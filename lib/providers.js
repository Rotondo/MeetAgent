import config from './config.js';

function parseCodexTarget(target) {
  const value = String(target || 'codex:auto');
  return value.startsWith('codex:') ? value.slice('codex:'.length) : value;
}

function classifyCodexFailure(error) {
  const code = error?.code || 'CODEX_ERROR';
  if (code === 'CODEX_AUTH_REQUIRED') return { kind: 'auth', cooldownMs: 30_000 };
  if (code === 'CODEX_TIMEOUT') return { kind: 'timeout', cooldownMs: 45_000 };
  if (/usage.?limit|quota|rate.?limit/i.test(`${code} ${error?.message || ''}`)) return { kind: 'quota', cooldownMs: 5 * 60_000 };
  if (/model|unavailable|not found|unsupported/i.test(error?.message || '')) return { kind: 'model-unavailable', cooldownMs: 60 * 60_000 };
  return { kind: 'transient', cooldownMs: config.providerCircuitBreakerMs };
}

export function createCodexRunner({ runtime, purposeRouting = {}, onProvider = () => {}, now = () => Date.now() } = {}) {
  if (!runtime) throw new Error('runtime Codex obrigatório');
  const circuits = new Map();
  return async (prompt, options = {}) => {
    const purpose = String(options.purpose || 'analysis');
    const purposeGroup = purpose.split('-')[0];
    const route = purposeRouting[purpose] ?? purposeRouting[purposeGroup] ?? {};
    const selected = parseCodexTarget(route.primary || route.model || 'auto');
    const model = selected === 'auto' ? null : selected;
    const effort = route.effort || (purposeGroup === 'observer' ? 'low' : 'medium');
    const key = `${purposeGroup}:${model || 'auto'}`;
    const circuit = circuits.get(key);
    if (circuit?.until > now()) {
      const error = new Error(`Análise ${purpose} temporariamente pausada após falha ${circuit.kind}.`);
      error.code = 'CODEX_CIRCUIT_OPEN';
      error.notAttempted = true;
      onProvider({ provider: 'codex', model, purpose, status: 'skipped', reason: 'circuit-open', failureKind: circuit.kind });
      throw error;
    }
    const startedAt = now();
    onProvider({ provider: 'codex', model, purpose, effort, status: 'started', timeoutMs: options.timeoutMs });
    try {
      const result = await runtime.run(prompt, { model, effort, schema: options.schema, timeoutMs: options.timeoutMs, purpose });
      circuits.delete(key);
      onProvider({ provider: 'codex', model: result.turn?.model || model, purpose, effort, status: 'success', durationMs: now() - startedAt, usage: result.usage || null });
      return result.text;
    } catch (error) {
      const failure = classifyCodexFailure(error);
      circuits.set(key, { until: now() + failure.cooldownMs, kind: failure.kind });
      onProvider({ provider: 'codex', model, purpose, effort, status: 'failed', failureKind: failure.kind, durationMs: now() - startedAt, message: error.message });
      throw error;
    }
  };
}
