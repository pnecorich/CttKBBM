(() => {
  'use strict';

  // ---------- Konfigurasi ----------
  const CFG = window.BBM_CONFIG || {};
  const PRESETS = [20000, 30000, 50000, 100000, 150000, 200000];
  const MAX_AMOUNT = 9999999;
  const LS_ROWS = 'bbm.rows.v1';
  const LS_PENDING = 'bbm.pending.v1';
  const LS_TOKEN = 'bbm.token.v1';

  const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  // ---------- Helper umum ----------
  const $ = (sel) => document.querySelector(sel);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => toISO(new Date());
  const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const labelTanggal = (iso) => { const d = parseISO(iso); return `${HARI[d.getDay()]} ${d.getDate()} ${BULAN_PENDEK[d.getMonth()]}`; };
  const tanggalPendek = (iso) => { const d = parseISO(iso); return `${d.getDate()} ${BULAN_PENDEK[d.getMonth()]}`; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* abaikan */ } }
  function getToken() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; } }
  function setToken(v) { try { v ? localStorage.setItem(LS_TOKEN, v) : localStorage.removeItem(LS_TOKEN); } catch (_) { /* abaikan */ } }

  const normalizeRow = (r) => ({
    id: String(r.id),
    date: String(r.date).slice(0, 10),
    amount: Number(r.amount) || 0,
    note: String(r.note || ''),
    ts: Number(r.ts) || 0
  });

  // ---------- State ----------
  const state = {
    today: todayISO(),
    date: todayISO(),
    amount: 0,
    note: '',
    rows: load(LS_ROWS, []).map(normalizeRow),     // sudah terkonfirmasi di Sheets
    pending: load(LS_PENDING, []).map(normalizeRow), // belum terkirim
    openMonths: new Set([todayISO().slice(0, 7)]),
    sync: 'idle',
    authError: false
  };

  const urlOk = () => typeof CFG.APPS_SCRIPT_URL === 'string' && /^https:\/\/script\.google\.com\//.test(CFG.APPS_SCRIPT_URL);
  const configured = () => urlOk() && !!getToken();
  const allRows = () => {
    const ids = new Set(state.rows.map((r) => r.id));
    return [...state.rows, ...state.pending.filter((p) => !ids.has(p.id))];
  };

  // ---------- API ----------
  async function api(action, payload) {
    if (!configured()) {
      const e = new Error('Belum terhubung');
      e.code = 'not-configured';
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(CFG.APPS_SCRIPT_URL, {
        method: 'POST',
        // text/plain menghindari preflight CORS yang tidak didukung Apps Script
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: getToken(), action }, payload || {})),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('Server membalas ' + res.status);
      const data = await res.json();
      if (!data.ok) {
        const e = new Error(data.error || 'Gagal');
        e.code = data.error;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function handleError(err) {
    if (err && err.code === 'unauthorized') {
      setToken('');
      state.authError = true;
      renderBanner();
    }
    setSync('error');
  }

  let flushPromise = null;
  function flush() {
    if (flushPromise) return flushPromise;
    if (!state.pending.length || !configured()) return Promise.resolve();
    flushPromise = (async () => {
      setSync('sending');
      try {
        while (state.pending.length) {
          const e = state.pending[0];
          await api('add', { id: e.id, date: e.date, amount: e.amount, note: e.note });
          state.pending = state.pending.filter((p) => p.id !== e.id);
          state.rows.push(e);
          save(LS_PENDING, state.pending);
          save(LS_ROWS, state.rows);
          renderHistory();
          renderSummary();
        }
        setSync('ok');
      } catch (err) {
        handleError(err);
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  async function refresh() {
    if (!configured()) { renderStatus(); return; }
    setSync('loading');
    try {
      const data = await api('list');
      state.rows = data.rows.map(normalizeRow);
      const ids = new Set(state.rows.map((r) => r.id));
      state.pending = state.pending.filter((p) => !ids.has(p.id));
      save(LS_ROWS, state.rows);
      save(LS_PENDING, state.pending);
      setSync('ok');
    } catch (err) {
      handleError(err);
    }
    renderHistory();
    renderSummary();
  }

  // ---------- Layar LCD ----------
  let shown = 0;
  let raf = 0;
  function setLCD(target, opts) {
    const animate = !opts || opts.animate !== false;
    const el = $('#lcd-value');
    cancelAnimationFrame(raf);
    if (!animate || reduceMotion() || shown === target) {
      shown = target;
      el.textContent = fmt(target);
      return;
    }
    const from = shown;
    const t0 = performance.now();
    const dur = 420;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      shown = Math.round(from + (target - from) * eased);
      el.textContent = fmt(shown);
      if (p < 1) raf = requestAnimationFrame(step);
      else { shown = target; el.textContent = fmt(target); }
    };
    raf = requestAnimationFrame(step);
  }

  function flashLCD() {
    if (reduceMotion()) return;
    const lcd = $('#lcd');
    lcd.classList.remove('is-flash');
    void lcd.offsetWidth; // restart animasi
    lcd.classList.add('is-flash');
    setTimeout(() => lcd.classList.remove('is-flash'), 1100);
  }

  function renderLCDMeta() {
    const isToday = state.date === state.today;
    $('#lcd-date').textContent = (isToday ? 'Hari ini, ' : '') + labelTanggal(state.date);
  }

  // ---------- Tanggal ----------
  function buildStrip() {
    const strip = $('#strip');
    strip.replaceChildren();
    for (let i = 6; i >= 0; i--) {
      const iso = addDays(state.today, -i);
      const d = parseISO(iso);
      strip.append(h('button', {
        type: 'button',
        class: 'day',
        'data-iso': iso,
        'aria-pressed': 'false',
        'aria-label': labelTanggal(iso) + (i === 0 ? ' (hari ini)' : ''),
        onclick: () => { state.date = iso; updateStrip(); renderLCDMeta(); }
      },
        h('span', { class: 'day__w', text: i === 0 ? 'Hari ini' : HARI[d.getDay()] }),
        h('span', { class: 'day__n', text: String(d.getDate()) })
      ));
    }
    const input = h('input', {
      type: 'date',
      id: 'day-picker',
      class: 'day__picker',
      max: state.today,
      value: state.date,
      'aria-label': 'Pilih tanggal lain'
    });
    input.addEventListener('change', () => {
      if (!input.value) return;
      state.date = input.value > state.today ? state.today : input.value;
      updateStrip();
      renderLCDMeta();
    });
    input.addEventListener('click', () => { try { input.showPicker(); } catch (_) { /* pakai bawaan browser */ } });
    strip.append(h('label', { class: 'day day--other', id: 'day-other' },
      h('span', { class: 'day__w', text: 'Lain' }),
      h('span', { class: 'day__n day__n--small', id: 'day-other-n', text: 'kalender' }),
      input
    ));
    requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });
  }

  function updateStrip() {
    let inStrip = false;
    document.querySelectorAll('.day[data-iso]').forEach((b) => {
      const on = b.dataset.iso === state.date;
      if (on) inStrip = true;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#day-other').classList.toggle('is-on', !inStrip);
    $('#day-other-n').textContent = inStrip ? 'kalender' : tanggalPendek(state.date);
    $('#day-picker').value = state.date;
  }

  // ---------- Nominal ----------
  function buildChips() {
    const box = $('#chips');
    box.replaceChildren();
    PRESETS.forEach((p) => {
      box.append(h('button', {
        type: 'button',
        class: 'chip',
        'data-amount': String(p),
        'aria-pressed': 'false',
        onclick: () => pickPreset(p)
      }, p >= 1000 ? (p / 1000) + 'rb' : String(p)));
    });
  }

  function updateChips() {
    document.querySelectorAll('.chip').forEach((c) => {
      const on = Number(c.dataset.amount) === state.amount;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', String(on));
    });
  }

  function pickPreset(p) {
    state.amount = state.amount === p ? 0 : p; // ketuk lagi untuk membatalkan
    $('#manual').value = '';
    setLCD(state.amount);
    updateChips();
    renderButton();
  }

  function onManualInput() {
    const input = $('#manual');
    const digits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 7);
    const n = digits ? Math.min(Number(digits), MAX_AMOUNT) : 0;
    input.value = n ? fmt(n) : '';
    state.amount = n;
    setLCD(n, { animate: false });
    updateChips();
    renderButton();
  }

  function renderButton() {
    const btn = $('#submit');
    btn.disabled = state.amount <= 0;
    btn.textContent = state.amount > 0 ? 'Catat Rp ' + fmt(state.amount) : 'Pilih nominal dulu';
  }

  // ---------- Simpan ----------
  async function submit() {
    if (state.amount <= 0) return;
    const entry = {
      id: uid(),
      date: state.date,
      amount: state.amount,
      note: state.note.trim().slice(0, 120),
      ts: Date.now()
    };
    state.pending.push(entry);
    save(LS_PENDING, state.pending);

    state.amount = 0;
    state.note = '';
    $('#manual').value = '';
    $('#note').value = '';
    setLCD(0);
    flashLCD();
    updateChips();
    renderButton();
    renderHistory();
    renderSummary();
    renderStatus();

    await flush();
    if (state.pending.some((p) => p.id === entry.id) && configured()) await flush();

    const stillPending = state.pending.some((p) => p.id === entry.id);
    if (!stillPending) toast(`Tersimpan: Rp ${fmt(entry.amount)}, ${labelTanggal(entry.date)}`, 'ok');
    else if (configured()) toast('Belum terkirim. Disimpan di perangkat, dicoba lagi nanti.', 'err');
    else toast('Disimpan di perangkat. Belum terhubung ke Sheets.', 'err');
  }

  async function removeRow(id) {
    const inPending = state.pending.some((p) => p.id === id);
    if (inPending) {
      state.pending = state.pending.filter((p) => p.id !== id);
      save(LS_PENDING, state.pending);
      renderHistory(); renderSummary(); renderStatus();
      toast('Catatan dihapus', 'ok');
      return;
    }
    const idx = state.rows.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const removed = state.rows.splice(idx, 1)[0];
    save(LS_ROWS, state.rows);
    renderHistory(); renderSummary();
    try {
      await api('delete', { id });
      toast('Catatan dihapus', 'ok');
    } catch (err) {
      state.rows.push(removed);
      save(LS_ROWS, state.rows);
      renderHistory(); renderSummary();
      handleError(err);
      toast('Gagal menghapus. Coba lagi.', 'err');
    }
  }

  // ---------- Ringkasan & riwayat ----------
  function renderSummary() {
    const rows = allRows();
    const curKey = state.today.slice(0, 7);
    const d = parseISO(state.today);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const prevKey = toISO(d).slice(0, 7);

    const cur = rows.filter((r) => r.date.startsWith(curKey));
    const curTotal = cur.reduce((a, r) => a + r.amount, 0);
    const prevTotal = rows.filter((r) => r.date.startsWith(prevKey)).reduce((a, r) => a + r.amount, 0);

    $('#summary').replaceChildren(
      h('div', null,
        h('span', { class: 'summary__label', text: 'Bulan ini' }),
        h('strong', { class: 'summary__total', text: 'Rp ' + fmt(curTotal) })
      ),
      h('div', { class: 'summary__side' },
        h('span', { text: cur.length ? cur.length + ' kali isi' : 'Belum ada isi' }),
        prevTotal ? h('span', { text: 'Bulan lalu Rp ' + fmt(prevTotal) }) : null
      )
    );
  }

  function entryRow(r, isPending) {
    let timer;
    const del = h('button', { type: 'button', class: 'del', 'aria-label': 'Hapus catatan ' + labelTanggal(r.date), text: 'Hapus' });
    del.addEventListener('click', () => {
      if (del.classList.contains('is-confirm')) {
        clearTimeout(timer);
        removeRow(r.id);
        return;
      }
      del.classList.add('is-confirm');
      del.textContent = 'Yakin?';
      timer = setTimeout(() => { del.classList.remove('is-confirm'); del.textContent = 'Hapus'; }, 3000);
    });
    return h('li', { class: 'entry-row' },
      h('div', { class: 'entry-row__when' },
        h('span', { class: 'entry-row__date', text: labelTanggal(r.date) }),
        r.note ? h('span', { class: 'entry-row__note', text: r.note }) : null,
        isPending ? h('span', { class: 'entry-row__tag', text: 'belum terkirim' }) : null
      ),
      h('span', { class: 'entry-row__amount', text: fmt(r.amount) }),
      del
    );
  }

  function renderHistory() {
    const box = $('#history');
    box.replaceChildren();
    const rows = allRows();
    if (!rows.length) {
      box.append(h('p', { class: 'empty', text: 'Belum ada catatan. Pilih nominal, lalu tekan Catat.' }));
      return;
    }
    const pendingIds = new Set(state.pending.map((p) => p.id));
    const groups = new Map();
    rows.slice()
      .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0))
      .forEach((r) => {
        const key = r.date.slice(0, 7);
        if (!groups.has(key)) groups.set(key, { key, total: 0, items: [] });
        const g = groups.get(key);
        g.total += r.amount;
        g.items.push(r);
      });
    const max = Math.max(1, ...Array.from(groups.values()).map((g) => g.total));

    groups.forEach((g) => {
      const open = state.openMonths.has(g.key);
      const parts = g.key.split('-').map(Number);
      const list = h('ul', { class: 'entries', hidden: !open }, g.items.map((r) => entryRow(r, pendingIds.has(r.id))));
      const head = h('button', { type: 'button', class: 'month', 'aria-expanded': String(open) },
        h('span', { class: 'month__bar', style: 'width:' + Math.max(4, Math.round((g.total / max) * 100)) + '%' }),
        h('span', { class: 'month__name', text: BULAN[parts[1] - 1] + ' ' + parts[0] }),
        h('span', { class: 'month__total', text: fmt(g.total) })
      );
      head.addEventListener('click', () => {
        const nowOpen = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', String(nowOpen));
        list.hidden = !nowOpen;
        if (nowOpen) state.openMonths.add(g.key); else state.openMonths.delete(g.key);
      });
      box.append(h('div', { class: 'monthgroup' }, head, list));
    });
  }

  // ---------- Status, banner, toast ----------
  function setSync(mode) { state.sync = mode; renderStatus(); }

  function renderStatus() {
    const n = state.pending.length;
    let text, mode;
    if (!configured()) { text = 'Belum terhubung'; mode = 'off'; }
    else if (state.sync === 'loading') { text = 'Memuat…'; mode = 'busy'; }
    else if (state.sync === 'sending') { text = 'Menyimpan…'; mode = 'busy'; }
    else if (state.sync === 'error' || n > 0) { text = n ? n + ' belum terkirim' : 'Gagal terhubung'; mode = 'err'; }
    else { text = 'Tersinkron'; mode = 'ok'; }
    $('#sync').dataset.mode = mode;
    $('#sync-text').textContent = text;
  }

  function renderBanner() {
    const b = $('#banner');
    b.replaceChildren();
    if (!urlOk()) {
      b.hidden = false;
      b.append(h('p', { text: 'Belum terhubung ke Google Sheets. Isi APPS_SCRIPT_URL di config.js. Sementara itu, catatan disimpan di perangkat ini.' }));
      return;
    }
    if (!getToken()) {
      b.hidden = false;
      const input = h('input', { type: 'password', id: 'token-input', placeholder: 'Kode akses', autocomplete: 'off', 'aria-label': 'Kode akses' });
      const form = h('form', { class: 'banner__form' }, input, h('button', { type: 'submit', text: 'Simpan' }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return;
        setToken(v);
        state.authError = false;
        renderBanner();
        renderStatus();
        flush().then(refresh);
      });
      b.append(
        h('p', { text: state.authError ? 'Kode akses salah. Masukkan lagi.' : 'Masukkan kode akses sekali di perangkat ini. Kode tidak disimpan di GitHub.' }),
        form
      );
      return;
    }
    b.hidden = true;
  }

  let toastTimer;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast is-show is-' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-show'), 3000);
  }

  // ---------- Mulai ----------
  function renderAll() {
    updateStrip();
    updateChips();
    setLCD(state.amount, { animate: false });
    renderLCDMeta();
    renderButton();
    renderSummary();
    renderHistory();
    renderStatus();
    renderBanner();
  }

  function init() {
    buildStrip();
    buildChips();

    $('#manual').addEventListener('input', onManualInput);
    $('#manual').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    $('#note-toggle').addEventListener('click', () => {
      const input = $('#note');
      const show = input.hidden;
      input.hidden = !show;
      $('#note-toggle').setAttribute('aria-expanded', String(show));
      $('#note-toggle').textContent = show ? 'Sembunyikan catatan' : '+ Tambah catatan';
      if (show) input.focus();
    });
    $('#note').addEventListener('input', (e) => { state.note = e.target.value; });
    $('#submit').addEventListener('click', submit);
    $('#sync').addEventListener('click', () => { flush().then(refresh); });
    $('#reset-token').addEventListener('click', () => {
      setToken('');
      state.authError = false;
      renderBanner();
      renderStatus();
      const i = $('#token-input');
      if (i) i.focus();
    });

    window.addEventListener('online', () => { flush().then(refresh); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const t = todayISO();
      if (t !== state.today) {
        const wasToday = state.date === state.today;
        state.today = t;
        if (wasToday) state.date = t;
        buildStrip();
        updateStrip();
        renderLCDMeta();
        renderSummary();
      }
      flush().then(refresh);
    });

    renderAll();
    flush().then(refresh);
  }

  init();
})();
