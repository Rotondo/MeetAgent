const $ = (id) => document.getElementById(id);
let activeProposal = null;
let proposalTimer = null;
let meetingRunning = false;
let startBarCollapsed = false;
let audioCapture = null;
let meetingStartedAt = null;
let meetingTimer = null;
let currentCoachIntervalMs = 15_000;
let configuredOpacityPct = 93;
let meetingPhase = 'idle';
let liveMeeting = null;

function applyLiveAssistance(mode) {
  const select = $('live-assistance');
  if (select) select.value = ['silent', 'protect', 'coach'].includes(mode) ? mode : 'protect';
}

function setStatus(text = '', tone = 'info') {
  $('status').textContent = text;
  $('global-status').dataset.tone = tone;
}

// Visibilidade do bloco de iniciar vs. botão compacto ▶ na barra.
// Recolhido só vale quando a reunião NÃO está rodando.
function applyStartBarState() {
  $('start-bar').hidden = meetingRunning || startBarCollapsed;
  $('btn-start-compact').hidden = meetingRunning || !startBarCollapsed;
}

function renderChecklist(data = liveMeeting) {
  if (!data) return;
  liveMeeting = { ...liveMeeting, ...data };
  const agenda = liveMeeting.agenda ?? [];
  const coverage = liveMeeting.coverageDetail
    ?? (liveMeeting.coverage?.total == null ? liveMeeting.coverage : {});
  const validated = Object.values(coverage).filter((item) => item.status === 'validado').length;
  $('meeting-priority').hidden = !meetingRunning;
  $('meeting-lens').textContent = String(liveMeeting.lens ?? 'apresentação').toUpperCase();
  $('meeting-progress').textContent = `Agenda: ${validated}/${agenda.length}`;
  applyLiveAssistance(liveMeeting.assistanceMode ?? 'protect');
  const box = $('agenda-items');
  box.replaceChildren();
  for (const item of agenda) {
    const row = document.createElement('label'); row.className = 'check-item';
    const label = document.createElement('span'); label.textContent = item.label;
    const select = document.createElement('select');
    for (const status of ['não abordado', 'em progresso', 'validado', 'adiado']) {
      const option = document.createElement('option'); option.value = status; option.textContent = status;
      if ((coverage[item.id]?.status ?? 'não abordado') === status) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', async () => {
      const result = await window.agent.updateChecklist(item.id, select.value);
      if (result?.ok) renderChecklist({ agenda: result.agenda, coverage: result.coverageDetail, lens: result.lens });
      else setStatus(result?.error ?? 'Não foi possível atualizar a agenda.', 'error');
    });
    row.append(label, select); box.appendChild(row);
  }
  const board = $('live-board');
  board.replaceChildren();
  const boardData = liveMeeting.board ?? {};
  const sections = [
    ['Decisões', boardData.decisoes],
    ['Anúncios', boardData.anuncios],
    ['Pendências', boardData.pendencias],
    ['Compromissos', boardData.compromissos],
    ['Propostas', boardData.propostas],
    ['Riscos', boardData.riscos],
  ];
  for (const [title, items] of sections) {
    if (!Array.isArray(items) || !items.length) continue;
    const group = document.createElement('section'); group.className = 'board-group';
    const heading = document.createElement('strong'); heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
      const line = document.createElement('li');
      line.textContent = typeof item === 'string'
        ? item
        : `${item.acao ?? 'Ação'} — ${item.responsavel ?? 'sem responsável'}${item.prazo ? ` · ${item.prazo}` : ''}`;
      list.appendChild(line);
    }
    group.append(heading, list); board.appendChild(group);
  }
}

async function loadLiveMeeting() {
  const data = await window.agent.getLiveMeeting();
  if (data) renderChecklist(data);
}

$('live-assistance').addEventListener('change', async (event) => {
  const mode = event.target.value;
  const result = await window.agent.setLiveAssistance(mode);
  if (!result?.ok) {
    setStatus(result?.error ?? 'Nao foi possivel ajustar as dicas.', 'error');
    await loadLiveMeeting();
    return;
  }
  applyLiveAssistance(result.mode);
  const labels = {
    silent: 'Dicas pausadas nesta reuniao.',
    protect: 'Dicas essenciais ativadas.',
    coach: 'Mais dicas ativadas para esta reuniao.',
  };
  setStatus(labels[result.mode], 'success');
});

// ── HISTÓRICO ───────────────────────────────────────────────────────────────
function addHistory(text, cls = '') {
  const div = document.createElement('div');
  div.className = `entry ${cls}`;
  div.textContent = text;
  const h = $('history');
  h.appendChild(div);
  while (h.children.length > 8) h.removeChild(h.firstChild);
  h.scrollTop = h.scrollHeight;
}

// ── BEEP ────────────────────────────────────────────────────────────────────
function beepAt(freq) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
    osc.addEventListener('ended', () => ctx.close().catch(() => {}), { once: true });
  } catch (_) {}
}

// ── CARDS DE PROPOSTA ────────────────────────────────────────────────────────
const URGENCIA_META = {
  alerta:   { tag: '⚠ ALERTA',    cls: 'urgencia-alerta',   beepFreq: 660, autoMs: 20000 },
  coaching: { tag: '🎯 COACHING', cls: 'urgencia-coaching', beepFreq: 440, autoMs: 12000 },
  insight:  { tag: '💡 INSIGHT',  cls: 'urgencia-insight',  beepFreq: 880, autoMs: 12000 },
  copilot:  { tag: '🧭 COPILOTO', cls: 'urgencia-copilot',  beepFreq: 520, autoMs: 20000 },
  alta:     { tag: '▶ AÇÃO',      cls: 'urgencia-alta',     beepFreq: 880, autoMs: 15000 },
};

function showProposal(s) {
  if (activeProposal) decide(false, 'ignorada');
  activeProposal = s;
  const meta = URGENCIA_META[s.urgencia] ?? URGENCIA_META.alta;
  const tag = s.urgencia === 'alta' && s.skill ? `▶ ${s.skill.toUpperCase()}` : meta.tag;

  $('proposal-tag').textContent = tag;
  $('proposal-text').textContent = s.proposta;
  $('proposal-act').textContent = s.act ? `Ato: ${s.act}` : '';
  $('proposal-act').hidden = !s.act;
  $('proposal-rationale').textContent = s.rationale ? `Por que agora: ${s.rationale}` : '';
  $('proposal-rationale').hidden = !s.rationale;
  const panel = $('proposal');
  panel.className = meta.cls;
  panel.hidden = false;

  const isPassivo = ['coaching', 'insight', 'copilot'].includes(s.urgencia);
  $('btn-approve').hidden = isPassivo;
  $('btn-approve').textContent = s.urgencia === 'alerta' ? '✔ Entendido' : '✔ Usar';
  $('btn-reject').textContent = isPassivo ? 'Dispensar' : '↓ Guardar';
  $('proposal-feedback').hidden = !isPassivo;

  // barra de tempo restante
  const fill = $('proposal-timer-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  requestAnimationFrame(() => {
    fill.style.transition = `width ${meta.autoMs}ms linear`;
    fill.style.width = '0%';
  });

  if (s.urgencia === 'alta') beepAt(meta.beepFreq);
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(() => decide(false, 'ignorada'), meta.autoMs);
}

function decide(approved, outcome = approved ? 'usada' : 'dispensada') {
  if (!activeProposal) return;
  clearTimeout(proposalTimer);
  const isPassivo = ['coaching', 'insight', 'copilot'].includes(activeProposal.urgencia);
  // Todo card precisa liberar a fila no processo principal. Cards passivos não
  // executam nada, mas ainda assim precisam ser resolvidos para o próximo aparecer.
  window.agent.decision(activeProposal.id, approved);
  window.agent.recordInterventionFeedback(activeProposal.id, outcome);
  const label = isPassivo ? '○ visto' : (approved ? '✓ usado' : '↓ guardado');
  addHistory(`${label}: ${activeProposal.proposta}`, approved ? 'ok' : '');
  const ratedId = activeProposal.id;
  const row = $('history').lastElementChild;
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Reavaliar recomendação');
  for (const value of ['ignorada', 'usada', 'útil', 'óbvia', 'errada', 'atrasada', 'dispensada']) {
    const option = document.createElement('option'); option.value = value; option.textContent = value; option.selected = value === outcome; select.append(option);
  }
  select.addEventListener('change', () => window.agent.recordInterventionFeedback(ratedId, select.value)); row.append(select);
  activeProposal = null;
  $('proposal').hidden = true;
  $('proposal').className = '';
}

// ── IPC EVENTS ───────────────────────────────────────────────────────────────
window.agent.on('suggestion', showProposal);
window.agent.on('result', (r) => addHistory(r.error ? `erro: ${r.error}` : r.output, r.error ? 'err' : 'ok'));
window.agent.on('status', (s) => { setStatus(s.text, /falha|erro|indisponível/i.test(s.text) ? 'error' : 'info'); });
window.agent.on('session-log', ({ filePath }) => addHistory(`Diagnóstico da sessão ativo: ${filePath}`, 'ok'));
window.agent.on('transcription-state', ({ connected }) => {
  const el = $('health-deepgram');
  el.textContent = `${connected ? '●' : '○'} Deepgram`;
  el.className = connected ? 'ok' : 'off';
});
window.agent.on('coach-state', ({ connected }) => {
  const el = $('health-coach');
  el.textContent = connected ? `● Coach ${Math.round(currentCoachIntervalMs / 1000)}s` : '○ Coach indisponível';
  el.className = connected ? 'ok' : 'off';
});
window.agent.on('provider-state', ({ provider, status }) => {
  const el = $('health-ai');
  if (status === 'started') {
    el.textContent = `◐ IA ${provider}`;
    el.className = '';
  } else if (status === 'success') {
    el.textContent = `● IA ${provider}`;
    el.className = 'ok';
  } else if (status === 'failed' || status === 'skipped') {
    el.textContent = `○ IA ${provider}`;
    el.className = 'off';
  }
});
window.agent.on('meeting-state', (m) => {
  const wasRunning = meetingRunning;
  meetingRunning = m.running;
  meetingPhase = m.phase || (m.running ? 'live' : 'idle');
  applyPanelOpacity(['ending', 'report', 'recoverable-error'].includes(meetingPhase) ? 100 : configuredOpacityPct);
  const interactive = m.running && (m.phase === 'live' || m.phase === 'degraded');
  $('meeting-label').textContent = m.running ? `● ${m.project}` : '';
  $('btn-end').hidden = !m.running;
  $('capture-health').hidden = !m.running;
  if (m.running && m.coverage) {
    $('meeting-priority').hidden = false;
    $('meeting-lens').textContent = String(m.lens ?? 'apresentação').toUpperCase();
    $('meeting-progress').textContent = `Agenda: ${m.coverage.validated}/${m.coverage.total}`;
  }
  if (m.running && m.adaptive?.confidence >= 0.6) {
    $('meeting-lens').textContent = `${String(m.adaptive.mode).toUpperCase()} · ${String(m.adaptive.role).toUpperCase()}`;
  }
  if (m.running && (m.board || m.agenda || m.coverageDetail)) renderChecklist(m);
  $('btn-suggest-question').hidden = !interactive;
  $('chat-input').disabled = !interactive;
  if (!m.running) $('end-confirm').hidden = true; // some ao encerrar
  applyStartBarState();
  if (m.running && !wasRunning) {
    addHistory(`Reunião iniciada — ${m.project}`, 'ok');
    $('question-card').hidden = true;
    meetingStartedAt = Date.now();
    clearInterval(meetingTimer);
    meetingTimer = setInterval(updateMeetingTimer, 1000);
    updateMeetingTimer();
    loadLiveMeeting().catch(() => {});
  } else if (!m.running && wasRunning) {
    clearInterval(meetingTimer);
    meetingTimer = null;
    meetingStartedAt = null;
    $('meeting-timer').textContent = '00:00:00';
    setSourceHealth('system', false);
    setSourceHealth('microphone', false);
    const deepgram = $('health-deepgram');
    deepgram.textContent = '○ Deepgram';
    deepgram.className = 'off';
    $('health-coach').textContent = '○ Coach';
    $('health-coach').className = 'off';
    $('health-ai').textContent = '○ IA';
    $('health-ai').className = 'off';
    stopAudioCapture();
    $('meeting-priority').hidden = true;
    $('live-checklist').hidden = true;
    liveMeeting = null;
  }
});
function createReportSection(title, id = '') {
  const section = document.createElement('section');
  section.className = 'report-section';
  if (id) section.id = id;
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function appendReportText(container, title, text, id = '') {
  const section = createReportSection(title, id);
  const paragraph = document.createElement('p');
  paragraph.textContent = text || '—';
  section.appendChild(paragraph);
  container.appendChild(section);
  return section;
}

window.agent.on('closing-report', ({
  report,
  pendingActions,
  executionResults,
  savedPath,
  usageEvents = [],
  usageSummary = null,
  warning = null,
}) => {
  meetingPhase = 'report';
  applyPanelOpacity(100);
  $('view-meeting').hidden = true;
  $('view-config').hidden = true;
  $('view-closing').hidden = false;
  const content = $('closing-content');
  content.replaceChildren();
  if (warning) {
    const warningBox = document.createElement('p');
    warningBox.className = 'report-warning';
    warningBox.textContent = warning;
    content.appendChild(warningBox);
  }

  const summarySection = appendReportText(content, 'Sumário', report.sumario);
  const tone = document.createElement('span');
  tone.className = 'report-tone';
  tone.textContent = report.tom_da_reuniao || 'não analisado';
  summarySection.appendChild(tone);

  const personalSections = [
    ['O que mudou', report.o_que_mudou, null],
    ['Decisões confirmadas', report.decisoes_confirmadas, 'decisao'],
    ['Anúncios operacionais', report.anuncios_operacionais, 'anuncio'],
  ];
  for (const [title, values, key] of personalSections) {
    if (!Array.isArray(values) || !values.length) continue;
    const section = createReportSection(title); const list = document.createElement('ul');
    for (const value of values) {
      const item = document.createElement('li'); const main = typeof value === 'string' ? value : value?.[key] || value?.text;
      item.textContent = `${main || 'Item não informado'}${value?.evidencia ? ` · Evidência: ${value.evidencia}` : ''}`; list.appendChild(item);
    }
    section.appendChild(list); content.appendChild(section);
  }

  const steps = createReportSection('Próximos passos');
  const stepsList = document.createElement('ul');
  const nextSteps = report.proximos_passos ?? [];
  for (const step of nextSteps) {
    const item = document.createElement('li');
    item.textContent = [
      step.acao,
      step.responsavel ? `Responsável: ${step.responsavel}` : null,
      step.prazo ? `Prazo: ${step.prazo}` : null,
      step.evidencia ? `Evidência: ${step.evidencia}` : null,
    ].filter(Boolean).join(' · ');
    stepsList.appendChild(item);
  }
  if (!nextSteps.length) {
    const item = document.createElement('li');
    item.textContent = 'Nenhum compromisso individual confirmado.';
    stepsList.appendChild(item);
  }
  steps.appendChild(stepsList);
  content.appendChild(steps);

  const routeEvaluation = report.avaliacao_roteiro ?? [];
  if (routeEvaluation.length) {
    const routeSection = createReportSection('Avaliação do roteiro');
    const routeList = document.createElement('ul');
    for (const item of routeEvaluation) {
      const li = document.createElement('li');
      li.textContent = `${item.ato}: ${item.status}${item.evidencia ? ` · ${item.evidencia}` : ''}${item.lacuna ? ` · Lacuna: ${item.lacuna}` : ''}`;
      routeList.appendChild(li);
    }
    routeSection.appendChild(routeList);
    content.appendChild(routeSection);
  }

  const optionalLists = [
    ['Encaminhamentos sugeridos · confirmação necessária', report.encaminhamentos_sugeridos],
    ['Relevância para você', report.relevancia_para_voce],
    ['O que acompanhar', report.o_que_acompanhar],
    ['Perguntas abertas', report.perguntas_abertas],
    ['Oportunidades', report.oportunidades],
    ['Desvios de foco', report.desvios_de_foco],
    ['Fontes utilizadas', report.fontes_utilizadas],
  ];
  for (const [title, values] of optionalLists) {
    if (!Array.isArray(values) || !values.length) continue;
    const section = createReportSection(title);
    const list = document.createElement('ul');
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = typeof value === 'string' ? value : JSON.stringify(value);
      list.appendChild(item);
    }
    section.appendChild(list);
    content.appendChild(section);
  }

  const crm = report.registro_crm ?? {};
  const crmSection = createReportSection('Registro CRM');
  const crmGrid = document.createElement('dl');
  crmGrid.className = 'report-grid';
  const crmRows = [
    ['Data', crm.data],
    ['Participantes', (crm.participantes ?? []).join(', ')],
    ['Assunto', crm.assunto],
    ['Resultado', crm.outcome],
    ['Notas', crm.notas],
  ];
  for (const [label, value] of crmRows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value || '—';
    crmGrid.append(dt, dd);
  }
  crmSection.appendChild(crmGrid);
  content.appendChild(crmSection);

  const usageSection = createReportSection('Consumo de IA');
  const usageList = document.createElement('ul');
  const usageGroups = usageSummary?.groups ?? [];
  for (const item of usageGroups) {
    const li = document.createElement('li');
    li.textContent = `${item.provider}${item.model ? ` (${item.model})` : ''} · ${item.purpose || 'outros'}: ${item.totalTokens ?? 'não informado'} tokens em ${item.calls ?? 0} chamada(s)`;
    usageList.appendChild(li);
  }
  if (!usageGroups.length) {
    const li = document.createElement('li');
    li.textContent = 'Nenhuma chamada contabilizada.';
    usageList.appendChild(li);
  }
  usageSection.appendChild(usageList);
  const usageTotal = document.createElement('p');
  usageTotal.textContent = `Total: ${usageSummary?.totalTokens ?? 0} tokens`;
  usageSection.appendChild(usageTotal);
  const cost = document.createElement('p');
  cost.className = 'report-cost';
  cost.textContent = `Custo estimado: ${usageSummary?.estimatedCostUsd == null ? 'indisponível' : `~US$ ${usageSummary.estimatedCostUsd.toFixed(6)}`}`;
  usageSection.appendChild(cost);
  content.appendChild(usageSection);

  const executionsSection = createReportSection('Execuções', 'report-executions');
  const executionsList = document.createElement('ul');
  executionsList.id = 'report-executions-list';
  for (const result of executionResults) {
    const li = document.createElement('li');
    li.textContent = `${result.skill}: ${result.error ?? result.output}`;
    executionsList.appendChild(li);
  }
  if (!executionResults.length) {
    const li = document.createElement('li');
    li.dataset.empty = '1';
    li.textContent = 'Nenhuma ação executada.';
    executionsList.appendChild(li);
  }
  executionsSection.appendChild(executionsList);
  content.appendChild(executionsSection);

  const saved = createReportSection('Arquivo');
  const savedCode = document.createElement('code');
  savedCode.className = 'report-path';
  savedCode.textContent = savedPath;
  saved.appendChild(savedCode);
  content.appendChild(saved);
  renderClosingActions(pendingActions ?? []);
  setStatus(warning ? 'Encerrado com relatório parcial; a transcrição foi preservada.' : 'Encerramento concluído.', warning ? 'warning' : 'success');
});
window.agent.on('closing-actions-result', ({ results }) => {
  for (const result of results) {
    addHistory(result.error ? `erro: ${result.error}` : `${result.skill}: ${result.output}`, result.error ? 'err' : 'ok');
    const row = document.querySelector(`[data-closing-id="${CSS.escape(String(result.id))}"]`);
    if (row) {
      row.classList.add(result.error ? 'err' : 'done');
      const input = row.querySelector('input');
      input.checked = false;
      input.disabled = true;
    }
    const executionsList = $('report-executions-list');
    executionsList?.querySelector('[data-empty="1"]')?.remove();
    if (executionsList) {
      const item = document.createElement('li');
      item.textContent = `${result.error ? 'ERRO' : 'EXECUTADO'} — ${result.skill}: ${result.error ?? result.output}`;
      executionsList.appendChild(item);
    }
  }
});
window.agent.on('request-audio-capture', ({ audioMode }) => startMeetingAudio(audioMode));

function updateMeetingTimer() {
  if (!meetingStartedAt) return;
  const seconds = Math.floor((Date.now() - meetingStartedAt) / 1000);
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  $('meeting-timer').textContent = `${h}:${m}:${s}`;
}

function setSourceHealth(source, ok) {
  const id = source === 'system' ? 'health-system' : 'health-mic';
  const label = source === 'system' ? 'Sistema' : 'Microfone';
  $(id).textContent = `${ok ? '●' : '○'} ${label}`;
  $(id).className = ok ? 'ok' : 'off';
}

async function stopAudioCapture() {
  const capture = audioCapture;
  audioCapture = null;
  if (capture) await capture.stop().catch(() => {});
  $('audio-meter').querySelector('i').style.width = '0%';
}

function renderClosingActions(actions) {
  const box = $('closing-action-list');
  box.innerHTML = '';
  $('closing-actions').hidden = !actions.length;
  for (const action of actions) {
    const label = document.createElement('label');
    label.dataset.closingId = action.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.value = action.id;
    const text = document.createElement('span');
    text.textContent = `${action.proposta} (${action.skill})`;
    label.append(cb, text);
    box.appendChild(label);
  }
}

// ── TECLADO ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (meetingRunning && e.key.toLowerCase() === 'a' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    $('live-checklist').hidden = !$('live-checklist').hidden;
    return;
  }
  if (!activeProposal || $('proposal').hidden || !$('view-config').hidden || !$('view-closing').hidden) return;
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Enter') decide(true);
  if (e.key === 'Escape') decide(false);
});

// ── BOTÕES DA BARRA ──────────────────────────────────────────────────────────
$('btn-approve').addEventListener('click', () => decide(true));
$('btn-reject').addEventListener('click',  () => decide(false));
document.querySelectorAll('[data-outcome]').forEach(button => button.addEventListener('click', () => decide(false, button.dataset.outcome)));
$('btn-toggle-checklist').addEventListener('click', () => { $('live-checklist').hidden = !$('live-checklist').hidden; });
$('btn-close').addEventListener('click',    () => window.agent.closeApp());
$('btn-minimize').addEventListener('click', () => window.agent.minimizeApp());

$('btn-collapse').addEventListener('click', async () => {
  const collapsed = await window.agent.toggleCollapse();
  $('btn-collapse').textContent = collapsed ? '▼' : '▲';
  $('btn-collapse').title = collapsed ? 'Expandir overlay' : 'Recolher para a barra';
});

// Recolher o bloco de iniciar (persiste a escolha)
$('btn-collapse-start').addEventListener('click', async () => {
  startBarCollapsed = true;
  applyStartBarState();
  await window.agent.saveSettings({ startBarCollapsed: true });
});

// Botão compacto ▶ na barra: reexpande p/ próxima vez e inicia com o último projeto
$('start-bar').prepend($('btn-start-now'), document.querySelector('.shortcut-help'));
$('btn-start-now').addEventListener('click', async () => {
  $('btn-start-now').disabled = true;
  try {
    const result = await window.agent.startQuickMeeting();
    if (!result?.ok) setStatus(result?.error ?? 'Não foi possível iniciar agora.', 'error');
  } catch (err) { setStatus(`Falha ao iniciar agora: ${err.message}`, 'error'); }
  finally { $('btn-start-now').disabled = false; }
});

$('btn-start-compact').addEventListener('click', async () => {
  startBarCollapsed = false;
  await window.agent.saveSettings({ startBarCollapsed: false });
  iniciarReuniao();
});

// Encerrar: mostra faixa de confirmação com dois botões explícitos
$('btn-end').addEventListener('click', () => { $('end-confirm').hidden = false; });
$('btn-end-no').addEventListener('click', () => { $('end-confirm').hidden = true; });
$('btn-end-yes').addEventListener('click', () => {
  $('end-confirm').hidden = true;
  endMeeting();
});

async function endMeeting() {
  meetingPhase = 'ending';
  applyPanelOpacity(100);
  $('btn-end').disabled = true;
  setStatus('Finalizando áudio e transcrição…');
  try {
    await stopAudioCapture();
    const result = await window.agent.endMeeting();
    if (!result?.ok) setStatus(result?.error ?? 'Falha ao encerrar.', 'error');
  } catch (err) {
    setStatus(`Falha ao encerrar: ${err.message}`, 'error');
  } finally {
    $('btn-end').disabled = false;
  }
}

$('btn-close-report').addEventListener('click', () => {
  $('view-closing').hidden = true;
  $('view-meeting').hidden = false;
  meetingPhase = 'idle';
  applyPanelOpacity(configuredOpacityPct);
});
$('btn-copy-report').addEventListener('click', () => {
  navigator.clipboard.writeText($('closing-content').textContent).then(() => {
    $('btn-copy-report').textContent = '✔ Copiado!';
    setTimeout(() => { $('btn-copy-report').textContent = '📋 Copiar'; }, 2000);
  }).catch((err) => setStatus(`Falha ao copiar: ${err.message}`, 'error'));
});
$('btn-execute-closing').addEventListener('click', async () => {
  const ids = [...$('closing-action-list').querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);
  if (!ids.length) return;
  $('btn-execute-closing').disabled = true;
  $('btn-execute-closing').textContent = '⏳ Executando…';
  try {
    const result = await window.agent.executeClosingActions(ids);
    if (!result?.ok) setStatus(result?.error ?? 'Falha ao executar ações.', 'error');
  } catch (err) {
    setStatus(`Falha ao executar ações: ${err.message}`, 'error');
  } finally {
    $('btn-execute-closing').disabled = false;
    $('btn-execute-closing').textContent = '▶ Executar selecionadas';
  }
});
$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addHistory(`você: ${text}`);
  $('chat-input').value = '';
  $('chat-input').disabled = true;
  try {
    const result = await window.agent.chat(text);
    addHistory(result?.ok ? result.output : `erro: ${result?.error ?? 'sem resposta'}`, result?.ok ? 'ok' : 'err');
  } catch (err) {
    addHistory(`erro: ${err.message}`, 'err');
  } finally {
    $('chat-input').disabled = !meetingRunning;
  }
});
$('btn-suggest-question').addEventListener('click', async () => {
  if (!meetingRunning) return;
  const button = $('btn-suggest-question');
  button.disabled = true;
  button.textContent = '⏳ Analisando discussão…';
  setStatus('Gerando uma pergunta com o contexto recente…');
  try {
    const result = await window.agent.suggestQuestion();
    if (!result?.ok) throw new Error(result?.error ?? 'sem resposta');
    $('question-text').textContent = result.question;
    $('question-rationale').textContent = result.rationale;
    $('question-act').textContent = result.act ? `Ato: ${result.act}` : '';
    $('question-act').hidden = !result.act;
    $('question-provider').textContent = result.provider ? `Gerado por ${result.provider}` : '';
    $('question-card').hidden = false;
    setStatus('Pergunta pronta.', 'success');
  } catch (err) {
    setStatus(`Não foi possível sugerir: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '💬 Sugerir pergunta';
  }
});

// ── CONFIG: toggle ────────────────────────────────────────────────────────────
$('btn-config').addEventListener('click', () => {
  const goingToConfig = $('view-config').hidden;
  $('view-config').hidden = !goingToConfig;
  $('view-meeting').hidden = goingToConfig;
  $('view-closing').hidden = true;
  $('btn-config').title = goingToConfig ? 'Voltar à reunião' : 'Configurações';
  $('btn-config').textContent = goingToConfig ? '←' : '⚙';
  if (goingToConfig) refreshConfig();
});

// ── CONFIG: Deepgram ─────────────────────────────────────────────────────────
$('cfg-save-deepgram').addEventListener('click', async () => {
  const key = $('cfg-deepgram-key').value.trim();
  if (!key) {
    $('status').textContent = '⚠ Cole uma API Key antes de salvar.';
    return;
  }
  try {
    await window.agent.saveDeepgramKey(key);
    $('cfg-deepgram-key').value = '';
    setDeepgramStatus(true);
    $('status').textContent = '✔ API Key protegida e salva.';
  } catch (err) {
    $('status').textContent = `Falha ao salvar: ${err.message}`;
  }
});

$('cfg-clear-deepgram').addEventListener('click', async () => {
  await window.agent.clearDeepgramKey();
  $('cfg-deepgram-key').value = '';
  setDeepgramStatus(false);
  $('status').textContent = 'API Key removida.';
});

function setDeepgramStatus(ok) {
  const el = $('deepgram-status');
  el.textContent = ok ? '✔ configurado' : '○ não configurado';
  el.className = 'step-status' + (ok ? ' ok' : '');
}

let codexModelsCache = [];

function availableEfforts(modelId) {
  const model = codexModelsCache.find((item) => item.id === modelId || item.model === modelId);
  return (model?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
}

function fillEffortSelect(select, modelId, selected = null) {
  const efforts = availableEfforts(modelId);
  const values = efforts.length ? efforts : ['low', 'medium', 'high'];
  select.innerHTML = '';
  for (const value of values) option(select, value, value);
  select.value = values.includes(selected) ? selected : (values.includes('medium') ? 'medium' : values[0]);
}

function fillModelSelectors(store) {
  for (const select of document.querySelectorAll('[data-model-purpose]')) {
    const purpose = select.dataset.modelPurpose;
    const route = store.settings?.modelRouting?.[purpose] || {};
    const selected = String(route.primary || 'codex:auto').replace(/^codex:/, '');
    select.innerHTML = '';
    option(select, 'auto', 'Automático (recomendado)');
    for (const model of codexModelsCache) option(select, model.id || model.model, model.displayName || model.id || model.model);
    select.value = [...select.options].some((item) => item.value === selected) ? selected : 'auto';
    const effort = document.querySelector(`[data-effort-purpose="${purpose}"]`);
    fillEffortSelect(effort, select.value, route.effort);
  }
}

async function saveModelChoice(purpose) {
  const store = await window.agent.getStore();
  const modelRouting = structuredClone(store.settings?.modelRouting || {});
  const model = document.querySelector(`[data-model-purpose="${purpose}"]`).value;
  const effort = document.querySelector(`[data-effort-purpose="${purpose}"]`).value;
  modelRouting[purpose] = { primary: `codex:${model}`, fallback: null, effort };
  await window.agent.saveSettings({ aiProfile: 'personalizado', modelRouting });
  $('cfg-ai-profile').value = 'personalizado';
  setStatus('Modelo salvo para a próxima reunião.', 'success');
}

for (const select of document.querySelectorAll('[data-model-purpose]')) {
  select.addEventListener('change', async () => {
    const purpose = select.dataset.modelPurpose;
    fillEffortSelect(document.querySelector(`[data-effort-purpose="${purpose}"]`), select.value);
    await saveModelChoice(purpose);
  });
}
for (const select of document.querySelectorAll('[data-effort-purpose]')) {
  select.addEventListener('change', () => saveModelChoice(select.dataset.effortPurpose));
}

$('cfg-connect-codex').addEventListener('click', async () => {
  try { setStatus('Abrindo o login do ChatGPT…'); await window.agent.codexLogin(); setStatus('Conclua o login no navegador.', 'success'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-disconnect-codex').addEventListener('click', async () => {
  try { await window.agent.codexLogout(); await refreshConfig(); setStatus('ChatGPT desconectado.', 'success'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-refresh-models').addEventListener('click', async () => {
  try { codexModelsCache = await window.agent.codexModels(); await refreshConfig(); setStatus('Catálogo de modelos atualizado.', 'success'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-reprocess-report').addEventListener('click', async () => {
  const filename = $('cfg-partial-report').value;
  if (!filename) return setStatus('Nenhum relatório parcial disponível.', 'error');
  try {
    setStatus('Reprocessando a transcrição preservada…');
    const result = await window.agent.reprocessPartialReport(filename);
    await refreshConfig();
    setStatus(`Análise recuperada: ${result.filename}`, 'success');
  } catch (error) { setStatus(error.message, 'error'); }
});
window.agent.on('codex-account', () => refreshConfig());

$('cfg-ai-profile').addEventListener('change', async (event) => {
  await window.agent.saveSettings({ aiProfile: event.target.value });
  await refreshConfig();
  setStatus('Perfil de IA salvo para a próxima reunião.', 'success');
});

$('cfg-save-google').addEventListener('click', async () => {
  try {
    await window.agent.saveGoogleCredentials({ clientId: $('cfg-google-client-id').value, clientSecret: $('cfg-google-client-secret').value });
    $('cfg-google-client-id').value = ''; $('cfg-google-client-secret').value = '';
    setStatus('Credenciais Google protegidas e salvas.', 'success'); await refreshConfig();
  } catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-connect-google').addEventListener('click', async () => {
  try { setStatus('Conclua a autorização no navegador…'); await window.agent.connectGoogle(); setStatus('Google Calendar e Drive conectados.', 'success'); await refreshConfig(); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-disconnect-google').addEventListener('click', async () => { await window.agent.disconnectGoogle(); await refreshConfig(); setStatus('Conta Google desconectada.', 'success'); });
$('cfg-sync-calendar').addEventListener('click', async () => {
  try { const result = await window.agent.syncGoogleCalendar(); await refreshAgendaSetup(); setStatus(`${result.count} evento(s) sincronizado(s).`, 'success'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-save-fireflies').addEventListener('click', async () => {
  try { await window.agent.saveFirefliesKey($('cfg-fireflies-key').value); $('cfg-fireflies-key').value = ''; await refreshConfig(); setStatus('Fireflies configurado.', 'success'); }
  catch (error) { setStatus(error.message, 'error'); }
});
$('cfg-clear-fireflies').addEventListener('click', async () => { await window.agent.clearFirefliesKey(); await refreshConfig(); });
$('cfg-local-folder').addEventListener('click', async () => {
  const folder = await window.agent.pickFolder();
  if (!folder) return;
  await window.agent.saveSettings({ localContextFolder: folder });
  await refreshConfig(); setStatus('Pasta de documentos salva.', 'success');
});

// ── CONFIG: preferências ──────────────────────────────────────────────────────
function applyPanelOpacity(pct) {
  document.documentElement.style.setProperty('--panel-alpha', String(pct / 100));
}

function applyConfiguredOpacity(pct) {
  configuredOpacityPct = pct;
  if (!['ending', 'report', 'recoverable-error'].includes(meetingPhase)) applyPanelOpacity(pct);
  $('cfg-opacity-val').textContent = `${pct}%`;
}

$('cfg-opacity').addEventListener('input', (e) => applyConfiguredOpacity(Number(e.target.value)));
$('cfg-opacity').addEventListener('change', async (e) => {
  await window.agent.saveSettings({ opacity: Number(e.target.value) / 100 });
  $('status').textContent = '✔ Opacidade da reunião salva.';
});
$('btn-open-logs').addEventListener('click', async () => {
  const result = await window.agent.openLogs();
  setStatus(result?.ok ? `Log localizado: ${result.path}` : `Não foi possível abrir os logs: ${result?.error}`, result?.ok ? 'success' : 'error');
});

$('cfg-auto-analysis').addEventListener('change', async (e) => {
  await window.agent.saveSettings({ autoAnalysis: e.target.checked });
  setStatus(e.target.checked
    ? 'Insights automáticos ativados; haverá chamadas adicionais de IA.'
    : 'Insights automáticos desativados; o coach e a pergunta manual continuam ativos.', 'success');
});
$('cfg-adaptive-meeting').addEventListener('change', async (e) => {
  await window.agent.saveSettings({ adaptiveMeeting: e.target.checked });
  setStatus('Adaptação automática salva para a próxima reunião.', 'success');
});
$('cfg-audio-mode').addEventListener('change', async (e) => {
  await window.agent.saveSettings({ audioMode: e.target.value });
  $('status').textContent = '✔ Fonte de áudio salva.';
});
$('cfg-coach-interval').addEventListener('change', async (e) => {
  currentCoachIntervalMs = Number(e.target.value);
  await window.agent.saveSettings({ coachIntervalMs: currentCoachIntervalMs });
  $('status').textContent = '✔ Frequência do coach salva. Vale a partir da próxima reunião.';
});

// ── CONFIG: contextos e direcionais ──────────────────────────────────────────
let editingContextPath = null;
let editorStore = null;

function option(select, value, label) {
  const item = document.createElement('option');
  item.value = value; item.textContent = label; select.appendChild(item);
}

function editorContext() {
  return (editorStore?.contexts ?? []).find((item) => item.id === $('ctx-editor-select').value) ?? null;
}

function editorDirectional() {
  return editorContext()?.directions?.find((item) => item.id === $('dir-editor-select').value) ?? null;
}

function renderPackagePreview(validation) {
  const box = $('context-package-preview');
  box.replaceChildren(); box.hidden = false;
  if (!validation?.valid) {
    box.className = 'package-preview invalid';
    box.textContent = `Pacote inválido: ${(validation?.errors ?? ['sem conteúdo']).join(' · ')}`;
    return;
  }
  box.className = 'package-preview valid';
  const cadence = validation.analysisIntervalSeconds ? ` · Consulta a cada ${validation.analysisIntervalSeconds}s.` : ' · Cadência da preferência geral.';
  box.textContent = `Pronto para revisão: ${validation.attributes.context_name} → ${validation.attributes.directional_name}. Público: ${validation.audiences.join(', ') || 'livre'} · Objetivo: ${validation.objectives.join(', ') || 'livre'}${cadence}`;
}

function populateDirectionalEditor(context, selectedId = null) {
  const select = $('dir-editor-select');
  select.innerHTML = '';
  option(select, '__new__', '＋ Novo direcional');
  for (const direction of context?.directions ?? []) option(select, direction.id, `${direction.status === 'ativo' ? '●' : '○'} ${direction.name}`);
  if (selectedId && [...select.options].some((item) => item.value === selectedId)) select.value = selectedId;
}

function loadEditorFields() {
  const context = editorContext();
  const directional = editorDirectional();
  editingContextPath = context?.path ?? null;
  $('ctx-name').value = context?.name ?? '';
  $('ctx-description').value = context?.description ?? '';
  $('ctx-path').textContent = editingContextPath || 'Sem pasta selecionada';
  $('dir-name').value = directional?.name ?? '';
  $('ctx-brief').value = directional?.sourceBrief ?? '';
  $('ctx-package').value = directional?.packageMarkdown ?? '';
  $('context-package-preview').hidden = true;
}

async function refreshConfig() {
  const store = await window.agent.getStore();
  const keyStatus = await window.agent.deepgramKeyStatus();
  const codexStatus = await window.agent.codexStatus();
  const integrationStatus = await window.agent.integrationStatus();
  setDeepgramStatus(keyStatus.configured);
  $('providers-status').textContent = codexStatus.connected ? '✔ ChatGPT conectado' : (codexStatus.available ? '○ login necessário' : '○ Codex indisponível');
  $('providers-status').className = 'step-status' + (codexStatus.connected ? ' ok' : '');
  $('codex-account-detail').textContent = codexStatus.connected
    ? `${codexStatus.account?.email || 'Conta ChatGPT'} · plano ${codexStatus.account?.planType || 'não informado'}`
    : (codexStatus.error || 'Entre com o ChatGPT para habilitar a análise.');
  if (codexStatus.connected && !codexModelsCache.length) {
    try { codexModelsCache = await window.agent.codexModels(); }
    catch (error) { setStatus(`Não foi possível atualizar modelos: ${error.message}`, 'error'); }
  }
  const partialReports = await window.agent.partialReports();
  const partialSelect = $('cfg-partial-report');
  const previousPartial = partialSelect.value;
  partialSelect.innerHTML = '';
  if (!partialReports.length) option(partialSelect, '', 'Nenhum relatório parcial');
  for (const filename of partialReports) option(partialSelect, filename, filename.replace('-parcial.md', ''));
  if (partialReports.includes(previousPartial)) partialSelect.value = previousPartial;
  const integrations = [integrationStatus.googleConnected && 'Google', integrationStatus.fireflies && 'Fireflies'].filter(Boolean);
  $('integrations-status').textContent = integrations.length ? `✔ ${integrations.join(' + ')}` : '○ não conectado';
  $('integrations-status').className = 'step-status' + (integrations.length ? ' ok' : '');

  const pct = Math.round((store.settings?.opacity ?? 0.93) * 100);
  $('cfg-opacity').value = pct;
  applyConfiguredOpacity(pct);
  $('cfg-auto-analysis').checked = Boolean(store.settings?.autoAnalysis);
  $('cfg-adaptive-meeting').checked = store.settings?.adaptiveMeeting !== false;
  $('cfg-ai-profile').value = store.settings?.aiProfile ?? 'equilibrado';
  fillModelSelectors(store);
  $('cfg-local-folder-label').textContent = store.settings?.localContextFolder || 'Nenhuma pasta';
  $('cfg-audio-mode').value = store.settings?.audioMode ?? 'both';
  currentCoachIntervalMs = Number(store.settings?.coachIntervalMs ?? 15_000);
  $('cfg-coach-interval').value = String(currentCoachIntervalMs);

  editorStore = store;
  const ul = $('context-list');
  ul.innerHTML = '';

  const contexts = store.contexts ?? [];
  $('context-status').textContent = contexts.length ? `✔ ${contexts.length} contexto(s)` : '○ nenhum contexto';
  $('context-status').className = 'step-status' + (contexts.length ? ' ok' : '');

  for (const context of contexts) {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${context.name} · ${context.directions.filter((item) => item.status === 'ativo').length} direcional(is) ativo(s)`;
    nameSpan.title = context.description || context.path || context.name;

    const btnDel = document.createElement('button');
    btnDel.textContent = '✕';
    btnDel.title = `Remover contexto ${context.name} (2 cliques)`;
    btnDel.addEventListener('click', async () => {
      if (btnDel.dataset.confirming) {
        await window.agent.deleteContext(context.id);
        refreshConfig();
        return;
      }
      btnDel.dataset.confirming = '1';
      btnDel.textContent = 'confirmar?';
      setTimeout(() => { delete btnDel.dataset.confirming; btnDel.textContent = '✕'; }, 3000);
    });

    li.appendChild(nameSpan);
    li.appendChild(btnDel);
    ul.appendChild(li);
  }

  const editContext = $('ctx-editor-select');
  const previous = editContext.value;
  editContext.innerHTML = '';
  option(editContext, '__new__', '＋ Novo contexto');
  for (const context of contexts) option(editContext, context.id, context.name);
  if (previous && [...editContext.options].some((item) => item.value === previous)) editContext.value = previous;
  populateDirectionalEditor(editorContext());
  loadEditorFields();
  refreshAgendaSetup();
}

$('ctx-editor-select').addEventListener('change', () => {
  populateDirectionalEditor(editorContext());
  loadEditorFields();
});
$('dir-editor-select').addEventListener('change', loadEditorFields);

$('ctx-pick-folder').addEventListener('click', async () => {
  const folder = await window.agent.pickFolder();
  if (!folder) return;
  editingContextPath = folder;
  $('ctx-path').textContent = folder;
  if (!$('ctx-name').value.trim()) $('ctx-name').value = folder.split(/[\\/]/).pop();
});

$('btn-copy-context-prompt').addEventListener('click', async () => {
  const prompt = await window.agent.buildContextPrompt({ contextName: $('ctx-name').value.trim(), directionalName: $('dir-name').value.trim(), brief: $('ctx-brief').value.trim() });
  await navigator.clipboard.writeText(prompt);
  setStatus('Prompt copiado. Use seu LLM externo e cole o pacote Markdown abaixo.', 'success');
});

$('btn-validate-context-package').addEventListener('click', async () => {
  const validation = await window.agent.validateContextPackage($('ctx-package').value);
  renderPackagePreview(validation);
});

async function saveDirectional(status) {
  const validation = await window.agent.validateContextPackage($('ctx-package').value);
  renderPackagePreview(validation);
  if (!validation.valid) return;
  const existingContext = editorContext();
  const contextName = $('ctx-name').value.trim() || validation.attributes.context_name;
  const directionalName = $('dir-name').value.trim() || validation.attributes.directional_name;
  if (!contextName || !directionalName) return setStatus('Informe contexto e direcional.', 'error');
  const skills = editingContextPath ? (await window.agent.scanSkills(editingContextPath)).map((item) => item.name) : (existingContext?.skills ?? []);
  await window.agent.saveContext({ ...(existingContext ?? {}), name: contextName, description: $('ctx-description').value.trim() || validation.attributes.description || '', path: editingContextPath, skills, directions: existingContext?.directions ?? [] });
  const updated = await window.agent.getStore();
  const context = updated.contexts.find((item) => item.name === contextName);
  const existingDirectional = editorDirectional();
  await window.agent.saveDirectional(context.id, {
    ...(existingDirectional ?? {}),
    id: existingDirectional?.id,
    name: directionalName,
    status,
    description: validation.attributes.description || '',
    audienceDefaults: validation.audiences,
    objectiveDefaults: validation.objectives,
    liveAnalysis: /^(true|sim|yes|1)$/i.test(validation.attributes.live_analysis ?? ''),
    analysisIntervalMs: validation.analysisIntervalSeconds ? validation.analysisIntervalSeconds * 1000 : null,
    packageMarkdown: $('ctx-package').value.trim(),
    sourceBrief: $('ctx-brief').value.trim(),
    legacyPlaybook: false,
  });
  setStatus(status === 'ativo' ? 'Direcional revisado e ativado.' : 'Rascunho salvo localmente; nenhuma IA foi chamada.', 'success');
  await refreshConfig();
}
$('btn-save-context-draft').addEventListener('click', () => saveDirectional('rascunho'));
$('btn-activate-directional').addEventListener('click', () => saveDirectional('ativo'));
$('btn-clone-directional').addEventListener('click', async () => {
  const context = editorContext(); const directional = editorDirectional();
  if (!context || !directional) return setStatus('Escolha um direcional existente para duplicar.', 'error');
  const name = window.prompt('Nome do novo direcional:', `${directional.name} — cópia`);
  if (!name?.trim()) return;
  await window.agent.cloneDirectional(context.id, directional.id, name.trim());
  setStatus('Direcional duplicado como rascunho.', 'success');
  refreshConfig();
});

// ── INICIAR REUNIÃO ──────────────────────────────────────────────────────────
async function iniciarReuniao() {
  const contextId = $('start-context').value;
  const directionalId = $('start-direction').value;
  const audience = $('start-audience').value;
  const objective = $('start-objective').value;
  if (!contextId || !directionalId || !audience || !objective) {
    $('status').textContent = '⚠ Escolha contexto, direcional, público e objetivo.';
    return;
  }
  $('btn-start').textContent = '⏳ Iniciando…';
  $('btn-start').disabled = true;
  try {
    const result = await window.agent.startMeeting({ contextId, directionalId, audience, objective,
      agendaId: $('secretary-agenda').value, assistantMode: $('secretary-mode').value, assistantPilot: $('secretary-pilot').checked });
    if (result?.ok) await startMeetingAudio(result.audioMode);
    else setStatus(result?.error ?? 'Não foi possível iniciar.', 'error');
  } catch (err) {
    setStatus(`Falha ao iniciar: ${err.message}`, 'error');
  } finally {
    $('btn-start').textContent = '▶ Iniciar reunião';
    $('btn-start').disabled = false;
  }
}

async function startMeetingAudio(audioMode) {
  try {
    await stopAudioCapture();
    setSourceHealth('system', false);
    setSourceHealth('microphone', false);
    audioCapture = await window.audioCaptureApi.start({
      mode: audioMode,
      onChunk: (chunk) => window.agent.sendAudio(chunk),
      onMicrophoneChunk: (chunk) => window.agent.sendMicrophoneAudio(chunk),
      onLevel: (level) => { $('audio-meter').querySelector('i').style.width = `${Math.round(level * 100)}%`; },
        onSourceStatus: (source, active) => {
          setSourceHealth(source, active);
          window.agent.setAudioSourceState(source, active);
        },
    });
    const hasMicrophone = audioCapture.activeSources.includes('microphone');
    $('health-coach').textContent = hasMicrophone
      ? `● Coach ${Math.round(currentCoachIntervalMs / 1000)}s`
      : '○ Coach sem microfone';
    $('health-coach').className = hasMicrophone ? 'ok' : 'off';
    const warning = audioCapture.warnings.length ? ` Avisos: ${audioCapture.warnings.join('; ')}` : '';
    $('status').textContent = `Capturando ${audioCapture.activeSources.join(' + ')}.${warning}`;
  } catch (err) {
    await window.agent.cancelMeeting();
    $('status').textContent = `Falha ao iniciar áudio: ${err.message}`;
  }
}
$('btn-start').addEventListener('click', iniciarReuniao);

// Atalho: novo contexto abre o gestor
$('btn-new-context').addEventListener('click', () => {
  if ($('view-config').hidden) $('btn-config').click(); // abre config se fechada
  $('ctx-editor-select').value = '__new__';
  populateDirectionalEditor(null); loadEditorFields();
  $('step-context').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function updateAgendaPreview() {
  const context = $('start-context').selectedOptions[0]?.textContent;
  const direction = $('start-direction').selectedOptions[0]?.textContent;
  const audience = $('start-audience').selectedOptions[0]?.textContent;
  const objective = $('start-objective').selectedOptions[0]?.textContent;
  $('agenda-preview').textContent = context && direction
    ? `Você conduzirá uma reunião de ${objective} com ${audience}, usando ${direction} em ${context}.`
    : 'Escolha contexto e direcional para preparar a agenda.';
}

function populateStartDirections(store, selectedId = null) {
  const context = store.contexts?.find((item) => item.id === $('start-context').value);
  const select = $('start-direction'); select.innerHTML = '';
  for (const direction of context?.directions?.filter((item) => item.status === 'ativo') ?? []) option(select, direction.id, direction.name);
  if (selectedId && [...select.options].some((item) => item.value === selectedId)) select.value = selectedId;
  const active = context?.directions?.find((item) => item.id === select.value);
  if (active?.audienceDefaults?.length) $('start-audience').value = active.audienceDefaults[0];
  if (active?.objectiveDefaults?.length) $('start-objective').value = active.objectiveDefaults[0];
  updateAgendaPreview();
}

async function refreshAgendaSetup() {
  const store = await window.agent.getStore();
  const select = $('start-context'); const previous = select.value;
  select.innerHTML = '';
  for (const context of (store.contexts ?? [])) option(select, context.id, context.name);
  if (previous && [...select.options].some((item) => item.value === previous)) select.value = previous;
  populateStartDirections(store, $('start-direction').value);
}
$('start-context').addEventListener('change', refreshAgendaSetup);
$('start-direction').addEventListener('change', updateAgendaPreview);
$('start-audience').addEventListener('change', updateAgendaPreview);
$('start-objective').addEventListener('change', updateAgendaPreview);

// ── RESIZE ───────────────────────────────────────────────────────────────────
(function initResize() {
  const handles = {
    'resize-n':  { dx: 0,  dy: -1, dw: 0,  dh: -1 },
    'resize-s':  { dx: 0,  dy: 0,  dw: 0,  dh: 1  },
    'resize-e':  { dx: 0,  dy: 0,  dw: 1,  dh: 0  },
    'resize-w':  { dx: -1, dy: 0,  dw: -1, dh: 0  },
    'resize-ne': { dx: 0,  dy: -1, dw: 1,  dh: -1 },
    'resize-nw': { dx: -1, dy: -1, dw: -1, dh: -1 },
    'resize-se': { dx: 0,  dy: 0,  dw: 1,  dh: 1  },
    'resize-sw': { dx: -1, dy: 0,  dw: -1, dh: 1  },
  };
  let resizing = false;
  for (const [id, dirs] of Object.entries(handles)) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      window.agent.startResize(e.screenX, e.screenY, dirs);
    });
  }
  document.addEventListener('mousemove', (e) => {
    if (resizing) window.agent.resizeMove(e.screenX, e.screenY);
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    window.agent.stopResize();
  });
})();

// ── INIT: aplica preferências salvas e popula a start-bar ────────────────────
(async function init() {
  try {
    const store = await window.agent.getStore();
    applyConfiguredOpacity(Math.round((store.settings?.opacity ?? 0.93) * 100));
    startBarCollapsed = store.settings?.startBarCollapsed ?? false;
    currentCoachIntervalMs = Number(store.settings?.coachIntervalMs ?? 15_000);
    await refreshAgendaSetup();
    applyStartBarState();
  } catch (_) {}
})();
