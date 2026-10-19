/* Reference renderer for the Ledger design.
   It shows which DOM attributes and text change in each state; the production app does the same from its WebSocket feed.
   Preview a state with ?state=disconnected|connecting|rejected|waiting-oi|live|live-sol|stale */
(function () {
  const SNAPSHOTS = {
    BTC: { ts: 1792337764708, avg: 0.007310528095238056, oiw: 0.006017929257405139, rows: [
      ['BINANCE USDC', 'BTCUSDC_PERP.A', 0.007044, 8, 0.007044, 1662228167.237, 'used'],
      ['BINANCE USDT', 'BTCUSDT_PERP.A', 0.006939, 8, 0.006939, 7594374650.624, 'used'],
      ['BYBIT USDC', 'BTCPERP.6', 0.004934, 8, 0.004934, 110881673.12, 'used'],
      ['BYBIT USDT', 'BTCUSDT.6', 0.001085, 8, 0.001085, 4701779640.716701, 'used'],
      ['DERIBIT', 'BTC_USDC-PERPETUAL.2', null, 8, null, 145996256.61731, 'no_rate'],
      ['HUOBI', 'BTCUSDT_PERP.4', null, 8, null, 1667840642.39, 'no_rate'],
      ['HYPERLIQUID', 'BTC.H', 0.00123245, 1, 0.0098596, 3401545464.93762, 'used'],
      ['KRAKEN', 'pf_xbtusd.K', 0.0017885120833333, 1, 0.0143080966666664, 184314063.0976, 'used'],
      ['OKX', 'BTCUSDT_PERP.3', null, 8, null, 2493917927.06253, 'no_rate'],
      ['WOO X', 'PERP_BTC_USDT.W', 0.007004, 8, 0.007004, 17850768.99408, 'used']] },
    ETH: { ts: 1792337764708, avg: 0.0032488233333333714, oiw: 0.0038321367784422797, rows: [
      ['BINANCE USDC', 'ETHUSDC_PERP.A', 0.007683, 8, 0.007683, 2667864392.76093, 'used'],
      ['BINANCE USDT', 'ETHUSDT_PERP.A', 0.003929, 8, 0.003929, 5423918040.158311, 'used'],
      ['BYBIT USDC', 'ETHPERP.6', 0.001848, 8, 0.001848, 33011987.232, 'used'],
      ['BYBIT USDT', 'ETHUSDT.6', 0.000685, 8, 0.000685, 1866151149.7746, 'used'],
      ['DERIBIT', 'ETH_USDC-PERPETUAL.2', null, 8, null, 64099065.431224, 'no_rate'],
      ['HUOBI', 'ETHUSDT_PERP.4', null, 8, null, 252449003.2212, 'no_rate'],
      ['HYPERLIQUID', 'ETH.H', 0.00023867, 1, 0.00190936, 2489131188.3126, 'used'],
      ['KRAKEN', 'pf_ethusd.K', 0.0003369254166667, 1, 0.0026954033333336, 65656695.3042, 'used'],
      ['OKX', 'ETHUSDT_PERP.3', null, 8, null, 1415886472.1513646, 'no_rate'],
      ['WOO X', 'PERP_ETH_USDT.W', 0.003992, 8, 0.003992, 1576218.6716, 'used']] },
    SOL: { ts: 1792337764708, avg: -0.0095666552380952, oiw: -0.008462360762505911, rows: [
      ['BINANCE USDC', 'SOLUSDC_PERP.A', -0.006684, 8, -0.006684, 127679396.0478, 'used'],
      ['BINANCE USDT', 'SOLUSDT_PERP.A', -0.005841, 8, -0.005841, 910223433.1496, 'used'],
      ['BYBIT USDC', 'SOLPERP.6', -0.005402, 8, -0.005402, 10747712.394, 'used'],
      ['BYBIT USDT', 'SOLUSDT.6', -0.010317, 8, -0.010317, 586043387.396, 'used'],
      ['DERIBIT', 'SOL_USDC-PERPETUAL.2', null, 8, null, 28189913.456894, 'no_rate'],
      ['HUOBI', 'SOLUSDT_PERP.4', null, 8, null, 166931756.3776, 'no_rate'],
      ['HYPERLIQUID', 'SOL.H', -0.00132657, 1, -0.01061256, 550638467.1514, 'used'],
      ['KRAKEN', 'pf_solusd.K', -0.0027945033333333, 1, -0.0223560266666664, 27027005.1505, 'used'],
      ['OKX', 'SOLUSDT_PERP.3', null, 8, null, 308512854.6600002, 'no_rate'],
      ['WOO X', 'PERP_SOL_USDT.W', -0.005754, 8, -0.005754, 151292.66316, 'used']] }
  };

  // Demo states. statusOverrides illustrates "stale" and "not listed" rows; aggregates are recomputed from used rows.
  const STATES = {
    'disconnected': { conn: 'disconnected', token: '', show: false, data: false },
    'connecting':   { conn: 'connecting', token: 'cz_live_8f2a91c4', show: false, data: false },
    'rejected':     { conn: 'rejected', token: 'cz_live_0000bad', show: true, data: false, invalid: true },
    'waiting-oi':   { conn: 'connected', token: 'cz_live_8f2a91c4', show: false, data: true, oi: false, coin: 'BTC', age: '3s ago' },
    'live':         { conn: 'connected', token: 'cz_live_8f2a91c4', show: false, data: true, oi: true, coin: 'BTC', age: '12s ago' },
    'live-sol':     { conn: 'connected', token: 'cz_live_8f2a91c4', show: false, data: true, oi: true, coin: 'SOL', age: '12s ago' },
    'stale':        { conn: 'connected', token: 'cz_live_8f2a91c4', show: false, data: true, oi: true, coin: 'ETH', age: '2m 14s ago', stale: true,
                      statusOverrides: { 'WOO X': 'stale', 'DERIBIT': 'not_listed' } }
  };
  const CONN_LABEL = { disconnected: 'Disconnected', connecting: 'Connecting', connected: 'Connected', rejected: 'Rejected' };
  const STATUS_LABEL = { used: 'used', stale: 'stale', no_rate: 'no predicted rate', not_listed: 'not listed' };

  const params = new URLSearchParams(location.search);
  const S = STATES[params.get('state')] || STATES.live;
  let coin = S.coin || 'BTC';
  const $ = id => document.getElementById(id);

  const signed = (v, d) => (v < 0 ? '-' : '+') + Math.abs(v).toFixed(d);
  const tone = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral');
  const usd = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(2) + 'K' : '$' + v.toFixed(0);

  function computeRows(c) {
    const snap = SNAPSHOTS[c];
    const ov = S.statusOverrides || {};
    const rows = snap.rows.map(([venue, symbol, pred, period, r8, oi, status]) => {
      status = ov[venue] || status;
      if (status === 'not_listed') return { venue, symbol: '—', pred: null, period: null, r8: null, oi: null, status };
      return { venue, symbol, pred, period, r8, oi, status };
    });
    const used = rows.filter(r => r.status === 'used');
    const oiTotal = used.reduce((a, r) => a + r.oi, 0);
    const changed = Object.keys(ov).length > 0;
    const avg = changed ? used.reduce((a, r) => a + r.r8, 0) / used.length : snap.avg;
    const oiw = changed ? used.reduce((a, r) => a + r.r8 * r.oi, 0) / oiTotal : snap.oiw;
    const sd = Math.sqrt(used.reduce((a, r) => a + (r.r8 - avg) ** 2, 0) / used.length);
    return { rows, used: used.length, oiTotal, avg, oiw, sd, ts: snap.ts };
  }

  function setKpi(id, { value, toneVal, meta, waiting }) {
    const el = $(id);
    el.dataset.state = waiting ? 'waiting' : 'ready';
    el.dataset.stale = String(!!S.stale && !waiting);
    const v = el.querySelector('.kpi__value');
    v.textContent = waiting ? '—' : value;
    v.dataset.tone = waiting ? 'neutral' : toneVal;
    el.querySelector('.kpi__meta').textContent = meta;
  }

  function renderHeader() {
    const conn = $('conn');
    conn.dataset.state = S.conn;
    $('conn-label').textContent = CONN_LABEL[S.conn];
    const input = $('token-input');
    input.value = S.token;
    setShow(S.show);
    $('token-form').dataset.invalid = String(!!S.invalid);
    input.setAttribute('aria-invalid', String(!!S.invalid));
    $('token-error').hidden = !S.invalid;
    $('token-connect').disabled = S.conn === 'connecting';
  }
  function setShow(on) {
    $('token-input').type = on ? 'text' : 'password';
    const t = $('token-toggle');
    t.textContent = on ? 'Hide' : 'Show';
    t.setAttribute('aria-pressed', String(on));
    t.setAttribute('aria-label', on ? 'Hide token' : 'Show token');
  }

  function render() {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.coin === coin)));
    $('chart-coin').textContent = coin;
    if (!S.data) {
      const w = { waiting: true, meta: 'waiting for data…' };
      ['kpi-avg', 'kpi-oiw', 'kpi-spread', 'kpi-venues'].forEach(id => setKpi(id, w));
      $('venues').dataset.empty = 'true';
      $('venue-rows').replaceChildren();
      setChart(null);
      return;
    }
    const d = computeRows(coin);
    const age = S.age;
    const oiWait = { waiting: true, meta: 'waiting for open interest…' };
    setKpi('kpi-avg', { value: signed(d.avg, 4) + '%', toneVal: tone(d.avg), meta: age });
    setKpi('kpi-oiw', S.oi ? { value: signed(d.oiw, 4) + '%', toneVal: tone(d.oiw), meta: age } : oiWait);
    const sp = d.oiw - d.avg;
    setKpi('kpi-spread', S.oi ? { value: signed(sp, 4) + ' pp', toneVal: tone(sp), meta: age } : oiWait);
    setKpi('kpi-venues', { value: d.used + ' / 10', toneVal: 'neutral', meta: age });

    const tpl = $('venue-row-tpl');
    const frag = document.createDocumentFragment();
    d.rows.forEach(r => {
      const n = tpl.content.firstElementChild.cloneNode(true);
      const used = r.status === 'used';
      n.dataset.status = r.status;
      n.querySelector('.vrow__venue').textContent = r.venue;
      n.querySelector('.vrow__symbol').textContent = r.symbol;
      n.querySelector('.vrow__pred').textContent = r.pred == null ? '—' : signed(r.pred, 5) + '%';
      n.querySelector('.vrow__period').textContent = r.period == null ? '—' : r.period + 'h';
      const p8 = n.querySelector('.vrow__p8');
      p8.querySelector('.p8-val').textContent = r.r8 == null ? '—' : signed(r.r8, 4) + '%';
      p8.dataset.tone = r.r8 == null ? 'neutral' : tone(r.r8);
      const out = used && Math.abs(r.r8 - d.avg) > d.sd;
      p8.dataset.outlier = String(out);
      if (out) p8.title = 'More than 1σ from AVG';
      n.querySelector('.vrow__oi').textContent = (!S.oi || r.oi == null) ? '—' : usd(r.oi);
      n.querySelector('.vrow__weight').textContent = (S.oi && used) ? (r.oi / d.oiTotal * 100).toFixed(1) + '%' : '—';
      n.querySelector('.status').textContent = STATUS_LABEL[r.status];
      frag.appendChild(n);
    });
    $('venue-rows').replaceChildren(frag);
    $('venues').dataset.empty = 'false';
    setChart(d);
  }

  // ---------- chart (lightweight-charts v5: two LineSeries, grid, crosshair, last-value labels) ----------
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let chart, sAvg, sOiw;
  function initChart() {
    const L = window.LightweightCharts;
    const el = $('chart-canvas');
    chart = L.createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: 'solid', color: css('--color-chart-bg') }, textColor: css('--color-chart-text'), fontFamily: css('--font-num'), fontSize: parseInt(css('--fs-xs'), 10) },
      grid: { vertLines: { color: css('--color-chart-grid') }, horzLines: { color: css('--color-chart-grid') } },
      rightPriceScale: { borderColor: css('--color-chart-grid'), scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: css('--color-chart-grid'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: L.CrosshairMode.Normal, vertLine: { color: css('--color-chart-crosshair') }, horzLine: { color: css('--color-chart-crosshair') } }
    });
    const priceFormat = { type: 'custom', minMove: 0.0001, formatter: v => signed(v, 4) + '%' };
    const line = { lineWidth: 2, lineType: L.LineType.WithSteps, priceFormat, priceLineVisible: true, lastValueVisible: true };
    sAvg = chart.addSeries(L.LineSeries, { ...line, color: css('--color-chart-avg'), title: 'AVG' });
    sOiw = chart.addSeries(L.LineSeries, { ...line, color: css('--color-chart-oiw'), title: 'OI-w' });
    new ResizeObserver(() => chart.resize(el.clientWidth, el.clientHeight)).observe(el);
  }
  // Plausible history ending at the snapshot values (demo only; the app appends one point per snapshot).
  function history(d, key) {
    let seed = key.charCodeAt(0) * 977 + key.charCodeAt(1) * 31;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const n = 120, step = 15, end = Math.floor(d.ts / 1000) - (S.stale ? 134 : 0);
    const amp = Math.max(Math.abs(d.avg) * 0.07, 0.00025), d0 = d.oiw - d.avg;
    let a = d.avg, sp = d0; const A = [], O = [];
    for (let i = 0; i < n; i++) {
      const t = end - i * step;
      A.push({ time: t, value: a }); O.push({ time: t, value: a + sp });
      a += rnd() * amp - (a - d.avg) * 0.06; sp += rnd() * amp * 0.5 - (sp - d0) * 0.1;
    }
    return { A: A.reverse(), O: O.reverse() };
  }
  function setChart(d) {
    $('chart').dataset.empty = String(!d);
    if (!chart) return;
    if (!d) { sAvg.setData([]); sOiw.setData([]); return; }
    const h = history(d, coin);
    sAvg.setData(h.A);
    sOiw.setData(S.oi ? h.O : []);
    chart.timeScale().fitContent();
  }

  // ---------- wiring ----------
  $('token-toggle').addEventListener('click', () => setShow($('token-input').type === 'password'));
  $('token-form').addEventListener('submit', e => e.preventDefault());
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { coin = t.dataset.coin; render(); }));

  renderHeader();
  if (window.LightweightCharts) initChart();
  render();

  // When embedded in the states board, report height so the frame can fit its content.
  if (window.parent !== window) {
    const post = () => window.parent.postMessage({ type: 'pfa-height', frame: params.get('frame'), height: document.documentElement.scrollHeight }, '*');
    new ResizeObserver(post).observe(document.body);
    window.addEventListener('load', post);
  }
})();
