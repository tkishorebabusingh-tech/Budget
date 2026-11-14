/* Data layer.
 *
 * Talks to the Flask API when it is reachable (same origin, /api/*).
 * If it is not — for example the static site is deployed on its own — it
 * falls back to this browser's localStorage so the app still works.
 */
const Store = (() => {
  const LS_KEY = 'budget.data.v1';
  let mode = 'local';
  let auth = false;   // the server has a password set
  let locked = false; // ...and this browser has not entered it yet

  const uid = () =>
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);

  const empty = () => ({ accounts: [], entries: [], expenses: [] });

  function readLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_KEY));
      if (d && Array.isArray(d.accounts) && Array.isArray(d.entries) && Array.isArray(d.expenses)) return d;
    } catch (_) { /* fall through */ }
    return empty();
  }
  function writeLocal(d) {
    d.expenses.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    localStorage.setItem(LS_KEY, JSON.stringify(d));
  }

  async function call(method, path, payload) {
    const res = await fetch('/api' + path, {
      method,
      cache: 'no-store',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (res.status === 401 && json && json.locked && !locked) {
      locked = true; // the login expired, or the app was locked in another tab
      window.dispatchEvent(new Event('budget:locked'));
    }
    if (!res.ok) throw new Error((json && json.error) || `Request failed (${res.status})`);
    return json;
  }

  async function login(password) {
    await call('POST', '/login', { password });
    locked = false;
  }

  async function logout() {
    await call('POST', '/logout');
    locked = auth;
  }

  async function init() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch('/api/health', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const json = await res.json();
      mode = res.ok && json && json.ok === true ? 'api' : 'local';
      auth = mode === 'api' && json.auth === true;
      locked = mode === 'api' && json.locked === true;
    } catch (_) {
      mode = 'local';
    }
    return mode;
  }

  const api = {
    load: () => call('GET', '/data'),
    addAccount: (a) => call('POST', '/accounts', a),
    updateAccount: (id, a) => call('PUT', '/accounts/' + id, a),
    deleteAccount: (id) => call('DELETE', '/accounts/' + id),
    saveMonth: (month, entries) => call('PUT', '/months/' + month, { entries }),
    addExpense: (e) => call('POST', '/expenses', e),
    deleteExpense: (id) => call('DELETE', '/expenses/' + id),
    importData: (d) => call('POST', '/import', d),
    reset: () => call('DELETE', '/data'),
  };

  const local = {
    async load() { return readLocal(); },
    async addAccount(a) {
      const d = readLocal();
      const acc = { id: uid(), kind: a.kind, name: a.name, bank: a.bank || '', color: a.color || '' };
      d.accounts.push(acc);
      writeLocal(d);
      return acc;
    },
    async updateAccount(id, a) {
      const d = readLocal();
      const acc = d.accounts.find((x) => x.id === id);
      if (!acc) throw new Error('Account not found.');
      Object.assign(acc, { kind: a.kind, name: a.name, bank: a.bank || '', color: a.color || '' });
      writeLocal(d);
      return acc;
    },
    async deleteAccount(id) {
      const d = readLocal();
      d.accounts = d.accounts.filter((x) => x.id !== id);
      d.entries = d.entries.filter((x) => x.account_id !== id);
      d.expenses.forEach((x) => { if (x.account_id === id) x.account_id = null; });
      writeLocal(d);
    },
    async saveMonth(month, entries) {
      const d = readLocal();
      for (const item of entries) {
        d.entries = d.entries.filter((x) => !(x.month === month && x.account_id === item.account_id));
        if (item.amount != null) d.entries.push({ month, account_id: item.account_id, amount: item.amount });
      }
      writeLocal(d);
    },
    async addExpense(e) {
      const d = readLocal();
      const exp = { id: uid(), date: e.date, amount: e.amount, category: e.category, note: e.note || '', account_id: e.account_id || null };
      d.expenses.unshift(exp);
      writeLocal(d);
      return exp;
    },
    async deleteExpense(id) {
      const d = readLocal();
      d.expenses = d.expenses.filter((x) => x.id !== id);
      writeLocal(d);
    },
    async importData(incoming) {
      const d = readLocal();
      const upsert = (list, item, same) => {
        const i = list.findIndex(same);
        if (i >= 0) list[i] = item; else list.push(item);
      };
      (incoming.accounts || []).forEach((a) => upsert(d.accounts, a, (x) => x.id === a.id));
      (incoming.entries || []).forEach((e) => upsert(d.entries, e, (x) => x.month === e.month && x.account_id === e.account_id));
      (incoming.expenses || []).forEach((e) => upsert(d.expenses, e, (x) => x.id === e.id));
      writeLocal(d);
      return readLocal();
    },
    async reset() { writeLocal(empty()); },
  };

  const run = (name) => (...args) => (mode === 'api' ? api : local)[name](...args);

  /* A believable six months of data so the dashboard can be explored
   * before any real numbers go in. Deterministic, so it looks the same
   * every time it is loaded. */
  function sample(endMonth) {
    let seed = 20261114;
    const rand = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = (lo, hi, step = 1) => Math.round((lo + rand() * (hi - lo)) / step) * step;
    const pick = (list) => list[Math.floor(rand() * list.length)];

    const accounts = [
      { id: uid(), kind: 'card', name: 'Rewards card', bank: 'Everyday spends', color: 'indigo' },
      { id: uid(), kind: 'card', name: 'Travel card', bank: 'Flights and hotels', color: 'ocean' },
      { id: uid(), kind: 'card', name: 'Fuel card', bank: 'Petrol and tolls', color: 'ember' },
      { id: uid(), kind: 'savings', name: 'Salary account', bank: 'Main bank', color: 'forest' },
      { id: uid(), kind: 'savings', name: 'Emergency fund', bank: 'Do not touch', color: 'ocean' },
      { id: uid(), kind: 'savings', name: 'Goals pot', bank: 'Holiday and gadgets', color: 'rose' },
    ];
    const [c1, c2, c3, s1, s2, s3] = accounts;

    const [ey, em] = endMonth.split('-').map(Number);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(ey, em - 1 - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const entries = [];
    months.forEach((month, i) => {
      entries.push(
        { month, account_id: c1.id, amount: between(14000, 32000, 50) },
        { month, account_id: c2.id, amount: i % 3 === 1 ? between(26000, 48000, 50) : between(3000, 12000, 50) },
        { month, account_id: c3.id, amount: between(2500, 6500, 50) },
        { month, account_id: s1.id, amount: between(48000, 82000, 100) },
        { month, account_id: s2.id, amount: 150000 + i * 10000 },
        { month, account_id: s3.id, amount: 30000 + i * between(5000, 9000, 500) },
      );
    });

    const catalogue = [
      ['Groceries', 5, [600, 3200], ['Weekly groceries', 'Vegetables and fruit', 'Supermarket run'], c1],
      ['Food & dining', 5, [250, 2400], ['Dinner out', 'Lunch with team', 'Coffee', 'Takeaway'], c1],
      ['Transport', 4, [150, 2800], ['Cab ride', 'Fuel', 'Metro card top-up'], c3],
      ['Bills & utilities', 3, [700, 4200], ['Electricity bill', 'Mobile plan', 'Broadband'], s1],
      ['Shopping', 3, [900, 7500], ['Clothes', 'Headphones', 'Home bits'], c1],
      ['Entertainment', 2, [300, 1800], ['Movie night', 'Streaming plan', 'Concert'], c1],
      ['Health', 1, [400, 3600], ['Pharmacy', 'Doctor visit', 'Gym'], s1],
      ['Travel', 1, [3000, 16000], ['Weekend trip', 'Train tickets', 'Hotel'], c2],
      ['Education', 1, [800, 5000], ['Online course', 'Books'], s1],
    ];
    const weighted = catalogue.flatMap((c) => Array(c[1]).fill(c));
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const expenses = [];
    months.forEach((month) => {
      const [y, m] = month.split('-').map(Number);
      const lastDay = month === currentMonth ? now.getDate() : new Date(y, m, 0).getDate();
      expenses.push({
        id: uid(), date: `${month}-01`, amount: 22000, category: 'Rent & home', note: 'Rent', account_id: s1.id,
      });
      const count = Math.max(4, Math.round(between(14, 20) * (lastDay / 30)));
      for (let i = 0; i < count; i++) {
        const [category, , range, notes, account] = pick(weighted);
        expenses.push({
          id: uid(),
          date: `${month}-${String(between(1, lastDay)).padStart(2, '0')}`,
          amount: between(range[0], range[1], 10),
          category,
          note: pick(notes),
          account_id: rand() < 0.15 ? null : account.id,
        });
      }
    });

    return { accounts, entries, expenses };
  }

  return {
    init,
    get mode() { return mode; },
    get auth() { return auth; },
    get locked() { return locked; },
    login,
    logout,
    load: run('load'),
    addAccount: run('addAccount'),
    updateAccount: run('updateAccount'),
    deleteAccount: run('deleteAccount'),
    saveMonth: run('saveMonth'),
    addExpense: run('addExpense'),
    deleteExpense: run('deleteExpense'),
    importData: run('importData'),
    reset: run('reset'),
    sample,
  };
})();

/* Pure calculations shared by both pages. */
const Calc = {
  /** Savings, card dues and what is left for one month. */
  month(data, month) {
    const kinds = new Map(data.accounts.map((a) => [a.id, a.kind]));
    const byAccount = new Map();
    let savings = 0, dues = 0, count = 0;
    for (const e of data.entries) {
      if (e.month !== month) continue;
      const kind = kinds.get(e.account_id);
      if (!kind) continue;
      byAccount.set(e.account_id, e.amount);
      if (kind === 'card') dues += e.amount; else savings += e.amount;
      count++;
    }
    return { month, savings, dues, net: savings - dues, byAccount, hasData: count > 0 };
  },

  /** Every month that has at least one number, oldest first. */
  months(data) {
    const ids = new Set(data.accounts.map((a) => a.id));
    return [...new Set(data.entries.filter((e) => ids.has(e.account_id)).map((e) => e.month))].sort();
  },

  /** The latest month before `month` that has numbers, or null. */
  previous(data, month) {
    const earlier = Calc.months(data).filter((m) => m < month);
    return earlier.length ? earlier[earlier.length - 1] : null;
  },

  spent(data, month) {
    return data.expenses.filter((e) => e.date.startsWith(month));
  },
};
