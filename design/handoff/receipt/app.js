/*
 * Predicted Funding Aggregator — reference renderer.
 *
 * Shows which element gets which text and attribute in every state. Production
 * (TypeScript, same markup) copies the DOM writes in the render* functions; the
 * README lists them as the DOM contract. Data comes from data.js fixtures here and
 * from the authenticated WebSocket in production.
 *
 * Query parameters (all optional):
 *   state   disconnected | connecting | rejected | waiting-data | waiting-oi | live | stale
 *   coin    BTC | ETH | SOL                            (default BTC)
 *   token   hidden | visible                           (default hidden)
 *   fixture comma list of: statuses, backfill
 *   pseudo  state board only — comma list of: coin, buttons, rows
 * Without ?state the page runs as a small demo: a remembered token reconnects,
 * Connect stores the token and plays connecting → live, and the clock ticks.
 */
(function () {
  'use strict';

  var POLL_INTERVAL_MS = 60000;
  var STALE_AFTER_MS = 3 * POLL_INTERVAL_MS;   // data is stale after 3 poll intervals
  var HISTORY_WINDOW = '12h';
  var COINS = ['BTC', 'ETH', 'SOL'];
  var TOKEN_STORAGE_KEY = 'pfa.token';
  var DEMO_TOKEN = 'pfa_7Hq2xR9mK4vNcW3e';
  var STATES = ['disconnected', 'connecting', 'rejected', 'waiting-data', 'waiting-oi', 'live', 'stale'];
  var MINUS = '−';

  var TEXT = {
    pending: 'waiting for data…',
    pendingOi: 'waiting for open interest…',
    offline: 'not connected',
    oiCell: 'waiting…',
    weightPending: 'pending'
  };

  var el = function (id) { return document.getElementById(id); };
  var app = el('app');

  /* ================================================================== */
  /* Formatting                                                          */
  /* ================================================================== */

  // Signed, 5 decimals, true minus sign: +0.01032 / −0.00112 / 0.00000
  function fmtRate(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var s = Math.abs(v).toFixed(5);
    if (Number(s) === 0) return '0.00000';
    return (v < 0 ? MINUS : '+') + s;
  }
  // $17.53B / $104.94M / $812.4K
  function fmtUsd(v) {
    if (v === null || v === undefined) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    return '$' + (v / 1e3).toFixed(1) + 'K';
  }
  // 40.8% / <0.1%
  function fmtPct(share) {
    var p = share * 100;
    if (p > 0 && p < 0.1) return '<0.1%';
    return p.toFixed(1) + '%';
  }
  // 4s / 3m 34s / 2h 05m
  function fmtDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtClock(ms, seconds) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (seconds ? ':' + pad2(d.getSeconds()) : '');
  }
  function slug(venue) { return 'venue-' + venue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  /* ================================================================== */
  /* Model                                                               */
  /* ================================================================== */

  var params = new URLSearchParams(location.search);
  var fixedState = STATES.indexOf(params.get('state')) >= 0 ? params.get('state') : null;
  var fixtures = (params.get('fixture') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var pseudo = (params.get('pseudo') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  var model = {
    conn: 'disconnected',          // disconnected | connecting | connected | rejected
    coin: COINS.indexOf(params.get('coin')) >= 0 ? params.get('coin') : 'BTC',
    token: '',
    tokenVisible: params.get('token') === 'visible',
    tokenError: null,              // null | 'empty'
    snapshots: null,               // { BTC, ETH, SOL } — latest snapshot per coin
    history: null,                 // { BTC, ETH, SOL } — 12 h of points per coin
    now: Date.now(),
    open: {}                       // venue name → true when its arithmetic is open
  };

  function load(state) {
    var f = window.PFA_DATA.fixture({ state: state, fixtures: fixtures });
    model.snapshots = f.snapshots;
    model.history = f.history;
    model.now = f.now;
  }

  if (fixedState) {
    model.conn = { disconnected: 'disconnected', connecting: 'connecting', rejected: 'rejected' }[fixedState] || 'connected';
    model.token = fixedState === 'disconnected' ? '' : DEMO_TOKEN;
    load(fixedState);
  }

  /* ================================================================== */
  /* Derived state                                                       */
  /* ================================================================== */

  function snapshotOf(coin) { return model.snapshots ? model.snapshots[coin] : null; }

  // #app[data-data]: waiting-data | waiting-oi | live | stale (stale wins over waiting-oi)
  function dataState(coin) {
    var s = snapshotOf(coin);
    if (model.conn !== 'connected' || !s) return 'waiting-data';
    if (model.now - s.timestamp > STALE_AFTER_MS) return 'stale';
    if (s.oi_weighted_predicted_funding_rate === null || s.open_interest_usd === null) return 'waiting-oi';
    return 'live';
  }

  // Text shown wherever a value has not arrived yet.
  function pendingText() { return model.conn === 'disconnected' || model.conn === 'rejected' ? TEXT.offline : TEXT.pending; }

  var STATUS_ORDER = { used: 0, stale: 1, unlisted: 2, no_rate: 3 };

  // Rows of the venue breakdown, in display order: used by OI weight, then excluded.
  function venueRows(s) {
    var comps = s.components;
    var used = comps.filter(function (c) { return c.status === 'used'; });
    var n = used.length;
    var usedOiKnown = used.every(function (c) { return c.oi_usd !== null; });
    var usedOi = usedOiKnown ? used.reduce(function (t, c) { return t + c.oi_usd; }, 0) : null;
    return comps.map(function (c) {
      var isUsed = c.status === 'used';
      var w = isUsed && usedOi ? c.oi_usd / usedOi : null;
      return { c: c, used: isUsed, weight: w, n: n, usedOi: usedOi };
    }).sort(function (a, b) {
      if (STATUS_ORDER[a.c.status] !== STATUS_ORDER[b.c.status]) return STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status];
      return (b.c.oi_usd || 0) - (a.c.oi_usd || 0);
    });
  }

  function statusLabel(c) {
    if (c.status === 'used') return 'Used';
    if (c.status === 'stale') return 'Excluded · stale ' + fmtDuration(model.now - c.updated_at);
    if (c.status === 'unlisted') return 'Excluded · not listed';
    return 'Excluded · no predicted rate';
  }

  function detailLines(r) {
    var c = r.c;
    if (c.status === 'used') {
      return [
        ['Rate / 8h', c.rate_period_hours === 8
          ? fmtRate(c.rate_8h) + ', already per 8h'
          : fmtRate(c.predicted_rate) + ' per ' + c.rate_period_hours + 'h × ' + (8 / c.rate_period_hours) + ' = ' + fmtRate(c.rate_8h)],
        ['→ AVG', fmtRate(c.rate_8h) + ' ÷ ' + r.n + ' = ' + fmtRate(c.rate_8h / r.n)],
        ['→ OI-weighted', r.weight === null ? TEXT.pendingOi : fmtRate(c.rate_8h) + ' × ' + fmtPct(r.weight) + ' = ' + fmtRate(c.rate_8h * r.weight)],
        ['OI weight', r.weight === null ? 'pending until every used venue reports open interest' : fmtUsd(c.oi_usd) + ' of ' + fmtUsd(r.usedOi) + ' used open interest']
      ];
    }
    if (c.status === 'stale') {
      return [
        ['Why excluded', 'Last update ' + fmtDuration(model.now - c.updated_at) + ' ago, older than 3 poll intervals (' + STALE_AFTER_MS / 1000 + ' s).'],
        ['Last rate', fmtRate(c.rate_8h) + ' per 8h, shown for reference only.'],
        ['Open interest', c.oi_usd === null ? TEXT.pendingOi : fmtUsd(c.oi_usd) + ' still counts toward total open interest.']
      ];
    }
    if (c.status === 'unlisted') {
      return [['Why excluded', 'This market is not listed on ' + c.venue + ', so it has no rate and no open interest.']];
    }
    return [
      ['Why excluded', 'No predicted rate from this venue, so it is outside AVG and OI-weighted.'],
      ['Open interest', c.oi_usd === null ? TEXT.pendingOi : fmtUsd(c.oi_usd) + ' still counts toward total open interest.']
    ];
  }

  /* ================================================================== */
  /* Render: root and token gate                                         */
  /* ================================================================== */

  function renderRoot(ds) {
    app.setAttribute('data-conn', model.conn);
    app.setAttribute('data-data', ds);
    document.querySelectorAll('[data-bind="coin"]').forEach(function (n) { n.textContent = model.coin; });
    var s = snapshotOf(model.coin);
    var nUsed = s ? s.components.filter(function (c) { return c.status === 'used'; }).length : 0;
    document.querySelectorAll('[data-bind="used-count"]').forEach(function (n) { n.textContent = s ? String(nUsed) : 'n'; });
  }

  function renderGate() {
    var input = el('token-input');
    input.type = model.tokenVisible ? 'text' : 'password';
    if (input.value !== model.token) input.value = model.token;
    var invalid = model.conn === 'rejected' || model.tokenError === 'empty';
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');

    var toggle = el('token-toggle');
    toggle.textContent = model.tokenVisible ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', model.tokenVisible ? 'true' : 'false');

    var busy = model.conn === 'connecting';
    el('token-connect').setAttribute('aria-disabled', busy ? 'true' : 'false');
    el('token-connect-label').textContent = busy ? 'Connecting…' : 'Connect';

    var help = el('token-help');
    if (model.tokenError === 'empty') {
      help.textContent = 'Enter a token to connect.';
    } else if (model.conn === 'rejected') {
      help.textContent = 'Token rejected by the service. Check it and connect again.';
    } else if (model.conn === 'disconnected') {
      help.textContent = 'Paste the access token from your service config. It is remembered on this device.';
    } else {
      help.textContent = 'Remembered on this device, so a reload reconnects.';
    }
    help.setAttribute('data-tone', invalid ? 'error' : 'neutral');
  }

  /* ================================================================== */
  /* Render: coin selector, data age, stale notice                       */
  /* ================================================================== */

  function renderCoins() {
    document.querySelectorAll('#coin-group [role="radio"]').forEach(function (b) {
      var coin = b.getAttribute('data-coin');
      var on = coin === model.coin;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
      var s = snapshotOf(coin);
      var rate = b.querySelector('[data-coin-rate]');
      if (model.conn !== 'connected') rate.textContent = '—';
      else if (!s || s.oi_weighted_predicted_funding_rate === null) rate.textContent = 'pending';
      else rate.textContent = fmtRate(s.oi_weighted_predicted_funding_rate);
    });
  }

  function renderAge(ds) {
    var s = snapshotOf(model.coin);
    var value = el('data-age-value'), note = el('data-age-note');
    if (ds === 'waiting-data') {
      value.textContent = '—';
      note.textContent = model.conn === 'connected' || model.conn === 'connecting' ? 'No snapshot yet' : 'Not connected';
    } else {
      value.textContent = fmtDuration(model.now - s.timestamp) + ' ago';
      note.textContent = ds === 'stale'
        ? 'Stale · older than 3 poll intervals (' + STALE_AFTER_MS / 1000 + ' s)'
        : 'Fresh · snapshot at ' + fmtClock(s.timestamp, true);
    }
    var notice = el('stale-notice-text');
    notice.textContent = ds === 'stale'
      ? 'No new snapshot for ' + fmtDuration(model.now - s.timestamp) + ', more than 3 poll intervals. The values below are the last ones received, at ' + fmtClock(s.timestamp, true) + '.'
      : '';
  }

  /* ================================================================== */
  /* Render: headline values                                             */
  /* ================================================================== */

  function setValue(node, text, pending) {
    node.textContent = text;
    node.setAttribute('data-pending', pending ? 'true' : 'false');
  }

  function renderKpis(ds) {
    var s = ds === 'waiting-data' ? null : snapshotOf(model.coin);
    var p = pendingText();
    el('kpis').setAttribute('aria-label', 'Headline values for ' + model.coin);
    if (!s) {
      ['kpi-avg', 'kpi-oi', 'kpi-spread', 'kpi-venues', 'kpi-oi-total'].forEach(function (id) { setValue(el(id), p, true); });
      el('kpi-oi-total-note').textContent = 'USD · 10 listed venues';
      el('kpi-venues-marks').replaceChildren();
      return;
    }
    var avg = s.aggregated_predicted_funding_rate, oiw = s.oi_weighted_predicted_funding_rate;
    var listed = s.components.filter(function (c) { return c.status !== 'unlisted'; }).length;
    setValue(el('kpi-avg'), fmtRate(avg), false);
    setValue(el('kpi-oi'), oiw === null ? TEXT.pendingOi : fmtRate(oiw), oiw === null);
    setValue(el('kpi-spread'), oiw === null ? TEXT.pendingOi : fmtRate(oiw - avg), oiw === null);
    setValue(el('kpi-venues'), s.markets + ' / ' + s.components.length, false);
    setValue(el('kpi-oi-total'), s.open_interest_usd === null ? TEXT.pendingOi : fmtUsd(s.open_interest_usd), s.open_interest_usd === null);
    el('kpi-oi-total-note').textContent = 'USD · ' + listed + ' listed venues';
    // one mark per venue, in breakdown order
    el('kpi-venues-marks').replaceChildren.apply(el('kpi-venues-marks'), venueRows(s).map(function (r) {
      var m = document.createElement('span');
      m.className = 'mark';
      m.setAttribute('data-status', r.c.status);
      return m;
    }));
  }

  /* ================================================================== */
  /* Render: history chart                                               */
  /* ================================================================== */

  var chart = null, series = null, chartKey = null;

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // Chart tokens, read from :root.
  function chartTokens() {
    return {
      avg: cssVar('--chart-avg'), oi: cssVar('--chart-oi'),
      avgBackfill: cssVar('--chart-avg-backfill'), oiBackfill: cssVar('--chart-oi-backfill'),
      pos: cssVar('--chart-spread-pos'), neg: cssVar('--chart-spread-neg'),
      posBackfill: cssVar('--chart-spread-pos-backfill'), negBackfill: cssVar('--chart-spread-neg-backfill'),
      grid: cssVar('--chart-grid'), text: cssVar('--chart-text'), bg: cssVar('--chart-bg'),
      separator: cssVar('--chart-separator'), crosshair: cssVar('--chart-crosshair'), crosshairLabel: cssVar('--chart-crosshair-label'),
      font: cssVar('--font-mono'), fontSize: parseFloat(cssVar('--chart-font-size')),
      lineWidth: parseFloat(cssVar('--chart-line-width')), spreadPane: parseFloat(cssVar('--chart-spread-pane'))
    };
  }

  // Colour, font and pane options from the chart tokens.
  function chartTokenOptions(T) {
    return {
      layout: {
        background: { type: 'solid', color: T.bg }, textColor: T.text, fontFamily: T.font, fontSize: T.fontSize,
        panes: { separatorColor: T.separator, separatorHoverColor: T.separator, enableResize: false }
      },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      crosshair: {
        vertLine: { color: T.crosshair, labelBackgroundColor: T.crosshairLabel },
        horzLine: { color: T.crosshair, labelBackgroundColor: T.crosshairLabel }
      }
    };
  }

  function initChart() {
    var LW = window.LightweightCharts;
    if (chart || !LW) return;
    var T = chartTokens();
    var priceFormat = { type: 'custom', minMove: 0.00001, formatter: fmtRate };
    chart = LW.createChart(el('chart'), Object.assign(chartTokenOptions(T), {
      autoSize: true,
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true,
        // Local time on the axis; where the UTC day changes the library marks the tick as
        // DayOfMonth (2), Month (1) or Year (0), and we print the UTC date there.
        tickMarkFormatter: function (time, tickMarkType) {
          var d = new Date(time * 1000);
          if (tickMarkType <= 2) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
          return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }
      },
      localization: {
        priceFormatter: fmtRate,
        timeFormatter: function (time) {
          var d = new Date(time * 1000);
          return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }
      }
    }));
    var line = { lineWidth: T.lineWidth, priceLineVisible: false, lastValueVisible: true, priceFormat: priceFormat };
    series = {
      avg: chart.addSeries(LW.LineSeries, Object.assign({ color: T.avg }, line), 0),
      oi: chart.addSeries(LW.LineSeries, Object.assign({ color: T.oi }, line), 0),
      spread: chart.addSeries(LW.HistogramSeries, { color: T.pos, base: 0, priceLineVisible: false, lastValueVisible: true, priceFormat: priceFormat }, 1),
      tokens: T
    };
    chart.panes()[1].setHeight(T.spreadPane);
  }

  // Contiguous runs of rebuilt points → [{ from, to }] in ms.
  function backfillRuns(points) {
    var runs = [], cur = null;
    points.forEach(function (p) {
      if (p.source === 'backfill') {
        if (!cur) { cur = { from: p.timestamp, to: p.timestamp }; runs.push(cur); } else cur.to = p.timestamp;
      } else cur = null;
    });
    return runs;
  }

  // History points → series data, coloured with the chart tokens T.
  function seriesData(points, T) {
    var a = [], o = [], sp = [], lastTime = -Infinity;
    points.forEach(function (p, i) {
      var t = Math.floor(p.timestamp / 1000);
      if (t <= lastTime) return;                      // the library needs strictly increasing times
      // A pause longer than 3 poll intervals: whitespace per missing minute leaves a gap.
      if (i > 0 && p.timestamp - points[i - 1].timestamp > STALE_AFTER_MS) {
        for (var g = lastTime + 60; g < t; g += 60) { a.push({ time: g }); o.push({ time: g }); sp.push({ time: g }); }
      }
      lastTime = t;
      var rebuilt = p.source === 'backfill';
      var avg = p.aggregated_predicted_funding_rate, oiw = p.oi_weighted_predicted_funding_rate;
      // The only per-point style is a colour; a line segment takes its left point's colour.
      a.push(avg === null ? { time: t } : { time: t, value: avg, color: rebuilt ? T.avgBackfill : T.avg });
      if (oiw === null || avg === null) { o.push(oiw === null ? { time: t } : { time: t, value: oiw, color: rebuilt ? T.oiBackfill : T.oi }); sp.push({ time: t }); return; }
      o.push({ time: t, value: oiw, color: rebuilt ? T.oiBackfill : T.oi });
      var d = oiw - avg;
      sp.push({ time: t, value: d, color: d >= 0 ? (rebuilt ? T.posBackfill : T.pos) : (rebuilt ? T.negBackfill : T.neg) });
    });
    return { avg: a, oi: o, spread: sp };
  }

  function setSeriesData(points, T) {
    var d = seriesData(points, T);
    series.avg.setData(d.avg);
    series.oi.setData(d.oi);
    series.spread.setData(d.spread);
    chart.panes()[1].setHeight(T.spreadPane);
  }

  function renderChart(ds) {
    var points = ds === 'waiting-data' || !model.history ? [] : model.history[model.coin];
    var runs = backfillRuns(points);
    var s = snapshotOf(model.coin);

    el('history-window').textContent = HISTORY_WINDOW;
    el('legend-backfill').hidden = runs.length === 0;
    var note = el('history-backfill-note');
    note.hidden = runs.length === 0;
    note.textContent = runs.length
      ? 'Muted points ' + runs.map(function (r) { return fmtClock(r.from) + '–' + fmtClock(r.to); }).join(', ') + ' were rebuilt from 1-minute history after a restart.'
      : '';
    try { el('history-tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch (e) { el('history-tz').textContent = 'local'; }
    el('chart-status').textContent = pendingText();
    el('chart').setAttribute('aria-label', points.length
      ? HISTORY_WINDOW + ' history for ' + model.coin + ': AVG and OI-weighted lines, spread bars in the lower pane. Latest AVG ' +
        fmtRate(s.aggregated_predicted_funding_rate) + ', OI-weighted ' + (s.oi_weighted_predicted_funding_rate === null ? TEXT.pendingOi : fmtRate(s.oi_weighted_predicted_funding_rate)) +
        ' % per 8h.' + (runs.length ? ' Includes rebuilt points.' : '')
      : 'History chart, ' + pendingText());

    initChart();
    if (!chart) return;
    var key = model.coin + '|' + ds + '|' + fixtures.join(',');
    if (key === chartKey) return;
    chartKey = key;
    setSeriesData(points, series.tokens);
    if (points.length) chart.timeScale().fitContent();
  }

  /* ================================================================== */
  /* Render: venue breakdown                                             */
  /* ================================================================== */

  function fillRow(r) {
    var c = r.c, id = slug(c.venue);
    var row = el('tpl-venue-row').content.firstElementChild.cloneNode(true);
    var f = function (name) { return row.querySelector('[data-field="' + name + '"]'); };
    var open = !!model.open[c.venue];
    row.id = id;
    row.setAttribute('data-venue', c.venue);
    row.setAttribute('data-status', c.status);
    row.setAttribute('data-open', open ? 'true' : 'false');

    var toggle = row.querySelector('.vtoggle');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-controls', id + '-detail');

    f('venue').textContent = c.venue;
    f('symbol').textContent = c.symbol;
    f('predicted').textContent = fmtRate(c.predicted_rate);
    f('period').textContent = c.rate_period_hours + 'h';
    f('rate-8h').textContent = fmtRate(c.rate_8h);
    f('oi').textContent = c.oi_usd !== null ? fmtUsd(c.oi_usd) : (c.status === 'unlisted' ? '—' : TEXT.oiCell);
    if (r.used) {
      f('weight').textContent = r.weight === null ? TEXT.weightPending : fmtPct(r.weight);
      f('weight-bar').style.setProperty('--weight', r.weight === null ? '0%' : (r.weight * 100).toFixed(2) + '%');
      f('to-avg').textContent = fmtRate(c.rate_8h / r.n);
      f('to-oi').textContent = r.weight === null ? TEXT.weightPending : fmtRate(c.rate_8h * r.weight);
    } else {
      f('weight').textContent = '—';
      f('weight-bar').parentNode.hidden = true;
      f('to-avg').textContent = '—';
      f('to-oi').textContent = '—';
    }
    f('status').textContent = statusLabel(c);

    var detail = row.querySelector('.vdetail');
    detail.id = id + '-detail';
    detail.hidden = !open;
    detail.replaceChildren.apply(detail, detailLines(r).map(function (kv) {
      var line = el('tpl-venue-line').content.firstElementChild.cloneNode(true);
      line.querySelector('.vline-k').textContent = kv[0];
      line.querySelector('.vline-v').textContent = kv[1];
      return line;
    }));
    return row;
  }

  function renderVenues(ds) {
    var s = ds === 'waiting-data' ? null : snapshotOf(model.coin);
    var offline = model.conn === 'disconnected' || model.conn === 'rejected';
    el('venue-placeholder-title').textContent = pendingText();
    el('venue-placeholder-text').textContent = offline
      ? 'Connect with your access token to see how the ten venues produce AVG and OI-weighted.'
      : 'The breakdown appears with the first snapshot.';

    // keep keyboard focus on the same venue across a re-render
    var focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.vrow-venue') : null;
    var focusedVenue = focused ? focused.getAttribute('data-venue') : null;

    if (!s) {
      el('venue-rows-used').replaceChildren();
      el('venue-rows-excluded').replaceChildren();
      return;
    }
    var rows = venueRows(s);
    var used = rows.filter(function (r) { return r.used; });
    var excluded = rows.filter(function (r) { return !r.used; });
    var usedOi = used.length ? used[0].usedOi : null;
    var listed = s.components.filter(function (c) { return c.status !== 'unlisted'; }).length;

    el('venue-rows-used').replaceChildren.apply(el('venue-rows-used'), used.map(fillRow));
    el('venue-rows-excluded').replaceChildren.apply(el('venue-rows-excluded'), excluded.map(fillRow));

    el('sum-used-oi').textContent = usedOi === null ? TEXT.weightPending : fmtUsd(usedOi);
    el('sum-weights').textContent = usedOi === null ? TEXT.weightPending : '100%';
    el('sum-avg').textContent = fmtRate(s.aggregated_predicted_funding_rate);
    el('sum-oi').textContent = s.oi_weighted_predicted_funding_rate === null ? TEXT.weightPending : fmtRate(s.oi_weighted_predicted_funding_rate);
    el('venue-excluded-count').textContent = String(excluded.length);
    el('venue-listed-count').textContent = String(listed);
    el('venue-total-oi').textContent = s.open_interest_usd === null ? TEXT.pendingOi : fmtUsd(s.open_interest_usd);

    if (focusedVenue) {
      var again = el(slug(focusedVenue));
      if (again) again.querySelector('.vtoggle').focus();
    }
  }

  /* ================================================================== */
  /* Live region                                                         */
  /* ================================================================== */

  var lastAnnouncement = null;
  function renderAnnounce(ds) {
    var s = snapshotOf(model.coin), msg;
    if (model.tokenError === 'empty') msg = 'Enter a token to connect.';
    else if (model.conn === 'disconnected') msg = 'Disconnected.';
    else if (model.conn === 'connecting') msg = 'Connecting.';
    else if (model.conn === 'rejected') msg = 'Token rejected.';
    else if (ds === 'waiting-data') msg = model.coin + ': connected, waiting for data.';
    else if (ds === 'waiting-oi') msg = model.coin + ': AVG received, waiting for open interest.';
    else if (ds === 'stale') msg = model.coin + ': data is stale, last update ' + fmtDuration(model.now - s.timestamp) + ' ago.';
    else msg = model.coin + ': live.';
    // announce data-state changes only, not every tick
    var key = model.coin + '|' + model.conn + '|' + ds + '|' + model.tokenError;
    if (key !== lastAnnouncement) {
      lastAnnouncement = key;
      el('data-announce').textContent = msg;
    }
  }

  /* ================================================================== */
  /* Render all                                                          */
  /* ================================================================== */

  function render() {
    var ds = dataState(model.coin);
    renderRoot(ds);
    renderGate();
    renderCoins();
    renderAge(ds);
    renderKpis(ds);
    renderChart(ds);
    renderVenues(ds);
    renderAnnounce(ds);
    applyPseudo();
  }

  /* ================================================================== */
  /* Events                                                              */
  /* ================================================================== */

  el('token-input').addEventListener('input', function (e) {
    model.token = e.target.value;
    if (model.tokenError) { model.tokenError = null; render(); }
  });

  el('token-toggle').addEventListener('click', function () {
    model.tokenVisible = !model.tokenVisible;
    renderGate();
  });

  el('token-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (model.conn === 'connecting') return;
    var token = el('token-input').value.trim();
    if (!token) { model.tokenError = 'empty'; render(); el('token-input').focus(); return; }
    model.token = token;
    model.tokenError = null;
    if (!fixedState) { try { localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch (err) { /* storage unavailable */ } }
    connect();
  });

  // Production: open the authenticated WebSocket here. On an auth failure set conn = 'rejected'
  // (keep the token in the field so it can be fixed); on open set conn = 'connected'; each
  // snapshot message replaces model.snapshots[coin] and appends to model.history[coin].
  function connect() {
    model.conn = 'connecting';
    model.snapshots = null;
    model.history = null;
    render();
    setTimeout(function () {
      if (/bad/i.test(model.token)) { model.conn = 'rejected'; }
      else { model.conn = 'connected'; load('live'); }
      render();
    }, 900);
  }

  function selectCoin(coin, focus) {
    if (coin === model.coin) return;
    model.coin = coin;
    model.open = {};
    render();
    if (focus) document.querySelector('#coin-group [data-coin="' + coin + '"]').focus();
  }

  el('coin-group').addEventListener('click', function (e) {
    var b = e.target.closest('[role="radio"]');
    if (b) selectCoin(b.getAttribute('data-coin'), false);
  });

  el('coin-group').addEventListener('keydown', function (e) {
    var i = COINS.indexOf(model.coin), j;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % COINS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + COINS.length - 1) % COINS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = COINS.length - 1;
    else return;
    e.preventDefault();
    selectCoin(COINS[j], true);
  });

  // Open or close one venue's arithmetic without re-rendering the table.
  el('venue-table').addEventListener('click', function (e) {
    var toggle = e.target.closest('.vtoggle');
    if (!toggle) return;
    var row = toggle.closest('.vrow-venue');
    var venue = row.getAttribute('data-venue');
    var open = !model.open[venue];
    if (open) model.open[venue] = true; else delete model.open[venue];
    row.setAttribute('data-open', open ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    el(toggle.getAttribute('aria-controls')).hidden = !open;
  });

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */

  if (!fixedState) {
    var stored = null;
    try { stored = localStorage.getItem(TOKEN_STORAGE_KEY); } catch (err) { /* storage unavailable */ }
    if (stored) { model.token = stored; connect(); }
    // Demo clock: production recomputes data age from Date.now() every second.
    setInterval(function () {
      if (model.conn !== 'connected' || !model.snapshots) return;
      var before = dataState(model.coin);
      model.now += 1000;
      var after = dataState(model.coin);
      if (after !== before) render(); else { renderAge(after); renderAnnounce(after); }
    }, 1000);
  }
  if (pseudo.indexOf('rows') >= 0 && model.snapshots) {
    // open the third used venue and the first excluded venue
    var rows = venueRows(model.snapshots[model.coin]);
    var used = rows.filter(function (r) { return r.used; });
    var excluded = rows.filter(function (r) { return !r.used; });
    if (used[2]) model.open[used[2].c.venue] = true;
    if (excluded[0]) model.open[excluded[0].c.venue] = true;
  }
  render();

  /* ================================================================== */
  /* State board only (states.html). Production can drop this section.  */
  /* ================================================================== */

  // ?pseudo=coin,buttons,rows forces hover and focus looks with classes
  // (.is-hover, .is-focus, .is-focus-row) so states.html can show them side by side.
  function applyPseudo() {
    if (!pseudo.length) return;
    document.querySelectorAll('.is-hover, .is-focus, .is-focus-row').forEach(function (n) { n.classList.remove('is-hover', 'is-focus', 'is-focus-row'); });
    if (pseudo.indexOf('coin') >= 0) {
      var others = COINS.filter(function (c) { return c !== model.coin; });
      document.querySelector('#coin-group [data-coin="' + model.coin + '"]').classList.add('is-focus');
      document.querySelector('#coin-group [data-coin="' + others[0] + '"]').classList.add('is-hover');
    }
    if (pseudo.indexOf('buttons') >= 0) {
      el('token-toggle').classList.add('is-focus');
      el('token-connect').classList.add('is-hover');
    }
    if (pseudo.indexOf('rows') >= 0) {
      var vr = document.querySelectorAll('#venue-rows-used .vrow-venue');
      if (vr[0]) { vr[0].classList.add('is-hover'); vr[0].querySelector('.vtoggle').classList.add('is-hover'); }
      if (vr[1]) { vr[1].classList.add('is-focus-row'); vr[1].querySelector('.vtoggle').classList.add('is-focus'); }
    }
  }

  // Report the page height to states.html so each iframe fits its content.
  if (window.parent !== window) {
    var post = function () { window.parent.postMessage({ type: 'pfa:height', height: document.documentElement.scrollHeight }, '*'); };
    if (window.ResizeObserver) new ResizeObserver(post).observe(document.body);
    window.addEventListener('load', post);
    post();
  }
})();
