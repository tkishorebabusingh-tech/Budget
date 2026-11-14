/* Spending page: log expenses and see where the money goes. */
(async function () {
  const { $, esc } = UI;
  const CATEGORIES = [
    'Food & dining', 'Groceries', 'Transport', 'Shopping', 'Bills & utilities', 'Rent & home',
    'Health', 'Entertainment', 'Travel', 'Education', 'Other',
  ];
  const SPEND = 'var(--s-spend)';

  let data = { accounts: [], entries: [], expenses: [] };
  let freshId = null; // the expense that was just added, so it can animate in

  const form = $('#expenseForm');
  const sum = (list) => list.reduce((total, e) => total + e.amount, 0);
  const asDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const initials = (category) => category.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  /* -------------------------------------------------------- form setup */
  $('#categoryChips').innerHTML = CATEGORIES.map((c, i) =>
    `<label><input type="radio" name="category" value="${esc(c)}"${i ? '' : ' checked'}><span>${esc(c)}</span></label>`).join('');

  function setDefaultDate() {
    form.elements.date.value = UI.month === UI.todayMonth() ? UI.todayISO() : `${UI.month}-01`;
  }

  function fillSelects() {
    const group = (label, kind) => {
      const options = data.accounts.filter((a) => a.kind === kind)
        .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      return options ? `<optgroup label="${label}">${options}</optgroup>` : '';
    };
    const paidWith = $('#paidWith');
    const keep = paidWith.value;
    paidWith.innerHTML = `<option value="">Cash or other</option>${group('Credit cards', 'card')}${group('Savings accounts', 'savings')}`;
    paidWith.value = [...paidWith.options].some((o) => o.value === keep) ? keep : '';

    const filter = $('#categoryFilter');
    const chosen = filter.value;
    const all = [...new Set([...CATEGORIES, ...data.expenses.map((e) => e.category)])];
    filter.innerHTML = `<option value="">All categories</option>${all.map((c) => `<option>${esc(c)}</option>`).join('')}`;
    filter.value = all.includes(chosen) ? chosen : '';

    const sym = UI.symbol();
    $('#amountSymbol').textContent = sym;
    $('#amountSymbol').parentElement.style.setProperty('--sym', sym.length);
  }

  /* ------------------------------------------------------------ render */
  function renderSummary() {
    const month = UI.month;
    const list = Calc.spent(data, month);
    const total = sum(list);
    const today = UI.todayMonth();

    UI.countUp($('#heroSpent'), total);
    $('#heroNote').textContent = list.length
      ? `Across ${list.length} ${list.length === 1 ? 'entry' : 'entries'} this month.`
      : `Nothing logged for ${UI.monthLabel(month)} yet. Add your first expense below.`;

    const days = month === today ? new Date().getDate() : UI.daysIn(month);
    UI.countUp($('#kpiDaily'), list.length ? Math.round(total / days) : 0);
    $('#kpiDailySub').textContent = month === today ? `Over the ${days} day${days === 1 ? '' : 's'} so far` : `Over ${days} days`;

    const byCategory = new Map();
    list.forEach((e) => byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount));
    const ranked = [...byCategory].sort((a, b) => b[1] - a[1]);
    $('#kpiTop').textContent = ranked.length ? ranked[0][0] : '—';
    $('#kpiTopSub').textContent = ranked.length
      ? `${UI.money(ranked[0][1])}, ${UI.percent(ranked[0][1] / total)} of the month`
      : 'No spending yet';

    const lastMonth = UI.shiftMonth(month, -1);
    const lastTotal = sum(Calc.spent(data, lastMonth));
    const kpiDelta = $('#kpiDelta');
    if (lastTotal > 0) {
      const change = total - lastTotal;
      kpiDelta.className = `delta ${change > 0 ? 'bad' : change < 0 ? 'good' : ''}`;
      UI.countUp(kpiDelta, change, (n) => `${n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}${UI.signed(n)}`);
      $('#kpiDeltaSub').textContent = `${UI.monthLabel(lastMonth)}: ${UI.money(lastTotal)}`;
    } else {
      cancelAnimationFrame(kpiDelta._raf);
      kpiDelta._value = 0;
      kpiDelta.className = '';
      kpiDelta.textContent = '—';
      $('#kpiDeltaSub').textContent = `Nothing logged in ${UI.monthLabel(lastMonth)}`;
    }

    Charts.bars($('#categoryBars'), {
      items: ranked.map(([label, value]) => ({ label, value })),
      color: SPEND,
      empty: 'Your categories will rank here once you log an expense.',
    });

    const perDay = Array(UI.daysIn(month)).fill(0);
    list.forEach((e) => { perDay[Number(e.date.slice(8, 10)) - 1] += e.amount; });
    const monthName = UI.monthLabel(month);
    Charts.columns($('#dailyChart'), {
      label: `Column chart of spending for each day of ${monthName}.`,
      name: 'Spent',
      labels: perDay.map((_, i) => String(i + 1)),
      titles: perDay.map((_, i) => `${i + 1} ${monthName}`),
      labelWhen: (i) => i === 0 || (i + 1) % 5 === 0,
      values: perDay,
      color: SPEND,
      empty: 'Nothing logged this month yet.',
    });

    const six = [5, 4, 3, 2, 1, 0].map((back) => UI.shiftMonth(month, -back));
    Charts.columns($('#monthsChart'), {
      label: 'Column chart of total spending for the last six months.',
      name: 'Spent',
      labels: six.map((m, i) => (i === 0 || m.endsWith('-01') ? `${UI.monthShort(m)} ’${m.slice(2, 4)}` : UI.monthShort(m))),
      titles: six.map((m) => UI.monthLabel(m)),
      values: six.map((m) => sum(Calc.spent(data, m))),
      color: SPEND,
      highlight: 5,
      height: 220,
      onSelect: (i) => UI.setMonth(six[i]),
      empty: 'Nothing logged in the last six months.',
    });
  }

  function renderList() {
    const month = UI.month;
    const all = Calc.spent(data, month);
    const query = $('#search').value.trim().toLowerCase();
    const category = $('#categoryFilter').value;
    const names = new Map(data.accounts.map((a) => [a.id, a.name]));
    const shown = all.filter((e) =>
      (!category || e.category === category) &&
      (!query || `${e.note} ${e.category} ${names.get(e.account_id) || ''}`.toLowerCase().includes(query)));

    $('#listCount').textContent = all.length
      ? (shown.length === all.length ? `${all.length} in ${UI.monthLabel(month)}` : `Showing ${shown.length} of ${all.length}`)
      : '';

    const host = $('#txnList');
    if (!shown.length) {
      host.innerHTML = `<p class="chart-empty">${all.length ? 'Nothing matches that search.' : `No expenses in ${esc(UI.monthLabel(month))} yet.`}</p>`;
      return;
    }
    const days = new Map();
    shown.forEach((e) => { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); });
    host.innerHTML = [...days].map(([date, items]) => `
      <section class="day">
        <header class="day-head">
          <span>${asDate(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <span>${UI.money(sum(items))}</span>
        </header>
        ${items.map((e) => `
          <div class="txn${e.id === freshId ? ' fresh' : ''}" data-id="${esc(e.id)}">
            <span class="badge" aria-hidden="true">${esc(initials(e.category))}</span>
            <div class="txn-main">
              <b>${esc(e.note || e.category)}</b>
              <small>${esc(e.category)} · ${esc(names.get(e.account_id) || 'Cash or other')}</small>
            </div>
            <span class="txn-amount">${UI.money(e.amount)}</span>
            <button type="button" class="txn-del" data-del="${esc(e.id)}" aria-label="Delete ${esc(e.note || e.category)}, ${UI.money(e.amount)}">✕</button>
          </div>`).join('')}
      </section>`).join('');
    freshId = null;
  }

  function renderAll() {
    renderSummary();
    renderList();
  }

  /* ------------------------------------------------------------ events */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = UI.parseAmount(form.elements.amount.value);
    if (!amount || amount <= 0) {
      form.elements.amount.focus();
      UI.toast('Enter an amount greater than zero.', 'error');
      return;
    }
    if (!form.elements.date.value) {
      form.elements.date.focus();
      UI.toast('Pick a date.', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const saved = await Store.addExpense({
        amount,
        category: form.elements.category.value,
        date: form.elements.date.value,
        note: form.elements.note.value.trim(),
        account_id: form.elements.account_id.value || null,
      });
      data.expenses.unshift(saved);
      data.expenses.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      freshId = saved.id;
      form.elements.amount.value = '';
      form.elements.note.value = '';
      const savedMonth = saved.date.slice(0, 7);
      if (savedMonth !== UI.month) {
        UI.setMonth(savedMonth); // re-renders through the month listener
        UI.toast(`Added to ${UI.monthLabel(savedMonth)}`);
      } else {
        renderAll();
        UI.toast(`${UI.money(saved.amount)} added`);
      }
      form.elements.amount.focus();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
    button.disabled = false;
  });

  $('#txnList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Delete';
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = '✕'; } }, 3000);
      return;
    }
    const id = btn.dataset.del;
    try {
      await Store.deleteExpense(id);
      data.expenses = data.expenses.filter((x) => x.id !== id);
      btn.closest('.txn').classList.add('removing');
      setTimeout(renderAll, UI.reduceMotion ? 0 : 320);
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  });

  $('#search').addEventListener('input', renderList);
  $('#categoryFilter').addEventListener('change', renderList);

  /* ---------------------------------------------------------------- go */
  await UI.boot();
  try {
    data = await Store.load();
  } catch (err) {
    UI.toast(`Could not load your data: ${err.message}`, 'error');
  }
  fillSelects();
  setDefaultDate();
  UI.initCurrency(() => { fillSelects(); renderAll(); });
  UI.onMonthChange(() => { setDefaultDate(); renderAll(); });
  renderAll();
})();
