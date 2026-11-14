/* Dashboard: monthly card dues and savings, the balance, and its analytics. */
(async function () {
  const { $, esc } = UI;
  const COLORS = ['indigo', 'ocean', 'ember', 'forest', 'rose', 'graphite'];
  const VAULT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10l9-6 9 6"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18"/></svg>';

  let data = { accounts: [], entries: [], expenses: [] };

  /* ------------------------------------------------------ account cards */
  function accountHTML(a, value, last, sym) {
    const card = a.kind === 'card';
    const label = card ? 'Amount due' : 'Balance';
    const placeholder = last != null ? `Last: ${Number(last).toLocaleString()}` : '0';
    return `
      <div data-reveal="zoom">
        <article class="acct tilt ${a.kind}" data-color="${esc(a.color || 'indigo')}">
          <div class="acct-top">
            ${card ? '<span class="chip" aria-hidden="true"></span>' : `<span class="vault">${VAULT_ICON}</span>`}
            <button type="button" class="acct-edit" data-edit="${esc(a.id)}" aria-label="Edit ${esc(a.name)}">Edit</button>
          </div>
          <div class="acct-name">${esc(a.name)}${a.bank ? `<small>${esc(a.bank)}</small>` : ''}</div>
          <label class="amount">
            <span>${label}</span>
            <div class="amount-box">
              <i aria-hidden="true">${esc(sym)}</i>
              <input type="text" inputmode="decimal" autocomplete="off" data-account="${esc(a.id)}"
                value="${value != null ? value : ''}" placeholder="${placeholder}"
                aria-label="${esc(a.name)}, ${label.toLowerCase()} for ${esc(UI.monthLabel(UI.month))}">
            </div>
          </label>
        </article>
      </div>`;
  }

  function renderAccounts() {
    const month = UI.month;
    const previous = Calc.previous(data, month);
    const now = Calc.month(data, month).byAccount;
    const before = previous ? Calc.month(data, previous).byAccount : new Map();
    const sym = UI.symbol();
    const lists = [
      ['card', $('#cardList'), 'No credit cards yet. Add one to start tracking what you owe.'],
      ['savings', $('#savingsList'), 'No savings accounts yet. Add one to see what you have.'],
    ];
    for (const [kind, host, none] of lists) {
      const accounts = data.accounts.filter((a) => a.kind === kind);
      host.innerHTML = accounts.length
        ? accounts.map((a) => accountHTML(a, now.get(a.id), before.get(a.id), sym)).join('')
        : `<p class="none">${none}</p>`;
      [...host.children].forEach((child, i) => child.style.setProperty('--d', `${i * 80}ms`));
    }
    $('#emptyState').hidden = data.accounts.length > 0;
    $('#entryGrid').hidden = data.accounts.length === 0;
    UI.reveal($('#entry'));
  }

  /* ------------------------------------------------------------ saving */
  const pending = new Map(); // "month|account" -> amount or null
  let saveTimer = null;
  const saveState = $('#saveState');

  function queueSave(month, accountId, amount) {
    pending.set(`${month}|${accountId}`, amount);
    saveState.className = 'save-state saving';
    saveState.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, 500);
  }

  async function flushSaves() {
    clearTimeout(saveTimer);
    if (!pending.size) return;
    const byMonth = new Map();
    for (const [key, amount] of pending) {
      const [month, account_id] = key.split('|');
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push({ account_id, amount });
    }
    pending.clear();
    try {
      for (const [month, entries] of byMonth) await Store.saveMonth(month, entries);
      if (!pending.size) {
        saveState.className = 'save-state saved';
        saveState.textContent = '✓ Saved';
      }
    } catch (err) {
      saveState.className = 'save-state failed';
      saveState.textContent = 'Could not save';
      UI.toast(`Could not save: ${err.message}`, 'error');
    }
  }

  $('#entry').addEventListener('input', (e) => {
    const input = e.target.closest('input[data-account]');
    if (!input) return;
    const id = input.dataset.account;
    const amount = UI.parseAmount(input.value);
    data.entries = data.entries.filter((x) => !(x.month === UI.month && x.account_id === id));
    if (amount != null) data.entries.push({ month: UI.month, account_id: id, amount });
    queueSave(UI.month, id, amount);
    renderSummary();
  });
  $('#entry').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-account]');
    if (!input) return;
    const amount = UI.parseAmount(input.value);
    input.value = amount != null ? amount : '';
    flushSaves();
  });

  /* ----------------------------------------------------------- summary */
  const coverage = $('#coverage');
  coverage.innerHTML = `
    <p class="chart-empty" data-part="empty">Fill in this month to see how much of your savings the cards take.</p>
    <div data-part="body" hidden>
      <div class="meter-value" data-part="value"></div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-label="Card dues as a share of savings" data-part="meter">
        <span class="meter-fill" data-part="fill"></span>
      </div>
      <div class="status" data-part="status"><i aria-hidden="true"></i><span></span></div>
      <p class="meter-note" data-part="note"></p>
    </div>`;
  const part = (name) => coverage.querySelector(`[data-part="${name}"]`);

  function renderCoverage(cur) {
    const hasNumbers = cur.savings > 0 || cur.dues > 0;
    part('empty').hidden = hasNumbers;
    part('body').hidden = !hasNumbers;
    if (!hasNumbers) return;
    const ratio = cur.savings > 0 ? cur.dues / cur.savings : Infinity;
    const level = ratio > 1 ? 'bad' : ratio >= 0.5 ? 'warn' : '';
    const [icon, text] = ratio > 1
      ? ['×', 'Dues are more than your savings']
      : ratio >= 0.5 ? ['!', 'Getting tight'] : ['✓', 'Well covered'];
    part('value').textContent = Number.isFinite(ratio) ? UI.percent(ratio) : '—';
    part('meter').className = `meter ${level}`;
    part('meter').setAttribute('aria-valuenow', Number.isFinite(ratio) ? Math.min(100, Math.round(ratio * 100)) : 100);
    part('fill').style.setProperty('--w', Math.min(100, ratio * 100).toFixed(1));
    part('status').className = `status ${level}`;
    part('status').firstElementChild.textContent = icon;
    part('status').lastElementChild.textContent = text;
    part('note').textContent = `${UI.money(cur.dues)} due against ${UI.money(cur.savings)} saved.`;
  }

  const deltaHTML = (n) => {
    if (!n) return '<span class="delta">No change</span>';
    return `<span class="delta ${n > 0 ? 'good' : 'bad'}"><span aria-hidden="true">${n > 0 ? '▲' : '▼'}</span>${UI.signed(n)}</span>`;
  };

  function renderSummary() {
    const month = UI.month;
    const cur = Calc.month(data, month);
    const prevMonth = Calc.previous(data, month);
    const prev = prevMonth ? Calc.month(data, prevMonth) : null;
    const cards = data.accounts.filter((a) => a.kind === 'card');
    const savings = data.accounts.filter((a) => a.kind === 'savings');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // hero
    const hero = $('#heroNet');
    hero.classList.toggle('negative', cur.net < 0);
    UI.countUp(hero, cur.net);
    $('#heroNote').textContent = !data.accounts.length
      ? 'Add your credit cards and savings accounts below to see your balance.'
      : !cur.hasData
        ? `No numbers for ${UI.monthLabel(month)} yet. Fill them in below.`
        : cur.net < 0
          ? 'Your card dues are higher than your savings this month.'
          : 'What is left in your savings once every credit card is paid.';

    UI.countUp($('#kpiSavings'), cur.savings);
    UI.countUp($('#kpiDues'), cur.dues);
    $('#kpiSavingsSub').textContent = `Across ${plural(savings.length, 'account')}`;
    $('#kpiDuesSub').textContent = `Across ${plural(cards.length, 'card')}`;
    const kpiDelta = $('#kpiDelta');
    if (prev && cur.hasData) {
      const change = cur.net - prev.net;
      kpiDelta.className = `delta ${change > 0 ? 'good' : change < 0 ? 'bad' : ''}`;
      UI.countUp(kpiDelta, change, (n) => `${n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}${UI.signed(n)}`);
      $('#kpiDeltaSub').textContent = `Compared with ${UI.monthLabel(prevMonth)}`;
    } else {
      cancelAnimationFrame(kpiDelta._raf);
      kpiDelta._value = 0;
      kpiDelta.className = '';
      kpiDelta.textContent = '—';
      $('#kpiDeltaSub').textContent = 'Needs an earlier month to compare';
    }

    // entry section totals
    $('#duesTotal').textContent = cards.length ? UI.money(cur.dues) : '';
    $('#savingsTotal').textContent = savings.length ? UI.money(cur.savings) : '';
    UI.countUp($('#eqSavings'), cur.savings);
    UI.countUp($('#eqDues'), cur.dues);
    UI.countUp($('#eqNet'), cur.net);

    // trend
    const months = Calc.months(data).slice(-12);
    const totals = months.map((m) => Calc.month(data, m));
    const short = (m, i) => (i === 0 || m.endsWith('-01') ? `${UI.monthShort(m)} ’${m.slice(2, 4)}` : UI.monthShort(m));
    Charts.lines($('#trendChart'), {
      label: 'Line chart of savings, card dues and balance for each month.',
      labels: months.map(short),
      titles: months.map((m) => UI.monthLabel(m)),
      series: [
        { name: 'Savings', color: 'var(--s-savings)', values: totals.map((t) => t.savings) },
        { name: 'Card dues', color: 'var(--s-dues)', values: totals.map((t) => t.dues) },
        { name: 'Balance', color: 'var(--s-net)', values: totals.map((t) => t.net) },
      ],
      selected: months.indexOf(month),
      onSelect: (i) => UI.setMonth(months[i]),
      empty: 'Fill in a month above and the trend will appear here.',
    });
    $('#trendSub').textContent = months.length > 1
      ? 'Click a month to open it.'
      : months.length === 1 ? 'One month so far. The lines appear from the second month.' : '';

    // split by account
    Charts.bars($('#duesBars'), {
      items: cards.map((a) => ({ label: a.name, value: cur.byAccount.get(a.id) || 0 })),
      color: 'var(--s-dues)',
      empty: 'No card dues entered for this month.',
    });
    Charts.bars($('#savingsBars'), {
      items: savings.map((a) => ({ label: a.name, value: cur.byAccount.get(a.id) || 0 })),
      color: 'var(--s-savings)',
      empty: 'No savings entered for this month.',
    });
    renderCoverage(cur);

    // history table
    const all = Calc.months(data).map((m) => Calc.month(data, m));
    $('#historyBody').innerHTML = all.length
      ? all.map((t, i) => `
        <tr class="${t.month === month ? 'current' : ''}">
          <td><button type="button" class="linkish" data-month="${t.month}">${esc(UI.monthLabel(t.month))}</button></td>
          <td>${UI.money(t.savings)}</td>
          <td>${UI.money(t.dues)}</td>
          <td><b>${UI.money(t.net)}</b></td>
          <td>${i ? deltaHTML(t.net - all[i - 1].net) : '<span class="delta">First month</span>'}</td>
        </tr>`).reverse().join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--ink-2)">No months filled in yet.</td></tr>';
  }

  $('#historyBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-month]');
    if (!btn) return;
    UI.setMonth(btn.dataset.month);
    $('#entry').scrollIntoView();
  });

  function renderAll() {
    renderAccounts();
    renderSummary();
  }

  /* ---------------------------------------------------- account dialog */
  const dialog = $('#accountDialog');
  const form = $('#accountForm');
  const deleteBtn = $('#accountDelete');
  let editing = null;

  $('#swatches').innerHTML = COLORS.map((c) =>
    `<label><input type="radio" name="color" value="${c}"><span data-color="${c}" title="${c}"></span></label>`).join('');

  function openDialog(kind, account) {
    editing = account || null;
    form.reset();
    $('#accountDialogTitle').textContent = account
      ? `Edit ${account.name}`
      : kind === 'card' ? 'Add a credit card' : 'Add a savings account';
    form.elements.kind.value = account ? account.kind : kind;
    form.elements.name.value = account ? account.name : '';
    form.elements.bank.value = account ? account.bank : '';
    form.elements.color.value = account && COLORS.includes(account.color)
      ? account.color
      : COLORS[data.accounts.length % COLORS.length];
    deleteBtn.hidden = !account;
    deleteBtn.classList.remove('armed');
    deleteBtn.textContent = 'Delete';
    dialog.showModal();
    form.elements.name.focus();
  }

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return openDialog(add.dataset.add);
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const account = data.accounts.find((a) => a.id === edit.dataset.edit);
      if (account) openDialog(account.kind, account);
    }
  });
  $('#accountCancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      kind: form.elements.kind.value,
      name: form.elements.name.value.trim(),
      bank: form.elements.bank.value.trim(),
      color: form.elements.color.value,
    };
    if (!payload.name) { form.elements.name.focus(); UI.toast('Give the account a name.', 'error'); return; }
    try {
      await flushSaves();
      if (editing) await Store.updateAccount(editing.id, payload);
      else await Store.addAccount(payload);
      data = await Store.load();
      dialog.close();
      renderAll();
      UI.toast(editing ? 'Account updated' : `${payload.name} added`);
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  });

  deleteBtn.addEventListener('click', async () => {
    if (!deleteBtn.classList.contains('armed')) {
      deleteBtn.classList.add('armed');
      deleteBtn.textContent = 'Delete it and its history?';
      return;
    }
    try {
      await flushSaves();
      await Store.deleteAccount(editing.id);
      data = await Store.load();
      dialog.close();
      renderAll();
      UI.toast('Account deleted');
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  });

  /* ------------------------------------------------- sample and reset */
  $('#loadSample').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      data = await Store.importData(Store.sample(UI.todayMonth()));
      renderAll();
      UI.toast('Sample data loaded. Delete it any time from the footer.');
    } catch (err) {
      UI.toast(err.message, 'error');
    }
    e.target.disabled = false;
  });

  const resetBtn = $('#resetAll');
  resetBtn.addEventListener('click', async () => {
    if (!resetBtn.classList.contains('armed')) {
      resetBtn.classList.add('armed');
      resetBtn.textContent = 'Really delete everything?';
      setTimeout(() => { resetBtn.classList.remove('armed'); resetBtn.textContent = 'Delete all data'; }, 4000);
      return;
    }
    try {
      pending.clear();
      await Store.reset();
      data = await Store.load();
      renderAll();
      UI.toast('All data deleted');
    } catch (err) {
      UI.toast(err.message, 'error');
    }
    resetBtn.classList.remove('armed');
    resetBtn.textContent = 'Delete all data';
  });

  /* --------------------------------------------------------------- go */
  await UI.boot();
  try {
    data = await Store.load();
  } catch (err) {
    UI.toast(`Could not load your data: ${err.message}`, 'error');
  }
  UI.initCurrency(renderAll);
  UI.onMonthChange(() => { flushSaves(); renderAll(); });
  renderAll();
})();
