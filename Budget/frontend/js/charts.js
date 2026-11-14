/* Small dependency-free SVG charts: multi-line, columns and ranked bars.
 * Every chart redraws itself when its container changes width, and plays
 * its entrance animation when an ancestor gains the `.in` class (see UI.reveal).
 */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const CHAR = 6.4; // approximate width of an 11px label character

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const key in attrs) el.setAttribute(key, attrs[key]);
    if (parent) parent.append(el);
    return el;
  }

  /** Round axis bounds and ticks covering [min, max]. */
  function scale(min, max, target = 4) {
    if (max - min < 1e-9) max = min + 1;
    const rough = (max - min) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(lo + i * step);
    return { lo, hi, ticks };
  }

  /** Full figures under 10,000; compact once the axis reaches it. */
  const tickFormat = (sc) => (Math.max(Math.abs(sc.lo), Math.abs(sc.hi)) >= 10000 ? UI.compact : UI.moneyWhole);

  function mount(el, config, draw) {
    el._config = config;
    el._draw = () => { if (el.clientWidth) draw(el, el._config); };
    if (!el._observer) {
      el._observer = new ResizeObserver(() => { if (el.clientWidth && el.clientWidth !== el._width) el._draw(); });
      el._observer.observe(el);
      el.tabIndex = 0;
      el.addEventListener('focus', () => { const h = el._hover; if (h) h.show(h.index == null ? h.count - 1 : h.index); });
      el.addEventListener('blur', () => el._hover && el._hover.hide());
      el.addEventListener('keydown', (e) => {
        const h = el._hover;
        if (!h) return;
        const at = h.index == null ? h.count - 1 : h.index;
        if (e.key === 'ArrowLeft') { h.show(Math.max(0, at - 1)); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { h.show(Math.min(h.count - 1, at + 1)); e.preventDefault(); }
        else if (e.key === 'Enter' && h.select) h.select(at);
        else if (e.key === 'Escape') h.hide();
      });
    }
    el._draw();
  }

  function begin(el, height, label) {
    el.innerHTML = '';
    el.classList.add('chart');
    el._width = el.clientWidth;
    el._hover = null;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `${label} Use the left and right arrow keys to read each value.`);
    const root = svg('svg', { width: el._width, height, viewBox: `0 0 ${el._width} ${height}`, 'aria-hidden': 'true' }, el);
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    el.append(tip);
    return { root, tip, W: el._width };
  }

  function placeTip(el, tip, html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14;
    if (left + w > el.clientWidth) left = x - 14 - w;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, y - h / 2)}px`;
  }

  const tipRow = (name, value, color) =>
    `<div class="tip-row">${color ? `<i class="key" style="--c:${color}"></i>` : ''}<span>${UI.esc(name)}</span><b>${value}</b></div>`;

  function empty(el, message) {
    el.innerHTML = `<p class="chart-empty">${UI.esc(message)}</p>`;
    el._hover = null;
    el.removeAttribute('aria-label');
  }

  /** Index under the pointer for evenly spaced slots. */
  function trackPointer(target, toIndex, hover) {
    target.addEventListener('pointermove', (e) => {
      const r = target.getBoundingClientRect();
      hover.show(toIndex(e.clientX - r.left));
    });
    target.addEventListener('pointerleave', () => hover.hide());
    if (hover.select) {
      target.style.cursor = 'pointer';
      target.addEventListener('click', (e) => {
        const r = target.getBoundingClientRect();
        hover.select(toIndex(e.clientX - r.left));
      });
    }
  }

  /* ------------------------------------------------------------- lines */
  function drawLines(el, c) {
    const n = c.labels.length;
    if (!n) return empty(el, c.empty || 'Nothing to show yet.');
    const H = c.height || 300;
    const { root, tip, W } = begin(el, H, c.label);

    const values = c.series.flatMap((s) => s.values);
    const sc = scale(Math.min(0, ...values), Math.max(0, ...values));
    const fmt = tickFormat(sc);
    const top = 14, bottom = 30;
    const left = Math.max(...sc.ticks.map((t) => fmt(t).length)) * CHAR + 16;
    const yOf = (v) => top + ((sc.hi - v) / (sc.hi - sc.lo)) * (H - top - bottom);

    // Name each line at its end, unless the ends sit too close to label cleanly.
    const ends = c.series.map((s) => yOf(s.values[n - 1])).sort((a, b) => a - b);
    let direct = W >= 640 && n > 1;
    for (let i = 1; i < ends.length; i++) if (ends[i] - ends[i - 1] < 16) direct = false;
    const right = direct ? Math.max(...c.series.map((s) => s.name.length)) * CHAR + 26 : 16;

    const pad = 12;
    const x0 = left + pad, x1 = W - right - pad;
    const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
    const xOf = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + step * i);

    if (c.selected != null && c.selected >= 0) {
      svg('rect', { class: 'sel-band', x: xOf(c.selected) - 18, y: top - 6, width: 36, height: H - top - bottom + 12, rx: 8 }, root);
    }
    for (const t of sc.ticks) {
      const y = Math.round(yOf(t)) + 0.5;
      svg('line', { class: t === 0 ? 'axis' : 'grid', x1: left, x2: W - right, y1: y, y2: y }, root);
      svg('text', { class: 'tick', x: left - 8, y: y + 4, 'text-anchor': 'end' }, root).textContent = fmt(t);
    }
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((x1 - x0) / 56))));
    c.labels.forEach((label, i) => {
      if ((n - 1 - i) % every && i !== c.selected) return;
      svg('text', { class: i === c.selected ? 'tick sel' : 'tick', x: xOf(i), y: H - 9, 'text-anchor': 'middle' }, root).textContent = label;
    });

    c.series.forEach((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join('');
      if (n > 1) svg('path', { class: 'line-path', d, pathLength: 1, style: `stroke:${s.color}` }, root);
      svg('circle', { class: 'dot end', cx: xOf(n - 1), cy: yOf(s.values[n - 1]), r: 5, style: `fill:${s.color}` }, root);
      if (direct) svg('text', { class: 'direct', x: xOf(n - 1) + 12, y: yOf(s.values[n - 1]) + 4 }, root).textContent = s.name;
    });

    const layer = svg('g', { class: 'hover-layer', visibility: 'hidden' }, root);
    const cross = svg('line', { class: 'cross', y1: top - 4, y2: H - bottom }, layer);
    const dots = c.series.map((s) => svg('circle', { class: 'dot', r: 5, style: `fill:${s.color}` }, layer));
    const hit = svg('rect', { x: left, y: 0, width: Math.max(0, W - left - right), height: H - bottom + 6, fill: 'transparent' }, root);

    const hover = {
      count: n,
      index: null,
      show(i) {
        hover.index = i;
        layer.setAttribute('visibility', 'visible');
        cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i));
        dots.forEach((dot, k) => { dot.setAttribute('cx', xOf(i)); dot.setAttribute('cy', yOf(c.series[k].values[i])); });
        const rows = c.series.map((s) => tipRow(s.name, UI.money(s.values[i]), s.color)).join('');
        placeTip(el, tip, `<div class="tip-title">${UI.esc(c.titles ? c.titles[i] : c.labels[i])}</div>${rows}`, xOf(i), top + 44);
      },
      hide() { hover.index = null; layer.setAttribute('visibility', 'hidden'); tip.hidden = true; },
      select: c.onSelect ? (i) => c.onSelect(i) : null,
    };
    el._hover = hover;
    trackPointer(hit, (px) => Math.max(0, Math.min(n - 1, n === 1 ? 0 : Math.round((px + left - x0) / step))), hover);
  }

  /* ----------------------------------------------------------- columns */
  function drawColumns(el, c) {
    const n = c.values.length;
    const peak = Math.max(0, ...c.values);
    if (!n || peak === 0) return empty(el, c.empty || 'Nothing to show yet.');
    const H = c.height || 240;
    const { root, tip, W } = begin(el, H, c.label);

    const sc = scale(0, peak);
    const fmt = tickFormat(sc);
    const top = 26, bottom = 30, right = 8;
    const left = Math.max(...sc.ticks.map((t) => fmt(t).length)) * CHAR + 16;
    const base = H - bottom;
    const yOf = (v) => top + ((sc.hi - v) / sc.hi) * (base - top);
    const band = (W - left - right) / n;
    const bar = Math.max(2, Math.min(24, band - 2)); // capped width, 2px gap minimum
    const xMid = (i) => left + band * (i + 0.5);

    for (const t of sc.ticks) {
      const y = Math.round(yOf(t)) + 0.5;
      svg('line', { class: t === 0 ? 'axis' : 'grid', x1: left, x2: W - right, y1: y, y2: y }, root);
      svg('text', { class: 'tick', x: left - 8, y: y + 4, 'text-anchor': 'end' }, root).textContent = fmt(t);
    }
    const band0 = svg('rect', { class: 'col-band', y: top - 6, width: band, height: base - top + 6, visibility: 'hidden' }, root);

    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - left - right) / 44))));
    const showLabel = c.labelWhen || ((i) => i % every === 0);
    c.labels.forEach((label, i) => {
      if (!showLabel(i) && i !== c.highlight) return;
      svg('text', { class: i === c.highlight ? 'tick sel' : 'tick', x: xMid(i), y: H - 9, 'text-anchor': 'middle' }, root).textContent = label;
    });

    c.values.forEach((v, i) => {
      if (v <= 0) return;
      const h = Math.max(1, base - yOf(v));
      const r = Math.min(4, bar / 2, h);
      const x = xMid(i) - bar / 2, y = base - h;
      const d = `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bar - r}Q${x + bar},${y} ${x + bar},${y + r}V${base}Z`;
      const dim = c.highlight != null && i !== c.highlight;
      svg('path', { class: 'col', d, style: `fill:${dim ? 'var(--deemph)' : c.color};--i:${i}` }, root);
    });

    // One direct label: the highlighted column, or the tallest.
    const labelled = c.highlight != null ? c.highlight : c.values.indexOf(peak);
    if (c.values[labelled] > 0) {
      const text = UI.money(c.values[labelled]);
      const half = (text.length * 7) / 2;
      const x = Math.max(left + half, Math.min(W - right - half, xMid(labelled)));
      svg('text', { class: 'cap', x, y: yOf(c.values[labelled]) - 8, 'text-anchor': 'middle' }, root).textContent = text;
    }

    const hit = svg('rect', { x: left, y: 0, width: Math.max(0, W - left - right), height: H, fill: 'transparent' }, root);
    const hover = {
      count: n,
      index: null,
      show(i) {
        hover.index = i;
        band0.setAttribute('visibility', 'visible');
        band0.setAttribute('x', left + band * i);
        placeTip(el, tip,
          `<div class="tip-title">${UI.esc(c.titles ? c.titles[i] : c.labels[i])}</div>${tipRow(c.name, UI.money(c.values[i]), c.color)}`,
          xMid(i), Math.max(30, yOf(c.values[i]) - 10));
      },
      hide() { hover.index = null; band0.setAttribute('visibility', 'hidden'); tip.hidden = true; },
      select: c.onSelect ? (i) => c.onSelect(i) : null,
    };
    el._hover = hover;
    trackPointer(hit, (px) => Math.max(0, Math.min(n - 1, Math.floor(px / band))), hover);
  }

  /* ------------------------------------------------------- ranked bars */
  function bars(el, c) {
    const items = c.items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
    if (!items.length) { el.innerHTML = `<p class="chart-empty">${UI.esc(c.empty || 'Nothing to show yet.')}</p>`; return; }
    const max = items[0].value;
    const total = items.reduce((sum, it) => sum + it.value, 0);
    el.innerHTML = `<ul class="rbars">${items.map((it, i) => `
      <li class="rbar" style="--w:${((it.value / max) * 100).toFixed(2)};--i:${i}">
        <span class="rbar-label">${UI.esc(it.label)}</span>
        <span class="rbar-track"><i style="background:${c.color}"></i></span>
        <span class="rbar-value">${UI.money(it.value)}<small>${UI.percent(it.value / total)}</small></span>
      </li>`).join('')}</ul>`;
  }

  return {
    lines: (el, config) => mount(el, config, drawLines),
    columns: (el, config) => mount(el, config, drawColumns),
    bars,
    redraw: () => document.querySelectorAll('.chart').forEach((el) => el._draw && el._draw()),
  };
})();
