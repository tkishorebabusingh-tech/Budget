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

  const normalize = (d) =>
    (d && Array.isArray(d.accounts) && Array.isArray(d.entries) && Array.isArray(d.expenses)) ? d : empty();

  function readPlain() {
    try { return normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch (_) { return empty(); }
  }

  /* ---------------------------------------------------- browser vault
   * With no server, the numbers live in this browser. Once a password is
   * set they are kept encrypted (AES-GCM, key from PBKDF2-SHA256), so the
   * stored copy cannot be read without the password. While unlocked, the
   * key is held in sessionStorage so moving between pages does not ask
   * again; closing the tab or pressing the lock button forgets it.
   */
  const VAULT_KEY = 'budget.vault.v1';
  const SESSION_KEY = 'budget.vaultKey';
  const ITERATIONS = 310000;
  let vaultKey = null;  // CryptoKey while unlocked
  let vaultMeta = null; // { v, iter, salt }
  let cache = null;     // decrypted data while unlocked
  let saving = Promise.resolve();

  const vaultSupported = !!(window.crypto && crypto.subtle && window.TextEncoder);
  const hasVault = () => { try { return localStorage.getItem(VAULT_KEY) != null; } catch (_) { return false; } };

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    );
  }
  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: toB64(iv), ct: toB64(ct) };
  }
  async function unseal(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
    return normalize(JSON.parse(new TextDecoder().decode(pt)));
  }
  const readVault = () => JSON.parse(localStorage.getItem(VAULT_KEY));

  async function persist(snapshot) {
    const box = await seal(vaultKey, snapshot);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...vaultMeta, ...box }));
  }
  async function remember() {
    try { sessionStorage.setItem(SESSION_KEY, toB64(await crypto.subtle.exportKey('raw', vaultKey))); } catch (_) { /* ask again next page */ }
  }
  function forget() {
    vaultKey = null; vaultMeta = null; cache = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  }

  const vault = {
    /** First time: choose a password and encrypt whatever is already saved here. */
    async create(password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      vaultKey = await deriveKey(password, salt, ITERATIONS);
      vaultMeta = { v: 1, iter: ITERATIONS, salt: toB64(salt) };
      cache = readPlain();
      await persist(cache);
      localStorage.removeItem(LS_KEY);
      await remember();
    },
    async unlock(password) {
      const record = readVault();
      const key = await deriveKey(password, fromB64(record.salt), record.iter);
      try { cache = await unseal(key, record); } catch (_) { throw new Error('Wrong password.'); }
      vaultKey = key;
      vaultMeta = { v: record.v, iter: record.iter, salt: record.salt };
      await remember();
    },
    /** Reuse the key from earlier in this tab. */
    async resume() {
      let raw = null;
      try { raw = sessionStorage.getItem(SESSION_KEY); } catch (_) { /* ignore */ }
      if (!raw || !hasVault()) return false;
      try {
        const record = readVault();
        const key = await crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', true, ['encrypt', 'decrypt']);
        cache = await unseal(key, record);
        vaultKey = key;
        vaultMeta = { v: record.v, iter: record.iter, salt: record.salt };
        return true;
      } catch (_) {
        forget();
        return false;
      }
    },
    lock: forget,
    /** Forgotten password: the only way forward is to delete everything stored here. */
    destroy() {
      forget();
      localStorage.removeItem(VAULT_KEY);
      localStorage.removeItem(LS_KEY);
    },
  };

  // Another tab saved: pick up its version so this tab doesn't write over it.
  addEventListener('storage', async (e) => {
    if (e.key !== VAULT_KEY || !vaultKey || !e.newValue) return;
    try { cache = await unseal(vaultKey, JSON.parse(e.newValue)); } catch (_) { /* different password; ignore */ }
  });

  function readLocal() {
    return cache ? structuredClone(cache) : readPlain();
  }
  async function writeLocal(d) {
    d.expenses.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!vaultKey) {
      if (hasVault()) throw new Error('Locked. Enter your password first.');
      localStorage.setItem(LS_KEY, JSON.stringify(d));
      return;
    }
    cache = structuredClone(d);
    const snapshot = cache;
    saving = saving.catch(() => {}).then(() => persist(snapshot));
    return saving;
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
      await writeLocal(d);
      return acc;
    },
    async updateAccount(id, a) {
      const d = readLocal();
      const acc = d.accounts.find((x) => x.id === id);
      if (!acc) throw new Error('Account not found.');
      Object.assign(acc, { kind: a.kind, name: a.name, bank: a.bank || '', color: a.color || '' });
      await writeLocal(d);
      return acc;
    },
    async deleteAccount(id) {
      const d = readLocal();
      d.accounts = d.accounts.filter((x) => x.id !== id);
      d.entries = d.entries.filter((x) => x.account_id !== id);
      d.expenses.forEach((x) => { if (x.account_id === id) x.account_id = null; });
      await writeLocal(d);
    },
    async saveMonth(month, entries) {
      const d = readLocal();
      for (const item of entries) {
        d.entries = d.entries.filter((x) => !(x.month === month && x.account_id === item.account_id));
        if (item.amount != null) d.entries.push({ month, account_id: item.account_id, amount: item.amount });
      }
      await writeLocal(d);
    },
    async addExpense(e) {
      const d = readLocal();
      const exp = { id: uid(), date: e.date, amount: e.amount, category: e.category, note: e.note || '', account_id: e.account_id || null };
      d.expenses.unshift(exp);
      await writeLocal(d);
      return exp;
    },
    async deleteExpense(id) {
      const d = readLocal();
      d.expenses = d.expenses.filter((x) => x.id !== id);
      await writeLocal(d);
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
      await writeLocal(d);
      return readLocal();
    },
    async reset() { await writeLocal(empty()); },
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
    vaultSupported,
    hasVault,
    vault,
    get vaultOpen() { return !!vaultKey; },
    get canLock() { return (mode === 'api' && auth) || (mode === 'local' && !!vaultKey); },
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
