(() => {
  const el = id => document.getElementById(id);
  const notice = text => { el('secretary-notice').textContent = text; };
  let agendaStore = null;
  function updateScopeSuggestion() {
    const agenda = agendaStore?.agendas?.find((item) => item.id === el('secretary-agenda').value);
    const button = el('secretary-confirm-scope');
    button.hidden = !agenda?.suggestedScope;
    button.textContent = agenda?.suggestedScope ? `Usar iniciativa sugerida: ${agenda.suggestedScope}` : '';
  }
  async function refresh() {
    try {
      const store = await window.agent.secretaryStore();
      agendaStore = store;
      const select = el('secretary-agenda'), previous = select.value;
      select.replaceChildren(new Option('Reunião avulsa', ''));
      store.agendas.filter(a => a.status !== 'completed').sort((a, b) => String(a.start).localeCompare(String(b.start))).forEach(a =>
        select.add(new Option(`${a.start ? new Date(a.start).toLocaleString('pt-BR') + ' · ' : ''}${a.title}`, a.id)));
      if ([...select.options].some(o => o.value === previous)) select.value = previous;
      updateScopeSuggestion();
      el('secretary-brief').textContent = await window.agent.secretaryBrief(select.value);
      const box = el('secretary-records'); box.replaceChildren();
      for (const record of store.records.slice(-12).reverse()) {
        const section = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = `${record.title} · ${record.reviewedAt ? 'revisada' : 'revisar memória'}`; section.append(summary);
        const hint = document.createElement('p'); hint.textContent = 'Selecione os registros corretos para usar nas próximas agendas desta iniciativa.'; section.append(hint);
        const checks = [];
        for (const item of record.items) {
          const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.review === 'approved';
          label.append(check, document.createTextNode(`${item.text} — evidência: “${item.evidence.quote}”`)); section.append(label); checks.push({ check, id: item.id });
          const edit = document.createElement('details'), heading = document.createElement('summary'); heading.textContent = 'Corrigir / marcar concluído'; edit.append(heading);
          const fields = {};
          for (const [key, caption] of [['text', 'Registro'], ['owner', 'Responsável'], ['due', 'Prazo']]) {
            const fieldLabel = document.createElement('label'); fieldLabel.textContent = caption;
            const input = document.createElement('input'); input.value = item[key] || ''; fields[key] = input; fieldLabel.append(input); edit.append(fieldLabel);
          }
          const state = document.createElement('select'); state.setAttribute('aria-label', 'Situação do registro');
          for (const [value, caption] of [['open', 'Aberto'], ['resolved', 'Concluído'], ['retracted', 'Retirado'], ['confirmed', 'Confirmado']]) state.add(new Option(caption, value, false, value === item.status));
          const save = document.createElement('button'); save.textContent = 'Salvar correção aprovada';
          save.addEventListener('click', async () => { try { await window.agent.secretaryCorrect(record.sessionId, item.id, { text: fields.text.value, owner: fields.owner.value, due: fields.due.value, status: state.value }); await refresh(); } catch(e) { notice(e.message); } });
          edit.append(state, save); section.append(edit);
        }
        const approve = document.createElement('button'); approve.textContent = 'Salvar revisão da memória';
        approve.addEventListener('click', async () => { try { await window.agent.secretaryReview(record.sessionId, checks.filter(x => x.check.checked).map(x => x.id)); await refresh(); } catch (e) { notice(e.message); } });
        const draft = document.createElement('textarea'); draft.value = record.followUp; draft.setAttribute('aria-label', 'Rascunho editável de acompanhamento'); draft.rows = 8;
        section.append(approve, draft); box.append(section);
      }
      if (!store.records.length) box.textContent = 'As próximas reuniões aparecerão aqui com evidências e rascunho de acompanhamento.';
      const legacy = await window.agent.secretaryLegacyList(); el('secretary-legacy').replaceChildren(...legacy.map(name => new Option(name, name)));
    } catch (e) { notice(`Não foi possível carregar agendas: ${e.message}`); }
  }
  el('secretary-save').addEventListener('click', async () => {
    try {
      await window.agent.secretaryAgenda({ title: el('secretary-title').value, scope: el('secretary-scope').value,
        participants: el('secretary-people').value, objective: el('secretary-objective').value, start: el('secretary-date').value });
      await refresh(); notice('Agenda salva. Selecione-a para preparar a reunião.');
    } catch (e) { notice(e.message); }
  });
  el('secretary-agenda').addEventListener('change', async () => { try { updateScopeSuggestion(); el('secretary-brief').textContent = await window.agent.secretaryBrief(el('secretary-agenda').value); } catch (e) { notice(e.message); } });
  el('secretary-confirm-scope').addEventListener('click', async () => { try { await window.agent.secretaryConfirmScope(el('secretary-agenda').value); await refresh(); notice('Iniciativa confirmada. O histórico aprovado será usado no briefing.'); } catch (e) { notice(e.message); } });
  el('secretary-find-fireflies').addEventListener('click', async () => {
    try {
      const agendaId = el('secretary-agenda').value;
      if (!agendaId) throw new Error('Selecione uma agenda primeiro.');
      const matches = await window.agent.firefliesMatches(agendaId);
      const select = el('secretary-fireflies'); select.replaceChildren(...matches.map((item) => new Option(`${item.title} · compatibilidade ${item.matchScore}`, item.id)));
      select.hidden = !matches.length; el('secretary-link-fireflies').hidden = !matches.length;
      notice(matches.length ? 'Escolha a reunião anterior correta e confirme.' : 'Nenhuma transcrição relacionada foi encontrada.');
    } catch (e) { notice(e.message); }
  });
  el('secretary-link-fireflies').addEventListener('click', async () => {
    try {
      const select = el('secretary-fireflies');
      await window.agent.linkFirefliesTranscript(el('secretary-agenda').value, select.value, select.selectedOptions[0]?.textContent || 'Fireflies');
      await refresh(); notice('Transcrição do Fireflies vinculada e disponível para o briefing.');
    } catch (e) { notice(e.message); }
  });
  el('secretary-import').addEventListener('click', async () => { try { await window.agent.secretaryLegacyImport(el('secretary-legacy').value, el('secretary-agenda').value); await refresh(); notice('Importado como memória não revisada; confirme apenas o que estiver correto.'); } catch (e) { notice(e.message); } });
  window.agent.on('closing-report', ({ secretary }) => {
    if (!secretary) return;
    document.getElementById('secretary-closing')?.remove();
    const section = document.createElement('section'); section.id = 'secretary-closing'; section.className = 'report-section';
    const title = document.createElement('h3'); title.textContent = 'Secretária · acompanhamento revisável';
    const draft = document.createElement('textarea'); draft.rows = 10; draft.value = secretary.followUp; draft.setAttribute('aria-label', 'Rascunho de acompanhamento');
    const hint = document.createElement('p'); hint.textContent = 'Rascunho editável. Revise a memória em Hoje antes de reutilizá-la. Nada foi enviado.';
    section.append(title, draft, hint); el('view-closing').append(section); refresh();
  });
  refresh();
})();
