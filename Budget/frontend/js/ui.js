/* Shared UI: formatting, month state, theme, scroll animations, toasts. */
const UI = (() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* private mode */ } },
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ------------------------------------------------------------ money */
  const CURRENCIES = {
    INR: 'en-IN', USD: 'en-US', EUR: 'en-IE', GBP: 'en-GB', AED: 'en-AE',
    SGD: 'en-SG', AUD: 'en-AU', CAD: 'en-CA', JPY: 'ja-JP',
  };
  let currency = CURRENCIES[store.get('budget.currency')] ? store.get('budget.currency') : 'INR';
  const formatters = {};
  function formatter(kind) {
    const key = currency + kind;
    if (!formatters[key]) {
      const base = { style: 'currency', currency };
      const opts = {
        whole: { ...base, maximumFractionDigits: 0 },
        exact: { ...base, minimumFractionDigits: 2, maximumFractionDigits: 2 },
        compact: { ...base, notation: 'compact', maximumFractionDigits: 1 },
      }[kind];
      formatters[key] = new Intl.NumberFormat(CURRENCIES[currency], opts);
    }
    return formatters[key];
  }
  /** Full amount; shows paise/cents only when the value has them. */
  const money = (n) => formatter(Number.isInteger(Math.round(n * 100) / 100) ? 'whole' : 'exact').format(n);
  const moneyWhole = (n) => formatter('whole').format(Math.round(n));
  const compact = (n) => formatter('compact').format(n);
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
  const symbol = () => formatter('whole').formatToParts(0).find((p) => p.type === 'currency').value;
  const percent = (ratio) => `${Math.round(ratio * 100)}%`;

  /** "1,25,000.50" -> 125000.5 ; "" -> null */
  function parseAmount(text) {
    const cleaned = String(text).replace(/[^0-9.]/g, '');
    if (!cleaned || cleaned === '.') return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  /* ----------------------------------------------------------- months */
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const todayMonth = () => ym(new Date());
  const todayISO = () => { const d = new Date(); return `${ym(d)}-${String(d.getDate()).padStart(2, '0')}`; };
  const toDate = (month) => { const [y, m] = month.split('-').map(Number); return new Date(y, m - 1, 1); };
  const shiftMonth = (month, by) => { const d = toDate(month); d.setMonth(d.getMonth() + by); return ym(d); };
  const daysIn = (month) => { const d = toDate(month); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
  const monthLabel = (month, style = 'long') =>
    toDate(month).toLocaleDateString('en-GB', { month: style, year: 'numeric' });
  const monthShort = (month) => toDate(month).toLocaleDateString('en-GB', { month: 'short' });

  let month = todayMonth();
  try {
    const saved = sessionStorage.getItem('budget.month');
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(saved || '')) month = saved;
  } catch (_) { /* ignore */ }
  const monthListeners = [];

  function paintMonth() {
    $$('[data-month-label]').forEach((el) => { el.textContent = monthLabel(month); });
    const label = $('#monthLabel');
    if (label) label.textContent = monthLabel(month, 'short');
  }
  function setMonth(next) {
    if (next === month) return;
    month = next;
    try { sessionStorage.setItem('budget.month', month); } catch (_) { /* ignore */ }
    paintMonth();
    monthListeners.forEach((fn) => fn(month));
  }

  /* ------------------------------------------------- scroll animation */
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });

  /** Watch every [data-reveal] under root; children of [data-stagger] cascade. */
  function reveal(root = document) {
    $$('[data-stagger]', root).forEach((group) => {
      [...group.children].forEach((child, i) => child.style.setProperty('--d', `${Math.min(i, 10) * 70}ms`));
    });
    $$('[data-reveal]:not(.in)', root).forEach((el) => io.observe(el));
    $$('.tilt:not([data-tilt])', root).forEach(tilt);
  }

  function tilt(el) {
    el.dataset.tilt = '1';
    if (reduceMotion || matchMedia('(hover: none)').matches) return;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      el.style.setProperty('--ry', `${(px - 0.5) * 9}deg`);
      el.style.setProperty('--rx', `${(0.5 - py) * 9}deg`);
      el.style.setProperty('--mx', `${px * 100}%`);
      el.style.setProperty('--my', `${py * 100}%`);
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
    });
  }

  function watchScroll() {
    const root = document.documentElement;
    const nav = $('#nav');
    const hero = $('.hero');
    let queued = false;
    const update = () => {
      queued = false;
      const y = window.scrollY;
      const max = root.scrollHeight - window.innerHeight;
      root.style.setProperty('--sy', y.toFixed(1));
      root.style.setProperty('--progress', max > 0 ? Math.min(1, y / max).toFixed(4) : '0');
      if (hero) root.style.setProperty('--hero-p', Math.min(1, y / (hero.offsetHeight * 0.85)).toFixed(3));
      if (nav) nav.classList.toggle('scrolled', y > 12);
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
    addEventListener('resize', update);
    update();
  }

  /** Animate a number from whatever the element shows now to `value`. */
  function countUp(el, value, format = money) {
    if (!el) return;
    const from = typeof el._value === 'number' ? el._value : 0;
    cancelAnimationFrame(el._raf);
    el._target = value;
    if (reduceMotion || from === value || document.hidden) {
      el._value = value;
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    const duration = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el._value = t === 1 ? value : from + (value - from) * eased;
      el.textContent = format(t === 1 ? value : Math.round(el._value));
      if (t < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------ chrome */
  function toast(message, kind = 'info') {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.append(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    host.append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, kind === 'error' ? 5200 : 2800);
  }

  function initTheme() {
    const btn = $('#themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      store.set('budget.theme', next);
      themeListeners.forEach((fn) => fn(next));
    });
  }
  const themeListeners = [];

  function initNav() {
    $('#monthPrev')?.addEventListener('click', () => setMonth(shiftMonth(month, -1)));
    $('#monthNext')?.addEventListener('click', () => setMonth(shiftMonth(month, 1)));
    $('#monthLabel')?.addEventListener('click', () => setMonth(todayMonth()));
    paintMonth();
  }

  function initCurrency(onChange) {
    const select = $('#currencySelect');
    if (!select) return;
    select.innerHTML = Object.keys(CURRENCIES).map((c) => `<option value="${c}">${c}</option>`).join('');
    select.value = currency;
    select.addEventListener('change', () => {
      currency = select.value;
      store.set('budget.currency', currency);
      onChange();
    });
  }

  function paintSync() {
    const badge = $('#syncBadge');
    const note = $('#syncNote');
    const api = Store.mode === 'api';
    if (badge) {
      badge.hidden = false;
      badge.className = `sync ${api ? 'ok' : 'local'}`;
      badge.innerHTML = `<i aria-hidden="true"></i><span>${api ? 'Synced to server' : 'Saved in this browser'}</span>`;
      badge.title = api
        ? 'Your numbers are stored by the Flask server.'
        : 'The server is not reachable, so your numbers are kept in this browser only.';
    }
    if (note) {
      note.textContent = api
        ? 'Your numbers are stored in the Flask server’s database.'
        : 'The Flask server is not reachable from this page, so your numbers are stored in this browser only.';
    }
  }

  /* -------------------------------------------------------- password lock */
  const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  let lockPromise = null;

  /** Cover the page until the right password is entered. Resolves once unlocked. */
  function lockScreen() {
    if (lockPromise) return lockPromise;
    lockPromise = new Promise((resolve) => {
      const behind = $$('body > header, body > main, body > footer');
      behind.forEach((el) => { el.inert = true; });
      $$('dialog[open]').forEach((d) => d.close());

      const overlay = document.createElement('div');
      overlay.className = 'lock';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'lockTitle');
      overlay.innerHTML = `
        <form class="lock-card" novalidate>
          <span class="lock-icon">${LOCK_ICON}</span>
          <h2 id="lockTitle">Locked</h2>
          <p>Enter your password to see your numbers.</p>
          <input type="text" name="username" value="budget" autocomplete="username" hidden>
          <label class="field"><span>Password</span>
            <input type="password" name="password" autocomplete="current-password" required>
          </label>
          <p class="lock-error" role="alert"></p>
          <button type="submit" class="btn primary">Unlock</button>
        </form>`;
      document.body.append(overlay);

      const form = $('form', overlay);
      const input = form.elements.password;
      const error = $('.lock-error', overlay);
      const button = $('button', overlay);
      input.focus();

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!input.value) { input.focus(); return; }
        button.disabled = true;
        error.textContent = '';
        try {
          await Store.login(input.value);
          behind.forEach((el) => { el.inert = false; });
          overlay.classList.add('open');
          setTimeout(() => overlay.remove(), reduceMotion ? 0 : 600);
          lockPromise = null;
          resolve();
        } catch (err) {
          error.textContent = err.message;
          form.classList.remove('shake');
          void form.offsetWidth; // restart the animation
          form.classList.add('shake');
          input.select();
          button.disabled = false;
        }
      });
    });
    return lockPromise;
  }

  function initLockButton() {
    if (!Store.auth || $('#lockBtn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'lockBtn';
    btn.className = 'icon-btn still';
    btn.setAttribute('aria-label', 'Lock the app');
    btn.title = 'Lock';
    btn.innerHTML = LOCK_ICON;
    btn.addEventListener('click', async () => {
      try { await Store.logout(); } catch (_) { /* reload shows the real state */ }
      location.reload();
    });
    $('.nav-tools')?.append(btn);
  }

  /** Connect to the data layer and switch on everything shared. */
  async function boot() {
    initTheme();
    initNav();
    watchScroll();
    reveal();
    await Store.init();
    if (Store.locked) await lockScreen();
    // Locked later on (login expired, or locked from another tab): ask again, then start fresh.
    addEventListener('budget:locked', () => lockScreen().then(() => location.reload()));
    initLockButton();
    paintSync();
  }

  return {
    $, $$, esc, reduceMotion,
    money, moneyWhole, compact, signed, symbol, percent, parseAmount,
    todayMonth, todayISO, shiftMonth, daysIn, monthLabel, monthShort,
    get month() { return month; },
    setMonth,
    onMonthChange: (fn) => monthListeners.push(fn),
    onThemeChange: (fn) => themeListeners.push(fn),
    reveal, countUp, toast, boot, initCurrency,
  };
})();
