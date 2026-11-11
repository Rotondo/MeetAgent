// Uses the application's encrypted credential store. Sends SYNTHETIC fixture text only.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
// safeStorage's master key belongs to this application's Chromium profile.
app.setPath('userData', path.join(app.getPath('appData'), 'meeting-agent'));
app.whenReady().then(async () => {
  const { createCodexRunner } = await import('../lib/providers.js');
  const { CodexRuntime } = await import('../lib/codex-runtime.js');
  const { Secretary } = await import('../lib/secretary.js');
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/meetings/quality-cases.json'), 'utf8'));
  const runtime = new CodexRuntime();
  const account = await runtime.getAccount();
  if (account?.account?.type !== 'chatgpt') throw new Error('Login ChatGPT/Codex indisponível');
  const usage = [];
  const runFn = createCodexRunner({ runtime, purposeRouting: { observer: { primary: 'codex:auto', effort: 'low' }, strategist: { primary: 'codex:auto', effort: 'medium' }, critic: { primary: 'codex:auto', effort: 'medium' } }, onProvider: event => { if (event.status === 'success') usage.push({ purpose: event.purpose, model: event.model, usage: event.usage, durationMs: event.durationMs }); } });
  const selected = process.argv.includes('--all') ? fixtures.cases : fixtures.cases.filter(c => ['pilot-impact', 'healthy-silence', 'internal-approval', 'commitment'].includes(c.id));
  const results = [];
  for (const fixture of selected) {
    const responses = [];
    const secretary = new Secretary({ runFn: async (prompt, options) => { const raw = await runFn(prompt, options); responses.push({ purpose: options.purpose, raw }); return raw; }, sessionId: fixture.id, objective: fixture.objective, shadow: true });
    const diagnostics = []; secretary.on('diagnostic', event => diagnostics.push(event));
    fixture.turns.forEach(text => secretary.add({ text, channel: 'meeting' }));
    await secretary.observe();
    results.push({ id: fixture.id, expected: fixture.expected, items: secretary.ledger.items, candidates: secretary.history, diagnostics, responses });
    console.log(JSON.stringify({ scenario: fixture.id, items: secretary.ledger.items.length, candidates: secretary.history.length, failures: diagnostics.filter(d => /failed/.test(d.event)).length }));
  }
  const report = { at: new Date().toISOString(), synthetic: true, results, usage };
  const output = path.join(__dirname, '../build/quality'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'live-quality.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: 'build/quality/live-quality.json', calls: usage.length, tokens: usage.reduce((n, u) => n + (u.usage?.totalTokens || 0), 0) }));
  await runtime.stop();
  app.exit(results.some(r => r.diagnostics.some(d => /failed/.test(d.event))) ? 1 : 0);
}).catch(error => { console.error(error.message); app.exit(1); });
