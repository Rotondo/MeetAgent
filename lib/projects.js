import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { migrateProjectsToContexts, normalizeContext } from './contexts.js';

export const MODEL_PURPOSES = ['dispatcher', 'coach', 'observer', 'strategist', 'critic', 'closing', 'chat'];

function codexRoute(effort = 'medium') {
  return { primary: 'codex:auto', fallback: null, effort };
}

export const MODEL_PROFILES = {
  economico: {
    dispatcher: codexRoute('low'), coach: codexRoute('low'), observer: codexRoute('low'),
    strategist: codexRoute('low'), critic: codexRoute('low'), closing: codexRoute('low'), chat: codexRoute('low'),
  },
  equilibrado: {
    dispatcher: codexRoute('low'), coach: codexRoute('low'), observer: codexRoute('low'),
    strategist: codexRoute('medium'), critic: codexRoute('medium'), closing: codexRoute('medium'), chat: codexRoute('medium'),
  },
  qualidade: {
    dispatcher: codexRoute('medium'), coach: codexRoute('medium'), observer: codexRoute('medium'),
    strategist: codexRoute('high'), critic: codexRoute('high'), closing: codexRoute('high'), chat: codexRoute('high'),
  },
};

export function sanitizeModelRouting(value, fallback = MODEL_PROFILES.equilibrado) {
  return Object.fromEntries(MODEL_PURPOSES.map((purpose) => {
    const route = value?.[purpose] ?? fallback[purpose];
    const requested = String(route?.primary || route?.model || 'codex:auto');
    const primary = /^codex:(auto|[a-zA-Z0-9._/-]+)$/.test(requested) ? requested : 'codex:auto';
    const effort = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(route?.effort)
      ? route.effort : (fallback[purpose]?.effort || 'medium');
    return [purpose, { primary, fallback: null, effort }];
  }));
}

const DEFAULT_SETTINGS = {
  opacity: 0.93,
  dispatcherModel: 'haiku',
  startBarCollapsed: false,
  audioMode: 'both',
  coachIntervalMs: 15_000,
  providerOrder: ['codex'],
  autoAnalysis: false,
  adaptiveMeeting: true,
  aiProfile: 'equilibrado',
  modelRouting: MODEL_PROFILES.equilibrado,
  localContextFolder: '',
};
const EMPTY = () => ({ settings: { ...DEFAULT_SETTINGS }, contexts: [] });

export function loadStore(filePath = config.projectsFile) {
  if (!fs.existsSync(filePath)) return EMPTY();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const contexts = Array.isArray(raw?.contexts)
      ? raw.contexts.map(normalizeContext)
      : migrateProjectsToContexts(raw?.projects ?? []);
    return {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(raw?.settings ?? {}),
        modelRouting: sanitizeModelRouting(raw?.settings?.modelRouting),
      },
      contexts,
    };
  } catch {
    return EMPTY();
  }
}

export function saveStore(store, filePath = config.projectsFile) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}
