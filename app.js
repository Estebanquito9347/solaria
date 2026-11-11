/* SolarIA – lógica de la aplicación (sin librerías externas) */
const TABS = [['panel','Panel'],['proy','Proyectos'],['gen','Generación'],['cmp','Comparar'],['ev','Fallas y mant.'],['ia','Análisis IA'],['rep','Reportes']];
const USES = ['Vivienda','Industria / taller','Bombeo / riego','Comercio','Alumbrado','Otro'];
let tab = 'panel', cur = null, user = null, db = null, localMode = false;

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
const noopQuery = new Proxy({}, {get: () => (...args) => noopQuery});
const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY) || {from: () => noopQuery};
let pending = null;   // email que está esperando el código de confirmación
async function auth(reg){
  if (!sb.auth) return $('#err').textContent = 'La conexión con Supabase no está disponible. Podés usar el modo de demostración.';
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
async function start(u){ localMode = false; user = u; await loadAll(); boot(); }
function startDemo(){
  localMode = true; user = {email:'Demostración local'};
  db = ls.get('solaria-demo-data') || seed(); cur = db.inst[0]?.id ?? null;
  db.inst.forEach(i => i.panels.forEach(p => { if (!p.id) p.id = db.nid++; }));
  saveLocal(); boot();
}
async function logout(){ if (!localMode && sb.auth) await sb.auth.signOut(); user = db = cur = null; localMode = false; boot(); }
function saveLocal(){ if (localMode) ls.set('solaria-demo-data', db); }
function fail(error){ if (error) { alert('Error de base de datos: ' + error.message); return true; } return false; }
// Ejecuta una consulta, recarga los datos y vuelve a dibujar
async function run(q, after = render, local = null){
  if (localMode) { local?.(); saveLocal(); after(); return; }
  const {error} = await q; if (fail(error)) return; await loadAll(); after();
}
// Descarga las 4 tablas (RLS hace que solo lleguen las filas del usuario) y arma el objeto db
async function loadAll(){
  const T = ['projects','panels','generation','events'];
  const R = await Promise.all(T.map(t => sb.from(t).select('*').range(0, 9999)));
  const bad = R.find(r => r.error); if (bad) return fail(bad.error);
  const [p, pa, g, ev] = R.map(r => r.data);
  p.sort((a,b) => a.created_at < b.created_at ? -1 : 1);
  db = {
    inst: p.map(x => ({id:x.id, name:x.name, loc:x.location || '', date:x.start_date || '', use:x.use || 'Otro', useDetail:x.use_detail || '', inv:x.inverter || '', desc:x.description || '',
      panels: pa.filter(y => y.project_id == x.id).map(y => ({id:y.id, brand:y.brand || '', model:y.model || '', qty:y.qty, wp:+y.wp, type:y.type || '', eff:+y.eff}))})),
    gen: g.map(x => ({inst:x.project_id, date:x.date, kwh:+x.kwh, pk:+x.pk, irr:+x.irr})),
    ev:  ev.map(x => ({id:x.id, inst:x.project_id, date:x.date, type:x.type, desc:x.description || ''}))
  };
}

/* ---------- datos de ejemplo (simulados) ---------- */
function seed(){
  let s = 7; const r = () => (s = s*16807 % 2147483647) / 2147483647, t = new Date();
  let panelId = 1;
  const pan = (brand, model, qty, wp, type, eff) => ({id:panelId++, brand, model, qty, wp, type, eff});
  const inst = [
    {id:1, name:'Casa Arroyito', loc:'Arroyito, Córdoba', date:'2024-03-10', use:'Vivienda', useDetail:'Heladera, aire acondicionado, iluminación', inv:'Inversor on-grid 5 kW', desc:'Sistema residencial conectado a red para reducir el consumo del hogar.', panels:[pan('Jinko','Tiger Neo 450',12,450,'Monocristalino',22.5)]},
    {id:2, name:'Taller Industrial', loc:'San Francisco, Córdoba', date:'2023-09-01', use:'Industria / taller', useDetail:'Máquinas herramienta y compresor', inv:'Inversor trifásico 10 kW', desc:'Sector de cubierta del taller que cubre el consumo diurno.', panels:[pan('Canadian Solar','HiKu6 500',20,500,'Monocristalino',21.0)]}
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
function chart(labels, series, bar, flags){
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

/* ---------- IA: detección de anomalías y recomendaciones ---------- */
function analyze(id){
  const ins = I(id), R = rows(id), F = [], rec = new Set();
  if (!ins || R.length < 10) return {F, rec:[], pr:null};
  const k = kwp(ins), P = R.map(g => ({g, p:pr(g,k)})), valid = P.filter(x => x.p != null);
  const m = med(valid.map(x => x.p));
  const mad = Math.max(1.4826 * med(valid.map(x => Math.abs(x.p - m))), .04);   // desvío robusto
  for (const {g,p} of P) {
    if (g.irr >= 3 && g.kwh < .05*k) {
      F.push({s:'alta', d:g.date, t:`Generación nula con buena irradiancia (${g.irr} kWh/m²): posible falla total del inversor, corte de red o protección disparada.`});
      rec.add('Revisar estado del inversor, códigos de error y protecciones (termomagnética/diferencial).');
    } else if (p != null && p < m - 3*mad) {
      F.push({s: p < .6*m ? 'alta' : 'media', d:g.date, t:`PR ${f1(p*100)}% vs. típico ${f1(m*100)}%: rendimiento anormalmente bajo para la irradiancia registrada.`});
      rec.add('Inspeccionar sombras puntuales, conexiones y cadenas (strings) con rendimiento bajo.');
    }
  }
  const v = valid.map(x => x.p), rc = v.slice(-10), pv = v.slice(-40,-10);
  if (rc.length >= 7 && pv.length >= 15) {
    const dr = (rc.reduce((s,x) => s+x, 0)/rc.length - med(pv)) / med(pv) * 100;
    if (dr < -7) {
      F.push({s:'media', d:R[R.length-1].date, t:`Pérdida gradual: el PR de los últimos 10 días es ${f1(-dr)}% menor que el de las semanas previas.`});
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
  return {F, rec:[...rec], pr:m, health:Math.max(0, 100 - bad*4)};
}

/* ---------- vistas ---------- */
function fichaProyecto(i){
  return `<div class="card"><h2>Ficha del proyecto: ${esc(i.name)}</h2>
    <div class="row"><label>¿A qué alimenta?<select id="eu">${USES.map(u => `<option ${u == i.use ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <label>Detalle (equipos/cargas)<input id="ed2" value="${esc(i.useDetail)}"></label>
    <label>Inversor<input id="ei" value="${esc(i.inv)}"></label></div>
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
    <div class="card"><h2>Energía diaria (kWh) – últimos 30 días</h2>${chart(l30.map(g => g.date.slice(5)), [{n:'kWh', v:l30.map(g => g.kwh)}], 1, l30.map(g => dates.has(g.date)))}<small class="mu">Barras rojas: días anómalos según el análisis IA.</small></div>
    <div class="card"><h2>Potencia pico diaria (kW)</h2>${chart(l30.map(g => g.date.slice(5)), [{n:'kW', v:l30.map(g => g.pk)}])}</div>`;
  },
  proy(){
    return `<div class="card"><h2>Nuevo proyecto / sector de paneles</h2>
      <div class="row"><label>Nombre<input id="n"></label><label>Ubicación<input id="l"></label><label>Puesta en marcha<input id="d" type="date"></label>
      <label>¿A qué alimenta?<select id="us">${USES.map(u => `<option>${u}</option>`).join('')}</select></label></div>
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
      <label>Potencia pico (kW)<input id="gp" type="number" step="0.01" min="0"></label><label>Irradiancia (kWh/m²)<input id="gi" type="number" step="0.01" min="0"></label><button class="pri" onclick="addGen()">Guardar</button></div>
      <p class="mu">La irradiancia sale de una estación meteorológica o de servicios abiertos (Open-Meteo, NASA POWER). Sin ella no se puede calcular el rendimiento (PR).</p>
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
    return `<div class="card"><h2>🤖 Análisis inteligente – ${esc(ins.name)}</h2>
      <p class="mu">Método: se calcula el Performance Ratio diario (energía real ÷ energía teórica según kWp e irradiancia). Se toma la mediana y se marcan días que se desvían más de 3 desvíos robustos (MAD), generaciones nulas con sol y caídas sostenidas en los últimos 10 días.</p>
      <div class="row"><span>Salud estimada: <b>${a.health}/100</b></span><span>PR típico: <b>${f1(a.pr*100)}%</b></span><span>Alimenta: <b>${esc(ins.use)}</b></span></div>
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
  await run(sb.from('projects').insert({name:n, location:$('#l').value, start_date:$('#d').value || null, use:$('#us').value, description:$('#ds').value}),
    () => { cur = db.inst[db.inst.length-1].id; boot(); },
    () => db.inst.push({id:db.nid++, name:n, loc:$('#l').value, date:$('#d').value, use:$('#us').value, useDetail:'', inv:'', desc:$('#ds').value, panels:[]}));
}
const saveProj = () => run(sb.from('projects').update({use:$('#eu').value, use_detail:$('#ed2').value, inverter:$('#ei').value, description:$('#eds').value}).eq('id', cur), render,
  () => Object.assign(I(cur), {use:$('#eu').value, useDetail:$('#ed2').value, inv:$('#ei').value, desc:$('#eds').value}));
async function delProj(){
  if (!confirm('¿Eliminar el proyecto y todos sus datos?')) return;
  await run(sb.from('projects').delete().eq('id', cur), () => { cur = null; boot(); }, () => {
    db.inst = db.inst.filter(i => i.id != cur); db.gen = db.gen.filter(g => g.inst != cur); db.ev = db.ev.filter(e => e.inst != cur);
  });
}
async function addPanel(){
  const q = +$('#pq').value, w = +$('#pw').value;
  if (!(q > 0 && w > 0)) return alert('Completá cantidad y potencia (Wp).');
  await run(sb.from('panels').insert({project_id:cur, brand:$('#pb').value, model:$('#pm').value, qty:q, wp:w, type:$('#pt').value, eff:+$('#pe').value || 0}), render,
    () => I(cur).panels.push({id:db.nid++, brand:$('#pb').value, model:$('#pm').value, qty:q, wp:w, type:$('#pt').value, eff:+$('#pe').value || 0}));
}
const delPanel = id => run(sb.from('panels').delete().eq('id', id), render, () => { I(cur).panels = I(cur).panels.filter(p => p.id != id); });
async function addGen(){
  const d = $('#gd').value;
  if (!cur || !d || $('#gk').value === '') return alert('Falta la fecha o la energía.');
  const g = {inst:cur, date:d, kwh:+$('#gk').value, pk:+$('#gp').value || 0, irr:+$('#gi').value || 0};
  await run(sb.from('generation').upsert({project_id:cur, date:d, kwh:g.kwh, pk:g.pk, irr:g.irr}, {onConflict:'project_id,date'}), render,
    () => { const old = db.gen.findIndex(x => x.inst == cur && x.date == d); if (old < 0) db.gen.push(g); else db.gen[old] = g; });
}
const delGen = d => run(sb.from('generation').delete().eq('project_id', cur).eq('date', d), render, () => { db.gen = db.gen.filter(g => !(g.inst == cur && g.date == d)); });
async function addEv(){
  const s = $('#edsc').value.trim(); if (!cur || !s) return;
  await run(sb.from('events').insert({project_id:cur, date:$('#ed').value, type:$('#et').value, description:s}), render,
    () => db.ev.push({id:db.nid++, inst:cur, date:$('#ed').value, type:$('#et').value, desc:s}));
}
const delEv = id => run(sb.from('events').delete().eq('id', id), render, () => { db.ev = db.ev.filter(e => e.id != id); });
async function demo(){
  if (db.inst.length && !confirm('Se agregarán 2 proyectos de ejemplo a tu cuenta. ¿Continuar?')) return;
  const s = seed();
  if (localMode) {
    const map = {};
    s.inst.forEach(i => {
      map[i.id] = db.nid++;
      db.inst.push({...i, id:map[i.id], panels:i.panels.map(p => ({...p, id:db.nid++}))});
    });
    db.gen.push(...s.gen.map(g => ({...g, inst:map[g.inst]})));
    db.ev.push(...s.ev.map(e => ({...e, id:db.nid++, inst:map[e.inst]})));
    cur = map[s.inst[0].id]; saveLocal(); boot(); return;
  }
  const {data:P, error} = await sb.from('projects').insert(s.inst.map(i => ({name:i.name, location:i.loc, start_date:i.date, use:i.use, use_detail:i.useDetail, inverter:i.inv, description:i.desc}))).select();
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
  await run(sb.from('projects').delete().not('id','is',null), () => { cur = null; boot(); }, () => { db = {inst:[], gen:[], ev:[], nid:1}; });
}
function cmpM(){
  const A = $('#ma').value, B = $('#mb').value, R = rows(cur), g = m => R.filter(x => x.date.startsWith(m));
  const a = g(A), b = g(B), s = x => x.reduce((t,y) => t + y.kwh, 0), ta = s(a), tb = s(b), L = Math.max(a.length, b.length), dl = ta ? (tb-ta)/ta*100 : 0;
  $('#rm').innerHTML = `<p>${A}: <b>${f1(ta)} kWh</b> (prom. ${f1(ta/(a.length||1))}/día) · ${B}: <b>${f1(tb)} kWh</b> (prom. ${f1(tb/(b.length||1))}/día) · Diferencia: <b>${dl > 0 ? '+' : ''}${f1(dl)}%</b></p>`
    + chart(Array.from({length:L}, (_,i) => i+1), [{n:A, v:a.map(x => x.kwh)}, {n:B, v:b.map(x => x.kwh)}]);
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
}

/* ---------- arranque ---------- */
function render(){
  if (!user) {
    $('#top').hidden = $('#nav').hidden = true;
    if (pending) {
      $('#app').innerHTML = `<div class="card auth"><h2>Confirmá tu email</h2><p>Te enviamos un código a <b>${esc(pending)}</b>.</p><div class="row"><label>Código<input id="cd" inputmode="numeric" autocomplete="one-time-code"></label><button class="pri" onclick="verify()">Confirmar</button></div><div class="row"><button onclick="resend()">Reenviar código</button><button onclick="cancelVerify()">Volver</button></div><div class="err" id="err"></div></div>`;
      return;
    }
    $('#app').innerHTML = `<div class="card auth"><h2>☀️ Ingresá a SolarIA</h2><div class="row"><label>Usuario (solo para crear cuenta)<input id="nm"></label><label>Email<input id="u" type="email"></label><label>Clave<input id="p" type="password"></label></div>
      <div class="row"><button class="pri" onclick="auth(false)">Ingresar</button><button onclick="auth(true)">Crear cuenta</button><button onclick="startDemo()">Probar con datos de ejemplo</button></div><div class="err" id="err"></div>
      <p class="mu">Cada usuario ve solo sus propios proyectos. Los datos se guardan en Supabase.</p></div>`;
    return;
  }
  $('#top').hidden = $('#nav').hidden = false;
  $('#nav').innerHTML = TABS.map(([k,l]) => `<button class="${k == tab ? 'on' : ''}" onclick="tab='${k}';render()">${l}</button>`).join('');
  $('#app').innerHTML = V[tab]();
}
function boot(){
  if (user) {
    if (!I(cur)) cur = db.inst[0]?.id ?? null;
    $('#who').textContent = '👤 ' + (user.user_metadata?.username || user.email);
    $('#cur').innerHTML = db.inst.map(i => `<option value="${i.id}" ${i.id == cur ? 'selected' : ''}>${esc(i.name)}</option>`).join('') || '<option>(sin proyectos)</option>';
  }
  render();
}
$('#cur').onchange = e => { cur = e.target.value; render(); };
(async () => { if (!sb.auth) return boot(); const {data} = await sb.auth.getSession(); data.session ? await start(data.session.user) : boot(); })();