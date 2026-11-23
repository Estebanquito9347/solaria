/* SolarIA – Laboratorio de IA (ia.js)
   Se carga DESPUÉS de app.js y usa sus funciones (rows, kwp, wxFor, geoFor, money, toast…).
   Todo corre en el navegador, sin claves ni costos. Módulos:
   1) Modelo físico aprendido (irradiancia + temperatura) con validación honesta (backtest)
   2) Pronóstico a 7 días con intervalo de confianza
   3) Detección de anomalías con Isolation Forest + regresión robusta (consenso)
   4) Diagnóstico probable de la causa de cada falla
   5) Suciedad (soiling) y plan de limpieza óptimo (costo vs. pérdida)
   6) Degradación y proyección financiera a 25 años (VAN, TIR, LCOE)
   7) Simulador de viabilidad con clima histórico real + qué pasa si agrego paneles
   8) Días tipo (k-means) · 9) Informe inteligente · 10) Centro de IA y asistente con NLU (TF-IDF) */
(() => {
'use strict';

/* ===== estilos propios (usan las variables del tema con valores de respaldo) ===== */
const st = document.createElement('style');
st.textContent = `
.ia-sub{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.ia-sub button.on{background:var(--ac,#e8890c);border-color:var(--ac,#e8890c);color:#111;font-weight:600}
.ia-it{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--bd,#e3e6ec)}
.ia-it:last-child{border-bottom:0}.ia-ic{font-size:20px;line-height:1.2}
.ia-sev{font-size:11px;padding:1px 8px;border-radius:99px;color:#fff;white-space:nowrap}
.ia-sev.alta{background:var(--bad,#d64545)}.ia-sev.media{background:var(--warn,#d9a000);color:#111}.ia-sev.info{background:var(--c2,#2f7de1)}.ia-sev.ok{background:var(--ok,#1f9d55)}
.ia-bar{height:8px;border-radius:99px;background:var(--bd,#e3e6ec);overflow:hidden}.ia-bar>i{display:block;height:100%;background:var(--ac,#e8890c)}
.ia-note{font-size:12px;color:var(--mu,#667085)}.ia-pre{white-space:pre-wrap;font-family:inherit;line-height:1.55;margin:0}
.ia-svg svg{width:100%;height:auto;display:block}.ia-svg text{fill:var(--mu,#667085);font-size:11px}
.ia-chip{display:inline-block;padding:2px 9px;border-radius:99px;border:1px solid var(--bd,#e3e6ec);font-size:12px;margin:2px 4px 2px 0}
`;
document.head.appendChild(st);

/* ===== utilidades ===== */
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mad = a => { const m = med(a); return 1.4826 * med(a.map(x => Math.abs(x - m))); };
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
const addDays = (d, n) => iso(new Date(new Date(d + 'T12:00:00Z').getTime() + n * 864e5));
const pc = x => f1(x * 100) + '%';
const asw = t => ({t, src:'local'});
const f2 = x => (+x).toFixed(2);
function olsFit(xs, ys){
  const mx = avg(xs), my = avg(ys); let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx ? sxy / sxx : 0; return {a:my - b * mx, b};
}
function robustLine(xs, ys){                       // recta ajustada descartando atípicos (mínimos cuadrados recortados)
  let fit = olsFit(xs, ys);
  for (let t = 0; t < 3; t++) {
    const res = ys.map((y, i) => y - (fit.a + fit.b * xs[i])), m = med(res), s = Math.max(mad(res), 1e-6);
    const ix = res.map((r, i) => Math.abs(r - m) < 2.5 * s ? i : -1).filter(i => i >= 0);
    if (ix.length < 5) break;
    fit = olsFit(ix.map(i => xs[i]), ix.map(i => ys[i]));
  }
  return fit;
}
const P_ = () => { const v = ls.get('solaria_ia_' + cur); return v || {}; };
const param = (k, def) => { const v = P_()[k]; return v != null && v >= 0 ? v : def; };

/* ===== 1) clima histórico (Open-Meteo, sin clave) y dataset ===== */
const WXC = {};
async function hist(ins){
  const g = await geoFor(ins), key = g.lat + ',' + g.lon, c = WXC[key];
  if (c && Date.now() - c.t < 36e5) return c.map;
  const vars = 'shortwave_radiation_sum,temperature_2m_mean,temperature_2m_max,precipitation_sum', base = `latitude=${g.lat}&longitude=${g.lon}&daily=${vars}&timezone=auto`;
  const map = {}, eat = j => { const d = j.daily || {}; (d.time || []).forEach((t, i) => { const irr = d.shortwave_radiation_sum[i]; if (irr != null) map[t] = {irr:+(irr / 3.6).toFixed(2), t:d.temperature_2m_mean[i], tmax:d.temperature_2m_max[i], rain:d.precipitation_sum[i] || 0}; }); };
  const from = iso(new Date(Date.now() - 400 * 864e5)), to = iso(new Date(Date.now() - 90 * 864e5));
  const [a, b] = await Promise.all([fetch(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${from}&end_date=${to}`), fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=92&forecast_days=1`)]);
  if (!b.ok) throw new Error('Open-Meteo no respondió');
  if (a.ok) eat(await a.json());
  eat(await b.json());
  WXC[key] = {t:Date.now(), map}; return map;
}
function dataset(ins, wx){                         // si el día no tiene irradiancia medida, se usa la del clima histórico
  return rows(ins.id).map(g => {
    const w = wx[g.date] || {}, own = g.irr > .5;
    return {date:g.date, kwh:g.kwh, pk:g.pk, irr:own ? g.irr : (w.irr || 0), irrEst:!own && !!w.irr, t:w.t ?? null, tmax:w.tmax ?? null, rain:w.rain ?? null};
  });
}

/* ===== 2) modelo físico: kWh = b1·irr + b2·irr·(T−25) ===== */
const pred = (m, d) => Math.max(m.b1 * d.irr + m.b2 * d.irr * ((d.t ?? 25) - 25), .05);
function fitPhys(D, k){
  const P = D.filter(d => d.irr > .5), def = {b1:k * .8, b2:k * .8 * -.004, gamma:-.004, sigma:.12, n:P.length, learned:false};
  if (P.length < 10) return def;
  const x2 = d => d.irr * ((d.t ?? 25) - 25), hasT = P.some(d => d.t != null);
  let use = P, b1 = def.b1, b2 = 0;
  for (let it = 0; it < 4; it++) {
    let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
    use.forEach(d => { const a = d.irr, b = x2(d); s11 += a * a; s12 += a * b; s22 += b * b; t1 += a * d.kwh; t2 += b * d.kwh; });
    const det = s11 * s22 - s12 * s12;
    if (!hasT || Math.abs(det) < 1e-9) { b1 = t1 / s11; b2 = b1 * -.004; }
    else { b1 = (t1 * s22 - t2 * s12) / det; b2 = (s11 * t2 - s12 * t1) / det; }
    const r = P.map(d => d.kwh / Math.max(b1 * d.irr + b2 * x2(d), .05) - 1), m = med(r), s = Math.max(mad(r), .02);
    const nu = P.filter((d, i) => Math.abs(r[i] - m) < 2.5 * s); if (nu.length < 8) break; use = nu;
  }
  if (!(b1 > 0)) return def;
  const gamma = clamp(b2 / b1, -.012, .002); b2 = gamma * b1;                    // límites físicos del coeficiente de temperatura
  const rr = P.map(d => d.kwh / pred({b1, b2}, d) - 1);
  return {b1, b2, gamma, sigma:Math.max(mad(rr), .03), n:P.length, learned:true};
}
function backtest(D, k){                           // validación honesta: se entrena con el 70% inicial y se evalúa en el 30% final
  const P = D.filter(d => d.irr > .5); if (P.length < 24) return null;
  const cut = Math.floor(P.length * .7), te = P.slice(cut), m = fitPhys(P.slice(0, cut), k); if (!m.learned) return null;
  const a = te.map(d => d.kwh), p = te.map(d => pred(m, d)), mean = avg(a);
  const sse = a.reduce((s, x, i) => s + (x - p[i]) ** 2, 0), sst = a.reduce((s, x) => s + (x - mean) ** 2, 0) || 1;
  return {n:te.length, wape:a.reduce((s, x, i) => s + Math.abs(x - p[i]), 0) / (a.reduce((s, x) => s + x, 0) || 1), r2:1 - sse / sst, mae:avg(a.map((x, i) => Math.abs(x - p[i])))};
}

/* ===== 3) Isolation Forest (implementación propia) ===== */
const rng = seed => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
const cFn = n => n <= 1 ? 0 : 2 * (Math.log(n - 1) + .5772156649) - 2 * (n - 1) / n;
function iTree(X, idx, depth, limit, R){
  if (depth >= limit || idx.length <= 1) return {size:idx.length};
  const f = Math.floor(R() * X[0].length); let lo = Infinity, hi = -Infinity;
  idx.forEach(i => { const v = X[i][f]; if (v < lo) lo = v; if (v > hi) hi = v; });
  if (lo === hi) return {size:idx.length};
  const sp = lo + R() * (hi - lo), L = [], Rt = []; idx.forEach(i => (X[i][f] < sp ? L : Rt).push(i));
  return {f, sp, l:iTree(X, L, depth + 1, limit, R), r:iTree(X, Rt, depth + 1, limit, R)};
}
const pathLen = (t, x, d = 0) => t.size !== undefined ? d + cFn(t.size) : pathLen(x[t.f] < t.sp ? t.l : t.r, x, d + 1);
function isoForest(X, trees = 120, psi = 64, seed = 7){
  const n = X.length, ps = Math.min(psi, n), limit = Math.ceil(Math.log2(Math.max(ps, 2))), R = rng(seed), T = [];
  for (let t = 0; t < trees; t++) {
    const pool = [...Array(n).keys()];
    for (let j = 0; j < ps; j++) { const r = j + Math.floor(R() * (n - j)); [pool[j], pool[r]] = [pool[r], pool[j]]; }
    T.push(iTree(X, pool.slice(0, ps), 0, limit, R));
  }
  const c = cFn(ps) || 1;
  return X.map(x => Math.pow(2, -(T.reduce((s, t) => s + pathLen(t, x), 0) / T.length) / c));   // cercano a 1 = muy anómalo
}
const FEAT = ['relación real/esperado', 'rendimiento específico (kWh/kWp)', 'irradiancia', 'potencia pico por kWp'];
function anomalies(o){
  const {D, model, k} = o, P = D.map((d, i) => ({d, i})).filter(x => x.d.irr > .5);
  if (P.length < 12) return {ok:false, n:P.length, items:[]};
  const pm = med(P.filter(x => x.d.pk > 0).map(x => x.d.pk / k)) || 0;
  const X = P.map(({d}) => [d.kwh / pred(model, d), d.kwh / k, d.irr, d.pk > 0 ? d.pk / k : pm]);
  const sc = isoForest(X), srt = [...sc].sort((a, b) => a - b), thr = Math.max(.6, srt[Math.floor(srt.length * .95)]);
  const mu = [0, 1, 2, 3].map(f => med(X.map(x => x[f]))), sd = [0, 1, 2, 3].map(f => Math.max(mad(X.map(x => x[f])), 1e-6));
  const items = [];
  P.forEach(({d, i}, j) => {
    const ratio = X[j][0], reg = ratio < 1 - 3 * Math.max(model.sigma, .04), ifo = sc[j] >= thr;
    if (!reg && !ifo) return;
    const z = X[j].map((v, f) => (v - mu[f]) / sd[f]), fz = z.reduce((b, v, f) => Math.abs(v) > Math.abs(z[b]) ? f : b, 0);
    items.push({i, date:d.date, score:sc[j], ratio, reg, ifo, both:reg && ifo, top:FEAT[fz], dir:z[fz] < 0 ? 'bajo' : 'alto',
      sev:(reg && ratio < .6) || (reg && ifo) ? 'alta' : reg ? 'media' : 'info'});
  });
  items.sort((a, b) => a.date < b.date ? 1 : -1);
  return {ok:true, n:P.length, items, thr, pts:P.map(({d}, j) => ({x:d.irr, y:d.kwh, flag:items.some(it => it.date === d.date)}))};
}

/* ===== 4) diagnóstico probable de la causa ===== */
const CAUSES = {
  corte:['🔌', 'Corte de red o falla total del inversor', 'Revisar el display y los códigos de error del inversor, y las protecciones (termomagnética y diferencial).'],
  intermitente:['🔁', 'Cortes intermitentes o reinicios del inversor', 'Revisar temperatura y ventilación del inversor, tensión de red e historial de eventos del equipo.'],
  suciedad:['🧼', 'Suciedad acumulada (soiling)', 'Limpiar los paneles con agua y cepillo suave, en horas de poca radiación.'],
  sombra:['🌳', 'Sombra nueva o string desconectado', 'Inspeccionar sombras (vegetación, antenas, construcciones) y verificar conectores y strings.'],
  uniforme:['📉', 'Pérdida pareja (degradación, suciedad o desbalance)', 'Comparar con mediciones anteriores y programar una inspección con termografía.'],
  calor:['🌡️', 'Pérdida por temperatura', 'Es un efecto normal; verificar la ventilación posterior de los paneles.'],
  irr_dato:['📡', 'Dato de irradiancia estimado', 'Cargá la irradiancia medida o revisá la ubicación del proyecto.'],
  dato:['❓', 'Dato sospechoso', 'Revisá si el kWh cargado corresponde a ese día.'],
  desconocida:['🔍', 'Causa no determinada', 'Revisar manualmente inversor, strings y sombras.']
};
function diagnose(o, i){
  const {D, model, k} = o, d = D[i], p = pred(model, d), r = d.kwh / p;
  const rat = x => x.kwh / pred(model, x);
  const prev = D.slice(Math.max(0, i - 7), i).filter(x => x.irr > .5).map(rat), pm = prev.length ? med(prev) : 1;
  const nxt = D.slice(i + 1, i + 4).filter(x => x.irr > .5).map(rat), nm = nxt.length ? med(nxt) : null;
  const w = D.slice(Math.max(0, i - 14), i).filter(x => x.irr > .5), tr = w.length >= 6 ? robustLine(w.map((_, j) => j), w.map(rat)).b : 0;
  const eh = med(D.filter(x => x.pk > 0 && x.kwh > 0 && x.irr > .5).map(x => x.kwh / x.pk)), ehd = d.pk > 0 && d.kwh > 0 && eh ? (d.kwh / d.pk) / eh : null;
  const S = {}, W = {}, add = (c, s, why) => { S[c] = (S[c] || 0) + s; (W[c] = W[c] || []).push(why); };
  if (d.irr >= 3 && d.kwh < .05 * p) add('corte', 8, 'generación prácticamente nula con sol');
  if (r < .75 && ehd != null && ehd < .7) add('intermitente', 5, 'la potencia pico fue normal pero la energía del día quedó corta: el sistema se detuvo parte del día');
  if (r < .97 && tr < -.004) add('suciedad', 4, `el rendimiento venía bajando ${f1(-tr * 100)} puntos por día en las 2 semanas previas`);
  if (o.dsr && o.dsr[d.date] >= 12 && r < .95) add('suciedad', 2, `pasaron ${o.dsr[d.date]} días sin una lluvia que limpie los paneles`);
  if (r < .9 && pm > .92) {
    if (nm != null && nm < .9) add('sombra', 4, 'cayó de golpe y sigue bajo los días siguientes: algo nuevo tapa o desconecta parte del arreglo');
    else if (nm != null) add('intermitente', 3.5, 'recuperó los días siguientes: fue un evento puntual (reinicio o corte), no un problema permanente');
    else add('sombra', 1.5, 'cayó de golpe respecto de la semana previa y todavía no hay días posteriores para confirmar');
  }
  if (r < .9 && ehd != null && ehd > .9 && Math.abs(tr) < .003) add('uniforme', 2.5, 'la pérdida es pareja a lo largo del día');
  if (d.t != null && d.t >= 32 && r >= .8 && r < .97) add('calor', 3.5, `día caluroso (${f1(d.t)} °C): los paneles rinden menos con el calor`);
  if (d.irrEst && r < .9) add('irr_dato', 2.5, 'la irradiancia de ese día es estimada del clima, no medida: el desvío puede venir del dato');
  if (r > 1.2) add('dato', 6, 'produjo más de lo físicamente esperado');
  if (!Object.keys(S).length) add('desconocida', 1, 'el patrón no coincide con ninguna causa conocida');
  const tot = Object.values(S).reduce((a, b) => a + b, 0);
  return Object.entries(S).map(([c, s]) => ({c, pct:Math.round(s / tot * 100), why:W[c]})).sort((a, b) => b.pct - a.pct).slice(0, 2);
}

/* ===== 5) suciedad y limpieza óptima ===== */
function dsrMap(o){                                // días desde la última lluvia ≥2 mm o limpieza registrada
  const dates = Object.keys(o.wx).sort(), resets = new Set(db.ev.filter(e => e.inst == cur && e.type === 'Mantenimiento' && /limpi/i.test(e.desc || '')).map(e => e.date));
  let last = null; const m = {};
  for (const d of dates) { if ((o.wx[d].rain || 0) >= 2 || resets.has(d)) last = d; m[d] = last ? dayDiff(last, d) : null; }
  return m;
}
function soilingModel(o){
  const {D, model, ins} = o; o.dsr = dsrMap(o);
  const P = D.filter(d => d.irr > 2 && o.dsr[d.date] != null).map(d => ({x:Math.min(o.dsr[d.date], 45), y:d.kwh / pred(model, d)}));
  if (P.length < 25 || new Set(P.map(p => p.x)).size < 5) return {ok:false, why:`Necesito al menos 25 días con datos y variedad de lluvias para medir la suciedad (tengo ${P.length} utilizables). Hace falta el clima histórico de la ubicación.`};
  const fit = robustLine(P.map(p => p.x), P.map(p => p.y)), r0 = Math.max(fit.a, .5), s = clamp(-fit.b / r0, 0, .01);
  const E = avg(D.filter(d => d.irr > .5).slice(-30).map(d => pred(model, d))), tar = ins.tariff > 0 ? ins.tariff : 100, C = param('clean', 15000);
  const T = s > 1e-4 && E > 0 ? Math.sqrt(2 * C / (E * s * tar)) : null;
  const dates = Object.keys(o.wx).sort(), dsrNow = o.dsr[dates[dates.length - 1]];
  return {ok:true, s, r0, E, tar, C, T, dsrNow, lossNow:dsrNow != null ? s * dsrNow : null, defTariff:!(ins.tariff > 0), pts:P, fit};
}

/* ===== 6) degradación, anual y finanzas ===== */
function degradation(o){
  const P = o.D.filter(d => d.irr > 2);
  if (P.length < 60) return {ok:false, why:`Hacen falta más datos (tengo ${P.length} días con sol).`};
  const span = dayDiff(P[0].date, P[P.length - 1].date);
  if (span < 180) return {ok:false, why:`Con ${span} días de historial todavía no se puede medir la degradación anual (hacen falta al menos 180).`};
  const f = robustLine(P.map(d => dayDiff(P[0].date, d.date) / 365), P.map(d => d.kwh / pred(o.model, d)));
  return {ok:true, rate:clamp(-f.b / Math.max(f.a, .5), -.02, .05), span};
}
function annual(o){                                // retrocálculo: qué habría generado en los últimos 365 días con el clima real
  const days = Object.keys(o.wx).sort().slice(-365); if (days.length < 300) return null;
  const months = Array(12).fill(0); let tot = 0;
  days.forEach(d => { const p = pred(o.model, {irr:o.wx[d].irr, t:o.wx[d].t}); tot += p; months[+d.slice(5, 7) - 1] += p; });
  const sc = 365 / days.length; return {kwh:tot * sc, months:months.map(m => m * sc / 1)};
}
function finance(Y1, cost, tariff, p){
  const rows_ = [], flows = [-cost]; let cum = -cost, pay = null;
  for (let t = 1; t <= 25; t++) {
    const prod = Y1 * Math.pow(1 - p.deg, t - 1), net = prod * tariff * Math.pow(1 + p.g, t - 1) - p.om * cost, prev = cum;
    cum += net; flows.push(net); if (pay == null && cum >= 0 && net > 0) pay = t - 1 + (-prev) / net;
    rows_.push({t, prod, net, cum});
  }
  const npv = (r) => flows.reduce((s, f, t) => s + f / Math.pow(1 + r, t), 0);
  let lo = -.9, hi = 5; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; npv(mid) > 0 ? lo = mid : hi = mid; }
  const disc = rows_.reduce((s, r) => s + r.prod / Math.pow(1 + p.disc, r.t), 0) || 1;
  return {rows:rows_, pay, van:npv(p.disc), tir:(lo + hi) / 2, lcoe:(cost + rows_.reduce((s, r) => s + p.om * cost / Math.pow(1 + p.disc, r.t), 0)) / disc, total:cum};
}
const finP = () => ({deg:param('deg', .5) / 100, g:param('g', 5) / 100, disc:param('disc', 10) / 100, om:param('om', 1) / 100});

/* ===== 8) días tipo (k-means) ===== */
function kmeans(o){
  const P = o.D.filter(d => d.irr > .3); if (P.length < 15) return {ok:false};
  const mx = Math.max(...P.map(d => d.irr)), my = Math.max(...P.map(d => d.kwh / o.k)) || 1, X = P.map(d => [d.irr / mx, d.kwh / o.k / my]);
  const s = [...X].sort((a, b) => a[0] - b[0]); let C = [.17, .5, .83].map(q => [...s[Math.floor(s.length * q)]]), asg = [];
  for (let it = 0; it < 20; it++) {
    asg = X.map(x => C.reduce((b, c, j) => ((x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2) < ((x[0] - C[b][0]) ** 2 + (x[1] - C[b][1]) ** 2) ? j : b, 0));
    C = C.map((c, j) => { const m = X.filter((_, i) => asg[i] === j); return m.length ? [avg(m.map(x => x[0])), avg(m.map(x => x[1]))] : c; });
  }
  const names = ['Nublado', 'Parcial', 'Soleado'];
  const groups = C.map((c, j) => { const m = P.filter((_, i) => asg[i] === j); return {irr:avg(m.map(d => d.irr)), kwh:avg(m.map(d => d.kwh)), n:m.length}; }).sort((a, b) => a.irr - b.irr).map((g, i) => ({...g, name:names[i]}));
  return {ok:true, groups, classify:irr => groups.reduce((b, g) => Math.abs(g.irr - irr) < Math.abs(b.irr - irr) ? g : b, groups[0])};
}

/* ===== pronóstico a 7 días con banda de confianza ===== */
async function forecast7(ins, model){
  const w = await wxFor(ins), d = w.d;
  return d.time.map((t, i) => {
    const irr = d.shortwave_radiation_sum[i] / 3.6, tm = (d.temperature_2m_max[i] + d.temperature_2m_min[i]) / 2, p = pred(model, {irr, t:tm}), z = 1.28 * Math.hypot(model.sigma, .03 * i);
    return {date:t, irr, t:tm, rain:d.precipitation_sum[i] || 0, kwh:p, lo:Math.max(0, p * (1 - z)), hi:p * (1 + z)};
  });
}

/* ===== paquete de resultados (se calcula una vez y se reutiliza) ===== */
const CACHE = {};
async function pack(force){
  const ins = I(cur); if (!ins) return null;
  const k = kwp(ins), R = rows(cur), last = R[R.length - 1];
  const key = [cur, R.length, last ? last.date + last.kwh : '', k, ins.tariff, ins.cost, db.ev.length, JSON.stringify(P_())].join('|');
  if (!force && CACHE[key] && Date.now() - CACHE[key].t < 6e5) return CACHE[key].v;
  const o = {ins, k, R, warn:[], noPanels:!(k > 0)};
  let wx = {}; try { wx = await hist(ins); } catch (e) { o.warn.push('Sin clima histórico: ' + e.message); }
  o.wx = wx; o.D = dataset(ins, wx);
  if (!o.noPanels) {
    o.model = fitPhys(o.D, k); o.bt = backtest(o.D, k); o.an = anomalies(o); o.soil = soilingModel(o); o.deg = degradation(o); o.km = kmeans(o); o.ann = annual(o);
    o.diag = (o.an.items || []).slice(0, 8).map(it => ({...it, causes:diagnose(o, it.i)}));
    try { o.f7 = await forecast7(ins, o.model); } catch (e) { o.warn.push('Sin pronóstico: ' + e.message); }
  }
  CACHE[key] = {t:Date.now(), v:o}; return o;
}

/* ===== gráficos SVG propios (con tooltips nativos) ===== */
const C = {ac:'var(--ac,#e8890c)', c2:'var(--c2,#2f7de1)', bad:'var(--bad,#d64545)', ok:'var(--ok,#1f9d55)', mu:'var(--mu,#667085)', bd:'var(--bd,#e3e6ec)'};
function axes(W, H, L, B, T, Rg, mx, labels, x){
  let o = ''; for (let k = 0; k <= 4; k++) { const y = H - B - (mx * k / 4 / mx) * (H - B - T); o += `<line x1="${L}" x2="${W - Rg}" y1="${y}" y2="${y}" stroke="${C.bd}"/><text x="2" y="${y + 4}">${f1(mx * k / 4)}</text>`; }
  const stp = Math.ceil(labels.length / 8); labels.forEach((l, i) => { if (i % stp === 0) o += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; }); return o;
}
function lineChart(labels, series, band){
  const n = labels.length; if (!n) return '';
  const W = 700, H = 230, L = 42, B = 26, T = 16, Rg = 10, all = series.flatMap(s => s.v.filter(v => v != null)).concat(band ? band.hi : []), mx = Math.max(1e-6, ...all) * 1.08;
  const x = i => L + i * (W - L - Rg) / Math.max(n - 1, 1), y = v => H - B - v / mx * (H - B - T);
  let o = `<div class="ia-svg"><svg viewBox="0 0 ${W} ${H}" role="img">` + axes(W, H, L, B, T, Rg, mx, labels, x);
  if (band) { let up = '', dn = ''; band.hi.forEach((v, i) => up += `${i ? 'L' : 'M'}${x(i)} ${y(v)}`); for (let i = n - 1; i >= 0; i--) dn += `L${x(i)} ${y(band.lo[i])}`; o += `<path d="${up}${dn}Z" fill="${C.ac}" opacity=".2"/>`; }
  series.forEach(s => {
    let d = ''; s.v.forEach((v, i) => { if (v != null) d += `${d ? 'L' : 'M'}${x(i)} ${y(v)}`; });
    o += `<path d="${d}" fill="none" stroke="${s.c || C.ac}" stroke-width="2.2"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
    if (n <= 40) s.v.forEach((v, i) => { if (v != null) o += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.c || C.ac}"><title>${esc(labels[i])}: ${f1(v)}</title></circle>`; });
  });
  series.forEach((s, i) => o += `<text x="${L + 8 + i * 140}" y="11" style="fill:${s.c || C.ac}">● ${esc(s.n)}</text>`);
  return o + '</svg></div>';
}
function barChart(labels, vals, cols){
  const n = labels.length; if (!n) return '';
  const W = 700, H = 220, L = 42, B = 26, T = 12, Rg = 10, mx = Math.max(1e-6, ...vals) * 1.1, x = i => L + (i + .5) * (W - L - Rg) / n, y = v => H - B - v / mx * (H - B - T), bw = (W - L - Rg) / n * .66;
  let o = `<div class="ia-svg"><svg viewBox="0 0 ${W} ${H}" role="img">` + axes(W, H, L, B, T, Rg, mx, labels, x);
  vals.forEach((v, i) => o += `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" fill="${cols ? cols[i] : C.ac}" rx="3"><title>${esc(labels[i])}: ${f1(v)}</title></rect>`);
  return o + '</svg></div>';
}
function scatter(pts, line, xl){
  if (!pts.length) return '';
  const W = 700, H = 240, L = 42, B = 30, T = 12, Rg = 10, xm = Math.max(...pts.map(p => p.x)) * 1.05, ym = Math.max(...pts.map(p => p.y)) * 1.1 || 1;
  const x = v => L + v / xm * (W - L - Rg), y = v => H - B - v / ym * (H - B - T);
  let o = `<div class="ia-svg"><svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let k = 0; k <= 4; k++) { const v = ym * k / 4; o += `<line x1="${L}" x2="${W - Rg}" y1="${y(v)}" y2="${y(v)}" stroke="${C.bd}"/><text x="2" y="${y(v) + 4}">${f1(v)}</text>`; }
  for (let k = 0; k <= 4; k++) o += `<text x="${x(xm * k / 4)}" y="${H - 14}" text-anchor="middle">${f1(xm * k / 4)}</text>`;
  o += `<text x="${W / 2}" y="${H - 2}" text-anchor="middle">${esc(xl)}</text>`;
  if (line && line.length) o += `<path d="${line.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)} ${y(p.y)}`).join('')}" fill="none" stroke="${C.c2}" stroke-width="2" stroke-dasharray="5 4"/>`;
  pts.forEach(p => o += `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="${p.flag ? 5 : 3.2}" fill="${p.flag ? C.bad : C.mu}" opacity="${p.flag ? 1 : .55}"><title>${p.t ? esc(p.t) : f1(p.x) + ' → ' + f1(p.y)}</title></circle>`);
  return o + '</svg></div>';
}

/* ===== secciones del Laboratorio ===== */
const need = m => `<div class="card"><p>${m}</p></div>`;
const head = (ic, t, d) => `<div class="card"><h2>${ic} ${t}</h2><p class="mu">${d}</p></div>`;
const SUB = [['res', 'Resumen'], ['f7', 'Predicción 7 días'], ['anom', 'Anomalías (ML)'], ['diag', 'Diagnóstico'], ['soil', 'Suciedad y limpieza'], ['fin', 'Finanzas 25 años'], ['sim', 'Simulador'], ['days', 'Días tipo'], ['rep', 'Informe']];
let SEC = 'res';
const inp = (k, lbl, def, step = '0.1') => `<label>${lbl}<input type="number" step="${step}" min="0" value="${param(k, def)}" onchange="IA.setParam('${k}', this.value)" style="width:120px"></label>`;
const SECTIONS = {
  res(o){
    const m = o.model, bt = o.bt, cov = o.D.filter(d => d.irr > .5).length, est = o.D.filter(d => d.irrEst).length;
    const mod = (ok, name, req) => `<div class="ia-it"><span class="ia-ic">${ok ? '✅' : '⏳'}</span><div><b>${name}</b><br><span class="ia-note">${ok ? 'Activo' : req}</span></div></div>`;
    return head('🧠', 'Cómo aprende SolarIA', 'Estos modelos corren en tu navegador con los datos de tu proyecto y el clima real de Open-Meteo. Cada módulo se activa cuando hay datos suficientes y siempre te dice qué le falta.') +
      `<div class="grid"><div class="card kpi"><small>Días utilizables</small><b>${cov}</b><small>${est ? est + ' con irradiancia estimada del clima' : 'con irradiancia propia'}</small></div>
      <div class="card kpi"><small>Modelo</small><b>${m.learned ? 'Aprendido' : 'Referencia'}</b><small>${m.learned ? 'ajustado con ' + m.n + ' días' : 'faltan ' + (10 - m.n) + ' días para aprender'}</small></div>
      <div class="card kpi"><small>Efecto de la temperatura</small><b>${f1(m.gamma * 100)} %/°C</b><small>${m.learned ? 'aprendido de tus datos' : 'valor típico'}</small></div>
      <div class="card kpi"><small>Dispersión normal</small><b>±${pc(m.sigma)}</b><small>desvío robusto diario</small></div>
      <div class="card kpi"><small>Error en validación</small><b>${bt ? pc(bt.wape) : '–'}</b><small>${bt ? 'R² ' + f1(bt.r2) + ' · ' + bt.n + ' días no vistos' : 'hacen falta 24 días'}</small></div></div>
      <div class="card"><h2>Módulos</h2>${mod(m.learned, 'Modelo físico (irradiancia + temperatura)', 'necesita 10 días con irradiancia')}${mod(!!bt, 'Validación honesta (backtest 70/30)', 'necesita 24 días')}${mod(o.an.ok, 'Detección de anomalías (Isolation Forest + regresión)', 'necesita 12 días')}
      ${mod(o.soil.ok, 'Suciedad y limpieza óptima', o.soil.why)}${mod(o.deg.ok, 'Degradación anual', o.deg.why)}${mod(!!o.km.ok, 'Días tipo (k-means)', 'necesita 15 días')}${mod(!!o.f7, 'Pronóstico a 7 días', 'necesita ubicación y conexión')}${mod(!!(o.ins.tariff > 0 && o.ins.cost > 0), 'Finanzas a 25 años', 'cargá tarifa e inversión en la ficha')}</div>` +
      (o.warn.length ? `<div class="card"><p class="ia-note">⚠️ ${o.warn.map(esc).join(' · ')}</p></div>` : '');
  },
  f7(o){
    if (!o.f7) return need('No pude obtener el pronóstico: ' + esc(o.warn[0] || 'sin ubicación o sin conexión') + '. Revisá la ubicación del proyecto.');
    const f = o.f7, tot = f.reduce((s, x) => s + x.kwh, 0), lo = f.reduce((s, x) => s + x.lo, 0), hi = f.reduce((s, x) => s + x.hi, 0), conf = o.model.learned && o.bt && o.bt.wape < .15 ? 'alta' : o.model.learned ? 'media' : 'baja (el modelo todavía está en modo referencia)';
    const lab = x => new Date(x.date + 'T12:00').toLocaleDateString('es-AR', {weekday:'short', day:'numeric'});
    return head('🔮', 'Predicción de generación a 7 días', 'Pronóstico meteorológico de Open-Meteo + el modelo aprendido de tu instalación (irradiancia y temperatura). La banda sombreada es un intervalo de confianza del ~80% que se ensancha con los días.') +
      `<div class="grid"><div class="card kpi"><small>Total próximos 7 días</small><b>${f1(tot)} kWh</b><small>rango ${f1(lo)} – ${f1(hi)}</small></div><div class="card kpi"><small>Confianza</small><b>${conf.split(' ')[0]}</b><small>${o.bt ? 'error de validación ' + pc(o.bt.wape) : 'sin validación todavía'}</small></div>${o.ins.tariff > 0 ? `<div class="card kpi"><small>Ahorro estimado</small><b>${money(tot * o.ins.tariff)}</b></div>` : ''}</div>
      <div class="card"><h2>kWh por día</h2>${lineChart(f.map(lab), [{n:'Esperado', v:f.map(x => +x.kwh.toFixed(2))}], {lo:f.map(x => x.lo), hi:f.map(x => x.hi)})}</div>
      <div class="card sc"><table><tr><th>Día</th><th>Tipo</th><th>Irradiancia</th><th>Temp.</th><th>Lluvia</th><th>Esperado</th><th>Rango</th></tr>${f.map(x => `<tr><td>${esc(lab(x))}</td><td>${o.km.ok ? o.km.classify(x.irr).name : '–'}</td><td>${f1(x.irr)}</td><td>${Math.round(x.t)}°</td><td>${f1(x.rain)} mm</td><td><b>${f1(x.kwh)} kWh</b></td><td>${f1(x.lo)} – ${f1(x.hi)}</td></tr>`).join('')}</table></div>`;
  },
  anom(o){
    const a = o.an; if (!a.ok) return need(`Para detectar anomalías con machine learning necesito al menos 12 días con irradiancia (tengo ${a.n}).`);
    const xs = a.pts.map(p => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs), line = [x0, x1].map(x => ({x, y:pred(o.model, {irr:x, t:25})}));
    const pts = a.pts.map(p => ({...p, t:`${f1(p.x)} kWh/m² → ${f1(p.y)} kWh`}));
    return head('🛰️', 'Detección de anomalías: dos detectores independientes', 'Un <b>Isolation Forest</b> (aprende qué días son raros por su combinación de energía, irradiancia y potencia) y una <b>regresión robusta</b> (días que producen mucho menos de lo físicamente esperado). Si coinciden los dos, la confianza es alta.') +
      `<div class="card"><h2>Producción vs. irradiancia</h2>${scatter(pts, line, 'irradiancia (kWh/m²)')}<span class="ia-note">Línea punteada: lo que el modelo espera a 25 °C. Puntos rojos: días señalados.</span></div>
      <div class="card"><h2>Días señalados (${a.items.length})</h2>${a.items.slice(0, 12).map(it => `<div class="ia-it"><span class="ia-sev ${it.sev}">${it.both ? 'ALTA CONFIANZA' : it.reg ? 'REGRESIÓN' : 'ISOLATION FOREST'}</span><div><b>${it.date}</b> · rindió ${pc(it.ratio)} de lo esperado · puntaje ${f1(it.score)}<br><span class="ia-note">Lo más atípico: ${it.top} (${it.dir}).</span></div></div>`).join('') || '<p>✅ No hay días anómalos.</p>'}</div>`;
  },
  diag(o){
    if (!o.an.ok) return need('El diagnóstico necesita primero detectar anomalías (mínimo 12 días con irradiancia).');
    return head('🩺', 'Diagnóstico probable de cada falla', 'Un sistema experto con pesos estima la causa más probable a partir de la forma de la caída: si fue brusca o gradual, si hubo lluvia, la temperatura, la potencia pico y los días siguientes. Son probabilidades orientativas, no certezas.') +
      (o.diag.length ? o.diag.map(it => `<div class="card"><h2>${it.date} <span class="ia-sev ${it.sev}">${it.sev.toUpperCase()}</span></h2><p class="mu">Rindió ${pc(it.ratio)} de lo esperado.</p>
        ${it.causes.map(c => `<div class="ia-it"><span class="ia-ic">${CAUSES[c.c][0]}</span><div style="flex:1"><b>${CAUSES[c.c][1]}</b> · ${c.pct}%<div class="ia-bar"><i style="width:${c.pct}%"></i></div><span class="ia-note">Evidencia: ${esc(c.why.join('; '))}.</span><br><span class="ia-note">👉 ${CAUSES[c.c][2]}</span></div></div>`).join('')}</div>`).join('') : '<div class="card"><p>✅ No hay anomalías para diagnosticar.</p></div>');
  },
  soil(o){
    const s = o.soil; if (!s.ok) return need(esc(s.why));
    const lossPct = s.lossNow != null ? s.lossNow * 100 : null, T = s.T, near = T && s.dsrNow != null && s.dsrNow >= T * .8, rain = o.f7 && o.f7.slice(0, 4).some(x => x.rain >= 5);
    const rec = !T ? 'La suciedad medida es muy baja: no hace falta limpiar por rendimiento.' : near ? (rain ? '🌧️ Se esperan lluvias fuertes en los próximos días: conviene esperar a que limpien los paneles.' : '🧼 Ya pasó casi todo el ciclo óptimo: conviene programar la limpieza.') : `Todavía no corresponde limpiar: el ciclo óptimo es cada ${Math.round(T)} días sin lluvia.`;
    return head('🧼', 'Suciedad y plan de limpieza óptimo', 'Mide cuánto rendimiento perdés por cada día sin lluvia (regresión del rendimiento vs. días desde la última lluvia ≥2 mm o limpieza registrada) y calcula cada cuánto conviene limpiar comparando el costo de limpiar con la energía que se pierde.') +
      `<div class="grid"><div class="card kpi"><small>Pérdida por suciedad</small><b>${f2(s.s * 100)} %/día</b><small>sin lluvia</small></div><div class="card kpi"><small>Días desde la última lluvia/limpieza</small><b>${s.dsrNow ?? '–'}</b><small>${lossPct != null ? 'pérdida actual ≈ ' + f1(lossPct) + '%' : ''}</small></div><div class="card kpi"><small>Limpieza óptima cada</small><b>${T ? Math.round(T) + ' días' : '–'}</b><small>con costo de ${money(s.C)}</small></div></div>
      <div class="card"><h2>Recomendación</h2><p>${rec}</p><div class="row">${inp('clean', 'Costo de una limpieza ($)', 15000, '100')}</div>${s.defTariff ? '<p class="ia-note">Usé una tarifa de $100/kWh porque no cargaste la tuya en la ficha.</p>' : ''}</div>
      <div class="card"><h2>Rendimiento vs. días sin lluvia</h2>${scatter(s.pts.map(p => ({x:p.x, y:p.y * 100, t:`${p.x} días → ${f1(p.y * 100)}%`})), [0, 45].map(x => ({x, y:(s.fit.a + s.fit.b * x) * 100})), 'días desde la última lluvia o limpieza')}<span class="ia-note">Cada punto es un día; la línea es la tendencia aprendida.</span></div>`;
  },
  fin(o){
    const ins = o.ins; if (!(ins.tariff > 0 && ins.cost > 0)) return need('Cargá la tarifa eléctrica y la inversión inicial en <b>Proyectos → ficha</b> para proyectar las finanzas.');
    const Y1 = o.ann ? o.ann.kwh : (() => { const l = o.D.slice(-60); return l.length ? avg(l.map(d => d.kwh)) * 365 : 0; })();
    if (!(Y1 > 0)) return need('Todavía no tengo datos para estimar la generación anual.');
    const p = finP(), r = finance(Y1, ins.cost, ins.tariff, p), dg = o.deg;
    return head('📈', 'Proyección financiera a 25 años', `Generación del primer año: <b>${f1(Y1)} kWh</b> (${o.ann ? 'retrocálculo con el clima real de los últimos 12 meses' : 'extrapolada de tus últimos días: poco precisa'}). ${dg.ok ? `Tu tendencia de rendimiento medida es ${f1(dg.rate * 100)}%/año (incluye suciedad).` : esc(dg.why)}`) +
      `<div class="grid"><div class="card kpi"><small>Retorno (payback)</small><b>${r.pay != null ? Math.floor(r.pay) + ' años ' + Math.round((r.pay % 1) * 12) + ' meses' : 'más de 25 años'}</b></div><div class="card kpi"><small>VAN a 25 años</small><b>${money(r.van)}</b></div><div class="card kpi"><small>TIR</small><b>${f1(r.tir * 100)}%</b></div><div class="card kpi"><small>Costo de la energía (LCOE)</small><b>${money(r.lcoe)}/kWh</b><small>vs. tarifa ${money(ins.tariff)}</small></div></div>
      <div class="card"><h2>Flujo de caja acumulado ($)</h2>${lineChart(r.rows.map(x => 'Año ' + x.t), [{n:'Acumulado (millones $)', v:r.rows.map(x => Math.max(x.cum, 0) / 1e6)}, {n:'Inversión (millones $)', v:r.rows.map(() => ins.cost / 1e6), c:C.bad, dash:1}])}<span class="ia-note">Muestra el acumulado positivo contra la inversión inicial.</span></div>
      <div class="card"><h2>Supuestos (editables)</h2><div class="row">${inp('deg', 'Degradación anual (%)', .5)}${inp('g', 'Suba real de tarifa (%/año)', 5)}${inp('disc', 'Tasa de descuento (%)', 10)}${inp('om', 'Mantenimiento (% de la inversión/año)', 1)}</div><p class="ia-note">VAN y TIR usan estos supuestos; cambialos para ver escenarios.</p></div>`;
  },
  sim(o){
    if (!o.ann) return need('El simulador necesita el clima histórico de la ubicación (12 meses). Revisá la ubicación del proyecto y la conexión.');
    const extra = param('xpan', 0), wp = o.ins.panels.length ? o.ins.panels[0].wp : 450, k2 = o.k + extra * wp / 1000, f = k2 / o.k, Y = o.ann.kwh * f;
    const ins = o.ins, costK = ins.cost > 0 ? ins.cost / o.k : param('ckw', 900000), cost2 = costK * k2, M = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const r = ins.tariff > 0 ? finance(Y, cost2, ins.tariff, finP()) : null;
    return head('🧪', 'Simulador de viabilidad', 'Estima cuánto generaría la instalación en un año usando el clima real de los últimos 12 meses en tu ubicación, y qué cambia si agregás paneles. Sirve también para evaluar un proyecto antes de comprarlo.') +
      `<div class="card"><div class="row">${inp('xpan', 'Paneles extra a simular (de ' + wp + ' Wp)', 0, '1')}${ins.cost > 0 ? '' : inp('ckw', 'Costo por kWp instalado ($)', 900000, '1000')}</div></div>
      <div class="grid"><div class="card kpi"><small>Potencia simulada</small><b>${f1(k2)} kWp</b></div><div class="card kpi"><small>Generación anual</small><b>${f1(Y)} kWh</b><small>${f1(Y / k2)} kWh por kWp</small></div>${ins.tariff > 0 ? `<div class="card kpi"><small>Ahorro anual</small><b>${money(Y * ins.tariff)}</b></div>` : ''}${r ? `<div class="card kpi"><small>Payback</small><b>${r.pay != null ? f1(r.pay) + ' años' : '> 25 años'}</b><small>inversión ${money(cost2)}</small></div>` : ''}<div class="card kpi"><small>CO₂ evitado por año</small><b>${f1(Y * .4 / 1000)} t</b><small>≈ ${Math.round(Y * .4 / 21)} árboles (factor 0,4 kg/kWh, orientativo)</small></div></div>
      <div class="card"><h2>Generación mensual estimada (kWh)</h2>${barChart(M, o.ann.months.map(m => m * f))}</div>`;
  },
  days(o){
    const k = o.km; if (!k.ok) return need('Necesito al menos 15 días con datos para agrupar los días por tipo.');
    const tot = k.groups.reduce((s, g) => s + g.n, 0);
    return head('🌗', 'Días tipo (aprendizaje no supervisado)', 'El algoritmo k-means agrupa tus días según irradiancia y producción, sin que nadie le diga las categorías. Sirve para entender tu clima y estimar cuántos días de cada tipo esperar.') +
      `<div class="grid">${k.groups.map(g => `<div class="card kpi"><small>${g.name === 'Soleado' ? '☀️' : g.name === 'Parcial' ? '⛅' : '☁️'} ${g.name}</small><b>${g.n} días (${Math.round(g.n / tot * 100)}%)</b><small>${f1(g.irr)} kWh/m² · ${f1(g.kwh)} kWh/día</small></div>`).join('')}</div>
      <div class="card"><h2>Producción media por tipo de día (kWh)</h2>${barChart(k.groups.map(g => g.name), k.groups.map(g => g.kwh), [C.mu, C.c2, C.ac])}</div>`;
  },
  rep(o){
    const t = reportText(o);
    return head('📝', 'Informe inteligente', 'Resumen redactado automáticamente con los resultados de todos los modelos. Podés copiarlo, imprimirlo o enviarlo por Telegram.') +
      `<div class="card"><pre class="ia-pre" id="iarep">${esc(t)}</pre><div class="row noprint" style="margin-top:10px"><button class="pri" onclick="IA.copy()">Copiar</button><button onclick="window.print()">Imprimir / PDF</button><button onclick="IA.tg()">Enviar por Telegram</button></div></div>`;
  }
};

/* ===== informe en lenguaje natural ===== */
function reportText(o){
  const ins = o.ins, mes = iso(new Date()).slice(0, 7), D = o.D.filter(d => d.date.startsWith(mes) && d.irr > .5), all = o.D.filter(d => d.date.startsWith(mes));
  const L = [`INFORME INTELIGENTE · ${ins.name} · ${mes}`, `${f1(o.k)} kWp · ${ins.loc || 'ubicación sin definir'} · alimenta: ${ins.use}`, ''];
  if (!all.length) return L.concat(['Todavía no hay datos de generación este mes.']).join('\n');
  const tot = all.reduce((s, d) => s + d.kwh, 0), exp = D.reduce((s, d) => s + pred(o.model, d), 0), got = D.reduce((s, d) => s + d.kwh, 0);
  L.push(`PRODUCCIÓN: generó ${f1(tot)} kWh en ${all.length} días (${f1(tot / all.length)} kWh/día)${ins.tariff > 0 ? `, un ahorro de ${money(tot * ins.tariff)}` : ''}.`);
  if (exp > 0) L.push(`RENDIMIENTO: ${pc(got / exp)} de lo que el modelo esperaba según el clima de esos días${got / exp < .9 ? ' (por debajo de lo normal)' : ' (dentro de lo normal)'}.`);
  const an = (o.diag || []).filter(x => x.date.startsWith(mes));
  L.push(an.length ? `ANOMALÍAS: ${an.length} día(s) señalados. ${an.slice(0, 3).map(x => `${x.date}: ${CAUSES[x.causes[0].c][1].toLowerCase()} (${x.causes[0].pct}%)`).join('; ')}.` : 'ANOMALÍAS: no se detectaron este mes.');
  if (o.soil && o.soil.ok) L.push(`SUCIEDAD: pérdida de ${f2(o.soil.s * 100)}%/día sin lluvia${o.soil.T ? `; limpieza óptima cada ${Math.round(o.soil.T)} días` : ''}.`);
  if (o.f7) { const t = o.f7.reduce((s, x) => s + x.kwh, 0); L.push(`PRÓXIMOS 7 DÍAS: se esperan ${f1(t)} kWh${ins.tariff > 0 ? ` (≈ ${money(t * ins.tariff)})` : ''}.`); }
  if (ins.tariff > 0 && ins.cost > 0 && o.ann) { const r = finance(o.ann.kwh, ins.cost, ins.tariff, finP()); L.push(`FINANZAS: retorno estimado en ${r.pay != null ? f1(r.pay) + ' años' : 'más de 25 años'}; TIR ${f1(r.tir * 100)}%.`); }
  L.push('', 'RECOMENDACIONES:'); const rc = recs(o); rc.forEach((r, i) => L.push(`${i + 1}. ${r}`));
  L.push('', `Modelo: ${o.model.learned ? 'aprendido con ' + o.model.n + ' días' : 'en modo referencia (' + o.model.n + '/10 días)'}${o.bt ? `; error de validación ${pc(o.bt.wape)}` : ''}. Generado por SolarIA.`);
  return L.join('\n');
}
function recs(o){
  const r = [], d0 = o.diag || [];
  if (d0.length && d0[0].sev !== 'info') { const c = d0[0].causes[0]; r.push(`${CAUSES[c.c][2]} (causa probable del ${d0[0].date}: ${CAUSES[c.c][1].toLowerCase()}).`); }
  if (o.soil && o.soil.ok && o.soil.T && o.soil.dsrNow != null && o.soil.dsrNow >= o.soil.T * .8) r.push('Programar la limpieza de los paneles (ya se alcanzó casi el ciclo óptimo).');
  const lm = db.ev.filter(e => e.inst == cur && e.type === 'Mantenimiento').map(e => e.date).sort().pop();
  if (!lm || dayDiff(lm, iso(new Date())) > 180) r.push('Hacer una inspección preventiva (termografía, ajuste de bornes): hace más de 6 meses del último mantenimiento.');
  if (!o.model.learned) r.push('Seguir cargando datos con irradiancia: el modelo propio se activa con 10 días.');
  if (!r.length) r.push('Continuar con el monitoreo habitual: no hay acciones urgentes.');
  return r;
}

/* ===== Centro de IA (Panel) ===== */
function centerItems(o){
  const it = [], push = (sev, ic, t, d) => it.push({sev, ic, t, d}), today = iso(new Date());
  if (!o.R.length) push('info', '🗂️', 'Todavía no hay datos de generación', 'Cargá datos, importá el CSV del inversor o conectá un dispositivo para activar los modelos.');
  else { const gap = dayDiff(o.R[o.R.length - 1].date, today); if (gap >= 3) push('media', '⏰', `Hace ${gap} días que no cargás datos`, 'Sin datos recientes no puedo detectar problemas a tiempo.'); }
  if (o.noPanels) push('info', '🔧', 'Faltan los paneles del proyecto', 'Cargalos en la ficha para activar el modelo físico.');
  (o.diag || []).filter(x => dayDiff(x.date, today) <= 7 && x.sev !== 'info').slice(0, 2).forEach(x => push(x.sev, '🚨', `Anomalía el ${x.date}`, `Causa más probable: ${CAUSES[x.causes[0].c][1].toLowerCase()} (${x.causes[0].pct}%). ${CAUSES[x.causes[0].c][2]}`));
  if (o.soil && o.soil.ok && o.soil.T && o.soil.dsrNow != null) {
    const rain = o.f7 && o.f7.slice(0, 4).some(x => x.rain >= 5);
    if (o.soil.dsrNow >= o.soil.T * .8) push(rain ? 'info' : 'media', '🧼', rain ? 'Se espera lluvia: no limpies todavía' : 'Conviene limpiar los paneles', `Llevás ${o.soil.dsrNow} días sin lluvia/limpieza (pérdida ≈ ${f1(o.soil.lossNow * 100)}%); el ciclo óptimo es cada ${Math.round(o.soil.T)} días.`);
  }
  if (o.f7 && o.f7.length > 1) {
    const l30 = avg(o.D.filter(d => d.irr > .5).slice(-30).map(d => d.kwh)), tm = o.f7[1];
    if (l30 > 0 && tm.kwh < .6 * l30) push('info', '🌧️', 'Mañana se espera poca generación', `Unos ${f1(tm.kwh)} kWh (${f1((1 - tm.kwh / l30) * 100)}% menos que tu promedio reciente).`);
    else push('ok', '☀️', 'Pronóstico de mañana', `Se esperan unos ${f1(tm.kwh)} kWh (rango ${f1(tm.lo)}–${f1(tm.hi)}).`);
  }
  const lm = db.ev.filter(e => e.inst == cur && e.type === 'Mantenimiento').map(e => e.date).sort().pop();
  if (!lm || dayDiff(lm, today) > 180) push('info', '🛠️', 'Mantenimiento preventivo pendiente', lm ? `Último registrado hace ${dayDiff(lm, today)} días.` : 'No hay mantenimientos registrados.');
  if (o.model && !o.model.learned && o.R.length) push('info', '🧠', `Entrenando el modelo: ${Math.min(o.model.n, 10)}/10 días`, 'Mientras tanto comparo contra una referencia teórica.');
  const ord = {alta:0, media:1, info:2, ok:3}; return it.sort((a, b) => ord[a.sev] - ord[b.sev]);
}
async function center(){
  const box = $('#iac'); if (!box || !I(cur)) return;
  box.innerHTML = '<div class="card mu">🧠 SolarIA está analizando tu instalación…</div>';
  try {
    const o = await pack(); if ($('#iac') !== box || !o) return;
    const it = centerItems(o);
    box.innerHTML = `<div class="card"><h2>🧠 Centro de IA: lo que SolarIA te recomienda hoy</h2>${it.map(x => `<div class="ia-it"><span class="ia-ic">${x.ic}</span><div style="flex:1"><b>${esc(x.t)}</b> <span class="ia-sev ${x.sev}">${x.sev === 'ok' ? 'OK' : x.sev === 'info' ? 'INFO' : x.sev.toUpperCase()}</span><br><span class="ia-note">${esc(x.d)}</span></div></div>`).join('') || '<p>✅ Todo en orden.</p>'}
      <div class="row noprint" style="margin-top:8px"><button class="pri" onclick="tab='lab';render()">Abrir Laboratorio IA</button><button onclick="IA.tg()">Enviar resumen por Telegram</button></div></div>`;
  } catch (e) { console.warn(e); box.innerHTML = ''; }
}

/* ===== asistente: comprensión de lenguaje con TF-IDF + similitud coseno ===== */
const STOP = new Set('el la los las un una de del y o que en a mi mis por para con es se lo al me te tu yo hay'.split(' '));
const tok = t => norm(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(w => w.length > 5 ? w.slice(0, 5) : w);
const INTENTS = {
  forecast7:['pronostico de la semana', 'cuanto voy a generar esta semana', 'generacion de los proximos dias', 'prediccion proximos 7 dias', 'como va a ser la semana', 'cuanto generare en los proximos dias'],
  soiling:['tengo que limpiar los paneles', 'cada cuanto limpiar', 'estan sucios los paneles', 'suciedad perdida de rendimiento', 'cuando conviene limpiar', 'cuanto pierdo por suciedad polvo'],
  degrad:['degradacion de los paneles', 'pierden eficiencia con los anos', 'cuanto se degradan por ano', 'envejecimiento de los modulos', 'vida util de los paneles'],
  proj25:['proyeccion financiera a 25 anos', 'cuanto gano en 25 anos', 'van tir rentabilidad', 'vale la pena la inversion a largo plazo', 'rentabilidad en la vida util', 'flujo de caja a 25 anos', 'cuanto voy a ahorrar en 25 anos'],
  whatif:['que pasa si agrego paneles', 'si instalo mas paneles cuanto genero', 'ampliar la instalacion agregar paneles', 'simular mas kwp', 'si sumo paneles'],
  cause:['que le paso a mi sistema', 'cual es la causa de la falla', 'por que fallo', 'que causo la anomalia', 'diagnostico de la falla', 'por que bajo la produccion un dia'],
  daytypes:['cuantos dias nublados tuve', 'dias soleados y nublados', 'tipos de dias', 'cuantos dias de sol tuve'],
  report:['hacer un informe', 'resumen del mes', 'informe de produccion inteligente', 'dame un reporte completo', 'resumen general de mi sistema'],
  co2:['cuanto co2 evite', 'impacto ambiental', 'cuantos arboles equivale', 'emisiones evitadas', 'huella de carbono'],
  accuracy:['que tan confiable es la prediccion', 'cual es el error del modelo', 'que tan preciso es', 'validacion del modelo', 'cuanto se equivoca la ia'],
  expected:['estoy produciendo lo esperado', 'rindo lo que deberia', 'mi rendimiento es normal', 'produzco menos de lo esperado', 'comparado con lo esperado'],
  anomml:['anomalias con machine learning', 'dias raros que detecto la ia', 'isolation forest', 'dias atipicos de produccion']
};
const DOCS = Object.entries(INTENTS).map(([k, ex]) => [k, ex.flatMap(tok)]);
const DF = {}; DOCS.forEach(([, ws]) => new Set(ws).forEach(w => DF[w] = (DF[w] || 0) + 1));
const idf = w => Math.log((DOCS.length + 1) / ((DF[w] || 0) + 1)) + 1;
const vec = ws => { const v = {}; ws.forEach(w => v[w] = (v[w] || 0) + idf(w)); return v; };
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (const k in a) { na += a[k] ** 2; if (b[k]) d += a[k] * b[k]; } for (const k in b) nb += b[k] ** 2; return na && nb ? d / Math.sqrt(na * nb) : 0; };
const DV = DOCS.map(([k, ws]) => [k, vec(ws)]);
function classify(raw){
  const q = vec(tok(raw)), s = DV.map(([k, v]) => [k, cos(q, v)]).sort((a, b) => b[1] - a[1]);
  return s[0][1] >= .3 && s[0][1] - s[1][1] >= .04 ? {intent:s[0][0], score:s[0][1]} : null;
}
const HANDLERS = {
  async forecast7(o){ if (!o.f7) return asw('No pude obtener el pronóstico ahora. ' + (o.warn[0] || '')); const t = o.f7.reduce((s, x) => s + x.kwh, 0), lo = o.f7.reduce((s, x) => s + x.lo, 0), hi = o.f7.reduce((s, x) => s + x.hi, 0);
    return asw(`En los próximos 7 días se esperan **${f1(t)} kWh** (rango ${f1(lo)}–${f1(hi)}).\n` + o.f7.map(x => `• ${x.date}: ${f1(x.kwh)} kWh${x.rain >= 5 ? ' 🌧️' : ''}`).join('\n') + `\nConfianza: ${o.model.learned ? 'modelo aprendido' : 'modelo en modo referencia (todavía estoy entrenando)'}.`); },
  async soiling(o){ const s = o.soil; if (!s.ok) return asw('Todavía no puedo medir la suciedad: ' + s.why); return asw(`Estimo una pérdida de **${f2(s.s * 100)}% por cada día sin lluvia**. Llevás ${s.dsrNow ?? '?'} días desde la última lluvia o limpieza (pérdida actual ≈ ${s.lossNow != null ? f1(s.lossNow * 100) : '?'}%). ${s.T ? `Con un costo de limpieza de ${money(s.C)}, lo óptimo es limpiar cada **${Math.round(s.T)} días**.` : 'La suciedad medida es baja: no hace falta limpiar por rendimiento.'}`); },
  async degrad(o){ const d = o.deg; if (!d.ok) return asw('Todavía no puedo medir la degradación: ' + d.why + ' Mientras tanto uso 0,5% por año, un valor típico.'); return asw(`Tu rendimiento muestra una tendencia de **${f1(d.rate * 100)}% por año** sobre ${d.span} días (incluye suciedad, así que puede sobrestimar la degradación real). Un valor típico para paneles de silicio es 0,4–0,8% anual.`); },
  async proj25(o){ const ins = o.ins; if (!(ins.tariff > 0 && ins.cost > 0)) return asw('Para proyectar necesito la tarifa y la inversión inicial en la ficha del proyecto.'); const Y = o.ann ? o.ann.kwh : null; if (!Y) return asw('Necesito el clima histórico de la ubicación para estimar la generación anual. Revisá la ubicación del proyecto.');
    const r = finance(Y, ins.cost, ins.tariff, finP()); return asw(`Con ${f1(Y)} kWh por año, el payback sería de **${r.pay != null ? f1(r.pay) + ' años' : 'más de 25 años'}**, el VAN a 25 años ${money(r.van)} y la TIR ${f1(r.tir * 100)}%. Supuestos: degradación ${f1(finP().deg * 100)}%/año, tarifa +${f1(finP().g * 100)}%/año, descuento ${f1(finP().disc * 100)}%. Podés cambiarlos en Laboratorio IA → Finanzas.`); },
  async whatif(o, raw){ const q = norm(raw), n = q.match(/(\d+)\s*(panel|modulo)/), kw = q.match(/(\d+[.,]?\d*)\s*kwp/); if (!o.ann) return asw('Para simular necesito el clima histórico de la ubicación.');
    const wp = o.ins.panels.length ? o.ins.panels[0].wp : 450, add = kw ? parseFloat(kw[1].replace(',', '.')) : n ? +n[1] * wp / 1000 : null; if (!add) return asw('Decime cuántos paneles querés agregar, por ejemplo: «¿qué pasa si agrego 4 paneles?».');
    const f = (o.k + add) / o.k, Y = o.ann.kwh * f, dY = Y - o.ann.kwh; return asw(`Agregando ${f1(add)} kWp (${f1(o.k)} → ${f1(o.k + add)} kWp) generarías unos **${f1(Y)} kWh por año** (+${f1(dY)} kWh)${o.ins.tariff > 0 ? `, ${money(dY * o.ins.tariff)} más de ahorro anual` : ''}. Es una estimación con el clima real de los últimos 12 meses.`); },
  async cause(o){ if (!o.diag || !o.diag.length) return asw(o.an && o.an.ok ? '✅ No detecté anomalías para diagnosticar.' : 'Todavía no tengo datos suficientes para diagnosticar (necesito 12 días con irradiancia).'); const x = o.diag[0], c = x.causes[0];
    return asw(`La anomalía más reciente es del **${x.date}** (rindió ${pc(x.ratio)} de lo esperado). Causa más probable: **${CAUSES[c.c][1]}** (${c.pct}%). Evidencia: ${c.why.join('; ')}.\n👉 ${CAUSES[c.c][2]}${x.causes[1] ? `\nSegunda hipótesis: ${CAUSES[x.causes[1].c][1]} (${x.causes[1].pct}%).` : ''}\nSon probabilidades orientativas, no certezas.`); },
  async daytypes(o){ const k = o.km; if (!k.ok) return asw('Necesito al menos 15 días con datos para agrupar los días por tipo.'); const t = k.groups.reduce((s, g) => s + g.n, 0); return asw(k.groups.map(g => `• **${g.name}**: ${g.n} días (${Math.round(g.n / t * 100)}%), ${f1(g.kwh)} kWh/día en promedio`).join('\n') + '\n(agrupados con k-means según irradiancia y producción)'); },
  async report(o){ return asw(reportText(o) + '\n\nTambién lo tenés en Laboratorio IA → Informe.'); },
  async co2(o){ const tot = o.R.reduce((s, g) => s + g.kwh, 0); return asw(`Con los ${f1(tot)} kWh registrados evitaste unos **${f1(tot * .4)} kg de CO₂** (≈ ${Math.round(tot * .4 / 21)} árboles absorbiendo durante un año). Uso 0,4 kg CO₂/kWh como factor de la red: es un valor orientativo.`); },
  async accuracy(o){ const b = o.bt; if (!b) return asw('Todavía no puedo medir mi error: necesito al menos 24 días para entrenar con una parte y comprobar con otra que nunca vi.'); return asw(`Entrené con el 70% inicial de tus datos y comprobé en los últimos ${b.n} días, que no había visto: el error ponderado fue **${pc(b.wape)}** (R² ${f1(b.r2)}, error medio ${f1(b.mae)} kWh/día). Es una medición honesta; en días con fallas el error es mayor.`); },
  async expected(o){ const D = o.D.filter(d => d.irr > .5).slice(-7); if (!D.length) return asw('No tengo datos recientes con irradiancia para comparar.'); const got = D.reduce((s, d) => s + d.kwh, 0), exp = D.reduce((s, d) => s + pred(o.model, d), 0); return asw(`En los últimos ${D.length} días con datos generaste ${f1(got)} kWh y el modelo esperaba ${f1(exp)} kWh: rendís **${pc(got / exp)}** de lo esperado. ${got / exp >= .9 ? 'Está dentro de lo normal.' : 'Está por debajo de lo normal: mirá Laboratorio IA → Diagnóstico.'}`); },
  async anomml(o){ const a = o.an; if (!a.ok) return asw(`Para el Isolation Forest necesito al menos 12 días con irradiancia (tengo ${a.n}).`); return asw(`El Isolation Forest y la regresión robusta señalaron **${a.items.length} día(s)** de ${a.n}; ${a.items.filter(i => i.both).length} fueron marcados por ambos detectores (alta confianza). ${a.items[0] ? `El más reciente: ${a.items[0].date}.` : ''}`); }
};
async function nlu(raw){
  const c = classify(raw); if (!c || !I(cur)) return null;
  const o = await pack(); if (!o) return null;
  if (o.noPanels) return asw('Primero cargá los paneles del proyecto en la ficha: sin ellos no puedo calcular lo esperado.');
  return HANDLERS[c.intent](o, raw);
}

/* ===== acciones expuestas al HTML ===== */
async function copy(){
  const t = ($('#iarep') || {}).textContent || ''; if (!t) return;
  try { await navigator.clipboard.writeText(t); toast('📋 Informe copiado'); } catch (e) { toast('No se pudo copiar: seleccioná el texto a mano'); }
}
async function tg(){
  const ins = I(cur); if (!ins || !ins.tgToken || !ins.tgChat) return toast('Configurá Telegram en la ficha del proyecto primero');
  const o = await pack(); if (!o) return; if (o.noPanels) return toast('Cargá los paneles del proyecto primero'); const t = reportText(o).slice(0, 3800);
  toast(await tgSend(ins, t) ? '📲 Enviado por Telegram' : 'No se pudo enviar (revisá token y Chat ID)');
}
function setParam(k, v){ const p = P_(); p[k] = parseFloat(v) >= 0 ? parseFloat(v) : 0; ls.set('solaria_ia_' + cur, p); paint(); }
function go(s){ SEC = s; render(); }
async function paint(){
  const box = $('#ialab'); if (!box) return;
  box.innerHTML = '<div class="card mu">🧠 Calculando modelos con tus datos y el clima real…</div>';
  try { const o = await pack(); if ($('#ialab') !== box) return; box.innerHTML = !o ? need('Creá un proyecto primero.') : o.noPanels ? need('Primero cargá los paneles del proyecto (<b>Proyectos → Abrir ficha</b>): sin ellos no puedo calcular cuánto debería producir.') : SECTIONS[SEC](o); }
  catch (e) { console.error(e); box.innerHTML = need('Error al calcular: ' + esc(e.message)); }
}
window.IA = {go, paint, center, copy, tg, setParam, pack, nlu, classify, reportText, fitPhys, isoForest, finance, kmeans, SECTIONS};

/* ===== integración con app.js (sin tocar su código) ===== */
if (!TABS.some(t => t[0] === 'lab')) TABS.splice(TABS.findIndex(t => t[0] === 'ia') + 1, 0, ['lab', 'Laboratorio IA']);
V.lab = () => `<div class="ia-sub">${SUB.map(([k, l]) => `<button class="${k === SEC ? 'on' : ''}" onclick="IA.go('${k}')">${l}</button>`).join('')}</div><div id="ialab"></div>`;
const _panel = V.panel; V.panel = function(){ return '<div id="iac"></div>' + _panel.apply(this, arguments); };
const _render = render; render = function(){ _render.apply(this, arguments); try { if (user && !recoveryMode) { if (tab === 'lab') paint(); if (tab === 'panel') center(); } } catch (e) { console.warn(e); } };
const DOM = ['gener', 'produ', 'energ', 'kwh', 'panel', 'solar', 'soleado', 'ahorr', 'plata', 'dinero', 'invers', 'retorn', 'payback', 'clima', 'tiempo', 'llov', 'lluvi', 'nubl', 'temper', 'viento', 'manan', 'pronos', 'predic', 'falla', 'anomal', 'problem', 'funcion', 'anda', 'salud', 'estado', 'manten', 'limpi', 'inspec', 'kwp', 'especif', 'ficha', 'model', 'entren', 'aprend', 'dia', 'mes', 'semana', 'hoy', 'ayer', 'compar', 'mejor', 'peor', 'por que', 'porque', 'recuper', 'amortiz', 'rentab', 'irradi', 'radiac', 'sistema', 'instal', 'proyecto', 'ubicac', 'co2', 'degrad', 'rendim', 'factura', 'costo', 'cuanto', 'cuantos'];
const HELP2 = 'Puedo responder con los datos de tu proyecto, el clima real y mis modelos de IA sobre:\n• **Producción y ahorro**: «¿cuánto generé este mes?», «¿cuánto ahorré?»\n• **Predicción**: «¿cuánto voy a generar mañana / esta semana?»\n• **Clima**: «¿cómo está el clima?»\n• **Estado**: «¿mi sistema funciona bien?», «¿qué le pasó a mi sistema?», «¿estoy produciendo lo esperado?»\n• **Suciedad y limpieza**: «¿tengo que limpiar los paneles?»\n• **Finanzas**: «¿cuándo recupero la inversión?», «¿cuánto voy a ahorrar en 25 años?», «¿qué pasa si agrego 4 paneles?»\n• **Modelo**: «¿qué tan confiable es la predicción?», «¿cuántos días nublados tuve?», «resumen del mes», «¿cuánto CO2 evité?»\nSi me preguntás algo fuera de esa lista, te voy a decir que todavía no estoy entrenada para eso.';
const NOT_TRAINED = 'Todavía no soy capaz de entender esa consulta: mi modelo no está entrenado para ese tema.\n\nPuedo ayudarte con producción, ahorro, predicción de la semana, clima, estado y diagnóstico de fallas, suciedad y limpieza, finanzas a 25 años, simulación de paneles extra y la confiabilidad de mis modelos. Escribí «ayuda» para ver ejemplos.';
const _answer = answer;
answer = async function(raw){
  const q = norm(raw);
  if (/(ayuda|que podes|que sabes|que puedes|que haces)/.test(q)) return asw(HELP2);
  if (/^(gracias|muchas gracias|genial|perfecto|buenisimo|excelente)/.test(q)) return asw('¡De nada! 😊 Si querés, preguntame por la predicción de la semana o por el estado de tu sistema.');
  try { const r = await nlu(raw); if (r) return r; } catch (e) { console.warn('NLU:', e.message); }
  if (!/^(hola|buenas|buen dia|buenos dias|que tal)\b/.test(q) && !DOM.some(w => q.includes(w))) return asw(NOT_TRAINED);
  return _answer(raw);
};
if (user) render();
})();