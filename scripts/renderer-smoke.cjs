// Isolated Electron renderer integration test: production HTML + preload, synthetic IPC data.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-renderer-test-'));
app.setPath('userData', temporary);
app.disableHardwareAcceleration();
let win;
app.whenReady().then(async () => {
  const { saveAgenda, buildBrief, reviewRecord } = await import('../lib/agenda-memory.js');
  const { seedRecommendedContexts } = await import('../lib/contexts.js');
  const configuration = seedRecommendedContexts({ contexts: [], settings: {} });
  let store = { schemaVersion: 1, agendas: [], records: [] };
  const feedback = [];
  const handlers = {
    'get-store': () => configuration, 'secretary-store': () => store,
    'secretary-agenda': (_, value) => (store = saveAgenda(store, value)),
    'secretary-brief': (_, id) => buildBrief(store, store.agendas.find(a => a.id === id)),
    'secretary-review': (_, { sessionId, ids }) => (store = reviewRecord(store, sessionId, ids)),
    'record-intervention-feedback': (_, value) => { feedback.push(value); return { ok: true }; },
    'secretary-legacy-list': () => [],
    'get-live-meeting': () => null, 'save-settings': () => configuration, 'start-quick-meeting': () => ({ ok: true }),
    'deepgram-key-status': () => ({ configured: false }),
    'codex-status': () => ({ available: true, connected: false, account: null }),
    'codex-models': () => [], 'partial-reports': () => [],
    'integration-status': () => ({ googleCredentials: false, googleConnected: false, fireflies: false }),
  };
  Object.entries(handlers).forEach(([name, fn]) => ipcMain.handle(name, fn));
  ipcMain.on('decision', () => {});
  const errors = [];
  win = new BrowserWindow({ show: false, width: 600, height: 900, webPreferences: { preload: path.join(root, 'overlay/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_event, _level, message) => { if (/Uncaught|TypeError|ReferenceError/.test(message)) errors.push(message); });
  await win.loadFile(path.join(root, 'overlay/renderer/index.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  await evaluate(`new Promise(resolve => { const poll = () => document.getElementById('start-context').options.length ? resolve() : setTimeout(poll, 20); poll(); })`);
  assert.equal(await evaluate(`document.getElementById('secretary-home').open`), true);
  assert.equal(await evaluate(`document.getElementById('btn-start-now').getBoundingClientRect().top < document.getElementById('secretary-home').getBoundingClientRect().top`), true);
  await evaluate(`document.getElementById('btn-start-now').click()`);
  await evaluate(`document.getElementById('secretary-title').value='Revisão do piloto'; document.getElementById('secretary-scope').value='empresa-teste'; document.getElementById('secretary-objective').value='Decidir a próxima validação'; document.getElementById('secretary-save').click();`);
  await evaluate(`new Promise(resolve => { const poll = () => document.getElementById('secretary-notice').textContent.includes('salva') ? resolve() : setTimeout(poll, 20); poll(); })`);
  assert.equal(store.agendas.length, 1);
  await evaluate(`document.getElementById('secretary-agenda').value=${JSON.stringify(store.agendas[0].id)}; document.getElementById('secretary-agenda').dispatchEvent(new Event('change'));`);
  win.webContents.send('suggestion', { id: 's1', source: 'secretary', proposta: 'Como mediremos pedidos entregues depois do teste?', urgencia: 'copilot', rationale: 'Janela de observação' });
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(await evaluate(`document.getElementById('proposal-feedback').hidden`), false);
  await evaluate(`document.querySelector('[data-outcome="óbvia"]').click()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(feedback.at(-1).outcome, 'óbvia');
  win.webContents.send('suggestion', { id: 's2', source: 'secretary', proposta: 'Qual hipótese ainda falta testar nesta validação?', urgencia: 'copilot' });
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  await evaluate(`decide(false, 'ignorada')`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(feedback.at(-1).outcome, 'ignorada');
  await evaluate(`document.getElementById('btn-config').click()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(await evaluate(`document.getElementById('view-config').hidden`), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-model-purpose]').length`), 5);
  assert.equal(await evaluate(`document.getElementById('cfg-adaptive-meeting').checked`), true);
  await evaluate(`document.getElementById('view-config').scrollIntoView({ block: 'start' })`);
  const shot = await win.webContents.capturePage();
  const output = path.join(root, 'build', 'quality'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'secretary-renderer.png'), shot.toPNG());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['production preload', 'quick start above preparation', 'agenda creation', 'brief selection', 'explicit rating', 'neutral expiry', 'model routing UI', 'adaptive mode UI', 'no renderer errors'], screenshot: 'build/quality/secretary-renderer.png' }));
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack); win?.destroy(); app.exit(1); });
setTimeout(() => { console.error('Renderer smoke timed out'); app.exit(1); }, 20000).unref();
