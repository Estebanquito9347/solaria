/* SolarIA – lógica de la aplicación (sin librerías externas) */
const TABS = [['panel','Panel'],['live','En vivo'],['proy','Proyectos'],['gen','Generación'],['cmp','Comparar'],['ev','Fallas y mant.'],['ia','Análisis IA'],['rep','Reportes']];
const USES = ['Vivienda','Industria / taller','Bombeo / riego','Comercio','Alumbrado','Otro'];
let tab = 'panel', cur = null, user = null, db = null;

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const iso = d => d.toISOString().slice(0,10);
const f1 = x => (+x).toFixed(1);
const med = a => { if (!a.length) return 0; a = [...a].sort((x,y) => x-y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1]+a[m])/2; };
const ls = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
};
const I = id => db.inst.find(i => i.id == id);
const rows = id => db.gen.filter(g => g.inst == id).sort((a,b) => a.date < b.date ? -1 : 1);
const kwp = p => p.panels.reduce((s,x) => s + x.qty * x.wp, 0) / 1000;      // potencia instalada = Σ cantidad × Wp
const nPan = p => p.panels.reduce((s,x) => s + x.qty, 0);
const pr = (g, k) => g.irr > 0.5 ? g.kwh / (k * g.irr) : null;               // Performance Ratio

/* ---------- Supabase: cuentas y datos ---------- */
let localMode = false;   // modo demostración: los datos viven en localStorage y no hace falta cuenta
let realSb = null;
try { realSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { console.warn('Supabase no disponible:', e.message); }
let sb = realSb;         // en modo local se reemplaza por localDB(), que imita la misma API
let pending = null;   // email que está esperando el código de confirmación
async function auth(reg){
  if (!realSb) return $('#err').textContent = 'Supabase no está configurado (revisá config.js). Podés usar el modo demostración.';
  const e = $('#err'), email = $('#u').value.trim(), pass = $('#p').value, name = reg ? $('#nm').value.trim() : '';
  if (!email || pass.length < 6) return e.textContent = 'Ingresá un email y una clave de al menos 6 caracteres.';
  if (reg && name.length < 3) return e.textContent = 'Ingresá un nombre de usuario (mínimo 3 caracteres).';
  const {data, error} = reg
    ? await sb.auth.signUp({email, password:pass, options:{data:{username:name}}})   // el nombre queda guardado en el usuario
    : await sb.auth.signInWithPassword({email, password:pass});
  if (error) {
    if (/not confirmed/i.test(error.message)) { await sb.auth.resend({type:'signup', email}); pending = email; return render(); }
    return e.textContent = error.message;
  }
  if (!data.session) { pending = email; return render(); }   // falta confirmar con el código del mail
  await start(data.session.user);
}
async function verify(){
  const {data, error} = await sb.auth.verifyOtp({email:pending, token:$('#cd').value.trim(), type:'signup'});
  if (error) return $('#err').textContent = 'Código incorrecto o vencido.';
  pending = null; await start(data.session.user);
}
async function resend(){ await sb.auth.resend({type:'signup', email:pending}); $('#err').textContent = 'Te enviamos un código nuevo.'; }
function cancelVerify(){ pending = null; render(); }
async function start(u){ user = u; await loadAll(); boot(); }
async function logout(){
  if (localMode) { localMode = false; ls.set('solaria_mode', null); sb = realSb; } else await sb.auth.signOut();
  user = db = cur = null; boot();
}
function fail(error){ if (error) { alert('Error de base de datos: ' + error.message); return true; } return false; }
// Ejecuta una consulta, recarga los datos y vuelve a dibujar
async function run(q, after = render){ const {error} = await q; if (fail(error)) return false; await loadAll(); after(); return true; }
// Descarga las 4 tablas (RLS hace que solo lleguen las filas del usuario) y arma el objeto db
async function loadAll(){
  const T = ['projects','panels','generation','events'];
  const R = await Promise.all(T.map(t => sb.from(t).select('*').range(0, 9999)));
  const bad = R.find(r => r.error); if (bad) return fail(bad.error);
  const [p, pa, g, ev] = R.map(r => r.data);
  p.sort((a,b) => a.created_at < b.created_at ? -1 : 1);
  db = {
    inst: p.map(x => ({id:x.id, name:x.name, loc:x.location || '', date:x.start_date || '', use:x.use || 'Otro', useDetail:x.use_detail || '', inv:x.inverter || '', desc:x.description || '', tariff:+x.tariff || 0, cost:+x.investment || 0, tgToken:x.tg_token || '', tgChat:x.tg_chat_id || '',
      panels: pa.filter(y => y.project_id == x.id).map(y => ({id:y.id, brand:y.brand || '', model:y.model || '', qty:y.qty, wp:+y.wp, type:y.type || '', eff:+y.eff}))})),
    gen: g.map(x => ({inst:x.project_id, date:x.date, kwh:+x.kwh, pk:+x.pk, irr:+x.irr})),
    ev:  ev.map(x => ({id:x.id, inst:x.project_id, date:x.date, type:x.type, desc:x.description || ''}))
  };
}

/* ---------- datos de ejemplo (simulados) ---------- */
function seed(){
  let s = 7; const r = () => (s = s*16807 % 2147483647) / 2147483647, t = new Date();
  const pan = (brand, model, qty, wp, type, eff) => ({brand, model, qty, wp, type, eff});
  const inst = [
    {id:1, name:'Casa Arroyito', loc:'Arroyito, Córdoba', date:'2024-03-10', use:'Vivienda', useDetail:'Heladera, aire acondicionado, iluminación', inv:'Inversor on-grid 5 kW', tariff:100, cost:6500000, desc:'Sistema residencial conectado a red para reducir el consumo del hogar.', panels:[pan('Jinko','Tiger Neo 450',12,450,'Monocristalino',22.5)]},
    {id:2, name:'Taller Industrial', loc:'San Francisco, Córdoba', date:'2023-09-01', use:'Industria / taller', useDetail:'Máquinas herramienta y compresor', inv:'Inversor trifásico 10 kW', tariff:130, cost:12000000, desc:'Sector de cubierta del taller que cubre el consumo diurno.', panels:[pan('Canadian Solar','HiKu6 500',20,500,'Monocristalino',21.0)]}
  ];
  const gen = [], ev = [];
  for (const i of inst) for (let d = 90; d >= 1; d--) {
    let irr = 5.8 + 1.8*Math.sin((90-d)/90*Math.PI) + (r()-.5)*1.2;
    if (r() < .2) irr *= .3 + .4*r();
    irr = Math.max(.8, irr);
    let k = 1 + (r()-.5)*.06;
    if (i.id == 1 && d <= 12) k *= .82;   // suciedad gradual
    if (i.id == 1 && d == 20) k = 0;      // corte total
    if (i.id == 2 && d == 35) k = .45;    // falla de inversor
    const kp = kwp(i), kwh = kp*irr*.8*k;
    gen.push({inst:i.id, date:iso(new Date(t - d*864e5)), kwh:+kwh.toFixed(2), pk:+(kwh > 0 ? kp*(.5+.07*irr)*Math.min(1,k+.1) : 0).toFixed(2), irr:+irr.toFixed(2)});
  }
  const dd = n => iso(new Date(t - n*864e5));
  ev.push({id:2, inst:2, date:dd(35), type:'Falla', desc:'Inversor se reinició por sobretemperatura'},
          {id:3, inst:2, date:dd(300), type:'Mantenimiento', desc:'Limpieza de paneles y ajuste de bornes'},
          {id:4, inst:1, date:dd(20), type:'Falla', desc:'Sin generación durante el día; corte de red'});
  return {inst, gen, ev, nid:10};
}

/* ---------- gráficos SVG ---------- */
function chartSVG(labels, series, bar, flags){
  const W = 700, H = 220, p = 36, n = labels.length;
  if (!n) return '<p class="mu">Sin datos.</p>';
  const mx = Math.max(1, ...series.flatMap(s => s.v.filter(x => x != null))) * 1.1;
  const x = i => p + i*(W-p-8)/Math.max(n-1,1), y = v => H-24 - v/mx*(H-40);
  let o = `<svg viewBox="0 0 ${W} ${H}">`;
  for (let k = 0; k <= 4; k++) { const v = mx*k/4; o += `<line x1="${p}" x2="${W-8}" y1="${y(v)}" y2="${y(v)}" stroke="var(--bd)"/><text x="2" y="${y(v)+4}">${f1(v)}</text>`; }
  const st = Math.ceil(n/7);
  labels.forEach((l,i) => { if (i % st == 0) o += `<text x="${x(i)}" y="${H-6}" text-anchor="middle">${esc(l)}</text>`; });
  series.forEach((s,si) => {
    const c = si ? 'var(--c2)' : 'var(--ac)';
    if (bar) {
      const bw = (W-p-8)/n*.7;
      s.v.forEach((v,i) => { if (v != null) o += `<rect x="${x(i)-bw/2}" y="${y(v)}" width="${bw}" height="${y(0)-y(v)}" fill="${flags && flags[i] ? 'var(--bad)' : c}" rx="2"/>`; });
    } else {
      let d = ''; s.v.forEach((v,i) => { if (v != null) d += (d ? 'L' : 'M') + x(i) + ' ' + y(v); });
      o += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2"/>`;
    }
  });
  if (series.length > 1) series.forEach((s,i) => o += `<text x="${p+8+i*120}" y="12" style="fill:${i ? 'var(--c2)' : 'var(--ac)'}">● ${esc(s.n)}</text>`);
  return o + '</svg>';
}

/* ---------- gráficos con Chart.js (si no carga, se usa el SVG propio) ---------- */
const CQ = {}; let CH = [], cid = 0;
function chart(labels, series, bar, flags){
  if (!window.Chart) return chartSVG(labels, series, bar, flags);
  if (!labels.length) return '<p class="mu">Sin datos.</p>';
  const id = 'c' + (++cid); CQ[id] = {labels, series, bar, flags};
  return `<div class="cv"><canvas id="${id}"></canvas></div>`;
}
function drawCharts(){
  if (!window.Chart) return;
  CH = CH.filter(c => c.canvas.isConnected ? true : (c.destroy(), false));          // libera los gráficos que ya no están en pantalla
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const cols = [v('--ac'), v('--c2')], tx = v('--tx'), mu = v('--mu'), bd = v('--bd'), bad = v('--bad');
  document.querySelectorAll('canvas[id^="c"]').forEach(cv => {
    const q = CQ[cv.id]; if (!q || Chart.getChart(cv)) return;
    CH.push(new Chart(cv, {
      type: q.bar ? 'bar' : 'line',
      data: {labels:q.labels, datasets:q.series.map((s,i) => ({label:s.n, data:s.v, borderColor:cols[i % 2], borderWidth:2, pointRadius:0, pointHoverRadius:4, tension:.25, spanGaps:true, borderRadius:3,
        backgroundColor: q.bar ? s.v.map((_,k) => q.flags && q.flags[k] ? bad : cols[i % 2]) : cols[i % 2]}))},
      options: {responsive:true, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
        plugins:{legend:{display:q.series.length > 1, labels:{color:tx}}},
        scales:{x:{ticks:{color:mu, maxTicksLimit:8}, grid:{display:false}}, y:{beginAtZero:true, ticks:{color:mu}, grid:{color:bd}}}}
    }));
  });
  Object.keys(CQ).forEach(k => { if (!document.getElementById(k)) delete CQ[k]; });
}

/* ---------- IA nivel 2: modelo de producción esperada (regresión robusta) ---------- */
// Aprende de cada instalación: kWh esperados = a + b × irradiancia. Se reajusta descartando días atípicos (mínimos cuadrados recortados).
function fitModel(R){
  const pts = R.filter(g => g.irr > 0.5); let use = pts, a = 0, b = 0;
  for (let it = 0; it < 3 && use.length >= 5; it++) {
    const n = use.length, mx = use.reduce((s,g) => s + g.irr, 0)/n, my = use.reduce((s,g) => s + g.kwh, 0)/n;
    const sxx = use.reduce((s,g) => s + (g.irr-mx)**2, 0) || 1, sxy = use.reduce((s,g) => s + (g.irr-mx)*(g.kwh-my), 0);
    b = sxy/sxx; a = my - b*mx;
    const res = pts.map(g => g.kwh - (a + b*g.irr)), mr = med(res), sg = Math.max(1.4826*med(res.map(x => Math.abs(x-mr))), .05);
    use = pts.filter((g,i) => Math.abs(res[i]-mr) < 2.5*sg);
  }
  return {a, b};
}

/* ---------- IA: detección de anomalías y recomendaciones ---------- */
function analyze(id){
  const ins = I(id), R = rows(id), F = [], rec = new Set();
  if (!ins || R.length < 10) return {F, rec:[], pr:null};
  const k = kwp(ins), md = fitModel(R), ex = g => Math.max(md.a + md.b*g.irr, .1);
  const P = R.map(g => ({g, p: g.irr > .5 ? g.kwh/ex(g) : null})), valid = P.filter(x => x.p != null);   // p = real ÷ esperado
  const m = med(valid.map(x => x.p));
  const mad = Math.max(1.4826 * med(valid.map(x => Math.abs(x.p - m))), .04);   // desvío robusto
  for (const {g,p} of P) {
    if (g.irr >= 3 && g.kwh < .05*k) {
      F.push({s:'alta', d:g.date, t:`Generación nula con buena irradiancia (${g.irr} kWh/m²): posible falla total del inversor, corte de red o protección disparada.`});
      rec.add('Revisar estado del inversor, códigos de error y protecciones (termomagnética/diferencial).');
    } else if (p != null && p < m - 3*mad) {
      F.push({s: p < .6*m ? 'alta' : 'media', d:g.date, t:`Produjo ${f1(p*100)}% de lo que el modelo esperaba (típico ${f1(m*100)}%): rendimiento anormalmente bajo para la irradiancia registrada.`});
      rec.add('Inspeccionar sombras puntuales, conexiones y cadenas (strings) con rendimiento bajo.');
    }
  }
  const v = valid.map(x => x.p), rc = v.slice(-10), pv = v.slice(-40,-10);
  if (rc.length >= 7 && pv.length >= 15) {
    const dr = (rc.reduce((s,x) => s+x, 0)/rc.length - med(pv)) / med(pv) * 100;
    if (dr < -7) {
      F.push({s:'media', d:R[R.length-1].date, t:`Pérdida gradual: el rendimiento (real vs. esperado) de los últimos 10 días es ${f1(-dr)}% menor que el de las semanas previas.`});
      rec.add('Programar limpieza de paneles (suciedad/polvo) y verificar degradación o sombras nuevas (vegetación, construcciones).');
    }
  }
  const lm = db.ev.filter(e => e.inst == id && e.type == 'Mantenimiento').map(e => e.date).sort().pop();
  const dm = lm ? Math.round((Date.now() - new Date(lm))/864e5) : null;
  if (dm == null || dm > 180) {
    F.push({s:'info', d:iso(new Date()), t: dm == null ? 'No hay mantenimientos registrados.' : `Último mantenimiento hace ${dm} días.`});
    rec.add('Realizar inspección preventiva (termografía, ajuste de bornes, limpieza) cada 6 meses.');
  }
  F.sort((a,b) => a.d < b.d ? 1 : -1);
  const bad = F.filter(f => f.s != 'info').length;
  const prs = R.map(g => pr(g,k)).filter(x => x != null);
  return {F, rec:[...rec], pr:med(prs), ex, health:Math.max(0, 100 - bad*4)};
}

/* ---------- vistas ---------- */
function fichaProyecto(i){
  return `<div class="card"><h2>Ficha del proyecto: ${esc(i.name)}</h2>
    <div class="row"><label>¿A qué alimenta?<select id="eu">${USES.map(u => `<option ${u == i.use ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <label>Detalle (equipos/cargas)<input id="ed2" value="${esc(i.useDetail)}"></label>
    <label>Inversor<input id="ei" value="${esc(i.inv)}"></label></div>
    <div class="row"><label>Tarifa eléctrica ($/kWh)<input id="etf" type="number" step="0.01" min="0" value="${i.tariff || ''}"></label>
    <label>Inversión inicial ($)<input id="ect" type="number" step="1" min="0" value="${i.cost || ''}"></label></div>
    <div class="row"><label>Telegram – token del bot (opcional)<input id="etk" type="password" autocomplete="off" value="${esc(i.tgToken)}"></label>
    <label>Telegram – Chat ID<input id="ech" value="${esc(i.tgChat)}"></label><button onclick="testTg()">Enviar prueba</button></div>
    <p class="mu" style="font-size:12px">Alertas al celular: creá un bot con @BotFather (te da el token), escribile un mensaje y averiguá tu Chat ID abriendo api.telegram.org/bot&lt;TOKEN&gt;/getUpdates. Guardá la ficha antes de probar.</p>
    <label>Descripción / utilidad del proyecto<textarea id="eds" rows="3">${esc(i.desc)}</textarea></label>
    <div class="row" style="margin-top:8px"><button class="pri" onclick="saveProj()">Guardar ficha</button><button onclick="delProj()">Eliminar proyecto</button></div></div>
  <div class="card sc"><h2>Paneles solares – potencia instalada: ${f1(kwp(i))} kWp (${nPan(i)} paneles)</h2>
    <table><tr><th>Marca</th><th>Modelo</th><th>Cant.</th><th>Wp</th><th>Tipo</th><th>Efic. %</th><th></th></tr>
    ${i.panels.map((x,n) => `<tr><td>${esc(x.brand)}</td><td>${esc(x.model)}</td><td>${x.qty}</td><td>${x.wp}</td><td>${esc(x.type)}</td><td>${x.eff}</td><td><button onclick="delPanel('${x.id}')">✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="mu">Aún no cargaste paneles.</td></tr>'}</table>
    <h2 style="margin-top:14px">Agregar paneles</h2>
    <div class="row"><label>Marca<input id="pb"></label><label>Modelo<input id="pm"></label><label>Cantidad<input id="pq" type="number" min="1" value="1" style="width:80px"></label><label>Potencia (Wp)<input id="pw" type="number" min="1" style="width:100px"></label>
    <label>Tipo<select id="pt"><option>Monocristalino</option><option>Policristalino</option><option>Película delgada</option></select></label><label>Eficiencia %<input id="pe" type="number" step="0.1" style="width:90px"></label><button class="pri" onclick="addPanel()">Agregar</button></div></div>`;
}
const V = {
  live(){ return '<div id="live" class="mu">Cargando…</div>'; },
  panel(){
    const ins = I(cur);
    if (!ins) return '<div class="card">Todavía no tenés proyectos. Andá a <b>Proyectos</b> para crear uno (o cargá datos de ejemplo en <b>Generación</b>).</div>';
    const R = rows(cur), l30 = R.slice(-30), tot = l30.reduce((s,g) => s+g.kwh, 0), a = analyze(cur);
    const an = a.F.filter(f => f.s != 'info'), dates = new Set(an.map(f => f.d));
    return `<div class="card"><b>${esc(ins.name)}</b> <span class="mu">· ${esc(ins.loc)} · Alimenta: ${esc(ins.use)}</span></div>
    <div class="grid"><div class="card kpi"><small>Potencia instalada</small><b>${f1(kwp(ins))} kWp</b></div>
    <div class="card kpi"><small>Energía últimos 30 días</small><b>${f1(tot)} kWh</b></div>
    <div class="card kpi"><small>Promedio diario</small><b>${f1(tot/(l30.length||1))} kWh</b></div>
    <div class="card kpi"><small>PR típico</small><b>${a.pr ? f1(a.pr*100)+'%' : '–'}</b></div>
    <div class="card kpi"><small>Alertas detectadas</small><b>${an.length}</b></div>
    <div class="card kpi"><small>Salud estimada</small><b>${a.health ?? '–'}/100</b></div></div>
    ${econ(ins, R, l30)}
    <div id="fc"></div>
    <div class="card"><h2>Energía diaria (kWh) – últimos 30 días</h2>${chart(l30.map(g => g.date.slice(5)), [{n:'kWh', v:l30.map(g => g.kwh)}], 1, l30.map(g => dates.has(g.date)))}<small class="mu">Barras rojas: días anómalos según el análisis IA.</small></div>
    <div class="card"><h2>Potencia pico diaria (kW)</h2>${chart(l30.map(g => g.date.slice(5)), [{n:'kW', v:l30.map(g => g.pk)}])}</div>`;
  },
  proy(){
    return `<div class="card"><h2>Nuevo proyecto / sector de paneles</h2>
      <div class="row"><label>Nombre<input id="n"></label><label>Ubicación<input id="l"></label><label>Puesta en marcha<input id="d" type="date"></label>
      <label>¿A qué alimenta?<select id="us">${USES.map(u => `<option>${u}</option>`).join('')}</select></label></div>
      <div class="row"><label>Tarifa eléctrica ($/kWh)<input id="tf" type="number" step="0.01" min="0"></label><label>Inversión inicial ($)<input id="ct" type="number" step="1" min="0"></label></div>
      <label>Descripción / utilidad<textarea id="ds" rows="2"></textarea></label>
      <div class="row" style="margin-top:8px"><button class="pri" onclick="addProj()">Crear proyecto</button></div></div>
    <div class="grid">${db.inst.map(p => `<div class="card"><h2>${esc(p.name)}</h2><p class="mu">${esc(p.loc)}</p>
      <p><b>${f1(kwp(p))} kWp</b> · ${nPan(p)} paneles<br>Alimenta: ${esc(p.use)}</p>
      <button onclick="cur='${p.id}';boot()">Abrir ficha</button></div>`).join('')}</div>
    ${I(cur) ? fichaProyecto(I(cur)) : ''}`;
  },
  gen(){
    const R = rows(cur).slice(-15).reverse();
    return `<div class="card"><h2>Cargar datos de generación</h2>
      <div class="row"><label>Fecha<input id="gd" type="date" value="${iso(new Date())}"></label><label>Energía (kWh)<input id="gk" type="number" step="0.01" min="0"></label>
      <label>Potencia pico (kW)<input id="gp" type="number" step="0.01" min="0"></label><label>Irradiancia kWh/m² (vacío = automática)<input id="gi" type="number" step="0.01" min="0"></label><button class="pri" onclick="addGen()">Guardar</button></div>
      <p class="mu">Si dejás la irradiancia vacía, SolarIA la obtiene sola de Open-Meteo según la ubicación del proyecto (${esc(I(cur) ? I(cur).loc || 'sin ubicación' : '')}). Sin irradiancia no se puede modelar el rendimiento.</p>
      <div class="row"><button onclick="fillIrr()">☀️ Completar irradiancia faltante (${rows(cur).filter(g => !(g.irr > 0)).length} días)</button></div>
      <div class="row"><button onclick="demo()">Cargar datos de ejemplo</button><button onclick="wipe()">Borrar todos mis datos</button></div></div>
    <div class="card sc"><h2>Últimos registros</h2><table><tr><th>Fecha</th><th>kWh</th><th>kW pico</th><th>Irrad.</th><th></th></tr>
    ${R.map(g => `<tr><td>${g.date}</td><td>${g.kwh}</td><td>${g.pk}</td><td>${g.irr}</td><td><button onclick="delGen('${g.date}')">✕</button></td></tr>`).join('')}</table></div>`;
  },
  cmp(){
    const o = [...new Set(rows(cur).map(g => g.date.slice(0,7)))].map(m => `<option>${m}</option>`).join('');
    return `<div class="card"><h2>Comparar meses</h2><div class="row"><label>Mes A<select id="ma">${o}</select></label><label>Mes B<select id="mb">${o}</select></label><button class="pri" onclick="cmpM()">Comparar</button></div><div id="rm"></div></div>
    <div class="card"><h2>Comparar días</h2><div class="row"><label>Día A<input type="date" id="da"></label><label>Día B<input type="date" id="db2"></label><button class="pri" onclick="cmpD()">Comparar</button></div><div id="rd"></div></div>`;
  },
  ev(){
    const E = db.ev.filter(e => e.inst == cur).sort((a,b) => a.date < b.date ? 1 : -1);
    return `<div class="card"><h2>Registrar falla o mantenimiento</h2><div class="row"><label>Fecha<input type="date" id="ed" value="${iso(new Date())}"></label>
      <label>Tipo<select id="et"><option>Falla</option><option>Mantenimiento</option></select></label><label>Descripción<input id="edsc" size="34"></label><button class="pri" onclick="addEv()">Guardar</button></div></div>
    <div class="card sc"><table><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th></th></tr>
    ${E.map(e => `<tr><td>${e.date}</td><td><span class="tag ${e.type == 'Falla' ? 'alta' : 'okc'}">${e.type}</span></td><td style="white-space:normal">${esc(e.desc)}</td><td><button onclick="delEv('${e.id}')">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="mu">Sin registros.</td></tr>'}</table></div>`;
  },
  ia(){
    const a = analyze(cur), ins = I(cur);
    if (a.pr == null) return '<div class="card">Se necesitan al menos 10 días de datos con irradiancia para analizar.</div>';
    return `<div id="fc"></div><div class="card"><h2>🤖 Análisis inteligente – ${esc(ins.name)}</h2>
      <p class="mu">Método: el sistema aprende un modelo propio de esta instalación (regresión robusta: energía esperada = a + b × irradiancia, ajustada descartando los días atípicos). Compara cada día real contra lo esperado y marca desvíos mayores a 3 desvíos robustos (MAD), generaciones nulas con sol y caídas sostenidas en los últimos 10 días.</p>
      <div class="row"><span>Salud estimada: <b>${a.health}/100</b></span><span>PR típico: <b>${f1(a.pr*100)}%</b></span><span>Alimenta: <b>${esc(ins.use)}</b></span><span>Días con irradiancia: <b>${rows(cur).filter(g => g.irr > .5).length}/${rows(cur).length}</b></span></div>
      <h2>Real vs. esperado por el modelo (kWh, últimos 30 días)</h2>${(() => { const R = rows(cur).slice(-30); return chart(R.map(g => g.date.slice(5)), [{n:'Real', v:R.map(g => g.kwh)}, {n:'Esperado', v:R.map(g => g.irr > .5 ? +a.ex(g).toFixed(2) : null)}]); })()}
      <h2>Hallazgos</h2>${a.F.slice(0,12).map(f => `<p><span class="tag ${f.s}">${f.s.toUpperCase()}</span> <b>${f.d}</b> – ${esc(f.t)}</p>`).join('') || '<p>✅ Sin comportamientos anormales.</p>'}
      <h2>Recomendaciones de inspección y mantenimiento</h2><ol>${a.rec.map(r => `<li>${esc(r)}</li>`).join('') || '<li>Continuar con el monitoreo habitual.</li>'}</ol></div>`;
  },
  rep(){
    const o = [...new Set(rows(cur).map(g => g.date.slice(0,7)))].map(m => `<option>${m}</option>`).join('');
    return `<div class="card"><h2>Reporte de producción</h2><div class="row noprint"><label>Mes<select id="rm2">${o}</select></label><button class="pri" onclick="genRep()">Generar</button><button onclick="window.print()">Imprimir / PDF</button></div><div id="rr"></div></div>`;
  }
};

/* ---------- acciones (cada una escribe en Supabase y recarga) ---------- */
async function addProj(){
  const n = $('#n').value.trim(); if (!n) return alert('Ingresá un nombre para el proyecto.');
  await run(sb.from('projects').insert({name:n, location:$('#l').value, start_date:$('#d').value || null, use:$('#us').value, description:$('#ds').value, tariff:+$('#tf').value || 0, investment:+$('#ct').value || 0}),
    () => { cur = db.inst[db.inst.length-1].id; boot(); });
}
async function saveProj(){
  const tk = $('#etk').value.trim(), ch = $('#ech').value.trim();
  if (tk && !/^\d+:[\w-]+$/.test(tk)) return alert('El token del bot no tiene el formato esperado (ej. 123456789:ABC...).');
  if (ch && !/^-?\d+$/.test(ch)) return alert('El Chat ID debe ser un número (puede empezar con -).');
  await run(sb.from('projects').update({use:$('#eu').value, use_detail:$('#ed2').value, inverter:$('#ei').value, description:$('#eds').value,
    tariff:+$('#etf').value || 0, investment:+$('#ect').value || 0, tg_token:tk || null, tg_chat_id:ch || null}).eq('id', cur));
}
async function delProj(){
  if (!confirm('¿Eliminar el proyecto y todos sus datos?')) return;
  await run(sb.from('projects').delete().eq('id', cur), () => { cur = null; boot(); });
}
async function addPanel(){
  const q = +$('#pq').value, w = +$('#pw').value;
  if (!(q > 0 && w > 0)) return alert('Completá cantidad y potencia (Wp).');
  await run(sb.from('panels').insert({project_id:cur, brand:$('#pb').value, model:$('#pm').value, qty:q, wp:w, type:$('#pt').value, eff:+$('#pe').value || 0}));
}
const delPanel = id => run(sb.from('panels').delete().eq('id', id));
async function addGen(){
  const d = $('#gd').value, kwh = +$('#gk').value, pk = +$('#gp').value || 0; let irr = +$('#gi').value || 0;
  if (!cur || !d || $('#gk').value === '') return alert('Falta la fecha o la energía.');
  if (!(irr > 0)) {                                                                       // irradiancia vacía: se pide a Open-Meteo
    try { const m = await irrMap(I(cur), [d]); if (m[d] != null) { irr = m[d]; toast(`☀️ Irradiancia obtenida de Open-Meteo: ${irr} kWh/m²`); } }
    catch (e) { toast('No se pudo obtener la irradiancia automática: ' + e.message); }
  }
  const antes = new Set(analyze(cur).F.filter(f => f.s === 'alta').map(f => f.d));      // anomalías graves que ya existían
  const ok = await run(sb.from('generation').upsert({project_id:cur, date:d, kwh, pk, irr}, {onConflict:'project_id,date'}));
  if (!ok) return;
  const nueva = analyze(cur).F.find(f => f.s === 'alta' && f.d === d && !antes.has(d));  // anomalía grave NUEVA en el día cargado
  if (nueva) await alertTg(`🚨 SolarIA – ${I(cur).name}: anomalía grave el ${d}. ${nueva.t}`);
}
const delGen = d => run(sb.from('generation').delete().eq('project_id', cur).eq('date', d));
async function addEv(){
  const s = $('#edsc').value.trim(); if (!cur || !s) return;
  const date = $('#ed').value, type = $('#et').value;
  const ok = await run(sb.from('events').insert({project_id:cur, date, type, description:s}));
  if (ok && type === 'Falla') await alertTg(`⚠️ SolarIA – ${I(cur).name}: falla registrada el ${date}. ${s}`);
}
const delEv = id => run(sb.from('events').delete().eq('id', id));
async function demo(){
  if (db.inst.length && !confirm('Se agregarán 2 proyectos de ejemplo a tu cuenta. ¿Continuar?')) return;
  const s = seed();
  const {data:P, error} = await sb.from('projects').insert(s.inst.map(i => ({name:i.name, location:i.loc, start_date:i.date, use:i.use, use_detail:i.useDetail, inverter:i.inv, description:i.desc, tariff:i.tariff, investment:i.cost}))).select();
  if (fail(error)) return;
  const map = {}; s.inst.forEach((i,n) => map[i.id] = P[n].id);
  const R = await Promise.all([
    sb.from('panels').insert(s.inst.flatMap(i => i.panels.map(x => ({project_id:map[i.id], brand:x.brand, model:x.model, qty:x.qty, wp:x.wp, type:x.type, eff:x.eff})))),
    sb.from('generation').insert(s.gen.map(g => ({project_id:map[g.inst], date:g.date, kwh:g.kwh, pk:g.pk, irr:g.irr}))),
    sb.from('events').insert(s.ev.map(e => ({project_id:map[e.inst], date:e.date, type:e.type, description:e.desc})))
  ]);
  if (R.some(r => fail(r.error))) return;
  cur = null; await loadAll(); boot();
}
async function wipe(){
  if (!confirm('¿Borrar todos tus proyectos y datos?')) return;
  await run(sb.from('projects').delete().not('id','is',null), () => { cur = null; boot(); });
}
function cmpM(){
  const A = $('#ma').value, B = $('#mb').value, R = rows(cur), g = m => R.filter(x => x.date.startsWith(m));
  const a = g(A), b = g(B), s = x => x.reduce((t,y) => t + y.kwh, 0), ta = s(a), tb = s(b), L = Math.max(a.length, b.length), dl = ta ? (tb-ta)/ta*100 : 0;
  $('#rm').innerHTML = `<p>${A}: <b>${f1(ta)} kWh</b> (prom. ${f1(ta/(a.length||1))}/día) · ${B}: <b>${f1(tb)} kWh</b> (prom. ${f1(tb/(b.length||1))}/día) · Diferencia: <b>${dl > 0 ? '+' : ''}${f1(dl)}%</b></p>`
    + chart(Array.from({length:L}, (_,i) => i+1), [{n:A, v:a.map(x => x.kwh)}, {n:B, v:b.map(x => x.kwh)}]);
  drawCharts();
}
function cmpD(){
  const R = rows(cur), a = R.find(x => x.date == $('#da').value), b = R.find(x => x.date == $('#db2').value);
  if (!a || !b) return $('#rd').innerHTML = '<p class="mu">No hay datos para alguna de las fechas.</p>';
  const r = (l,k) => `<tr><td>${l}</td><td>${a[k]}</td><td>${b[k]}</td><td>${f1((b[k]-a[k])/(a[k]||1)*100)}%</td></tr>`;
  $('#rd').innerHTML = `<table><tr><th></th><th>${a.date}</th><th>${b.date}</th><th>Δ</th></tr>${r('Energía (kWh)','kwh')}${r('Pico (kW)','pk')}${r('Irradiancia','irr')}</table>`;
}
function genRep(){
  const m = $('#rm2').value, ins = I(cur), R = rows(cur).filter(g => g.date.startsWith(m));
  if (!R.length) return;
  const tot = R.reduce((s,g) => s+g.kwh, 0), best = R.reduce((a,b) => b.kwh > a.kwh ? b : a), worst = R.reduce((a,b) => b.kwh < a.kwh ? b : a);
  const E = db.ev.filter(e => e.inst == cur && e.date.startsWith(m)), prs = R.map(g => pr(g, kwp(ins))).filter(x => x != null);
  const csv = 'fecha,kWh,kW_pico,irradiancia\n' + R.map(g => [g.date, g.kwh, g.pk, g.irr].join(',')).join('\n');
  $('#rr').innerHTML = `<h3>${esc(ins.name)} – ${m}</h3><p>${esc(ins.loc)} · ${f1(kwp(ins))} kWp · Alimenta: ${esc(ins.use)}</p>
    <div class="grid"><div class="kpi"><small>Total</small><b>${f1(tot)} kWh</b></div><div class="kpi"><small>Promedio diario</small><b>${f1(tot/R.length)} kWh</b></div>
    <div class="kpi"><small>Mejor día</small><b>${best.date.slice(5)} (${f1(best.kwh)})</b></div><div class="kpi"><small>Peor día</small><b>${worst.date.slice(5)} (${f1(worst.kwh)})</b></div>
    <div class="kpi"><small>PR medio</small><b>${prs.length ? f1(prs.reduce((s,x) => s+x, 0)/prs.length*100)+'%' : '–'}</b></div></div>`
    + chart(R.map(g => g.date.slice(8)), [{n:'kWh', v:R.map(g => g.kwh)}], 1)
    + `<h3>Eventos del mes</h3>${E.map(e => `<p>${e.date} – <b>${e.type}</b>: ${esc(e.desc)}</p>`).join('') || '<p class="mu">Sin eventos.</p>'}
    <div class="noprint"><h3>Datos (CSV)</h3><textarea class="csv" readonly>${esc(csv)}</textarea></div>`;
  drawCharts();
}

/* ---------- estado en vivo (lecturas de dispositivos) ---------- */
let lv = {ch:null, t:null};
function liveStop(){ if (lv.ch) { sb.removeChannel(lv.ch); lv.ch = null; } clearInterval(lv.t); }
async function liveStart(){
  liveStop(); if (!cur) return $('#live').innerHTML = '<div class="card">Creá un proyecto primero.</div>';
  if (localMode) return $('#live').innerHTML = '<div class="card">El estado en vivo necesita Supabase (recibe lecturas de dispositivos). En modo demostración local no está disponible.</div>';
  await liveLoad();
  lv.ch = sb.channel('rd-' + cur).on('postgres_changes', {event:'INSERT', schema:'public', table:'readings', filter:'project_id=eq.' + cur}, liveLoad).subscribe();
  lv.t = setInterval(liveLoad, 30000);   // también re-evalúa si dejaron de llegar datos
}
async function liveLoad(){
  if (tab !== 'live' || !cur) return liveStop();
  const since = new Date(Date.now() - 864e5).toISOString();
  const [r, d] = await Promise.all([
    sb.from('readings').select('ts,power_kw,energy_kwh,irr_wm2').eq('project_id', cur).gte('ts', since).order('ts', {ascending:false}).limit(600),
    sb.from('devices').select('*').eq('project_id', cur).order('created_at')]);
  const box = $('#live'); if (!box) return;
  if (r.error || d.error) return box.innerHTML = `<div class="card">Error: ${esc((r.error || d.error).message)}. ¿Ejecutaste schema_live.sql?</div>`;
  const L = r.data[0], age = L ? (Date.now() - new Date(L.ts))/6e4 : null, h = new Date().getHours(), clockDay = h >= 7 && h < 19;
  const sun = L && L.irr_wm2 != null ? L.irr_wm2 > 200 : clockDay;
  let st;
  if (!d.data.length) st = ['⚪','Sin dispositivo vinculado','Creá un dispositivo abajo y usá su clave en el simulador o en el ESP32.'];
  else if (!L) st = ['⚪','Esperando datos','El dispositivo todavía no envió lecturas.'];
  else if (age > 10) st = (sun || clockDay) ? ['🔴','Sin comunicación',`Último dato hace ${Math.round(age)} min en horario de sol. Revisar WiFi, alimentación del dispositivo o internet.`] : ['⚪','Reposo nocturno','Sin datos recientes; es normal de noche.'];
  else if (L.power_kw > 0.05) st = ['🟢','Generando','La instalación está produciendo con normalidad.'];
  else st = sun ? ['🟡','Sin producción con sol','Hay irradiancia pero la potencia es nula: posible falla del inversor, protección disparada o corte de red.'] : ['⚪','Sin producción','No hay sol suficiente en este momento.'];
  const pts = r.data.slice().reverse(), step = Math.ceil(pts.length/150) || 1, S = pts.filter((_,i) => i % step == 0);
  box.innerHTML = `<div class="card"><h2 style="font-size:22px">${st[0]} ${st[1]}</h2><p>${st[2]}</p><small class="mu">${L ? 'Último dato: ' + new Date(L.ts).toLocaleString() : ''}</small></div>
    ${L ? `<div class="grid"><div class="card kpi"><small>Potencia actual</small><b>${f1(L.power_kw)} kW</b></div><div class="card kpi"><small>Energía de hoy</small><b>${L.energy_kwh != null ? f1(L.energy_kwh) + ' kWh' : '–'}</b></div><div class="card kpi"><small>Irradiancia</small><b>${L.irr_wm2 != null ? Math.round(L.irr_wm2) + ' W/m²' : '–'}</b></div></div>
    <div class="card"><h2>Potencia (kW) – últimas 24 h</h2>${chart(S.map(x => new Date(x.ts).toTimeString().slice(0,5)), [{n:'kW', v:S.map(x => +x.power_kw)}])}</div>` : ''}
    <div class="card sc"><h2>Dispositivos vinculados</h2><table><tr><th>Nombre</th><th>Clave del dispositivo</th><th>Último contacto</th><th></th></tr>
    ${d.data.map(x => `<tr><td>${esc(x.name)}</td><td><code>${esc(x.key)}</code></td><td>${x.last_seen ? new Date(x.last_seen).toLocaleString() : '–'}</td><td><button onclick="delDevice('${x.id}')">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="mu">Ninguno todavía.</td></tr>'}</table>
    <div class="row" style="margin-top:8px"><button class="pri" onclick="addDevice()">Crear dispositivo para este proyecto</button></div>
    <p class="mu">Los dispositivos envían sus lecturas a <code>${esc(SUPABASE_URL)}/rest/v1/rpc/ingest_reading</code> con su clave. Mirá la carpeta <b>tools/</b> (simulador y ejemplo de ESP32).</p></div>`;
  drawCharts();
}
const addDevice = () => run(sb.from('devices').insert({project_id:cur, name:'Dispositivo'}), liveLoad);
const delDevice = id => run(sb.from('devices').delete().eq('id', id), liveLoad);

/* ---------- modo demostración local: imita la API de Supabase usando localStorage ---------- */
function localDB(){
  const K = 'solaria_local', get = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch (e) { return {}; } };
  const put = d => { try { localStorage.setItem(K, JSON.stringify(d)); } catch (e) {} };
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2);
  const CHILD = ['panels','generation','events','devices','readings'];
  return {
    from(t){
      const q = {op:'select', f:[], rows:null, opts:null};
      const exec = () => {
        const d = get(), T = d[t] = d[t] || [], m = x => q.f.every(fn => fn(x)); let out = null;
        if (q.op === 'select') return {data:T.filter(m), error:null};
        if (q.op === 'insert') { out = q.rows.map(r => ({id:uid(), created_at:new Date().toISOString(), ...r})); T.push(...out); }
        else if (q.op === 'update') T.filter(m).forEach(x => Object.assign(x, q.rows));
        else if (q.op === 'upsert') {
          const ks = (q.opts && q.opts.onConflict || 'id').split(',');
          q.rows.forEach(r => { const x = T.find(y => ks.every(k => y[k] == r[k])); x ? Object.assign(x, r) : T.push({id:uid(), created_at:new Date().toISOString(), ...r}); });
        } else if (q.op === 'delete') {
          const del = T.filter(m); d[t] = T.filter(x => !m(x));
          if (t === 'projects') CHILD.forEach(c => d[c] = (d[c] || []).filter(x => !del.some(p => p.id == x.project_id)));   // ON DELETE CASCADE
        }
        put(d); return {data:out, error:null};
      };
      const api = {
        select(){ return api; }, range(){ return api; }, limit(){ return api; }, order(){ return api; }, gte(){ return api; },
        insert(r){ q.op = 'insert'; q.rows = [].concat(r); return api; },
        update(r){ q.op = 'update'; q.rows = r; return api; },
        upsert(r, o){ q.op = 'upsert'; q.rows = [].concat(r); q.opts = o; return api; },
        delete(){ q.op = 'delete'; return api; },
        eq(k, v){ q.f.push(x => x[k] == v); return api; },
        not(k, op, v){ q.f.push(x => !(op === 'is' && (v === null ? x[k] == null : x[k] === v))); return api; },
        then(ok, ko){ return Promise.resolve().then(exec).then(ok, ko); }
      };
      return api;
    }
  };
}
async function enterLocal(){
  localMode = true; ls.set('solaria_mode', 'local'); sb = localDB();
  user = {email:'demo@local', user_metadata:{username:'Demo'}};
  await loadAll();
  if (!db.inst.length) await demo();   // primera vez: carga proyectos de ejemplo
  boot();
}

/* ---------- viabilidad financiera y ROI ---------- */
const money = n => '$ ' + Math.round(n).toLocaleString('es-AR');
function econ(ins, R, l30){
  const t = ins.tariff, c = ins.cost;
  if (!(t > 0)) return '<div class="card"><h2>💰 Viabilidad financiera</h2><p class="mu">Cargá la tarifa eléctrica ($/kWh) y la inversión inicial en la ficha del proyecto (pestaña Proyectos) para ver el ahorro y el retorno de la inversión.</p></div>';
  const e30 = l30.reduce((s,g) => s + g.kwh, 0), eAll = R.reduce((s,g) => s + g.kwh, 0), s30 = e30*t, sAll = eAll*t;
  const anual = l30.length ? e30/l30.length*365*t : 0;        // ahorro anual proyectado con el promedio de los últimos 30 días
  let pb = '–', sub = 'Cargá la inversión inicial para estimar el retorno';
  if (c > 0 && anual > 0) { const m = Math.round(c/anual*12); pb = `${Math.floor(m/12)} años ${m % 12} meses`; sub = `Recuperado hasta hoy: ${f1(Math.min(100, sAll/c*100))}%`; }
  return `<div class="grid"><div class="card kpi"><small>Ahorro últimos 30 días</small><b>${money(s30)}</b></div>
    <div class="card kpi"><small>Ahorro histórico acumulado</small><b>${money(sAll)}</b></div>
    <div class="card kpi"><small>Retorno de la inversión (payback)</small><b>${pb}</b><small>${sub}</small></div></div>
    <p class="mu" style="font-size:12px;margin:-4px 0 14px">Ahorro = energía generada × tarifa. El payback proyecta el promedio de los últimos 30 días a un año; no incluye estacionalidad, degradación ni cambios de tarifa.</p>`;
}

/* ---------- alertas por Telegram ---------- */
function toast(msg){
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 4500);
}
async function tgSend(p, text){
  if (!p || !p.tgToken || !p.tgChat) return false;
  const url = `https://api.telegram.org/bot${p.tgToken}/sendMessage`;   // el token se valida con regex al guardar la ficha
  try {
    const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:p.tgChat, text})});
    return (await r.json()).ok === true;
  } catch (e) {
    try { await fetch(`${url}?chat_id=${encodeURIComponent(p.tgChat)}&text=${encodeURIComponent(text)}`, {mode:'no-cors'}); return true; } catch (e2) { return false; }
  }
}
async function alertTg(text){
  const p = I(cur); if (!p || !p.tgToken || !p.tgChat) return;   // sin Telegram configurado no hace nada
  toast(await tgSend(p, text) ? '📲 Alerta enviada por Telegram' : 'No se pudo enviar la alerta a Telegram (revisá token y Chat ID)');
}
async function testTg(){
  const p = I(cur); if (!p || !p.tgToken || !p.tgChat) return alert('Completá token y Chat ID y guardá la ficha primero.');
  toast(await tgSend(p, `✅ SolarIA conectado al proyecto «${p.name}». Vas a recibir alertas de fallas y anomalías.`) ? '📲 Mensaje de prueba enviado' : 'No se pudo enviar (revisá token y Chat ID)');
}

/* ---------- predicción de generación (Open-Meteo, sin clave) ---------- */
const fcCache = {};
async function geocode(loc){
  const parts = loc.split(',').map(x => x.trim()).filter(Boolean); if (!parts.length) return null;
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=10&language=es&name=' + encodeURIComponent(parts[0]));
  if (!r.ok) throw new Error('El servicio de ubicaciones no respondió');
  const res = (await r.json()).results || [], rest = parts.slice(1).map(x => x.toLowerCase());
  const hit = res.find(x => rest.every(w => (x.admin1 || '').toLowerCase().includes(w) || (x.country || '').toLowerCase().includes(w))) || res[0];
  return hit ? {lat:hit.latitude, lon:hit.longitude, name:hit.name + ', ' + (hit.admin1 || hit.country)} : null;
}
async function forecastFor(ins){
  const key = ins.id + '|' + ins.loc, c = fcCache[key];
  if (c && Date.now() - c.t < 18e5) return c.v;
  const g = await geoFor(ins);
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&daily=shortwave_radiation_sum&forecast_days=3&timezone=auto`);
  if (!r.ok) throw new Error('Open-Meteo no respondió');
  const j = await r.json(), v = {place:g.name, days:j.daily.time.map((d,i) => ({date:d, mj:j.daily.shortwave_radiation_sum[i]}))};   // MJ/m² por día
  fcCache[key] = {t:Date.now(), v}; return v;
}
async function forecastCard(){
  const box = $('#fc'), ins = I(cur); if (!box || !ins) return;
  const head = '<h2>⛅ Proyección de generación para mañana</h2>', k = kwp(ins);
  if (!(k > 0)) return box.innerHTML = `<div class="card">${head}<p class="mu">Cargá los paneles del proyecto (pestaña Proyectos) para proyectar la generación.</p></div>`;
  box.innerHTML = `<div class="card">${head}<p class="mu">Consultando el pronóstico…</p></div>`;
  try {
    const f = await forecastFor(ins), a = analyze(cur), prv = a.pr || .8;                // PR mediano histórico (0,80 si aún no hay datos suficientes)
    if ($('#fc') !== box) return;                                                         // la persona cambió de pestaña mientras cargaba
    const est = d => d.mj / 3.6 * k * prv;                                                // MJ/m² → kWh/m² (horas sol pico) × kWp × PR
    const [, d1, d2] = f.days, last7 = rows(cur).slice(-7), avg7 = last7.length ? last7.reduce((s,g) => s + g.kwh, 0)/last7.length : null;
    const fecha = d => new Date(d.date + 'T12:00').toLocaleDateString('es-AR', {weekday:'long', day:'numeric', month:'short'});
    const e1 = est(d1), diff = avg7 ? (e1 - avg7)/avg7*100 : null;
    box.innerHTML = `<div class="card">${head}<div class="grid">
      <div class="kpi"><small>${esc(fecha(d1))}</small><b>${f1(e1)} kWh</b>${ins.tariff > 0 ? `<small>≈ ${money(e1*ins.tariff)} de ahorro</small>` : ''}</div>
      <div class="kpi"><small>Irradiancia pronosticada</small><b>${f1(d1.mj/3.6)} kWh/m²</b></div>
      ${diff != null ? `<div class="kpi"><small>vs. promedio últimos 7 días</small><b>${diff > 0 ? '+' : ''}${f1(diff)}%</b></div>` : ''}
      ${d2 ? `<div class="kpi"><small>Pasado mañana (${esc(fecha(d2))})</small><b>${f1(est(d2))} kWh</b></div>` : ''}</div>
      <small class="mu">Estimación = irradiancia pronosticada × ${f1(k)} kWp × PR ${f1(prv*100)}% ${a.pr ? '(mediana histórica)' : '(valor por defecto)'} · ${esc(f.place)} · Datos: Open-Meteo</small></div>`;
  } catch (e) {
    if ($('#fc') === box) box.innerHTML = `<div class="card">${head}<p class="mu">No se pudo obtener el pronóstico: ${esc(e.message)}</p></div>`;
  }
}

/* ---------- irradiancia automática (Open-Meteo: histórico + últimos 92 días, sin clave) ---------- */
const geoCache = {};
async function geoFor(ins){
  const k = ins.loc || '';
  if (!geoCache[k]) {
    const g = await geocode(k);
    if (!g) throw new Error('No se encontró la ubicación «' + k + '». Escribila como «Ciudad, Provincia» en la ficha.');
    geoCache[k] = g;
  }
  return geoCache[k];
}
// Devuelve {fecha: kWh/m²}. Fechas recientes: API de pronóstico con past_days; fechas viejas: API de archivo histórico (ERA5).
async function irrMap(ins, dates){
  const g = await geoFor(ins), lim = iso(new Date(Date.now() - 88*864e5)), m = {};
  const old = dates.filter(d => d < lim).sort(), rec = dates.filter(d => d >= lim);
  const get = async url => {
    const r = await fetch(url); if (!r.ok) throw new Error('Open-Meteo no respondió (' + r.status + ')');
    const j = await r.json(); (j.daily.time || []).forEach((d,i) => { const v = j.daily.shortwave_radiation_sum[i]; if (v != null) m[d] = +(v/3.6).toFixed(2); });   // MJ/m² → kWh/m²
  };
  const base = `latitude=${g.lat}&longitude=${g.lon}&daily=shortwave_radiation_sum&timezone=auto`;
  if (rec.length) await get(`https://api.open-meteo.com/v1/forecast?${base}&past_days=92&forecast_days=1`);
  if (old.length) await get(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${old[0]}&end_date=${old[old.length-1]}`);
  return m;
}
async function fillIrr(){
  const ins = I(cur); if (!ins) return;
  const miss = rows(cur).filter(g => !(g.irr > 0));
  if (!miss.length) return toast('Todos los días ya tienen irradiancia');
  toast('Consultando Open-Meteo…');
  try {
    const m = await irrMap(ins, miss.map(g => g.date));
    const up = miss.filter(g => m[g.date] != null).map(g => ({project_id:cur, date:g.date, kwh:g.kwh, pk:g.pk, irr:m[g.date]}));
    if (!up.length) return toast('Open-Meteo no devolvió datos para esas fechas');
    if (await run(sb.from('generation').upsert(up, {onConflict:'project_id,date'}))) toast(`☀️ Irradiancia completada en ${up.length} de ${miss.length} días`);
  } catch (e) { toast('No se pudo obtener la irradiancia: ' + e.message); }
}

/* ---------- arranque ---------- */
function render(){
  if (!user) {
    liveStop();
    $('#top').hidden = $('#nav').hidden = true;
    if (pending) {
      $('#app').innerHTML = `<div class="card auth"><h2>Confirmá tu email</h2><p>Te enviamos un código a <b>${esc(pending)}</b>.</p><div class="row"><label>Código<input id="cd" inputmode="numeric" autocomplete="one-time-code"></label><button class="pri" onclick="verify()">Confirmar</button></div><div class="row"><button onclick="resend()">Reenviar código</button><button onclick="cancelVerify()">Volver</button></div><div class="err" id="err"></div></div>`;
      return;
    }
    $('#app').innerHTML = `<div class="card auth"><h2>☀️ Ingresá a SolarIA</h2><div class="row"><label>Usuario (solo para crear cuenta)<input id="nm"></label><label>Email<input id="u" type="email"></label><label>Clave<input id="p" type="password"></label></div>
      <div class="row"><button class="pri" onclick="auth(false)">Ingresar</button><button onclick="auth(true)">Crear cuenta</button></div>
      <div class="row"><button onclick="enterLocal()">Probar en modo demostración (sin cuenta)</button></div><div class="err" id="err"></div>
      <p class="mu">Cada usuario ve solo sus propios proyectos. Los datos se guardan en Supabase. El modo demostración los guarda solo en este navegador.</p></div>`;
    return;
  }
  $('#top').hidden = $('#nav').hidden = false;
  $('#nav').innerHTML = TABS.map(([k,l]) => `<button class="${k == tab ? 'on' : ''}" onclick="tab='${k}';render()">${l}</button>`).join('');
  $('#app').innerHTML = V[tab]();
  if (tab === 'live') liveStart(); else liveStop();
  if (tab === 'panel' || tab === 'ia') forecastCard();
  drawCharts();
}
function boot(){
  if (user) {
    if (!I(cur)) cur = db.inst[0]?.id ?? null;
    $('#who').textContent = '👤 ' + (user.user_metadata?.username || user.email) + (localMode ? ' (modo local)' : '');
    $('#cur').innerHTML = db.inst.map(i => `<option value="${i.id}" ${i.id == cur ? 'selected' : ''}>${esc(i.name)}</option>`).join('') || '<option>(sin proyectos)</option>';
  }
  render();
}
$('#cur').onchange = e => { cur = e.target.value; render(); };
(async () => {
  if (ls.get('solaria_mode') === 'local') return enterLocal();
  if (!realSb) return boot();
  const {data} = await sb.auth.getSession();
  data.session ? await start(data.session.user) : boot();
})();