/* SolarIA – lógica de la aplicación (sin librerías externas) */
const TABS = [['panel','Panel'],['live','En vivo'],['clima','Clima'],['proy','Proyectos'],['gen','Generación'],['cmp','Comparar'],['ev','Fallas y mant.'],['ia','Análisis IA'],['chat','Asistente'],['rep','Reportes']];
const USES = ['Vivienda','Industria / taller','Bombeo / riego','Comercio','Alumbrado','Otro'];
let tab = 'panel', cur = null, user = null, db = null;
const locationMaps = new Map();

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
let recoveryMode = false, forgotPasswordMode = false, resetEmail = '', resetMessage = '', authNotice = '';
if (realSb) realSb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    localMode = false;
    sb = realSb;
    ls.set('solaria_mode', null);
    recoveryMode = true;
    forgotPasswordMode = false;
    user = session && session.user || null;
    render();
  }
});
const authHash = new URLSearchParams(location.hash.slice(1));
if (authHash.get('type') === 'recovery') recoveryMode = true;
if (authHash.has('error_description')) {
  authNotice = 'El enlace no es válido o venció. Solicitá uno nuevo para recuperar la contraseña.';
  forgotPasswordMode = true;
  if (/^https?:$/.test(location.protocol)) history.replaceState(null, '', location.pathname + location.search);
}
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
function showForgotPassword(){
  resetEmail = $('#u') ? $('#u').value.trim() : '';
  resetMessage = '';
  forgotPasswordMode = true;
  render();
}
function backToLogin(){
  forgotPasswordMode = false;
  resetMessage = '';
  render();
}
async function sendPasswordReset(){
  const email = $('#resetEmail').value.trim(), err = $('#err');
  if (!email) return err.textContent = 'Ingresá el email asociado a tu cuenta.';
  if (!realSb) return err.textContent = 'Supabase no está configurado. No se puede enviar el enlace.';
  resetEmail = email;
  const button = $('#sendReset');
  button.disabled = true;
  err.textContent = '';
  try {
    const options = /^https?:$/.test(location.protocol) ? {redirectTo:location.origin + location.pathname} : {};
    const {error} = await sb.auth.resetPasswordForEmail(email, options);
    if (error) return err.textContent = error.message;
    resetMessage = 'Si el email está asociado a una cuenta, recibirás un enlace para cambiar la contraseña. Revisá también el correo no deseado.';
    render();
  } catch (error) {
    err.textContent = 'No se pudo enviar el enlace: ' + error.message;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
async function saveNewPassword(){
  const password = $('#newPass').value, confirmation = $('#confirmPass').value, err = $('#err');
  if (password.length < 6) return err.textContent = 'La contraseña debe tener al menos 6 caracteres.';
  if (password !== confirmation) return err.textContent = 'Las contraseñas no coinciden.';
  if (!realSb) return err.textContent = 'Supabase no está disponible para actualizar la contraseña.';
  const button = $('#savePassword');
  button.disabled = true;
  err.textContent = '';
  try {
    const {data, error} = await sb.auth.updateUser({password});
    if (error) return err.textContent = error.message;
    if (!data.user) return err.textContent = 'No se pudo validar la sesión de recuperación. Solicitá un enlace nuevo.';
    recoveryMode = false;
    resetMessage = '';
    await start(data.user);
    toast('Contraseña actualizada correctamente.');
  } catch (error) {
    err.textContent = 'No se pudo actualizar la contraseña: ' + error.message;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
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
    inst: p.map(x => ({id:x.id, name:x.name, loc:x.location || '', date:x.start_date || '', use:x.use || 'Otro', useDetail:x.use_detail || '', inv:x.inverter || '', desc:x.description || '', tariff:+x.tariff || 0, cost:+x.investment || 0, tgToken:x.tg_token || '', tgChat:x.tg_chat_id || '', lat:x.latitude == null ? null : +x.latitude, lon:x.longitude == null ? null : +x.longitude,
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
  if (!ins) return {F, rec:[], pr:null, n:0, learned:false};
  const nv = R.filter(g => g.irr > .5).length;                         // días utilizables (con generación e irradiancia)
  if (!(kwp(ins) > 0) || !nv) return {F, rec:[], pr:null, n:nv, learned:false, noPanels:!(kwp(ins) > 0)};
  // Arranque en frío: con menos de 10 días se compara contra una referencia teórica (PR 80%); desde 10 días se aprende el modelo propio
  const k = kwp(ins), learned = nv >= 10, md = learned ? fitModel(R) : {a:0, b:k*.8}, ex = g => Math.max(md.a + md.b*g.irr, .1);
  const P = R.map(g => ({g, p: g.irr > .5 ? g.kwh/ex(g) : null})), valid = P.filter(x => x.p != null);   // p = real ÷ esperado
  const m = learned ? med(valid.map(x => x.p)) : 1;
  const mad = learned ? Math.max(1.4826 * med(valid.map(x => Math.abs(x.p - m))), .04) : .1;   // desvío robusto (o umbral fijo en modo referencia)
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
  return {F, rec:[...rec], pr:med(prs), ex, n:nv, learned, health:Math.max(0, 100 - bad*4)};
}

/* ---------- vistas ---------- */
function fichaProyecto(i){
  return `<div class="card"><h2>Ficha del proyecto: ${esc(i.name)}</h2>
    <div class="row"><label>¿A qué alimenta?<select id="eu">${USES.map(u => `<option ${u == i.use ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <label>Detalle (equipos/cargas)<input id="ed2" value="${esc(i.useDetail)}"></label>
    <label>Inversor<input id="ei" value="${esc(i.inv)}"></label></div>
    <label>Ubicación del proyecto — hacé clic en el mapa o arrastrá el marcador</label>
    <div id="editMap" role="application" aria-label="Mapa para seleccionar la ubicación del proyecto"></div>
    <input id="editLat" type="hidden" value="${i.lat ?? ''}"><input id="editLon" type="hidden" value="${i.lon ?? ''}">
    <small id="editLocationStatus" class="mu" role="status" aria-live="polite">${i.lat != null ? 'Coordenadas guardadas: ' + i.lat + ', ' + i.lon : 'Seleccioná un punto en el mapa o buscá una ubicación.'}</small>
    <div class="row"><label>Ciudad, provincia o dirección<input id="eloc" value="${esc(i.loc)}" placeholder="Arroyito, Córdoba, Argentina" onkeydown="if(event.key==='Enter'){event.preventDefault();searchLocation('edit')}"></label>
    <button id="editLocationSearch" onclick="searchLocation('edit')">Buscar en el mapa</button><button onclick="detectLoc()">📍 Usar mi ubicación (GPS)</button></div>
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
  clima(){ return '<div id="wx" class="mu">Consultando el clima…</div>'; },
  chat(){
    if (!chatLog.length) chatLog.push({r:'b', src:'local', t:`Hola 👋 Soy el asistente de SolarIA. Respondo con los datos reales de tu proyecto${I(cur) ? ' «' + I(cur).name + '»' : ''}. Si algo todavía no lo entiendo, te lo voy a decir. Probá con una de las preguntas de abajo.`});
    return `<div class="card"><h2>💬 Preguntale a SolarIA</h2><div id="chatlog">${chatHTML()}</div>
      <div class="row" style="margin-top:8px">${CHIPS.map(c => `<button onclick="sendChat('${c}')">${c}</button>`).join('')}</div>
      <div class="row"><input id="chatq" style="flex:1;min-width:200px" placeholder="Escribí tu pregunta…" onkeydown="if(event.key==='Enter')sendChat()"><button class="pri" onclick="sendChat()">Enviar</button></div></div>`;
  },
  panel(){
    const ins = I(cur);
    if (!ins) return '<div class="card">Todavía no tenés proyectos. Andá a <b>Proyectos</b> para crear uno (o cargá datos de ejemplo en <b>Generación</b>).</div>';
    const R = rows(cur), l30 = R.slice(-30), tot = l30.reduce((s,g) => s+g.kwh, 0), a = analyze(cur);
    const an = a.F.filter(f => f.s != 'info'), dates = new Set(an.map(f => f.d));
    return `${setupCard(ins, R)}<section class="dashboard-hero">
      <div><span class="eyebrow">RESUMEN DE INSTALACIÓN</span><h2>${esc(ins.name)}</h2>
      <p>${esc(ins.loc || 'Ubicación sin definir')} <span aria-hidden="true">·</span> ${esc(ins.use)}</p></div>
      <div class="hero-status"><span class="status-dot"></span> Proyecto activo</div>
    </section>
    <div class="grid"><div class="card kpi"><small>Potencia instalada</small><b>${f1(kwp(ins))} kWp</b></div>
    <div class="card kpi"><small>Energía últimos 30 días</small><b>${f1(tot)} kWh</b></div>
    <div class="card kpi"><small>Promedio diario</small><b>${f1(tot/(l30.length||1))} kWh</b></div>
    <div class="card kpi"><small>PR típico</small><b>${a.pr ? f1(a.pr*100)+'%' : '–'}</b></div>
    <div class="card kpi"><small>Alertas detectadas</small><b>${an.length}</b></div>
    <div class="card kpi"><small>Salud estimada</small><b>${a.health ?? '–'}/100</b></div></div>
    ${econ(ins, R, l30)}
    <div id="fc"></div>
    <div class="card chart-card"><div class="section-heading"><div><span class="eyebrow">PRODUCCIÓN</span><h2>Energía diaria</h2></div><span class="unit-chip">kWh · 30 días</span></div>${chart(l30.map(g => g.date.slice(5)), [{n:'kWh', v:l30.map(g => g.kwh)}], 1, l30.map(g => dates.has(g.date)))}<small class="mu">Barras rojas: días anómalos según el análisis IA.</small></div>
    <div class="card chart-card"><div class="section-heading"><div><span class="eyebrow">RENDIMIENTO</span><h2>Potencia pico diaria</h2></div><span class="unit-chip">kW</span></div>${chart(l30.map(g => g.date.slice(5)), [{n:'kW', v:l30.map(g => g.pk)}])}</div>`;
  },
  proy(){
    return `<div class="card"><h2>Nuevo proyecto / sector de paneles</h2>
      <div class="row"><label>Nombre<input id="n"></label><label>Puesta en marcha<input id="d" type="date"></label>
      <label>¿A qué alimenta?<select id="us">${USES.map(u => `<option>${u}</option>`).join('')}</select></label></div>
      <label>Elegí la ubicación del proyecto en el mapa</label>
      <div id="newMap" role="application" aria-label="Mapa para elegir la ubicación del proyecto"></div>
      <input id="newLat" type="hidden"><input id="newLon" type="hidden">
      <small id="newLocationStatus" class="mu" role="status" aria-live="polite">Hacé clic en el mapa o buscá una ubicación; después podés ajustar el marcador.</small>
      <div class="row"><label>Ciudad, provincia o dirección<input id="l" placeholder="Arroyito, Córdoba, Argentina" onkeydown="if(event.key==='Enter'){event.preventDefault();searchLocation('new')}"></label>
      <button id="newLocationSearch" onclick="searchLocation('new')">Buscar en el mapa</button></div>
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
    return `<div class="card"><h2>¿Cómo ingresan los datos a SolarIA?</h2>
      <p class="mu">SolarIA no puede detectar tu instalación por sí sola: necesita que le cuentes qué tenés (la ficha del proyecto) y cuánto genera. Hay tres caminos:</p>
      <ol><li><b>Manual:</b> cargá un día por vez en el formulario de más abajo.</li><li><b>CSV del inversor:</b> casi todos los inversores exportan un historial; subilo acá.</li><li><b>Automático:</b> un dispositivo (ESP32 o el inversor con su API) envía lecturas solo. Ver la pestaña <b>En vivo</b>.</li></ol>
      <div class="row"><label>Importar CSV<input id="csvf" type="file" accept=".csv,text/csv"></label><button class="pri" onclick="importCSV()">Importar</button><a download="plantilla_solaria.csv" href="data:text/csv;charset=utf-8,fecha%2Ckwh%2Ckw_pico%2Cirradiancia%0A2026-11-01%2C21.4%2C3.9%2C6.1%0A2026-11-02%2C19.8%2C3.6%2C5.7">Descargar plantilla</a></div>
      <small class="mu">Columnas: fecha (AAAA-MM-DD o DD/MM/AAAA) y kWh; opcionales: kW pico e irradiancia. Si falta la irradiancia, se completa sola desde Open-Meteo.</small></div>
    <div class="card"><h2>Cargar datos de generación</h2>
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
    if (a.pr == null) return `<div id="fc"></div><div class="card"><h2>🤖 Análisis inteligente</h2><p>${a.noPanels ? 'Cargá los paneles del proyecto (Proyectos → Abrir ficha) para que pueda calcular cuánto debería producir.' : 'Necesito al menos 1 día con generación e irradiancia. Cargá datos en Generación o usá «Completar irradiancia faltante».'}</p></div>`;
    return `<div id="fc"></div><div class="card"><h2>🤖 Análisis inteligente – ${esc(ins.name)}</h2>
      <p class="mu">Método: con menos de 10 días con irradiancia, SolarIA compara contra una referencia teórica (energía = kWp × irradiancia × 0,80), así que ya puede avisarte de caídas fuertes desde el primer día. Con 10 días o más aprende un modelo propio de esta instalación (regresión robusta: energía esperada = a + b × irradiancia, descartando días atípicos) y usa su variabilidad real (MAD). ¿Por qué 10? Con menos puntos no se pueden estimar con confianza ni la recta ni la variabilidad normal. Además detecta generación nula con sol y caídas sostenidas.</p><p class="mu"><progress value="${Math.min(a.n,10)}" max="10" style="width:100%"></progress><br>Entrenamiento del modelo: <b>${Math.min(a.n,10)}/10</b> días con irradiancia · modo <b>${a.learned ? 'aprendido' : 'referencia'}</b></p>
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
  const point = selectedMapPoint('newLat', 'newLon');
  if (!point) return alert('Seleccioná la ubicación del proyecto en el mapa.');
  const location = $('#l').value.trim() || `${point.latitude}, ${point.longitude}`;
  await run(sb.from('projects').insert({name:n, location, latitude:point.latitude, longitude:point.longitude, start_date:$('#d').value || null, use:$('#us').value, description:$('#ds').value, tariff:+$('#tf').value || 0, investment:+$('#ct').value || 0}),
    () => { cur = db.inst[db.inst.length-1].id; boot(); });
}
async function saveProj(){
  const tk = $('#etk').value.trim(), ch = $('#ech').value.trim();
  if (tk && !/^\d+:[\w-]+$/.test(tk)) return alert('El token del bot no tiene el formato esperado (ej. 123456789:ABC...).');
  if (ch && !/^-?\d+$/.test(ch)) return alert('El Chat ID debe ser un número (puede empezar con -).');
  const point = selectedMapPoint('editLat', 'editLon');
  if (!point) return alert('Seleccioná la ubicación del proyecto en el mapa.');
  const location = $('#eloc').value.trim() || `${point.latitude}, ${point.longitude}`;
  await run(sb.from('projects').update({location, latitude:point.latitude, longitude:point.longitude, use:$('#eu').value, use_detail:$('#ed2').value, inverter:$('#ei').value, description:$('#eds').value,
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
let pendingDeviceKey = null;
const sim = {key:'', power:'1.8', energy:'12.45', auto:false, timer:null, sending:false, controller:null, requestId:0, message:'', messageType:''};
function liveStop(){
  if (lv.ch) { sb.removeChannel(lv.ch); lv.ch = null; }
  clearInterval(lv.t);
  clearInterval(sim.timer);
  sim.timer = null;
  sim.auto = false;
  pendingDeviceKey = null;
  sim.key = '';
  sim.requestId++;
  if (sim.controller) sim.controller.abort();
  sim.controller = null;
  sim.sending = false;
}
function deviceKeyCard(){
  if (!pendingDeviceKey) return '';
  return `<div class="card device-key-card"><h2>Guardá la clave del dispositivo</h2>
    <p>Se muestra solo ahora. Copiala y guardala en el ESP32; después no se puede volver a consultar.</p>
    <code class="device-key-value">${esc(pendingDeviceKey)}</code>
    <div class="row"><button class="pri" onclick="copyDeviceKey()">Copiar clave</button><button onclick="dismissDeviceKey()">Ya la guardé</button></div></div>`;
}
function simulatorCard(){
  return `<div class="card"><h2>Probar envío de lecturas</h2>
    <p class="mu">Simula un ESP32 usando la clave del dispositivo. Los datos se enviarán a Supabase y aparecerán en este panel.</p>
    <div class="row"><label>Clave individual del dispositivo<input id="simKey" type="password" autocomplete="off" spellcheck="false" placeholder="Pegá la clave que copiaste" value="${esc(sim.key)}" oninput="sim.key=this.value"></label></div>
    <div class="row"><label>Potencia (kW)<input id="simPower" type="number" min="0" max="100000" step="0.01" value="${esc(sim.power)}" oninput="sim.power=this.value"></label>
    <label>Energía acumulada hoy (kWh)<input id="simEnergy" type="number" min="0" max="1000000000" step="0.01" value="${esc(sim.energy)}" oninput="sim.energy=this.value"></label>
    <button class="pri" onclick="sendSimReading()">Enviar lectura ahora</button></div>
    <label class="sim-switch"><input id="simAuto" type="checkbox" ${sim.auto ? 'checked' : ''} onchange="setSimAuto(this.checked)"> Envío automático cada 10 segundos</label>
    <small id="simStatus" class="sim-status ${esc(sim.messageType)}" role="status" aria-live="polite">${esc(sim.message || 'La simulación usa la clave pública anon del proyecto y la clave individual pegada arriba.')}</small></div>`;
}
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
    sb.from('devices').select('id,name,last_seen,created_at').eq('project_id', cur).order('created_at')]);
  const box = $('#live'); if (!box) return;
  if (r.error || d.error) return box.innerHTML = `${deviceKeyCard()}<div class="card">Error: ${esc((r.error || d.error).message)}. ¿Ejecutaste schema_live.sql?</div>`;
  const L = r.data[0], age = L ? (Date.now() - new Date(L.ts))/6e4 : null, h = new Date().getHours(), clockDay = h >= 7 && h < 19;
  const sun = L && L.irr_wm2 != null ? L.irr_wm2 > 200 : clockDay;
  let st;
  if (!d.data.length) st = ['⚪','Sin dispositivo vinculado','Creá un dispositivo abajo y usá su clave en el simulador o en el ESP32.'];
  else if (!L) st = ['⚪','Esperando datos','El dispositivo todavía no envió lecturas.'];
  else if (age > 10) st = (sun || clockDay) ? ['🔴','Sin comunicación',`Último dato hace ${Math.round(age)} min en horario de sol. Revisar WiFi, alimentación del dispositivo o internet.`] : ['⚪','Reposo nocturno','Sin datos recientes; es normal de noche.'];
  else if (L.power_kw > 0.05) st = ['🟢','Generando','La instalación está produciendo con normalidad.'];
  else st = sun ? ['🟡','Sin producción con sol','Hay irradiancia pero la potencia es nula: posible falla del inversor, protección disparada o corte de red.'] : ['⚪','Sin producción','No hay sol suficiente en este momento.'];
  const pts = r.data.slice().reverse(), step = Math.ceil(pts.length/150) || 1, S = pts.filter((_,i) => i % step == 0);
  box.innerHTML = `${deviceKeyCard()}${simulatorCard()}
    <div class="card"><h2 style="font-size:22px">${st[0]} ${st[1]}</h2><p>${st[2]}</p><small class="mu">${L ? 'Último dato: ' + new Date(L.ts).toLocaleString() : ''}</small></div>
    ${L ? `<div class="grid"><div class="card kpi"><small>Potencia actual</small><b>${f1(L.power_kw)} kW</b></div><div class="card kpi"><small>Energía de hoy</small><b>${L.energy_kwh != null ? f1(L.energy_kwh) + ' kWh' : '–'}</b></div><div class="card kpi"><small>Irradiancia</small><b>${L.irr_wm2 != null ? Math.round(L.irr_wm2) + ' W/m²' : '–'}</b></div></div>
    <div class="card"><h2>Potencia (kW) – últimas 24 h</h2>${chart(S.map(x => new Date(x.ts).toTimeString().slice(0,5)), [{n:'kW', v:S.map(x => +x.power_kw)}])}</div>` : ''}
    <div class="card sc"><h2>Dispositivos vinculados</h2><table><tr><th>Nombre</th><th>Último contacto</th><th></th></tr>
    ${d.data.map(x => `<tr><td>${esc(x.name)}</td><td>${x.last_seen ? new Date(x.last_seen).toLocaleString() : '–'}</td><td><button onclick="delDevice('${x.id}')">Eliminar</button></td></tr>`).join('') || '<tr><td colspan="3" class="mu">Ninguno todavía.</td></tr>'}</table>
    <div class="row" style="margin-top:8px"><button class="pri" onclick="addDevice()">Crear dispositivo para este proyecto</button></div>
    <p class="mu">Los dispositivos envían sus lecturas a <code>${esc(SUPABASE_URL)}/rest/v1/rpc/ingest_reading</code> con su clave. Consultá <b>README.md</b> para la configuración del endpoint y el formato de los datos.</p></div>`;
  drawCharts();
}
function setSimStatus(message, type){
  sim.message = message;
  sim.messageType = type || '';
  const status = $('#simStatus');
  if (status) {
    status.textContent = message;
    status.className = `sim-status ${sim.messageType}`;
  }
}
function simReadingInput(){
  const key = $('#simKey').value.trim(), powerText = $('#simPower').value, energyText = $('#simEnergy').value;
  const power = Number(powerText), energy = Number(energyText);
  sim.key = key;
  sim.power = powerText;
  sim.energy = energyText;
  if (!/^[0-9a-f]{64}$/.test(key)) {
    setSimStatus('Pegá una clave válida de 64 caracteres hexadecimales.', 'error');
    return null;
  }
  if (powerText === '' || !Number.isFinite(power) || power < 0 || power > 100000) {
    setSimStatus('Ingresá una potencia válida entre 0 y 100000 kW.', 'error');
    return null;
  }
  if (energyText === '' || !Number.isFinite(energy) || energy < 0 || energy > 1000000000) {
    setSimStatus('Ingresá una energía válida entre 0 y 1000000000 kWh.', 'error');
    return null;
  }
  return {key, power, energy};
}
async function sendSimReading(){
  if (sim.sending) return;
  const payload = simReadingInput();
  if (!payload) {
    if (sim.auto) {
      clearInterval(sim.timer);
      sim.timer = null;
      sim.auto = false;
      const checkbox = $('#simAuto');
      if (checkbox) checkbox.checked = false;
    }
    return;
  }

  sim.sending = true;
  const requestId = ++sim.requestId, controller = new AbortController();
  sim.controller = controller;
  const sendButton = $('#simStatus') && $('#simStatus').parentElement.querySelector('button.pri');
  if (sendButton) sendButton.disabled = true;
  setSimStatus('Enviando lectura a Supabase…');
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_reading`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        apikey:SUPABASE_KEY,
        Authorization:`Bearer ${SUPABASE_KEY}`
      },
      body:JSON.stringify({
        p_device_key:payload.key,
        p_power_kw:payload.power,
        p_energy_kwh:payload.energy,
        p_ts:new Date().toISOString()
      }),
      signal:controller.signal
    });
    let result = null;
    const responseText = await response.text();
    if (responseText) {
      try { result = JSON.parse(responseText); }
      catch (error) {
        if (response.ok) throw new Error('Supabase devolvió una respuesta inválida.');
      }
    }
    if (!response.ok || !result || result.ok !== true) {
      const detail = result && (result.message || result.error);
      throw new Error(detail || `Supabase no confirmó la lectura (HTTP ${response.status}).`);
    }
    if (requestId !== sim.requestId) return;
    setSimStatus(`Lectura enviada correctamente (${new Date().toLocaleTimeString()})${sim.auto ? '. Envío automático activo.' : '.'}`, 'success');
    await liveLoad();
  } catch (error) {
    if (requestId === sim.requestId) setSimStatus(`No se pudo enviar la lectura: ${error.message}`, 'error');
  } finally {
    if (requestId === sim.requestId) {
      sim.sending = false;
      sim.controller = null;
      const button = $('#simStatus') && $('#simStatus').parentElement.querySelector('button.pri');
      if (button) button.disabled = false;
    }
  }
}
function setSimAuto(enabled){
  clearInterval(sim.timer);
  sim.timer = null;
  sim.auto = !!enabled;
  const checkbox = $('#simAuto');
  if (checkbox) checkbox.checked = sim.auto;
  if (!sim.auto) {
    setSimStatus('Envío automático detenido.');
    return;
  }
  if (!simReadingInput()) {
    sim.auto = false;
    if (checkbox) checkbox.checked = false;
    return;
  }
  setSimStatus('Envío automático activo: se enviará una lectura ahora y luego cada 10 segundos.');
  sendSimReading();
  sim.timer = setInterval(sendSimReading, 10000);
}
async function addDevice(){
  const {data, error} = await sb.rpc('create_device', {p_project_id:cur, p_name:'Dispositivo'});
  if (fail(error)) return;
  if (!data || typeof data.device_key !== 'string') return alert('Supabase creó el dispositivo, pero no devolvió su clave. Revisá la función create_device.');
  pendingDeviceKey = data.device_key;
  await liveLoad();
}
async function copyDeviceKey(){
  if (!pendingDeviceKey) return;
  try {
    await navigator.clipboard.writeText(pendingDeviceKey);
    toast('Clave copiada. Guardala en un lugar seguro.');
  } catch (error) {
    alert('No se pudo copiar automáticamente. Seleccioná la clave y copiala manualmente.');
  }
}
function dismissDeviceKey(){
  pendingDeviceKey = null;
  liveLoad();
}
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
  const hit = rest.length
    ? res.find(x => rest.every(w => (x.admin1 || '').toLowerCase().includes(w) || (x.country || '').toLowerCase().includes(w)))
    : res[0];
  return hit ? {lat:hit.latitude, lon:hit.longitude, name:[hit.name, hit.admin1, hit.country].filter(Boolean).join(', ')} : null;
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
  if (ins.lat != null && ins.lon != null) return {lat:ins.lat, lon:ins.lon, name:ins.loc || 'ubicación del proyecto (GPS)'};   // coordenadas exactas del proyecto
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

/* ---------- primeros pasos ---------- */
function setupCard(ins, R){
  const steps = [
    ['Paneles cargados', ins.panels.length > 0, 'proy', 'Cargar paneles'],
    ['Ubicación definida', !!(ins.loc || ins.lat != null), 'proy', 'Definir ubicación'],
    ['Datos de generación', R.length > 0, 'gen', 'Cargar datos'],
    ['Tarifa e inversión', ins.tariff > 0 && ins.cost > 0, 'proy', 'Completar ficha']];
  if (steps.every(x => x[1])) return '';
  return `<div class="card"><h2>🚀 Primeros pasos</h2>${steps.map(x => `<p>${x[1] ? '✅' : '⬜'} ${x[0]} ${x[1] ? '' : `<button onclick="tab='${x[2]}';render()">${x[3]}</button>`}</p>`).join('')}
    <small class="mu">SolarIA no detecta la instalación por sí sola: necesita la ficha (paneles y ubicación) y los datos de generación, cargados a mano, por CSV del inversor o con un dispositivo en vivo.</small></div>`;
}
function detectLoc(){
  if (!navigator.geolocation) return alert('Tu navegador no permite la geolocalización.');
  navigator.geolocation.getCurrentPosition(async pos => {
    // se redondea a 2 decimales (~1 km): alcanza para el clima y no guarda la dirección exacta
    if (await run(sb.from('projects').update({latitude:+pos.coords.latitude.toFixed(2), longitude:+pos.coords.longitude.toFixed(2)}).eq('id', cur))) toast('📍 Ubicación del proyecto guardada por GPS');
  }, err => alert('No se pudo obtener la ubicación: ' + err.message), {timeout:10000});
}

function selectedMapPoint(latId, lonId){
  const lat = $(`#${latId}`).value, lon = $(`#${lonId}`).value;
  if (lat === '' || lon === '') return null;
  const latitude = Number(lat), longitude = Number(lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? {latitude, longitude} : null;
}
function clearLocationMaps(){
  for (const state of locationMaps.values()) state.map.remove();
  locationMaps.clear();
}
function initLocationMap(mapId, latId, lonId, statusId, location, lat, lon){
  const container = document.getElementById(mapId), status = document.getElementById(statusId);
  if (!container || !status) return;
  if (!window.L) {
    status.textContent = 'No se pudo cargar el mapa. Revisá tu conexión e intentá recargar.';
    return;
  }
  const hasPoint = lat != null && lon != null && Number.isFinite(+lat) && Number.isFinite(+lon);
  const map = L.map(container).setView(hasPoint ? [+lat, +lon] : [-34.6, -58.4], hasPoint ? 15 : 5);
  const state = {map, revision:0, selectPoint:null};
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19, attribution:'&copy; OpenStreetMap'
  }).addTo(map);
  let marker = null;
  const selectPoint = point => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return;
    state.revision++;
    const latitude = +point.lat.toFixed(6), longitude = +point.lng.toFixed(6);
    if (marker) marker.setLatLng([latitude, longitude]);
    else {
      marker = L.marker([latitude, longitude], {draggable:true}).addTo(map);
      marker.on('dragend', () => selectPoint(marker.getLatLng()));
    }
    $(`#${latId}`).value = latitude;
    $(`#${lonId}`).value = longitude;
    status.textContent = `Punto seleccionado: ${latitude}, ${longitude}`;
  };
  state.selectPoint = selectPoint;
  locationMaps.set(mapId, state);
  if (hasPoint) selectPoint({lat:+lat, lng:+lon});
  map.on('click', event => selectPoint(event.latlng));
  if (!hasPoint && location) {
    const revision = state.revision;
    geocode(location).then(point => {
      if (!point || !container.isConnected || state.revision !== revision) return;
      map.setView([point.lat, point.lon], 14);
      selectPoint({lat:point.lat, lng:point.lon});
    }).catch(error => {
      if (container.isConnected && state.revision === revision) status.textContent = `No se pudo ubicar "${location}" automáticamente (${error.message}). Elegí el punto en el mapa.`;
    });
  }
}
async function searchLocation(prefix){
  const isNew = prefix === 'new', input = $(isNew ? '#l' : '#eloc');
  const status = $(isNew ? '#newLocationStatus' : '#editLocationStatus');
  const button = $(isNew ? '#newLocationSearch' : '#editLocationSearch');
  const mapId = isNew ? 'newMap' : 'editMap', query = input.value.trim();
  if (button.disabled) return;
  if (!query) {
    status.textContent = 'Escribí una ciudad o dirección para buscarla en el mapa.';
    input.focus();
    return;
  }
  const state = locationMaps.get(mapId), revision = state ? ++state.revision : 0;
  const isCurrentSearch = () => input.isConnected && status.isConnected && input.value.trim() === query
    && locationMaps.get(mapId) === state && (!state || state.revision === revision);
  button.disabled = true;
  button.textContent = 'Buscando…';
  status.textContent = `Buscando "${query}"…`;
  try {
    const place = await geocode(query);
    if (!isCurrentSearch()) return;
    if (!place) {
      status.textContent = `No encontramos "${query}". Probá con ciudad, provincia y país.`;
      return;
    }
    if (!state) {
      status.textContent = 'El mapa todavía no está listo. Volvé a intentarlo.';
      return;
    }
    state.map.setView([place.lat, place.lon], 14);
    state.selectPoint({lat:place.lat, lng:place.lon});
    status.textContent = `Ubicación encontrada: ${place.name}. Podés ajustar el marcador en el mapa.`;
  } catch (error) {
    if (isCurrentSearch()) status.textContent = `No se pudo buscar la ubicación: ${error.message}`;
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = 'Buscar en el mapa';
    }
  }
}
function initLocationMaps(){
  const ins = I(cur);
  initLocationMap('newMap', 'newLat', 'newLon', 'newLocationStatus', '', null, null);
  if (ins) initLocationMap('editMap', 'editLat', 'editLon', 'editLocationStatus', ins.loc, ins.lat, ins.lon);
}

/* ---------- importar CSV del inversor ---------- */
const norm = t => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const okd = r => { try { return iso(new Date(r + 'T12:00:00Z')) === r ? r : null; } catch (e) { return null; } };
function parseDate(x){
  let m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return okd(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
  m = x.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); return m ? okd(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`) : null;
}
const num = x => { const v = parseFloat(String(x ?? '').replace(',', '.')); return isNaN(v) ? null : v; };
async function importCSV(){
  const f = $('#csvf') && $('#csvf').files && $('#csvf').files[0];
  if (!f || !cur) return alert('Elegí un archivo CSV primero.');
  if (f.size > 2e6) return alert('El archivo es demasiado grande (máximo 2 MB).');
  const lines = (await f.text()).split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return alert('El CSV está vacío.');
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const H = lines[0].split(sep).map(h => norm(h.trim()));
  let di = H.findIndex(h => /fecha|date/.test(h)); if (di < 0) di = H.findIndex(h => h === 'dia');
  const ki = H.findIndex(h => /kwh|energia|energy|produccion/.test(h));
  const pi = H.findIndex((h, j) => j !== ki && /pico|potencia|power|peak|^kw($|[^h])/.test(h)), ii = H.findIndex(h => /irrad|radiacion/.test(h));
  if (di < 0 || ki < 0) return alert('No encontré las columnas «fecha» y «kWh». Descargá la plantilla para ver el formato.');
  const out = {};
  for (const l of lines.slice(1)) {
    const c = l.split(sep), d = parseDate((c[di] || '').trim()), kwh = num(c[ki]);
    if (d && kwh != null && kwh >= 0) out[d] = {project_id:cur, date:d, kwh, pk:pi >= 0 ? (num(c[pi]) || 0) : 0, irr:ii >= 0 ? (num(c[ii]) || 0) : 0};
  }
  const up = Object.values(out); if (!up.length) return alert('No encontré filas válidas (revisá el formato de fechas y números).');
  toast(`Importando ${up.length} días…`);
  for (let i = 0; i < up.length; i += 500) if (!(await run(sb.from('generation').upsert(up.slice(i, i + 500), {onConflict:'project_id,date'}), () => {}))) return;
  render(); toast(`✅ ${up.length} días importados`);
  if (up.some(g => !(g.irr > 0))) fillIrr();   // completa la irradiancia automáticamente
}

/* ---------- clima de la ubicación ---------- */
const wxCache = {};
const wmo = c => c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : '⛈️';
const cloudText = p => p <= 20 ? 'cielo despejado' : p <= 60 ? 'parcialmente nublado' : 'muy nublado';
async function wxFor(ins){
  const g = await geoFor(ins), key = g.lat + ',' + g.lon, c = wxCache[key];
  if (c && Date.now() - c.t < 9e5) return c.v;
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,shortwave_radiation,is_day&hourly=shortwave_radiation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,shortwave_radiation_sum&timezone=auto&forecast_days=7`);
  if (!r.ok) throw new Error('Open-Meteo no respondió');
  const j = await r.json(), v = {place:g.name, c:j.current, h:j.hourly, d:j.daily};
  wxCache[key] = {t:Date.now(), v}; return v;
}
async function wxCard(){
  const box = $('#wx'), ins = I(cur); if (!box) return;
  if (!ins) return box.innerHTML = '<div class="card">Creá un proyecto primero.</div>';
  try {
    const w = await wxFor(ins); if ($('#wx') !== box) return;
    const k = kwp(ins), a = analyze(cur), prv = a.pr || .8, c = w.c, d = w.d;
    const i0 = Math.max(0, w.h.time.findIndex(t => t.slice(0,13) >= c.time.slice(0,13)));
    const hrs = w.h.time.slice(i0, i0 + 24), pw = w.h.shortwave_radiation.slice(i0, i0 + 24).map(x => +(k * x/1000 * prv).toFixed(2));
    const mine = rows(cur).filter(g => g.irr > .5).slice(-30), avg = mine.length ? mine.reduce((s,g) => s + g.irr, 0)/mine.length : null, tom = d.shortwave_radiation_sum[1]/3.6;
    const notes = [`Ahora hay ${cloudText(c.cloud_cover)} (${c.cloud_cover}% de nubes).`];
    if (!c.is_day) notes.push('Es de noche: no hay generación.'); else if (k > 0) notes.push(`Con esta radiación, tu instalación debería estar entregando unos ${f1(k*c.shortwave_radiation/1000*prv)} kW.`);
    if (avg) { const df = (tom - avg)/avg*100; notes.push(`Mañana se espera ${Math.abs(df) < 5 ? 'un sol similar' : f1(Math.abs(df)) + '% ' + (df > 0 ? 'más' : 'menos') + ' de sol'} que en tu promedio reciente (${f1(tom)} vs. ${f1(avg)} kWh/m²).`); }
    if (d.precipitation_sum[1] >= 1) notes.push('Mañana se esperan lluvias: ayudan a limpiar los paneles, pero bajan la generación ese día.');
    const dia = t => new Date(t + 'T12:00').toLocaleDateString('es-AR', {weekday:'short', day:'numeric', month:'short'});
    box.innerHTML = `<div class="card"><h2>${wmo(c.weather_code)} Clima en ${esc(w.place)}</h2><div class="grid">
      <div class="kpi"><small>Temperatura</small><b>${f1(c.temperature_2m)} °C</b></div><div class="kpi"><small>Nubosidad</small><b>${c.cloud_cover}%</b></div>
      <div class="kpi"><small>Radiación solar</small><b>${Math.round(c.shortwave_radiation)} W/m²</b></div><div class="kpi"><small>Viento</small><b>${f1(c.wind_speed_10m)} km/h</b></div>
      <div class="kpi"><small>Lluvia</small><b>${c.precipitation} mm</b></div></div></div>
    <div class="card"><h2>🤖 Lectura de SolarIA</h2>${notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>
    <div class="card"><h2>Potencia esperada – próximas 24 h (kW)</h2>${chart(hrs.map(t => t.slice(11,16)), [{n:'kW esperados', v:pw}])}<small class="mu">Radiación pronosticada × ${f1(k)} kWp × PR ${f1(prv*100)}%${a.pr ? ' (mediana histórica)' : ' (valor por defecto)'}. Datos: Open-Meteo.</small></div>
    <div class="card sc"><h2>Próximos 7 días</h2><table><tr><th>Día</th><th></th><th>Mín / Máx</th><th>Irradiancia</th><th>Generación esperada</th><th>Lluvia</th></tr>
    ${d.time.map((t,i) => `<tr><td>${esc(dia(t))}</td><td>${wmo(d.weather_code[i])}</td><td>${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</td><td>${f1(d.shortwave_radiation_sum[i]/3.6)} kWh/m²</td><td>${k > 0 ? f1(d.shortwave_radiation_sum[i]/3.6*k*prv) + ' kWh' : '–'}</td><td>${f1(d.precipitation_sum[i])} mm</td></tr>`).join('')}</table></div>`;
    drawCharts();
  } catch (e) { if ($('#wx') === box) box.innerHTML = `<div class="card"><h2>🌦️ Clima</h2><p class="mu">No se pudo obtener el clima: ${esc(e.message)}</p></div>`; }
}

/* ---------- asistente: motor local de intenciones (+ LLM opcional por Edge Function) ---------- */
const CHIPS = ['¿Cuánto generé este mes?', '¿Cuánto voy a generar mañana?', '¿Cómo está el clima?', '¿Mi sistema funciona bien?', '¿Cuánto ahorré?', '¿Cuándo recupero la inversión?', '¿Por qué generé poco ayer?', '¿Cuándo conviene limpiar los paneles?'];
let chatLog = [];
const has = (q, ...w) => w.some(x => q.includes(x));
const llmOn = () => typeof ENABLE_LLM !== 'undefined' && ENABLE_LLM && realSb && !localMode;
const dAgo = n => iso(new Date(Date.now() - n*864e5));
const A = (t, src = 'local') => ({t, src});
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
function chatHTML(){
  return chatLog.map(m => `<div class="msg ${m.r}">${fmt(m.t)}${m.src === 'llm' ? '<br><small class="mu">🧠 Respuesta generada con un modelo de lenguaje: verificá los datos importantes.</small>' : ''}</div>`).join('');
}
function chatPaint(){ const b = $('#chatlog'); if (b) { b.innerHTML = chatHTML(); b.scrollTop = b.scrollHeight; } }
async function sendChat(txt){
  const inp = $('#chatq'), raw = String(txt ?? (inp ? inp.value : '')).trim(); if (!raw) return;
  if (inp) inp.value = '';
  chatLog.push({r:'u', t:raw}, {r:'b', t:'Pensando…'}); chatPaint();
  let msg; try { msg = await answer(raw); } catch (e) { msg = A('No pude consultar los datos ahora: ' + e.message); }
  chatLog.pop(); chatLog.push({r:'b', ...msg}); chatPaint();
}
function period(q, R){
  const sel = (label, f) => ({label, rows:R.filter(g => f(g.date))}), m = q.match(/ultim[oa]s?\s+(\d+)\s+dias/);
  if (has(q, 'ayer')) return sel('el día de ayer', d => d === dAgo(1));
  if (has(q, 'hoy')) return sel('el día de hoy', d => d === dAgo(0));
  if (m) { const from = dAgo(+m[1] - 1); return sel(`los últimos ${m[1]} días`, d => d >= from); }
  if (has(q, 'semana')) { const from = dAgo(6); return sel('los últimos 7 días', d => d >= from); }
  if (has(q, 'mes pasado', 'mes anterior')) { const t = new Date(), p = iso(new Date(t.getFullYear(), t.getMonth() - 1, 15)).slice(0,7); return sel('el mes pasado', d => d.startsWith(p)); }
  if (has(q, 'este mes', 'del mes', 'mensual')) { const p = dAgo(0).slice(0,7); return sel('este mes', d => d.startsWith(p)); }
  if (has(q, 'total', 'historico', 'siempre', 'acumulad')) return sel('todo el historial', () => true);
  const from = dAgo(29); return sel('los últimos 30 días', d => d >= from);
}
const sumKwh = r => r.reduce((s,g) => s + g.kwh, 0);
async function tomorrowEst(ins){
  const f = await forecastFor(ins), a = analyze(cur), prv = a.pr || .8, d = f.days[1];
  return {e:d.mj/3.6*kwp(ins)*prv, irr:d.mj/3.6, prv, learned:!!a.pr, place:f.place, date:d.date};
}
function whyLow(q, R, a){
  const g = has(q, 'ayer') ? R.find(x => x.date === dAgo(1)) : R[R.length - 1];
  if (!g) return 'No tengo datos de generación de ese día, así que no puedo explicar qué pasó.';
  if (!(g.irr > 0) || a.pr == null) return `El ${g.date} generaste ${f1(g.kwh)} kWh, pero no tengo la irradiancia de ese día (ni paneles cargados) para saber cuánto se esperaba. Cargá la irradiancia o usá «Completar irradiancia faltante» en Generación y te explico la causa.`;
  const exp = a.ex(g), ratio = g.kwh/exp, mine = R.filter(x => x.irr > .5).slice(-30), avg = mine.reduce((s,x) => s + x.irr, 0)/mine.length, rel = g.irr/avg;
  const base = `El ${g.date} generaste **${f1(g.kwh)} kWh**; con la irradiancia de ese día (${g.irr} kWh/m²) se esperaban ${f1(exp)} kWh, o sea rindió el **${f1(ratio*100)}%** de lo esperado.`;
  if (ratio >= .85) return base + (rel < .85 ? ` La causa principal fue el clima: ese día tuvo ${f1((1-rel)*100)}% menos de sol que tu promedio.` : ' Está dentro de lo normal.');
  return base + ' Rindió menos de lo esperado aun considerando el clima, así que no se explica solo por el tiempo. Posibles causas: suciedad, sombras, falla del inversor o corte de red. Revisá Análisis IA.';
}
const HELP = 'Puedo responder con los datos de tu proyecto sobre:\n• **Producción**: «¿cuánto generé esta semana / este mes / ayer?»\n• **Ahorro y retorno**: «¿cuánto ahorré?», «¿cuándo recupero la inversión?»\n• **Mañana**: «¿cuánto voy a generar mañana?»\n• **Clima**: «¿cómo está el clima?»\n• **Estado**: «¿mi sistema funciona bien?», «¿por qué generé poco ayer?»\n• **Mantenimiento**, **especificaciones** del sistema y **cómo funciona el modelo**.\nSi me preguntás algo fuera de esa lista, te voy a decir que todavía no estoy entrenada para eso.';
async function answer(raw){
  const q = norm(raw), ins = I(cur);
  if (/^(hola|buenas|buen dia|buenos dias|que tal)\b/.test(q) && q.length < 30) return A('¡Hola! 👋 Preguntame por tu producción, el ahorro, el clima, el pronóstico de mañana o el estado de tu sistema.');
  if (has(q, 'ayuda', 'que podes', 'que sabes', 'que puedes', 'que haces')) return A(HELP);
  if (!ins) return A('Primero creá un proyecto en la pestaña Proyectos y después te ayudo con sus datos.');
  const R = rows(cur), a = analyze(cur), k = kwp(ins);
  if (has(q, 'por que', 'porque', 'motivo') && has(q, 'poco', 'menos', 'baj', 'cay', 'mal', 'nada')) return A(whyLow(q, R, a));
  if (has(q, 'mejor dia', 'peor dia')) {
    if (!R.length) return A('Todavía no cargaste datos de generación.');
    const best = R.reduce((x,y) => y.kwh > x.kwh ? y : x), worst = R.reduce((x,y) => y.kwh < x.kwh ? y : x);
    return A(`Tu mejor día fue el **${best.date}** con ${f1(best.kwh)} kWh y el peor el **${worst.date}** con ${f1(worst.kwh)} kWh (sobre ${R.length} días registrados).`);
  }
  if (has(q, 'compar', ' vs ', 'versus')) {
    const t = new Date(), mA = dAgo(0).slice(0,7), mB = iso(new Date(t.getFullYear(), t.getMonth() - 1, 15)).slice(0,7);
    const ra = R.filter(g => g.date.startsWith(mA)), rb = R.filter(g => g.date.startsWith(mB));
    if (!ra.length || !rb.length) return A(`Para comparar necesito datos de este mes y del anterior. Tengo ${ra.length} día(s) de ${mA} y ${rb.length} de ${mB}.`);
    const pa = sumKwh(ra)/ra.length, pb = sumKwh(rb)/rb.length, df = (pa - pb)/pb*100;
    return A(`Promedio diario de este mes: **${f1(pa)} kWh** (${ra.length} días) vs. el mes pasado: **${f1(pb)} kWh** (${rb.length} días): ${df >= 0 ? '+' : ''}${f1(df)}%. Comparo promedios diarios porque los meses no tienen los mismos días cargados.`);
  }
  if (has(q, 'retorno', 'payback', 'amortiz', 'recuper', 'se paga', 'rentab')) {
    const l30 = R.filter(g => g.date >= dAgo(29));
    if (!(ins.tariff > 0 && ins.cost > 0)) return A('Para estimar el retorno necesito la tarifa eléctrica y la inversión inicial. Cargalas en Proyectos → ficha del proyecto.');
    if (!l30.length) return A('No tengo generación de los últimos 30 días para proyectar el ahorro anual. Cargá datos recientes.');
    const anual = sumKwh(l30)/l30.length*365*ins.tariff, m = Math.round(ins.cost/anual*12), rec = sumKwh(R)*ins.tariff;
    return A(`Con tu generación de los últimos 30 días, el ahorro anual proyectado es ${money(anual)} y la inversión se recupera en unos **${Math.floor(m/12)} años y ${m % 12} meses**. Hasta hoy recuperaste ${money(rec)} (${f1(Math.min(100, rec/ins.cost*100))}%). Es una estimación: no incluye estacionalidad ni cambios de tarifa.`);
  }
  if (has(q, 'ahorr', 'plata', 'dinero', 'factura', 'pesos', 'gane')) {
    if (!(ins.tariff > 0)) return A('Para calcular el ahorro necesito la tarifa eléctrica ($/kWh). Cargala en Proyectos → ficha del proyecto.');
    const p = period(q, R); if (!p.rows.length) return A(`No tengo registros de generación de ${p.label}.`);
    return A(`En ${p.label} generaste ${f1(sumKwh(p.rows))} kWh, lo que equivale a un ahorro de **${money(sumKwh(p.rows)*ins.tariff)}** (tarifa de $${ins.tariff}/kWh).`);
  }
  if (has(q, 'manana', 'pronostic', 'predic', 'voy a generar', 'generare', 'proyeccion')) {
    if (!(k > 0)) return A('Para proyectar necesito los paneles cargados en la ficha del proyecto.');
    const t = await tomorrowEst(ins);
    return A(`Mañana (${t.date}) se espera una irradiancia de ${f1(t.irr)} kWh/m² en ${t.place}, así que generarías unos **${f1(t.e)} kWh**${ins.tariff > 0 ? ` (≈ ${money(t.e*ins.tariff)})` : ''}. Uso un PR de ${f1(t.prv*100)}% ${t.learned ? '(mediana histórica de tu instalación)' : '(valor por defecto: todavía no tengo datos propios suficientes)'}.`);
  }
  if (has(q, 'clima', 'nublad', 'temperatura', 'llueve', 'lluvia', 'viento', 'soleado', 'radiacion', 'irradiancia', 'que tiempo', 'el tiempo')) {
    const w = await wxFor(ins), c = w.c;
    return A(`En **${w.place}** ahora hay ${f1(c.temperature_2m)} °C, ${cloudText(c.cloud_cover)} (${c.cloud_cover}% de nubes), radiación de ${Math.round(c.shortwave_radiation)} W/m² y viento de ${f1(c.wind_speed_10m)} km/h.${c.is_day ? '' : ' Es de noche, así que no hay generación.'} Mañana: ${f1(w.d.shortwave_radiation_sum[1]/3.6)} kWh/m² de irradiancia esperada y ${f1(w.d.precipitation_sum[1])} mm de lluvia. En la pestaña Clima está el detalle.`);
  }
  if (has(q, 'mantenimiento', 'limpi', 'inspecc', 'recomend', 'que hago', 'revisar')) {
    const lm = db.ev.filter(e => e.inst == cur && e.type === 'Mantenimiento').map(e => e.date).sort().pop();
    if (a.pr == null) return A('Todavía no tengo datos suficientes para recomendarte algo específico. Regla general: inspección preventiva cada 6 meses y limpieza cuando notes una caída de producción.' + (lm ? ` Tu último mantenimiento registrado fue el ${lm}.` : ' No hay mantenimientos registrados.'));
    return A('Recomendaciones según tus datos:\n' + (a.rec.map(r => '• ' + r).join('\n') || '• Continuar con el monitoreo habitual.') + (lm ? `\nÚltimo mantenimiento registrado: ${lm}.` : '\nNo hay mantenimientos registrados.'));
  }
  if (has(q, 'falla', 'anomal', 'problema', 'funciona', 'anda bien', 'esta bien', 'salud', 'estado', 'error', 'alerta')) {
    if (a.pr == null) return A(a.noPanels ? 'Todavía no puedo evaluar el estado: cargá los paneles del proyecto.' : 'Todavía no puedo evaluar el estado: necesito al menos 1 día con generación e irradiancia.');
    const al = a.F.filter(f => f.s === 'alta'), me = a.F.filter(f => f.s === 'media');
    return A(`Salud estimada: **${a.health}/100**. Detecté ${al.length} alerta(s) graves y ${me.length} moderadas.` + (a.F.filter(f => f.s !== 'info').slice(0,3).map(f => `\n• ${f.d}: ${f.t}`).join('')) +
      (a.learned ? '' : `\n\nOjo: todavía comparo contra una referencia teórica (${a.n}/10 días con irradiancia). Con 10 días mi modelo aprende el comportamiento propio de tu instalación y el diagnóstico gana precisión.`));
  }
  if (has(q, 'panel', 'kwp', 'potencia instalada', 'inversor', 'especificac', 'ficha', 'alimenta', 'ubicacion')) {
    return A(`**${ins.name}**: ${f1(k)} kWp (${nPan(ins)} paneles). ${ins.panels.map(p => `${p.qty}× ${p.brand} ${p.model} ${p.wp} Wp (${p.type})`).join('; ') || 'Todavía no cargaste paneles.'} Inversor: ${ins.inv || 'sin dato'}. Alimenta: ${ins.use}${ins.useDetail ? ' (' + ins.useDetail + ')' : ''}. Ubicación: ${ins.loc || 'sin definir'}.`);
  }
  if (has(q, 'entrena', 'aprend', 'modelo', 'como funciona', 'inteligencia', 'confiable', 'cuantos dias', '10 dias')) {
    return A(`Mi análisis tiene dos etapas. Con menos de 10 días con irradiancia comparo contra una referencia teórica (kWp × irradiancia × 0,80). Con 10 días o más aprendo un modelo propio de tu instalación (regresión robusta) y detecto lo que se aparta de ese comportamiento. Ahora tengo **${a.n || 0}/10** días utilizables: modo **${a.learned ? 'aprendido' : 'referencia'}**. No soy un modelo de lenguaje: respondo con tus datos y reglas, y cuando algo no lo sé, te lo digo.`);
  }
  if (has(q, 'gener', 'produj', 'produccion', 'energia', 'kwh')) {
    const p = period(q, R);
    if (!p.rows.length) return A(`No tengo registros de generación de ${p.label}.` + (R.length ? ` Tu último dato es del ${R[R.length-1].date}.` : ' Todavía no cargaste datos: andá a Generación.'));
    const tot = sumKwh(p.rows);
    return A(`En ${p.label} generaste **${f1(tot)} kWh** (${p.rows.length} día(s) con datos, promedio ${f1(tot/p.rows.length)} kWh/día)${ins.tariff > 0 ? `, equivalente a ${money(tot*ins.tariff)} de ahorro` : ''}.`);
  }
  if (llmOn()) {                                   // la pregunta no es de las que conozco: se consulta al modelo de lenguaje (Edge Function)
    try { return A(await askLLM(raw), 'llm'); } catch (e) { console.warn('LLM:', e.message); }
  }
  return A('Todavía no soy capaz de entender esa consulta: mi modelo no está entrenado para ese tema.\n\nPuedo ayudarte con producción y ahorro, retorno de la inversión, pronóstico de mañana, clima, estado y anomalías, mantenimiento, especificaciones del sistema y cómo funciona el modelo. Probá reformular la pregunta o usá los botones de ejemplo.' + (llmOn() ? '' : '\n\n(El modo de lenguaje avanzado no está activado en este proyecto.)'));
}
function llmContext(){
  const ins = I(cur), a = analyze(cur), w = Object.values(wxCache)[0];
  return {proyecto:{nombre:ins.name, ubicacion:ins.loc, kWp:+f1(kwp(ins)), paneles:ins.panels.map(p => `${p.qty}x ${p.brand} ${p.model} ${p.wp}Wp`), uso:ins.use, tarifa:ins.tariff, inversion:ins.cost},
    ultimos_dias:rows(cur).slice(-30).map(g => ({fecha:g.date, kwh:g.kwh, irradiancia:g.irr})), hallazgos:a.F.slice(0,8).map(f => ({fecha:f.d, gravedad:f.s, texto:f.t})),
    modelo:{aprendido:a.learned, dias_con_irradiancia:a.n}, clima:w ? {actual:w.v.c, diario:w.v.d} : null};
}
async function askLLM(question){
  const {data, error} = await sb.functions.invoke('ask-solaria', {body:{question, context:llmContext()}});
  if (error || !data || data.error) throw new Error((error && error.message) || (data && data.error) || 'sin respuesta');
  return data.answer;
}

/* ---------- arranque ---------- */
function render(){
  if (recoveryMode) {
    liveStop();
    $('#top').hidden = $('#nav').hidden = true;
    $('#app').innerHTML = `<div class="card auth"><h2>Elegí una contraseña nueva</h2>
      <p class="mu">La contraseña debe tener al menos 6 caracteres.</p>
      <div class="row"><label>Nueva contraseña<input id="newPass" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')saveNewPassword()"></label>
      <label>Repetí la contraseña<input id="confirmPass" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')saveNewPassword()"></label></div>
      <div class="row"><button id="savePassword" class="pri" onclick="saveNewPassword()">Guardar contraseña</button></div><div class="err" id="err"></div></div>`;
    return;
  }
  if (!user) {
    liveStop();
    $('#top').hidden = $('#nav').hidden = true;
    if (pending) {
      $('#app').innerHTML = `<div class="card auth"><h2>Confirmá tu email</h2><p>Te enviamos un código a <b>${esc(pending)}</b>.</p><div class="row"><label>Código<input id="cd" inputmode="numeric" autocomplete="one-time-code"></label><button class="pri" onclick="verify()">Confirmar</button></div><div class="row"><button onclick="resend()">Reenviar código</button><button onclick="cancelVerify()">Volver</button></div><div class="err" id="err"></div></div>`;
      return;
    }
    if (forgotPasswordMode) {
      $('#app').innerHTML = `<div class="card auth"><h2>Recuperar contraseña</h2>
        <p class="mu">Ingresá el email de tu cuenta y te enviaremos un enlace para crear una contraseña nueva.</p>
        <div class="row"><label>Email<input id="resetEmail" type="email" autocomplete="email" value="${esc(resetEmail)}"></label></div>
        <div class="row"><button id="sendReset" class="pri" onclick="sendPasswordReset()">Enviar enlace</button><button onclick="backToLogin()">Volver al inicio de sesión</button></div>
        <p class="reset-note">${esc(resetMessage)}</p><div class="err" id="err">${esc(authNotice)}</div></div>`;
      return;
    }
    $('#app').innerHTML = `<div class="card auth"><h2>☀️ Ingresá a SolarIA</h2><div class="row"><label>Usuario (solo para crear cuenta)<input id="nm"></label><label>Email<input id="u" type="email"></label><label>Clave<input id="p" type="password" autocomplete="current-password"></label></div>
      <div class="row"><button class="pri" onclick="auth(false)">Ingresar</button><button onclick="auth(true)">Crear cuenta</button><button onclick="showForgotPassword()">Olvidé mi contraseña</button></div>
      <div class="row"><button onclick="enterLocal()">Probar en modo demostración (sin cuenta)</button></div><div class="err" id="err">${esc(authNotice)}</div>
      <p class="mu">Cada usuario ve solo sus propios proyectos. Los datos se guardan en Supabase. El modo demostración los guarda solo en este navegador.</p></div>`;
    return;
  }
  $('#top').hidden = $('#nav').hidden = false;
  $('#nav').innerHTML = TABS.map(([k,l]) => `<button class="${k == tab ? 'on' : ''}" onclick="tab='${k}';render()">${l}</button>`).join('');
  clearLocationMaps();
  $('#app').innerHTML = V[tab]();
  if (tab === 'proy') initLocationMaps();
  if (tab === 'live') liveStart(); else liveStop();
  if (tab === 'panel' || tab === 'ia') forecastCard();
  if (tab === 'clima') wxCard();
  if (tab === 'chat') chatPaint();
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
  if (ls.get('solaria_mode') === 'local' && !recoveryMode) return enterLocal();
  if (!realSb) return boot();
  const {data} = await sb.auth.getSession();
  data.session ? await start(data.session.user) : boot();
})();