import pkg from 'electron';
const { app, BrowserWindow, ipcMain, dialog, clipboard, screen, safeStorage, shell, globalShortcut } = pkg;
import { initMain as initAudioLoopback } from 'electron-audio-loopback';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStore, saveStore, MODEL_PROFILES, sanitizeModelRouting } from '../lib/projects.js';
import { getContext, getDirectional, upsertContext, deleteContext, upsertDirectional, cloneDirectional, composeMeetingPlaybook, seedRecommendedContexts } from '../lib/contexts.js';
import { validateContextPackage, buildExternalContextPrompt } from '../lib/context-package.js';
import { scanSkills, buildCardapio } from '../lib/skills.js';
import { parseJsonLoose } from '../lib/claude-client.js';
import { Transcriber } from '../lib/transcriber.js';
import { Dispatcher } from '../lib/dispatcher.js';
import { Coach } from '../lib/coach.js';
import { executeSkill } from '../lib/executor.js';
import {
  generateClosing,
  generateFallbackClosing,
  executeClosingActions,
  appendExecutionResults,
  appendUsageResults,
} from '../lib/output-generator.js';
import { CredentialStore } from '../lib/credential-store.js';
import { createCodexRunner } from '../lib/providers.js';
import { CodexRuntime } from '../lib/codex-runtime.js';
import { createSessionLog } from '../lib/session-log.js';
import { migrateLegacyData } from '../lib/data-migration.js';
import { loadPlaybook } from '../lib/playbook.js';
import { buildLabeledTranscript } from '../lib/transcript-labeler.js';
import { HIGH_PERFORMANCE_GUIDANCE } from '../lib/high-performance.js';
import { adaptMeetingModel, buildMeetingModel, coverageSummary, inferCoverage, inferMeetingLens, inferAdaptiveMeeting, updateCoverage } from '../lib/meeting-domain.js';
import { loadRelationshipMemory, confirmRelationship, deleteRelationship, saveRelationshipMemory } from '../lib/relationship-memory.js';
import config from '../lib/config.js';
import { Secretary } from '../lib/secretary.js';
import { OUTCOMES } from '../lib/intervention-gate.js';
import { ledgerBoard } from '../lib/meeting-ledger.js';
import { atomicSave, loadAgendas, saveAgenda, reviewRecord, buildBrief, archiveMeeting, correctMemory, importLegacyReport, suggestInitiative } from '../lib/agenda-memory.js';
import { authorizeGoogle, listGoogleCalendarEvents, searchGoogleDrive, readGoogleDriveText } from '../lib/google-workspace.js';
import { fetchFirefliesTranscripts, fetchFirefliesTranscript, matchExternalMeeting, scanLocalContext } from '../lib/external-context.js';

const agendasFile = path.join(config.dataDir, 'agendas-v1.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let session = null;
let closingContext = null;
let shutdownPromise = null;

// Precisa ser inicializado antes de app.whenReady(). O plugin registra os
// handlers enable-loopback-audio/disable-loopback-audio usados pelo preload.
initAudioLoopback();

// Nunca herdar a opção de desenvolvimento que desativa a validação TLS.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
migrateLegacyData({ legacyDataDir: config.legacyDataDir, dataDir: config.dataDir });

const credentialStore = new CredentialStore({
  filePath: config.deepgramKeyFile,
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
});
const codexSandboxDir = path.join(config.dataDir, 'codex-sandbox');
fs.mkdirSync(codexSandboxDir, { recursive: true });
const codexRuntime = new CodexRuntime({ cwd: codexSandboxDir });
const googleCredentialStore = new CredentialStore({ filePath: config.googleCredentialFile,
  available: () => safeStorage.isEncryptionAvailable(), encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) });
const googleTokenStore = new CredentialStore({ filePath: config.googleTokenFile,
  available: () => safeStorage.isEncryptionAvailable(), encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) });
const firefliesStore = new CredentialStore({ filePath: config.firefliesKeyFile,
  available: () => safeStorage.isEncryptionAvailable(), encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) });

function loadSecretJson(store) {
  const value = store.load();
  return value ? JSON.parse(value) : null;
}

function saveSecretJson(store, value) { store.save(JSON.stringify(value)); }

// Instância única: um segundo clique no atalho foca a janela existente
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 340, height: 520, x: width - 360, y: height - 540,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: false, // aparece na taskbar — minimizar tem para onde voltar
    resizable: true, minWidth: 260, minHeight: 38,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('close', (event) => {
    if (shutdownPromise) return;
    event.preventDefault();
    shutdownApp('window-close');
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) { win?.webContents.send(channel, payload); }

function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function compactClosingTranscript(transcript, maxChars = 55_000) {
  const text = String(transcript || '');
  if (text.length <= maxChars) return text;
  const head = text.slice(0, 12_000);
  const tail = text.slice(-(maxChars - head.length));
  return `${head}\n\n[... trecho intermediário omitido do prompt; íntegra preservada no arquivo ...]\n\n${tail}`;
}

function transcriptFromPartialReport(markdown) {
  const match = String(markdown || '').match(/## Transcri[cç][aã]o preservada\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/i);
  if (!match) return '';
  return match[1].split(/\r?\n/).map((line) => line.replace(/^ {4}/, '')).join('\n').trim();
}

async function validatedModelRouting(store, { persist = false } = {}) {
  const routing = sanitizeModelRouting(store.settings.modelRouting, MODEL_PROFILES[store.settings.aiProfile] || MODEL_PROFILES.equilibrado);
  try {
    const models = await codexRuntime.listModels();
    const available = new Map(models.map((model) => [model.id || model.model, model]));
    let changed = false;
    for (const route of Object.values(routing)) {
      const id = String(route.primary || '').replace(/^codex:/, '');
      if (id !== 'auto' && !available.has(id)) { route.primary = 'codex:auto'; changed = true; continue; }
      const supported = available.get(id)?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) || [];
      if (supported.length && !supported.includes(route.effort)) {
        route.effort = available.get(id).defaultReasoningEffort || supported[0]; changed = true;
      }
    }
    if (changed && persist) {
      store.settings = { ...store.settings, aiProfile: 'personalizado', modelRouting: routing };
      saveStore(store);
      send('status', { text: 'Um modelo indisponível foi substituído automaticamente pelo padrão atual do ChatGPT.' });
    }
  } catch {
    // Sem login ou sem rede: a reunião continua e será reprocessada quando a conta voltar.
  }
  return routing;
}

function listPartialReports({ pendingOnly = false } = {}) {
  if (!fs.existsSync(config.outputsDir)) return [];
  return fs.readdirSync(config.outputsDir).filter((name) => /-parcial\.md$/i.test(name))
    .filter((name) => !pendingOnly || !/## Reprocessamento concluído/i.test(fs.readFileSync(path.join(config.outputsDir, name), 'utf8')))
    .sort().reverse();
}

async function reprocessPartialReport(filename) {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || !/-parcial\.md$/i.test(filename)) throw new Error('Relatório parcial inválido.');
  const sourcePath = path.join(config.outputsDir, filename);
  if (!fs.existsSync(sourcePath)) throw new Error('Relatório parcial não encontrado.');
  const fullTranscript = transcriptFromPartialReport(fs.readFileSync(sourcePath, 'utf8'));
  if (!fullTranscript) throw new Error('A transcrição preservada não foi encontrada nesse relatório.');
  const settings = loadStore().settings;
  const modelRouting = await validatedModelRouting({ settings });
  const usageEvents = [];
  const runFn = createCodexRunner({ runtime: codexRuntime, purposeRouting: modelRouting, onProvider: (info) => {
    if (info.status === 'success') usageEvents.push({ provider: info.provider, model: info.model, purpose: info.purpose, durationMs: info.durationMs, usage: info.usage });
    send('provider-state', info);
  } });
  const result = await generateClosing({
    transcript: compactClosingTranscript(fullTranscript), fullTranscript, executedActions: [], filaSilenciosa: [],
    projectPath: config.dataDir, playbook: `Reprocessamento do relatório parcial ${filename}. Preserve somente fatos sustentados pela transcrição.`,
    guidance: HIGH_PERFORMANCE_GUIDANCE,
    meetingProfile: { context: 'Reunião reprocessada', directional: 'Recuperação de análise', audience: 'não informado', objective: 'recuperar análise pendente' },
    liveState: null,
  }, { timeoutMs: Math.max(config.closingTimeoutMs, 120_000), runFn });
  result.usageSummary = appendUsageResults(result.savedPath, usageEvents);
  fs.appendFileSync(result.savedPath, `\n## Origem\nReprocessado de: ${filename}\n`, 'utf8');
  fs.appendFileSync(sourcePath, `\n## Reprocessamento concluído\nNovo relatório: ${path.basename(result.savedPath)}\n`, 'utf8');
  return { ok: true, savedPath: result.savedPath, filename: path.basename(result.savedPath) };
}

let drainingPartialReports = false;
async function drainPartialReports(limit = 3) {
  if (drainingPartialReports || session) return;
  drainingPartialReports = true;
  try {
    for (const filename of listPartialReports({ pendingOnly: true }).slice(0, limit)) {
      send('status', { text: `Reprocessando análise pendente: ${filename}` });
      try { await reprocessPartialReport(filename); }
      catch (error) { send('status', { text: `Reprocessamento pendente: ${error.message}` }); break; }
    }
  } finally { drainingPartialReports = false; }
}

async function buildConnectedBrief(agenda, settings, sessionLog = null) {
  if (!agenda) return '';
  const terms = [agenda.title, agenda.scope].filter(Boolean);
  const sections = [];
  const local = scanLocalContext(settings.localContextFolder, terms);
  if (local.length) sections.push(`DOCUMENTOS LOCAIS RELACIONADOS:\n${local.map((item) => `- ${item.title}\n${item.text.slice(0, 3000)}`).join('\n')}`);
  try {
    const credentials = loadSecretJson(googleCredentialStore);
    const token = loadSecretJson(googleTokenStore);
    if (credentials && token) {
      const files = await searchGoogleDrive({ credentials, token, query: agenda.scope || agenda.title,
        saveToken: (value) => saveSecretJson(googleTokenStore, value), limit: 5 });
      const documents = [];
      for (const file of files.slice(0, 3)) {
        try { documents.push({ ...file, text: await readGoogleDriveText({ credentials, token: loadSecretJson(googleTokenStore), file,
          saveToken: (value) => saveSecretJson(googleTokenStore, value) }) }); } catch {}
      }
      if (documents.length) sections.push(`GOOGLE DRIVE RELACIONADO:\n${documents.map((item) => `- ${item.name} (${item.webViewLink || 'sem link'})\n${item.text.slice(0, 5000)}`).join('\n')}`);
    }
  } catch (error) { sessionLog?.write('connected-context-failed', { source: 'google-drive', message: error.message }); }
  try {
    const apiKey = firefliesStore.load();
    if (apiKey && agenda.firefliesTranscriptId) {
        const transcript = await fetchFirefliesTranscript(apiKey, agenda.firefliesTranscriptId);
        const text = (transcript?.sentences || []).map((item) => `${item.speaker_name || 'Participante'}: ${item.text}`).join('\n').slice(0, 15_000);
        if (text) sections.push(`FIREFLIES — REUNIÃO ANTERIOR RELACIONADA:\n${transcript.title}\n${text}`);
    }
  } catch (error) { sessionLog?.write('connected-context-failed', { source: 'fireflies', message: error.message }); }
  return sections.join('\n\n');
}

function shutdownApp(reason = 'app-close') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (session) {
      const closingSession = session;
      session = null;
      closingSession.state = 'ending';
      closingSession.coach.stop();
      closingSession.secretary.stopped = true;
      await Promise.all([
        closingSession.transcriber.stop().catch(() => {}),
        closingSession.microphoneTranscriber?.stop().catch(() => {}),
      ]);
      closingSession.sessionLog.write('session-end', {
        reason,
        context: closingSession.context?.name || null,
        directional: closingSession.directional?.name || null,
        audience: closingSession.audience || null,
        objective: closingSession.objective || null,
      });
    }
    await codexRuntime.stop().catch(() => {});
    win?.destroy();
    app.quit();
  })();
  return shutdownPromise;
}

async function waitAtMost(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function calibrationForObjective(objective) {
  if (['decisão', 'negociação'].includes(objective)) return 'contratual';
  if (['execução', 'alinhamento'].includes(objective)) return 'operacional';
  if (objective === 'escuta/descoberta') return 'exploratória';
  if (['feedback', '1:1'].includes(objective)) return 'operacional';
  return 'exploratória';
}

async function startMeeting(selection, legacyTipoReuniao = 'exploratória') {
  if (session) return { ok: false, error: 'Já existe uma reunião em andamento.' };
  const store = loadStore();
  const normalized = typeof selection === 'string'
    ? { contextId: selection, directionalId: null, audience: 'interna', objective: 'escuta/descoberta' }
    : selection ?? {};
  const context = getContext(store, normalized.contextId);
  if (!context) {
    const error = 'Contexto não encontrado. Abra Contextos.';
    send('status', { text: error });
    return { ok: false, error };
  }
  const directional = getDirectional(context, normalized.directionalId)
    ?? context.directions.find((item) => item.status === 'ativo') ?? null;
  if (!directional || directional.status !== 'ativo') {
    const error = 'Escolha um direcional ativo antes de iniciar.';
    send('status', { text: error });
    return { ok: false, error };
  }
  const audience = normalized.audience;
  const objective = normalized.objective;
  if (!audience || !objective) return { ok: false, error: 'Escolha público e objetivo da reunião.' };
  const tipoReuniao = calibrationForObjective(objective) || legacyTipoReuniao;
  const project = context; // compatibilidade com execução de skills existente
  let apiKey;
  try {
    apiKey = credentialStore.load();
  } catch (err) {
    send('status', { text: err.message });
    return { ok: false, error: err.message };
  }
  if (!apiKey) {
    const error = 'Configure a API Key da Deepgram em Config.';
    send('status', { text: error });
    return { ok: false, error };
  }

  const skills = scanSkills(context.path);
  const isPresentationSolutions = /apresenta[cç][aã]o.*solu[cç][oõ]es/i.test(`${context.name} ${directional.name}`);
  const audioMode = store.settings.audioMode || 'both';
  const configuredCoachIntervalMs = store.settings.coachIntervalMs || config.coachIntervalMs;
  const directionalIntervalMs = Number(directional.analysisIntervalMs);
  const analysisIntervalMs = [15_000, 25_000, 40_000, 60_000, 90_000].includes(directionalIntervalMs)
    ? directionalIntervalMs : configuredCoachIntervalMs;
  const cardapio = buildCardapio(skills, project.skills?.length ? project.skills : null);
  const usageEvents = [];
  const sessionLog = createSessionLog({ logsDir: config.logsDir });
  let legacyPlaybook = null;
  try {
    legacyPlaybook = loadPlaybook(context.path);
  } catch (err) {
    sessionLog.write('playbook-load-failed', { message: err.message });
  }
  const meetingModel = buildMeetingModel({
    directional,
    objective: isPresentationSolutions ? 'apresentação' : objective,
    skills: skills.filter((skill) => (skill.type || 'acao-externa') !== 'acao-externa'),
    lenses: isPresentationSolutions ? [{ id: 'apresentação', label: 'Apresentação' }] : undefined,
  });
  const playbook = {
    profile: directional.name,
    liveAnalysis: Boolean(directional.liveAnalysis || legacyPlaybook?.liveAnalysis),
    text: composeMeetingPlaybook({ context, directional, audience, objective, legacyPlaybook }),
  };
  // V1: somente o direcional já auditado recebe o novo motor proativo.
  const liveAnalysis = false; // Secretary owns analysis; legacy dispatcher remains for approved actions.
  const modelRouting = await validatedModelRouting(store, { persist: true });
  const runWithFallback = createCodexRunner({
    runtime: codexRuntime,
    purposeRouting: modelRouting,
    onProvider: (info) => {
      if (info.status === 'success') {
        usageEvents.push({
          provider: info.provider,
          model: info.model,
          purpose: info.purpose,
          durationMs: info.durationMs,
          usage: info.usage,
        });
      }
      if (info.status === 'success') session && (session.lastProvider = info.provider);
      session?.sessionLog?.write('provider-attempt', info);
      send('provider-state', info);
    },
  });
  const dispatcher = new Dispatcher({
    runFn: runWithFallback,
    skillsCardapio: cardapio,
    tipoReuniao,
    model: store.settings.dispatcherModel || config.dispatcherModel,
    playbook: playbook?.text ?? '',
    guidance: HIGH_PERFORMANCE_GUIDANCE,
    warmupWords: config.dispatcherWarmupWords,
    semanticDedupeMs: config.semanticInterventionDedupeMs,
  });
  const transcriber = new Transcriber({ apiKey, windowMs: analysisIntervalMs });
  const agenda = loadAgendas(agendasFile).agendas.find(a => a.id === normalized.agendaId) || null;
  const sessionId = path.basename(sessionLog.filePath, '.jsonl');
  const connectedBrief = await buildConnectedBrief(agenda, store.settings, sessionLog);
  const secretary = new Secretary({ runFn: runWithFallback, sessionId,
    objective: agenda?.objective || objective, brief: [buildBrief(loadAgendas(agendasFile), agenda), connectedBrief].filter(Boolean).join('\n\n'),
    mode: ['silent', 'protect', 'coach'].includes(normalized.assistantMode) ? normalized.assistantMode : 'protect',
    shadow: normalized.assistantPilot !== true,
    modelRouting,
    persist: snapshot => atomicSave(path.join(config.dataDir, 'sessions', `${sessionId}.json`), snapshot) });
  secretary.on('diagnostic', ({ event, ...data }) => sessionLog.write(event, data));
  secretary.on('board', board => send('meeting-state', {
    running: true,
    phase: session?.state || 'live',
    project: context.name,
    board,
    assistanceMode: secretary.shadow ? 'silent' : secretary.mode,
  }));
  secretary.on('card', card => {
    if (!session || session.ending) return;
    send('suggestion', { id: card.id, source: 'secretary', proposta: card.say, rationale: card.whyNow,
      evidence: card.evidenceIds.join(', '), act: card.type, urgencia: 'copilot', expiresAt: card.at + 20_000 });
    sessionLog.write('intervention-shown', { id: card.id, suggestion: card.say, source: 'secretary', manual: card.manual });
  });
  const coach = new Coach({
    runFn: runWithFallback,
    model: store.settings.dispatcherModel || config.dispatcherModel,
    intervalMs: analysisIntervalMs,
    playbook: playbook?.text ?? '',
    guidance: HIGH_PERFORMANCE_GUIDANCE,
  });
  // No modo combinado, uma segunda transcrição recebe apenas o microfone.
  // Isso permite medir e interpretar a fala do usuário sem confundi-la com a reunião.
  const microphoneTranscriber = audioMode === 'both' ? new Transcriber({ apiKey, windowMs: analysisIntervalMs }) : null;
  const transcriptSegments = [];
  const microphoneSegments = [];
  const adaptationSegments = [];
  const participantCount = String(agenda?.participants || '').split(/[,;\n]/).filter((value) => value.trim()).length;
  const adaptiveState = inferAdaptiveMeeting({ objective, participantCount });
  const coachEnabled = false;
  sessionLog.write('session-start', {
    context: context.name,
    directional: directional.name,
    audience,
    objective,
    audioMode,
    coachIntervalMs: analysisIntervalMs,
    analysisIntervalSource: directionalIntervalMs === analysisIntervalMs ? 'direcional' : 'preferência geral',
    liveAnalysis,
    coachEnabled,
    playbookProfile: playbook?.profile ?? null,
    playbookPath: playbook?.path ?? null,
    modelRouting,
    adaptiveMeeting: store.settings.adaptiveMeeting !== false,
  });

  transcriber.on('transcript-final', (c) => {
    transcriptSegments.push({ text: c.text, receivedAt: c.receivedAt, duration: c.duration });
    sessionLog.write('transcript-final', { source: 'meeting', words: wordCount(c.text), duration: c.duration });
    secretary.add({ text: c.text, at: c.receivedAt, channel: audioMode === 'microphone' ? 'microphone' : 'meeting' });
    secretary.observe();
    adaptationSegments.push(c.text);
    if (adaptationSegments.length > 80) adaptationSegments.shift();
    // Coverage is user-confirmed; keyword mentions no longer imply progress or decisions.
    if (session) {
      if (store.settings.adaptiveMeeting !== false) {
        const nextAdaptive = inferAdaptiveMeeting({ text: adaptationSegments.join(' '), objective,
          meetingWords: transcriptSegments.reduce((total, segment) => total + wordCount(segment.text), 0),
          microphoneWords: microphoneSegments.reduce((total, segment) => total + wordCount(segment.text), 0), participantCount });
        const changed = nextAdaptive.mode !== session.adaptiveState.mode || nextAdaptive.role !== session.adaptiveState.role;
        session.adaptiveState = nextAdaptive;
        secretary.setAdaptiveContext(nextAdaptive);
        if (changed && nextAdaptive.confidence >= 0.7) sessionLog.write('meeting-adapted', nextAdaptive);
      }
      send('meeting-state', {
      project: `${context.name} · ${directional.name}`, running: true, phase: session.state,
      lens: session.meetingModel.activeLens, coverage: coverageSummary(session.meetingModel),
        adaptive: session.adaptiveState,
      });
    }
  });
  transcriber.on('connection-state', (state) => { sessionLog.write('transcription-state', state); send('transcription-state', state); });
  transcriber.on('transcriber-error', (e) => { sessionLog.write('transcriber-error', { source: 'meeting', message: e.message }); send('status', { text: `Deepgram: ${e.message}` }); });
  transcriber.on('status', (t) => send('status', { text: t }));
  dispatcher.on('suggestion', (s) => {
    if (s.source === 'playbook') coach.suppressFor(config.liveInterventionCooldownMs);
    sessionLog.write('intervention-shown', {
      suggestion: s.proposta,
      rationale: s.rationale,
      act: s.act,
      evidence: s.evidence,
      confidence: s.confidence,
      source: s.source,
      urgency: s.urgencia,
    });
    send('suggestion', s);
  });
  dispatcher.on('status', (t) => { sessionLog.write('dispatcher-status', { message: t }); send('status', { text: t }); });
  dispatcher.on('state', (board) => {
    if (!session) return;
    send('meeting-state', {
      project: `${context.name} · ${directional.name}`,
      running: true,
      phase: session.state,
      lens: session.meetingModel.activeLens,
      coverage: coverageSummary(session.meetingModel),
      board,
    });
  });
  coach.on('feedback', (feedback) => {
    if (isPresentationSolutions) return;
    sessionLog.write('coach-feedback', {
      category: feedback.category,
      source: feedback.source,
      suggestion: feedback.text,
      rationale: feedback.rationale,
      act: feedback.act,
      evidence: feedback.evidence,
      confidence: feedback.confidence,
    });
    dispatcher.enqueueCoaching(feedback.text, feedback);
  });
  coach.on('review', (review) => sessionLog.write('coach-review', review));
  coach.on('status', (t) => send('status', { text: t }));
  if (microphoneTranscriber) {
    microphoneTranscriber.on('connection-state', (state) => {
      sessionLog.write('coach-transcription-state', state);
      send('coach-state', state);
    });
    microphoneTranscriber.on('transcript-final', (c) => {
      microphoneSegments.push({ text: c.text, receivedAt: c.receivedAt, duration: c.duration });
      sessionLog.write('transcript-final', { source: 'microphone', words: wordCount(c.text), duration: c.duration });
      // The mixed channel remains unassigned; microphone evidence is separately traceable.
      secretary.add({ text: c.text, at: c.receivedAt, channel: 'microphone' });
      secretary.observe();
      if (session && store.settings.adaptiveMeeting !== false) {
        session.adaptiveState = inferAdaptiveMeeting({ text: adaptationSegments.join(' '), objective,
          meetingWords: transcriptSegments.reduce((total, segment) => total + wordCount(segment.text), 0),
          microphoneWords: microphoneSegments.reduce((total, segment) => total + wordCount(segment.text), 0), participantCount });
        secretary.setAdaptiveContext(session.adaptiveState);
      }
    });
    microphoneTranscriber.on('transcriber-error', (e) => { sessionLog.write('transcriber-error', { source: 'microphone', message: e.message }); send('status', { text: `Coach de microfone: ${e.message}` }); });
  }

  session = {
    project, context, directional, audience, objective, transcriber, microphoneTranscriber, coach, dispatcher, secretary, agenda,
    transcriptSegments, microphoneSegments, adaptationSegments, skills, audioMode, sessionLog, runWithFallback, usageEvents,
    playbook, liveAnalysis, analysisIntervalMs, meetingModel, isPresentationSolutions, coachEnabled, modelRouting, adaptiveState,
    state: 'starting', lastProvider: null, questionPromise: null, ending: false,
  };
  try {
    await transcriber.start();
    if (microphoneTranscriber) await microphoneTranscriber.start();
    send('status', { text: secretary.shadow ? 'Secretária ativa; sugestões automáticas em avaliação silenciosa.' : 'Piloto ativo: intervenções limitadas e revisadas.' });
  } catch (err) {
    coach.stop();
    await transcriber.stop().catch(() => {});
    await microphoneTranscriber?.stop().catch(() => {});
    sessionLog.write('session-start-failed', { message: err.message });
    session = null;
    const error = `Não foi possível conectar à Deepgram: ${err.message}`;
    send('status', { text: error });
    return { ok: false, error };
  }
  closingContext = null;
  session.state = 'live';
  store.settings = { ...store.settings, lastMeetingSelection: { contextId: context.id, directionalId: directional.id, audience, objective } };
  saveStore(store);
  send('meeting-state', { project: `${context.name} · ${directional.name}`, running: true, phase: 'live', lens: meetingModel.activeLens, coverage: coverageSummary(meetingModel), adaptive: adaptiveState });
  send('session-log', { filePath: sessionLog.filePath });
  send('status', {
    text: playbook
      ? `Transcrição conectada — ${directional.name} ativo para ${objective} com público ${audience}.`
      : 'Transcrição conectada — iniciando captura de áudio…',
  });
  return { ok: true, audioMode, context: context.name, directional: directional.name };
}

function quickSelection() {
  const store = loadStore();
  const saved = store.settings?.lastMeetingSelection || {};
  const context = getContext(store, saved.contextId) || store.contexts.find(item => /parceria/i.test(item.name)) || store.contexts[0];
  const directional = context && (getDirectional(context, saved.directionalId) || context.directions.find(item => item.status === 'ativo'));
  if (!context || !directional) return null;
  return { contextId: context.id, directionalId: directional.id, audience: saved.audience || (/parceria/i.test(context.name) ? 'parceiro' : 'interna'),
    objective: saved.objective || 'escuta/descoberta', assistantMode: 'silent', assistantPilot: false };
}

async function startQuickMeeting() {
  const selection = quickSelection();
  if (!selection) return { ok: false, error: 'Não há um contexto ativo para início imediato.' };
  const result = await startMeeting(selection);
  if (result.ok) {
    send('request-audio-capture', { audioMode: result.audioMode });
    send('status', { text: 'Início imediato: secretária silenciosa. Ctrl+Alt+1 decisão · 2 próximo passo · 3 dúvida · P pergunta.' });
  }
  return result;
}

function markMoment(kind) {
  const mark = session?.secretary.mark(kind);
  if (!mark) return;
  const labels = { decision: 'decisão', 'next-step': 'próximo passo', question: 'dúvida' };
  send('status', { text: `Marcado: ${labels[kind]}. O fechamento priorizará este trecho.` });
}

function registerGlobalShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+R', () => { startQuickMeeting().catch(error => send('status', { text: error.message })); });
  globalShortcut.register('CommandOrControl+Alt+1', () => markMoment('decision'));
  globalShortcut.register('CommandOrControl+Alt+2', () => markMoment('next-step'));
  globalShortcut.register('CommandOrControl+Alt+3', () => markMoment('question'));
  globalShortcut.register('CommandOrControl+Alt+P', () => {
    if (!session) return;
    session.secretary.observe(true).finally(() => session?.secretary.suggest(true));
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
  const contextStore = loadStore();
  const seededStore = seedRecommendedContexts(contextStore);
  let persistedContexts = false;
  try { persistedContexts = Array.isArray(JSON.parse(fs.readFileSync(config.projectsFile, 'utf8')).contexts); } catch {}
  if (seededStore !== contextStore || !persistedContexts) saveStore(seededStore);
  createWindow();
  codexRuntime.on('account', (state) => {
    send('codex-account', state);
    if (state.authMode === 'chatgpt' || state.success === true) setTimeout(() => drainPartialReports(), 1_000);
  });
  codexRuntime.on('state', (state) => send('codex-state', state));
  codexRuntime.on('diagnostic', (entry) => session?.sessionLog?.write(entry.event, { message: entry.message }));
  registerGlobalShortcuts();
  setTimeout(async () => {
    try {
      const account = await codexRuntime.getAccount();
      if (account?.account?.type === 'chatgpt') await drainPartialReports();
    } catch {}
  }, 2_000);

  ipcMain.handle('get-store', () => loadStore());
  ipcMain.handle('get-live-meeting', () => session ? {
    lens: session.meetingModel.activeLens,
    agenda: session.meetingModel.agenda,
    coverage: coverageSummary(session.meetingModel),
    coverageDetail: session.meetingModel.coverage,
    skills: session.meetingModel.skills,
    board: ledgerBoard(session.secretary.ledger),
    assistanceMode: session.secretary.shadow ? 'silent' : session.secretary.mode,
    adaptive: session.adaptiveState,
  } : null);
  ipcMain.handle('set-live-assistance', (_e, { mode }) => {
    if (!session || session.ending) return { ok: false, error: 'Nenhuma reuniao ativa.' };
    if (!['silent', 'protect', 'coach'].includes(mode)) return { ok: false, error: 'Modo de dicas invalido.' };
    session.secretary.setAssistance(mode);
    session.sessionLog.write('live-assistance-changed', { mode });
    send('meeting-state', {
      project: `${session.context.name} - ${session.directional.name}`,
      running: true,
      phase: session.state,
      lens: session.meetingModel.activeLens,
      coverage: coverageSummary(session.meetingModel),
      board: ledgerBoard(session.secretary.ledger),
      assistanceMode: mode,
    });
    return { ok: true, mode };
  });
  ipcMain.handle('update-checklist', (_e, { itemId, status, evidence }) => {
    if (!session) return { ok: false, error: 'Nenhuma reunião ativa.' };
    session.meetingModel = updateCoverage(session.meetingModel, itemId, status, evidence);
    session.sessionLog.write('agenda-coverage', { itemId, status });
    const payload = { project: `${session.context.name} · ${session.directional.name}`, running: true, phase: session.state, lens: session.meetingModel.activeLens, coverage: coverageSummary(session.meetingModel) };
    send('meeting-state', payload);
    return { ok: true, ...payload, agenda: session.meetingModel.agenda, coverageDetail: session.meetingModel.coverage };
  });
  ipcMain.handle('get-relationship-memory', () => loadRelationshipMemory(config.relationshipMemoryFile));
  ipcMain.handle('confirm-relationship', (_e, candidate) => {
    const saved = confirmRelationship(loadRelationshipMemory(config.relationshipMemoryFile), candidate, config.relationshipMemoryFile);
    session?.sessionLog.write('relationship-confirmed', { company: candidate?.company || null, person: candidate?.person || null });
    send('stakeholder-state', saved);
    return saved;
  });
  ipcMain.handle('delete-relationship', (_e, { id }) => {
    const saved = deleteRelationship(loadRelationshipMemory(config.relationshipMemoryFile), id);
    saveRelationshipMemory(saved, config.relationshipMemoryFile);
    send('stakeholder-state', saved);
    return saved;
  });
  ipcMain.handle('record-intervention-feedback', (_e, { id, outcome }) => {
    if (!session || !OUTCOMES.includes(outcome)) return { ok: false };
    if (session.secretary.history.some(card => card.id === id)) session.secretary.rate(id, outcome);
    session.sessionLog.write('intervention-feedback', { id, outcome });
    return { ok: true };
  });
  ipcMain.handle('secretary-store', () => loadAgendas(agendasFile));
  ipcMain.handle('secretary-agenda', (_e, value) => {
    const store = saveAgenda(loadAgendas(agendasFile), value); atomicSave(agendasFile, store); return store;
  });
  ipcMain.handle('secretary-confirm-scope', (_e, id) => {
    const memory = loadAgendas(agendasFile);
    const agenda = memory.agendas.find((item) => item.id === id);
    if (!agenda?.suggestedScope) throw new Error('Não há iniciativa sugerida para confirmar.');
    const updated = saveAgenda(memory, { ...agenda, scope: agenda.suggestedScope, suggestedScope: '' });
    atomicSave(agendasFile, updated); return updated;
  });
  ipcMain.handle('secretary-brief', async (_e, id) => {
    const memory = loadAgendas(agendasFile);
    const agenda = memory.agendas.find(a => a.id === id);
    return [buildBrief(memory, agenda), await buildConnectedBrief(agenda, loadStore().settings)].filter(Boolean).join('\n\n');
  });
  ipcMain.handle('secretary-review', (_e, { sessionId, ids }) => {
    const store = reviewRecord(loadAgendas(agendasFile), sessionId, Array.isArray(ids) ? ids : []);
    atomicSave(agendasFile, store); return store;
  });
  ipcMain.handle('secretary-correct', (_e, { sessionId, itemId, changes }) => {
    const store = correctMemory(loadAgendas(agendasFile), sessionId, itemId, changes || {}); atomicSave(agendasFile, store); return store;
  });
  ipcMain.handle('secretary-legacy-list', () => fs.existsSync(config.outputsDir) ? fs.readdirSync(config.outputsDir).filter(name => name.endsWith('.md')).sort().reverse() : []);
  ipcMain.handle('secretary-legacy-import', (_e, { filename, agendaId }) => {
    if (typeof filename !== 'string' || filename !== path.basename(filename) || !filename.endsWith('.md')) throw new Error('Arquivo inválido.');
    const store = loadAgendas(agendasFile);
    const updated = importLegacyReport(store, { filename, markdown: fs.readFileSync(path.join(config.outputsDir, filename), 'utf8'), agenda: store.agendas.find(a => a.id === agendaId) });
    atomicSave(agendasFile, updated); return updated;
  });
  ipcMain.handle('scan-skills', (_e, { path: p }) => scanSkills(p));
  ipcMain.handle('save-context', (_e, context) => { const s = upsertContext(loadStore(), context); saveStore(s); return s; });
  ipcMain.handle('delete-context', (_e, { id }) => { const s = deleteContext(loadStore(), id); saveStore(s); return s; });
  ipcMain.handle('validate-context-package', (_e, { markdown }) => validateContextPackage(markdown));
  ipcMain.handle('build-context-prompt', (_e, payload) => buildExternalContextPrompt(payload));
  ipcMain.handle('save-directional', (_e, { contextId, directional }) => {
    const validation = validateContextPackage(directional?.packageMarkdown);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    const s = upsertDirectional(loadStore(), contextId, directional);
    saveStore(s); return s;
  });
  ipcMain.handle('clone-directional', (_e, { contextId, directionalId, name }) => {
    const s = cloneDirectional(loadStore(), contextId, directionalId, name); saveStore(s); return s;
  });

  // Merge parcial: salva só as chaves enviadas, preserva o resto
  ipcMain.handle('save-settings', (_e, partial) => {
    const s = loadStore();
    const safePartial = {};
    const opacity = Number(partial?.opacity);
    if (Number.isFinite(opacity) && opacity >= 0.4 && opacity <= 1) safePartial.opacity = opacity;
    if (typeof partial?.startBarCollapsed === 'boolean') safePartial.startBarCollapsed = partial.startBarCollapsed;
    if (['both', 'system', 'microphone'].includes(partial?.audioMode)) safePartial.audioMode = partial.audioMode;
    const coachIntervalMs = Number(partial?.coachIntervalMs);
    if ([15_000, 25_000, 40_000].includes(coachIntervalMs)) safePartial.coachIntervalMs = coachIntervalMs;
    if (typeof partial?.autoAnalysis === 'boolean') safePartial.autoAnalysis = partial.autoAnalysis;
    if (typeof partial?.adaptiveMeeting === 'boolean') safePartial.adaptiveMeeting = partial.adaptiveMeeting;
    if (['economico', 'equilibrado', 'qualidade', 'personalizado'].includes(partial?.aiProfile)) safePartial.aiProfile = partial.aiProfile;
    if (partial?.modelRouting && typeof partial.modelRouting === 'object') {
      safePartial.modelRouting = sanitizeModelRouting(partial.modelRouting,
        MODEL_PROFILES[safePartial.aiProfile || s.settings.aiProfile] || MODEL_PROFILES.equilibrado);
      if (!safePartial.aiProfile) safePartial.aiProfile = 'personalizado';
    } else if (safePartial.aiProfile && MODEL_PROFILES[safePartial.aiProfile]) {
      safePartial.modelRouting = MODEL_PROFILES[safePartial.aiProfile];
    }
    if (typeof partial?.localContextFolder === 'string') {
      const resolved = partial.localContextFolder ? path.resolve(partial.localContextFolder) : '';
      if (!resolved || fs.existsSync(resolved)) safePartial.localContextFolder = resolved;
    }
    s.settings = { ...s.settings, ...safePartial };
    saveStore(s);
    return s;
  });

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('open-logs', async () => {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const latest = fs.readdirSync(config.logsDir)
      .filter((name) => /^session-.*\.jsonl$/i.test(name))
      .map((name) => {
        const filePath = path.join(config.logsDir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (latest) {
      shell.showItemInFolder(latest.filePath);
      return { ok: true, path: latest.filePath };
    }
    const error = await shell.openPath(config.logsDir);
    return error ? { ok: false, error } : { ok: true, path: config.logsDir };
  });

  ipcMain.on('close-app', () => shutdownApp('app-close'));
  ipcMain.on('minimize-app', () => win.minimize());

  let collapsed = false;
  let expandedHeight = 520;
  ipcMain.handle('toggle-collapse', () => {
    const b = win.getBounds();
    if (!collapsed) {
      expandedHeight = b.height;
      win.setBounds({ ...b, height: 38 });
      collapsed = true;
    } else {
      win.setBounds({ ...b, height: expandedHeight });
      collapsed = false;
    }
    return collapsed;
  });

  ipcMain.handle('deepgram-key-status', () => ({ configured: credentialStore.has() }));
  ipcMain.handle('save-deepgram-key', (_e, value) => {
    credentialStore.save(value);
    return { configured: true };
  });
  ipcMain.handle('clear-deepgram-key', () => {
    credentialStore.clear();
    return { configured: false };
  });
  ipcMain.handle('codex-status', async () => {
    try {
      const account = await codexRuntime.getAccount();
      const connected = account?.account?.type === 'chatgpt';
      const rateLimits = connected ? await codexRuntime.getRateLimits().catch(() => null) : null;
      return { available: true, connected, account: account?.account || null, rateLimits };
    } catch (error) {
      return { available: false, connected: false, error: error.message };
    }
  });
  ipcMain.handle('codex-login', async () => {
    const result = await codexRuntime.beginLogin();
    if (result?.authUrl) await shell.openExternal(result.authUrl);
    return result;
  });
  ipcMain.handle('codex-logout', async () => { await codexRuntime.logout(); return { connected: false }; });
  ipcMain.handle('codex-models', async () => codexRuntime.listModels());
  ipcMain.handle('partial-reports', () => listPartialReports({ pendingOnly: true }));
  ipcMain.handle('reprocess-partial-report', (_e, { filename }) => reprocessPartialReport(filename));
  ipcMain.handle('integration-status', () => ({ googleCredentials: googleCredentialStore.has(), googleConnected: googleTokenStore.has(), fireflies: firefliesStore.has() }));
  ipcMain.handle('save-google-credentials', (_e, value) => {
    const clientId = String(value?.clientId || '').trim();
    const clientSecret = String(value?.clientSecret || '').trim();
    if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('Client ID OAuth do Google inválido.');
    saveSecretJson(googleCredentialStore, { clientId, clientSecret });
    googleTokenStore.clear();
    return { configured: true };
  });
  ipcMain.handle('connect-google', async () => {
    const credentials = loadSecretJson(googleCredentialStore);
    await authorizeGoogle(credentials, { openExternal: (url) => shell.openExternal(url), saveToken: (value) => saveSecretJson(googleTokenStore, value) });
    return { connected: true };
  });
  ipcMain.handle('disconnect-google', () => { googleTokenStore.clear(); return { connected: false }; });
  ipcMain.handle('sync-google-calendar', async () => {
    const credentials = loadSecretJson(googleCredentialStore);
    const token = loadSecretJson(googleTokenStore);
    const events = await listGoogleCalendarEvents({ credentials, token, saveToken: (value) => saveSecretJson(googleTokenStore, value) });
    let memory = loadAgendas(agendasFile);
    for (const event of events) {
      const existing = memory.agendas.find((item) => item.source === 'google-calendar' && item.externalId === event.externalId);
      const suggestion = existing?.scope ? null : suggestInitiative(memory, { ...event, participants: event.participants.join(', ') });
      memory = saveAgenda(memory, { ...existing, ...event, id: existing?.id,
        scope: existing?.scope || event.title, objective: existing?.objective || event.description || 'Acompanhar o objetivo e os encaminhamentos da reunião.',
        participants: event.participants.join(', '), suggestedScope: existing?.suggestedScope || suggestion?.scope || null });
    }
    atomicSave(agendasFile, memory);
    return { ok: true, count: events.length, store: memory };
  });
  ipcMain.handle('save-fireflies-key', (_e, value) => { firefliesStore.save(value); return { configured: true }; });
  ipcMain.handle('clear-fireflies-key', () => { firefliesStore.clear(); return { configured: false }; });
  ipcMain.handle('fireflies-matches', async (_e, agendaId) => {
    const memory = loadAgendas(agendasFile);
    const agenda = memory.agendas.find((item) => item.id === agendaId);
    return matchExternalMeeting(await fetchFirefliesTranscripts(firefliesStore.load(), { limit: 50 }), agenda).slice(0, 10);
  });
  ipcMain.handle('link-fireflies-transcript', (_e, { agendaId, transcriptId, title }) => {
    const memory = loadAgendas(agendasFile);
    const agenda = memory.agendas.find((item) => item.id === agendaId);
    if (!agenda) throw new Error('Agenda não encontrada.');
    const updated = saveAgenda(memory, { ...agenda, firefliesTranscriptId: transcriptId, firefliesTranscriptTitle: title });
    atomicSave(agendasFile, updated); return updated;
  });

  // Redimensionamento via alças nas bordas — renderer envia mousemove contínuo
  ipcMain.on('start-resize', (_e, { startX, startY, dirs }) => {
    const orig = win.getBounds();
    const handler = (_e2, { screenX, screenY }) => {
      const dx = screenX - startX;
      const dy = screenY - startY;
      win.setBounds({
        x:      dirs.dx ? orig.x + dx : orig.x,
        y:      dirs.dy ? orig.y + dy : orig.y,
        width:  Math.max(260, orig.width  + (dirs.dw ? dx * dirs.dw : 0)),
        height: Math.max(120, orig.height + (dirs.dh ? dy * dirs.dh : 0)),
      });
    };
    ipcMain.on('resize-move', handler);
    ipcMain.once('stop-resize', () => ipcMain.removeListener('resize-move', handler));
  });

  ipcMain.handle('start-meeting', (_e, selection) => startMeeting(selection));
  ipcMain.handle('start-quick-meeting', () => startQuickMeeting());
  ipcMain.on('audio-chunk', (_e, chunk) => session?.transcriber.feedAudio(chunk));
  ipcMain.on('microphone-chunk', (_e, chunk) => session?.microphoneTranscriber?.feedAudio(chunk));
  ipcMain.on('audio-source-state', (_e, { source, active }) => {
    session?.sessionLog.write('audio-source-state', { source, active });
    if (!active && session?.state === 'live') {
      session.state = 'degraded';
    send('meeting-state', { project: `${session.context.name} · ${session.directional.name}`, running: true, phase: 'degraded' });
      send('status', { text: `${source === 'system' ? 'Áudio do sistema' : 'Microfone'} interrompido. Reinicie a captura para recuperar.` });
    }
    if (source !== 'microphone' || active || !session?.microphoneTranscriber) return;
    session.microphoneTranscriber.stop().catch(() => {});
    send('status', { text: 'Microfone indisponível: coaching pessoal pausado.' });
  });
  ipcMain.handle('cancel-meeting', async () => {
    if (!session) return { ok: true };
    const cancelled = session;
    session = null;
    cancelled.coach.stop();
    cancelled.secretary.stopped = true;
    await Promise.all([cancelled.transcriber.stop().catch(() => {}), cancelled.microphoneTranscriber?.stop().catch(() => {})]);
    cancelled.sessionLog.write('session-end', {
      reason: 'cancelled',
      context: cancelled.context?.name || null,
      directional: cancelled.directional?.name || null,
      audience: cancelled.audience || null,
      objective: cancelled.objective || null,
    });
    send('meeting-state', { project: null, running: false });
    return { ok: true };
  });

  ipcMain.on('decision', async (_e, { id, approved }) => {
    if (!session) return;
    const action = session.dispatcher.resolveDecision(id, approved);
    if (!action) return;
    if (session.isPresentationSolutions) {
      session.sessionLog.write('skill-blocked', { id, skill: action.skill, reason: 'ações externas desativadas no corte v1' });
      session.dispatcher.recordResult(id, 'adiado: ações externas desativadas no corte v1');
      send('result', { id, error: 'Ações externas ficam disponíveis após a validação deste motor.' });
      return;
    }
    const allowedSkills = session.project.skills?.length
      ? session.project.skills
      : session.skills.map((skill) => skill.name);
    if (!action.skill || !allowedSkills.includes(action.skill)) {
      const error = `skill não permitida: ${action.skill || '(vazia)'}`;
      session.sessionLog.write('skill-blocked', { id, skill: action.skill, reason: error });
      session.dispatcher.recordResult(id, `erro: ${error}`);
      send('result', { id, error });
      return;
    }
    send('status', { text: `Executando ${action.skill}…` });
    try {
      const output = await executeSkill(action, { projectPath: session.project.path || config.dataDir });
      session.dispatcher.recordResult(id, output);
      send('result', { id, output });
    } catch (err) {
      session.dispatcher.recordResult(id, `erro: ${err.message}`);
      send('result', { id, error: err.message });
    }
    send('status', { text: '' });
  });

  ipcMain.handle('chat', async (_e, { text }) => {
    if (!session || !['live', 'degraded'].includes(session.state)) {
      return { ok: false, error: 'Inicie uma reunião antes de conversar com o agente.' };
    }
    const recentTranscript = session.transcriptSegments.slice(-12).map((segment) => segment.text).join('\n');
    const ctx = `Memória aprovada e briefing: ${session.secretary.brief}\nRegistro com evidências: ${JSON.stringify(session.secretary.ledger.items)}\nContexto recente da reunião:\n${recentTranscript || session.dispatcher.meetingSummary || '(ainda sem contexto)'}\n\n`
      + `Roteiro do projeto:\n${session.playbook?.text?.slice(0, 5_000) || '(sem roteiro específico)'}\n\n`
      + `${HIGH_PERFORMANCE_GUIDANCE}\n\n`;
    try {
      session.sessionLog.write('manual-request', { kind: 'chat' });
      const output = await session.runWithFallback(
        `${ctx}Mensagem do usuário durante a reunião: ${text}\nResponda de forma curta, em português.`,
        { cwd: session.project.path || config.dataDir, timeoutMs: 20_000, purpose: 'chat' },
      );
      return { ok: true, output, provider: session.lastProvider ?? null };
    } catch (err) {
      session?.sessionLog.write('manual-request-failed', { kind: 'chat', message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('suggest-question', async () => {
    if (!session || session.state !== 'live') return { ok: false, error: 'Inicie uma reunião antes de pedir uma pergunta.' };
    const current = session;
    await current.secretary.observe();
    const card = await current.secretary.suggest(true);
    return card ? { ok: true, question: card.say, rationale: card.whyNow, act: card.type, provider: current.lastProvider }
      : { ok: false, error: 'Nenhuma pergunta passou pela revisão de novidade, evidência e oportunidade. O quadro vivo continua disponível.' };
    /* Legacy question generator retained only until pilot evaluation is complete.
    if (session.questionPromise) return { ok: false, error: 'Já existe uma pergunta sendo gerada.' };
    const requestedAt = Date.now();
    const context = session.transcriptSegments.slice(-24).map((segment) => segment.text).join('\n').slice(-8_000);
    if (wordCount(context) < 20) return { ok: false, error: 'Ainda há pouco contexto. Aguarde mais alguns segundos.' };
    session.sessionLog.write('manual-request', { kind: 'suggest-question', contextWords: wordCount(context) });
    session.questionPromise = (async () => {
      try {
        const raw = await session.runWithFallback(
          `Você acompanha uma reunião ao vivo. Com base SOMENTE no contexto abaixo, proponha a pergunta de maior valor que Usuário possa fazer agora.

CONTEXTO:
${context}

ROTEIRO DO PROJETO:
${session.playbook?.text?.slice(0, 6_000) || '(sem roteiro específico)'}

${HIGH_PERFORMANCE_GUIDANCE}

Responda apenas JSON válido:
{"question":"<pergunta direta, até 120 caracteres>","rationale":"<por que é útil agora, até 160 caracteres>","act":"<ato do roteiro ou null>"}

Não invente fatos, nomes ou decisões. Não repita uma pergunta já respondida. A pergunta deve produzir clareza, evidência, alinhamento ou compromisso — não apenas prolongar a conversa.`,
          { timeoutMs: 12_000, purpose: 'suggest-question' },
        );
        const parsed = parseJsonLoose(raw);
        const question = String(parsed?.question ?? '').trim().slice(0, 160);
        const rationale = String(parsed?.rationale ?? '').trim().slice(0, 200);
        const act = String(parsed?.act ?? '').trim().slice(0, 80);
        if (!question || !rationale) throw new Error('resposta inválida do provedor');
        session.sessionLog.write('manual-request-completed', {
          kind: 'suggest-question', durationMs: Date.now() - requestedAt, provider: session.lastProvider,
          suggestion: question, rationale, act,
        });
        return { ok: true, question, rationale, act, provider: session.lastProvider };
      } catch (err) {
        session?.sessionLog.write('manual-request-failed', {
          kind: 'suggest-question', durationMs: Date.now() - requestedAt, message: err.message,
        });
        return { ok: false, error: err.message };
      } finally {
        if (session) session.questionPromise = null;
      }
    })();
    return session.questionPromise; */
  });

  ipcMain.handle('end-meeting', async () => {
    if (!session || session.ending) return { ok: false, error: 'Nenhuma reunião ativa.' };
    session.ending = true;
    session.state = 'ending';
    const endingSession = session;
    endingSession.sessionLog.write('ending-started');
    send('meeting-state', { project: `${endingSession.context.name} · ${endingSession.directional.name}`, running: true, phase: 'ending' });
    send('status', { text: 'Gerando encerramento…' });
    try {
      endingSession.coach.stop();
      endingSession.secretary.stopped = true;
      const stopResults = await Promise.allSettled([
        endingSession.transcriber.stop(),
        endingSession.microphoneTranscriber?.stop(),
      ]);
      for (const stopped of stopResults) {
        if (stopped.status === 'rejected') {
          endingSession.sessionLog.write('transcriber-stop-failed', { message: stopped.reason?.message });
        }
      }
      // A análise ao vivo pode ter várias janelas na fila. Ela não pode travar
      // o encerramento: aguardamos apenas a rodada já quase concluída.
      if (endingSession.dispatcher.processingPromise) {
        const completed = await waitAtMost(endingSession.dispatcher.processingPromise, config.closingDrainWaitMs);
        if (!completed) endingSession.sessionLog.write('closing-dispatcher-timeout', { waitMs: config.closingDrainWaitMs });
      }
      const fullTranscript = buildLabeledTranscript(
          endingSession.transcriptSegments,
          endingSession.microphoneSegments,
          { audioMode: endingSession.audioMode },
        );
      const closingInput = {
        transcript: compactClosingTranscript(fullTranscript),
        fullTranscript,
        executedActions: endingSession.dispatcher.executedActions,
        filaSilenciosa: endingSession.dispatcher.filaSilenciosa,
        projectPath: endingSession.project.path || config.dataDir,
        playbook: endingSession.playbook?.text ?? '',
        guidance: HIGH_PERFORMANCE_GUIDANCE,
        meetingProfile: {
          context: endingSession.context.name,
          directional: endingSession.directional.name,
          audience: endingSession.audience,
          objective: endingSession.objective,
          inferredLens: endingSession.meetingModel.activeLens,
          inferredMode: endingSession.adaptiveState?.mode,
          inferredRole: endingSession.adaptiveState?.role,
          adaptationConfidence: endingSession.adaptiveState?.confidence,
        },
        liveState: {
          summary: endingSession.dispatcher.meetingSummary,
          board: endingSession.dispatcher.liveState,
          lens: endingSession.meetingModel.activeLens,
          agenda: endingSession.meetingModel.agenda,
          coverage: endingSession.meetingModel.coverage,
          deadlines: endingSession.dispatcher.deadlines,
          adaptive: endingSession.adaptiveState,
        },
      };
      const secretaryResult = await endingSession.secretary.finish();
      closingInput.liveState.board = ledgerBoard(secretaryResult.ledger);
      if (endingSession.secretary.brief) closingInput.playbook += `\nBriefing e fontes consultadas antes da reunião:\n${endingSession.secretary.brief.slice(0, 20_000)}`;
      closingInput.playbook += `\nRegistro factual revisável com evidências (não inventar campos ausentes):\n${JSON.stringify(secretaryResult.ledger.items)}`;
      if (secretaryResult.marks.length) closingInput.playbook += `\nMarcas manuais do usuário (priorize os turnos ao redor do índice indicado; não trate a marca como fato):\n${JSON.stringify(secretaryResult.marks)}`;
      atomicSave(agendasFile, archiveMeeting(loadAgendas(agendasFile), {
        ...secretaryResult, agenda: endingSession.agenda, title: endingSession.context.name }));
      let result;
      try {
        result = await generateClosing(closingInput, {
          timeoutMs: config.closingTimeoutMs,
          runFn: endingSession.runWithFallback,
        });
      } catch (closingError) {
        endingSession.sessionLog.write('closing-ai-failed', { message: closingError.message });
        result = generateFallbackClosing(closingInput, { error: closingError });
      }
      try {
        clipboard.writeText(JSON.stringify(result.report.registro_crm, null, 2));
      } catch (clipboardError) {
        endingSession.sessionLog.write('clipboard-failed', { message: clipboardError.message });
      }
      result.usageSummary = appendUsageResults(result.savedPath, endingSession.usageEvents);
      result.secretary = secretaryResult;
      fs.appendFileSync(result.savedPath, `\n## Rascunho de acompanhamento\n${secretaryResult.followUp}\n`, 'utf8');
      result.usageEvents = endingSession.usageEvents;
      result.agenda = endingSession.meetingModel.agenda;
      result.coverage = endingSession.meetingModel.coverage;
      const coverageLines = endingSession.meetingModel.agenda.map((item) => {
        const state = endingSession.meetingModel.coverage[item.id];
        return `- ${item.label}: ${state?.status ?? 'não abordado'}${state?.evidence ? ` — ${state.evidence}` : ''}`;
      });
      fs.appendFileSync(result.savedPath, `\n## Cobertura da agenda\n${coverageLines.join('\n')}\n`, 'utf8');
      closingContext = {
        ...result,
        projectPath: endingSession.project.path || config.dataDir,
        allowedSkills: endingSession.project.skills?.length
          ? endingSession.project.skills
          : endingSession.skills.map((s) => s.name),
        executedIds: new Set(),
      };
      send('closing-report', result);
      endingSession.sessionLog.write('session-end', {
        reason: result.partial ? 'completed-partial' : 'completed',
        transcriptSegments: endingSession.transcriptSegments.length,
        context: endingSession.context?.name || null,
        directional: endingSession.directional?.name || null,
        audience: endingSession.audience || null,
        objective: endingSession.objective || null,
      });
      session = null;
      send('meeting-state', { project: null, running: false, phase: 'report' });
      return { ok: true, partial: Boolean(result.partial), savedPath: result.savedPath };
    } catch (err) {
      endingSession.ending = false;
      endingSession.state = 'recoverable-error';
      endingSession.sessionLog.write('ending-failed', { message: err.message });
      send('meeting-state', { project: `${endingSession.context.name} · ${endingSession.directional.name}`, running: true, phase: 'recoverable-error' });
      send('status', { text: `Falha no encerramento: ${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('execute-closing-actions', async (_e, { ids }) => {
    if (!closingContext) return { ok: false, error: 'Relatório de encerramento indisponível.' };
    const selectedIds = new Set((ids ?? []).map(String));
    const actions = closingContext.pendingActions.filter(
      (action) => selectedIds.has(String(action.id)) && !closingContext.executedIds.has(String(action.id)),
    );
    const results = await executeClosingActions(actions, {
      projectPath: closingContext.projectPath,
      allowedSkills: closingContext.allowedSkills,
      execFn: executeSkill,
    });
    for (const action of actions) closingContext.executedIds.add(String(action.id));
    appendExecutionResults(closingContext.savedPath, results);
    send('closing-actions-result', { results });
    return { ok: true, results };
  });

  const projArg = process.argv.find((a) => a.startsWith('--project='));
  if (projArg) {
    win.webContents.once('did-finish-load', async () => {
      const result = await startMeeting(projArg.slice('--project='.length));
      if (result?.ok) send('request-audio-capture', { audioMode: result.audioMode });
    });
  }
});

app.on('window-all-closed', () => app.quit());
