/* Reference renderer for the design. The production app is vanilla TypeScript; this file
   shows which element gets which value in each state. Query params (used by states.html):
   ?state=disconnected|connecting|rejected|waiting-data|waiting-oi|live|stale
   &coin=BTC|ETH|SOL  &token=hidden|visible  &fixture=statuses  &frame=<id> */
(function () {
  'use strict';
  var POLL_MS = 20000;                 // assumed polling interval; STALE = age > 3 × POLL_MS
  var STATUS = { used: 'Used', stale: 'Excluded · stale', no_rate: 'Excluded · no predicted rate', not_listed: 'Excluded · not listed' };
  var CONN_DETAIL = {
    disconnected: 'Enter a token and connect.',
    connecting: 'Opening live connection…',
    connected: 'Live',
    rejected: 'Token rejected. Check it and connect again.'
  };
  var STATES = {
    disconnected: { conn: 'disconnected', data: 'waiting-data', token: '' },
    connecting: { conn: 'connecting', data: 'waiting-data' },
    rejected: { conn: 'rejected', data: 'waiting-data', token: 'expired-7c21' },
    'waiting-data': { conn: 'connected', data: 'waiting-data' },
    'waiting-oi': { conn: 'connected', data: 'waiting-oi' },
    live: { conn: 'connected', data: 'live', ageMs: 4000 },
    stale: { conn: 'connected', data: 'stale', ageMs: 84000 }
  };

  var q = new URLSearchParams(location.search);
  var preset = STATES[q.get('state')] || STATES.live;
  var S = {
    conn: preset.conn,
    data: preset.data,
    ageMs: preset.ageMs || 0,
    coin: (q.get('coin') || 'BTC').toUpperCase(),
    showToken: q.get('token') === 'visible',
    token: preset.token != null ? preset.token : 'demo-token-4821'
  };

  /* ---------- data ---------- */
  var SNAP = {};
  (window.SNAPSHOT || []).forEach(function (s) { SNAP[s.symbol] = s; });
  if (q.get('fixture') === 'statuses') applyStatusFixture();

  // Fixture only: flag two venues so every exclusion reason is visible; aggregates recomputed from components.
  function applyStatusFixture() {
    Object.keys(SNAP).forEach(function (k) {
      var s = JSON.parse(JSON.stringify(SNAP[k]));
      s.components.forEach(function (c) {
        if (c.venue === 'WOO X') c.status = 'stale';
        if (c.venue === 'DERIBIT') { c.status = 'not_listed'; c.symbol = null; c.oi_usd = null; c.rate_period_hours = null; }
      });
      var used = s.components.filter(function (c) { return c.status === 'used'; });
      var oiSum = used.reduce(function (a, c) { return a + c.oi_usd; }, 0);
      s.aggregated_predicted_funding_rate = used.reduce(function (a, c) { return a + c.rate_8h; }, 0) / used.length;
      s.oi_weighted_predicted_funding_rate = used.reduce(function (a, c) { return a + c.rate_8h * c.oi_usd / oiSum; }, 0);
      s.markets = used.length;
      SNAP[k] = s;
    });
  }

  /* ---------- formatting ---------- */
  function signed(v, d) { return v == null ? '—' : (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d); }
  function usd(v) {
    if (v == null) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    return '$' + (v / 1e3).toFixed(1) + 'K';
  }
  function age(ms) { var s = Math.round(ms / 1000); return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ' + (s % 60) + 's ago'; }
  function signClass(v) { return v == null ? '' : v < 0 ? 'is-neg' : 'is-pos'; }
  function signWord(v) { return v < 0 ? 'negative' : 'positive'; }

  /* ---------- dom ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var app = $('#app'), tokenEl = $('#token'), toggleEl = $('#toggle'), connectEl = $('#connect');

  function setMetric(id, text, note, cls, waiting) {
    var el = $('#' + id), n = $('#' + id + '-note');
    el.textContent = text;
    el.className = 'metric__value ' + (waiting ? 'is-waiting' : cls);
    if (n) { n.textContent = note; n.className = 'metric__note' + (waiting ? ' is-waiting' : ''); }
  }

  function render() {
    var snap = SNAP[S.coin];
    var none = S.data === 'waiting-data', noOi = none || S.data === 'waiting-oi';
    app.dataset.conn = S.conn;
    app.dataset.data = S.data;

    // connection + token
    $$('[data-conn-label]').forEach(function (e) { e.textContent = S.conn.charAt(0).toUpperCase() + S.conn.slice(1); });
    $('#conn-detail').textContent = CONN_DETAIL[S.conn];
    tokenEl.type = S.showToken ? 'text' : 'password';
    tokenEl.value = S.token;
    tokenEl.setAttribute('aria-invalid', S.conn === 'rejected' ? 'true' : 'false');
    toggleEl.textContent = S.showToken ? 'Hide' : 'Show';
    toggleEl.setAttribute('aria-pressed', String(S.showToken));
    toggleEl.setAttribute('aria-label', (S.showToken ? 'Hide' : 'Show') + ' token');
    connectEl.disabled = S.conn === 'connecting';
    connectEl.textContent = S.conn === 'connecting' ? 'Connecting…' : 'Connect';

    // coin switch
    $$('.coin').forEach(function (b) {
      var k = b.dataset.coin, oi = SNAP[k].oi_weighted_predicted_funding_rate;
      b.setAttribute('aria-selected', String(k === S.coin));
      $('.coin__val', b).textContent = noOi ? '—' : signed(oi, 5);
    });
    $$('[data-coin-label]').forEach(function (e) { e.textContent = S.coin; });

    // freshness
    $('#age').textContent = none ? '—' : age(S.ageMs);

    // headline
    var avg = snap.aggregated_predicted_funding_rate, oi = snap.oi_weighted_predicted_funding_rate, sp = oi - avg;
    var comps = snap.components, used = comps.filter(function (c) { return c.status === 'used'; });
    var wData = 'waiting for data…', wOi = 'waiting for open interest…';
    setMetric('m-avg', none ? '—' : signed(avg, 5), none ? wData : '% per 8h · ' + signWord(avg), signClass(avg), none);
    setMetric('m-oi', noOi ? '—' : signed(oi, 5), none ? wData : noOi ? wOi : '% per 8h · ' + signWord(oi), signClass(oi), noOi);
    setMetric('m-sp', noOi ? '—' : signed(sp, 5), none ? wData : noOi ? wOi : 'pp · OI-weighted − AVG', signClass(sp), noOi);
    setMetric('m-ven', none ? '—' : used.length + ' / ' + comps.length, '', '', none);
    $('#pips').innerHTML = comps.map(function (c) {
      return '<span class="pip' + (none ? '' : c.status === 'used' ? ' pip--used' : ' pip--excluded') + '"></span>';
    }).join('');

    renderVenues(snap, none, noOi);
    renderChart(none, noOi);
    postHeight();
  }

  function renderVenues(snap, none, noOi) {
    var body = $('#venue-rows'), tpl = $('#venue-row');
    body.innerHTML = '';
    if (none) return;
    var avg = snap.aggregated_predicted_funding_rate, oi = snap.oi_weighted_predicted_funding_rate;
    var used = snap.components.filter(function (c) { return c.status === 'used'; });
    var excl = snap.components.filter(function (c) { return c.status !== 'used'; });
    var oiSum = used.reduce(function (a, c) { return a + c.oi_usd; }, 0);

    var vals = used.map(function (c) { return c.rate_8h; }).concat([avg, oi, 0]);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), pad = (mx - mn) * 0.08;
    mn -= pad; mx += pad;
    var pos = function (v) { return ((v - mn) / (mx - mn) * 100).toFixed(2) + '%'; };
    var box = $('#venues');
    box.style.setProperty('--zero', pos(0));
    box.style.setProperty('--avg', pos(avg));
    box.style.setProperty('--oi', pos(oi));
    var near = function (v) { return Math.abs(v) / (mx - mn) < 0.1; };
    var minT = near(mn) ? '' : signed(mn, 4), maxT = near(mx) ? '' : signed(mx, 4);
    $$('[data-axis-min]').forEach(function (e) { e.textContent = minT; });
    $$('[data-axis-max]').forEach(function (e) { e.textContent = maxT; });

    used.slice().sort(function (a, b) { return b.rate_8h - a.rate_8h; }).concat(excl).forEach(function (c) {
      var row = tpl.content.firstElementChild.cloneNode(true);
      var isUsed = c.status === 'used', w = isUsed && !noOi ? c.oi_usd / oiSum : null;
      row.dataset.status = c.status;
      if (!isUsed) row.classList.add('is-excluded');
      if (c.rate_8h != null && c.rate_8h < 0) row.classList.add('is-neg-rate');
      $('.v__name', row).textContent = c.venue;
      $('.v__sym', row).textContent = c.symbol || '—';
      $('.v__pred', row).textContent = signed(c.predicted_rate, 5);
      $('.v__per', row).textContent = c.rate_period_hours ? c.rate_period_hours + 'h' : '—';
      var r8 = $('.v__r8-val', row);
      r8.textContent = signed(c.rate_8h, 4);
      if (isUsed) r8.className = 'v__r8-val ' + signClass(c.rate_8h);
      $('.v__oi', row).textContent = noOi ? '—' : usd(c.oi_usd);
      $('.v__w', row).textContent = w == null ? '—' : w > 0 && w < 0.0005 ? '<0.1%' : (w * 100).toFixed(1) + '%';
      $('.tick-min', row).textContent = minT;
      $('.tick-max', row).textContent = maxT;
      $('.badge', row).textContent = STATUS[c.status] || c.status;
      var t = $('.track', row);
      if (isUsed) { t.style.setProperty('--x', pos(c.rate_8h)); t.style.setProperty('--w', noOi ? 0.3 : Math.sqrt(w).toFixed(3)); }
      body.appendChild(row);
    });
  }

  /* ---------- chart (lightweight-charts v5) ---------- */
  function rng(s) { return function () { s = s * 16807 % 2147483647; return s / 2147483647; }; }
  var SERIES = {};
  var SHAPE = { BTC: [0.0095, -0.0008, 7], ETH: [0.0088, -0.0007, 13], SOL: [0.005, -0.002, 29] };
  // Plausible 12h history at 5-min steps that ends on the snapshot values.
  function history(k) {
    if (SERIES[k]) return SERIES[k];
    var s = SNAP[k], sh = SHAPE[k], r = rng(sh[2]), end = Math.floor(s.timestamp / 300000) * 300;
    var a = s.aggregated_predicted_funding_rate, d = s.oi_weighted_predicted_funding_rate - a, A = [], O = [];
    for (var i = 0; i < 144; i++) {
      var t = end - i * 300;
      A.push({ time: t, value: a }); O.push({ time: t, value: a + d });
      a += (r() - 0.5) * 0.0007 + (sh[0] - a) * 0.03;
      d += (r() - 0.5) * 0.0005 + (sh[1] - d) * 0.06;
    }
    return SERIES[k] = { A: A.reverse(), O: O.reverse() };
  }

  var chart = null, sAvg, sOi, sSpread, css;
  function token(n) { return css.getPropertyValue(n).trim(); }
  function initChart() {
    var L = window.LightweightCharts; if (!L) return;
    css = getComputedStyle(document.documentElement);
    var fmt = { type: 'custom', minMove: 0.00001, formatter: function (v) { return signed(v, 4); } };
    var lw = parseInt(token('--chart-line-width'), 10) || 2;
    chart = L.createChart($('#chart'), {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: token('--chart-text'), fontFamily: token('--font-mono'), fontSize: parseInt(token('--chart-font-size'), 10) },
      grid: { vertLines: { color: token('--chart-grid') }, horzLines: { color: token('--chart-grid') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: L.CrosshairMode.Normal }
    });
    sAvg = chart.addSeries(L.LineSeries, { color: token('--chart-avg'), lineWidth: lw, priceFormat: fmt, priceLineVisible: false, title: 'AVG' });
    sOi = chart.addSeries(L.LineSeries, { color: token('--chart-oi'), lineWidth: lw, priceFormat: fmt, priceLineVisible: false, title: 'OI-w' });
    sSpread = chart.addSeries(L.HistogramSeries, { priceFormat: fmt, priceLineVisible: false, title: 'Spread' }, 1);
    try { chart.panes()[1].setHeight(parseInt(token('--chart-spread-pane'), 10)); } catch (e) { /* older v5 builds */ }
  }
  function renderChart(none, noOi) {
    if (!chart) initChart(); if (!chart) return;
    var h = history(S.coin), pos = token('--chart-spread-pos'), neg = token('--chart-spread-neg');
    sAvg.setData(none ? [] : h.A);
    sOi.setData(noOi ? [] : h.O);
    sSpread.setData(noOi ? [] : h.O.map(function (p, i) { var d = p.value - h.A[i].value; return { time: p.time, value: d, color: d < 0 ? neg : pos }; }));
    chart.timeScale().fitContent();
  }

  /* ---------- interactions ---------- */
  $('#coins').addEventListener('click', function (e) {
    var b = e.target.closest('.coin'); if (!b) return;
    S.coin = b.dataset.coin; render();
  });
  toggleEl.addEventListener('click', function () { S.showToken = !S.showToken; S.token = tokenEl.value; render(); tokenEl.focus(); });
  tokenEl.addEventListener('input', function () { S.token = tokenEl.value; });
  var timers = [];
  $('#auth').addEventListener('submit', function (e) {
    e.preventDefault();
    timers.forEach(clearTimeout); timers = [];
    S.token = tokenEl.value;
    S.conn = 'connecting'; S.data = 'waiting-data'; render();
    var ok = S.token.trim().length > 0;
    timers.push(setTimeout(function () { S.conn = ok ? 'connected' : 'rejected'; render(); }, 900));
    if (!ok) return;
    timers.push(setTimeout(function () { S.data = 'waiting-oi'; S.ageMs = 1000; render(); }, 1800));
    timers.push(setTimeout(function () { S.data = 'live'; S.ageMs = 2000; render(); }, 2700));
  });

  /* ---------- states.html embedding ---------- */
  var frameId = q.get('frame');
  function postHeight() {
    if (!frameId || window.parent === window) return;
    window.parent.postMessage({ type: 'pfa-height', id: frameId, h: document.documentElement.scrollHeight }, '*');
  }
  if (frameId && window.ResizeObserver) new ResizeObserver(postHeight).observe(document.body);
  if (document.fonts) document.fonts.ready.then(postHeight);

  render();
})();
