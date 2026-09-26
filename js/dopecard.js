/* ---------------------------------------------------------------------
   Applied Concepts — Dope Card
   Digitale pols-dope kaart: fullscreen overlay met een dope-grid, een
   windklok en een target card (max 3 doelen). Herbruikt het bestaande
   wapenprofiel (js/profiles.js) voor BC/V0/dragModel/zero — geen aparte
   profielenlijst — en de SIGHTS/MOUNTS-HOB-data uit js/app.js voor de
   richtmiddelhoogte-picker. Ballistiek via js/ballistics.js
   (computeDopeCardTable + computeAtmosphere).
   Valt gewoon achter de pass-phrase gate; niets hier omzeilt die.
--------------------------------------------------------------------- */

const DC_SETTINGS_KEY = 'ac_dopecard_settings_v1';
const DC_WIND_KEY = 'ac_dopecard_wind_v1';
const DC_TARGETS_KEY = 'ac_dopecard_targets_v1';

const DC_DEFAULT_SETTINGS = {
  activeProfileId: null,
  hobSource: 'manual', sightId: 'manual_sight', mountId: 'none', hobMm: 70,
  envMode: 'altitude', envTempC: 15, envAltitudeM: 0, envPressureHpa: 1013.25,
  rangeStart: 200, rangeEnd: 980, rangeInterval: 20,
  wristMode: 'device', theme: 'day',
};
// 5.0 m/s @ 3:00 doubles as the spec's own worked example (R5.0) — a sane,
// checkable default rather than an arbitrary one.
const DC_DEFAULT_WIND = { speedMps: 5.0, angleDeg: 90 };

function dcLoad(key, fallback){
  try { const raw = JSON.parse(localStorage.getItem(key)); return raw == null ? fallback : raw; }
  catch(e){ return fallback; }
}
function dcSave(key, val){
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e){ /* opslag niet beschikbaar — sessie werkt door */ }
}

let dcSettings = Object.assign({}, DC_DEFAULT_SETTINGS, dcLoad(DC_SETTINGS_KEY, {}));
let dcWind = Object.assign({}, DC_DEFAULT_WIND, dcLoad(DC_WIND_KEY, {}));
let dcTargets = dcLoad(DC_TARGETS_KEY, []);
let dcActiveTargetIdx = null;
let dcTable = null; // Map<distanceM, {elevMil, driftMilPerMps}>

let dcScreen = 'dope';
let dcOverlayEl = null;
let dcWakeLock = null;
let dcRotationDeg = 0;
let dcOrientationMq = null;
let dcFallbackVideo = null;

/* ---- Profiel + HOB + atmosfeer -> ballistiek-tabel ---- */
function dcGetActiveProfile(){
  const profiles = window.AppliedConceptsProfiles.load();
  return profiles.find(p => p.id === dcSettings.activeProfileId) || null;
}
function dcComputeHobMm(){
  if(dcSettings.hobSource !== 'auto') return dcSettings.hobMm;
  const sight = SIGHTS.find(s => s.id === dcSettings.sightId);
  const mount = MOUNTS.find(m => m.id === dcSettings.mountId);
  if(!sight || !mount) return dcSettings.hobMm;
  let hobIn = null;
  if(mount.id !== 'none' && mount.id !== 'manual_mount') hobIn = mount.hobIn;
  else if(mount.id === 'none') hobIn = sight.hobIn;
  return hobIn != null ? hobIn * 25.4 : dcSettings.hobMm;
}
function dcRecomputeTable(){
  const profile = dcGetActiveProfile();
  if(!profile){ dcTable = null; return false; }
  const input = window.AppliedConceptsProfiles.toBallisticsInput(profile);
  if(!input){ dcTable = null; return false; }
  input.sightHeightCm = dcComputeHobMm() / 10;
  const atmInput = { tempC: dcSettings.envTempC };
  if(dcSettings.envMode === 'pressure') atmInput.pressureHpa = dcSettings.envPressureHpa;
  else atmInput.altitudeM = dcSettings.envAltitudeM;
  const atmosphere = window.AppliedConceptsBallistics.computeAtmosphere(atmInput);
  dcTable = window.AppliedConceptsBallistics.computeDopeCardTable(input, atmosphere, dcDistances());
  return true;
}

/* ---- Afstanden / blokken / kolommen ---- */
function dcDistances(){
  const arr = [];
  const { rangeStart:s, rangeEnd:e, rangeInterval:i } = dcSettings;
  for(let d = s; d <= e; d += i) arr.push(Math.round(d));
  return arr;
}
function dcBlocksFrom(distances){
  const byHundred = new Map();
  distances.forEach(d => {
    const h = Math.floor(d/100)*100;
    if(!byHundred.has(h)) byHundred.set(h, []);
    byHundred.get(h).push(d);
  });
  return [...byHundred.entries()].sort((a,b)=>a[0]-b[0]).map(([h,ds]) => ({ hundred:h, distances:ds }));
}
// Kolom 0 draagt ook het windvak, dus krijgt bij een oneven verdeling als
// eerste minder blokken — bij precies 8 blokken (het spec-voorbeeld) geeft
// dit exact 2/3/3, dus met het windvak 3/3/3: een nette 3x3.
function dcColumnsFrom(blocks){
  const n = blocks.length;
  const base = Math.floor(n/3);
  const counts = [base, base, base];
  let rem = n - base*3;
  for(let c=1; c<3 && rem>0; c++, rem--) counts[c]++;
  for(let c=0; c<3 && rem>0; c++, rem--) counts[c]++;
  const cols = [[],[],[]];
  let idx = 0;
  for(let c=0; c<3; c++){ for(let i=0; i<counts[c]; i++){ cols[c].push(blocks[idx++]); } }
  return cols;
}
// Schat of het raster op één (liggend) scherm past, vóór het opslaan —
// gebaseerd op de fysieke korte zijde van het scherm (screen.width/height
// i.p.v. window.inner*, want de fullscreen-modus vult straks de hele
// liggende viewport, ongeacht hoe het setup-scherm er nu (staand) bij staat).
function dcFitCheck(){
  const distances = dcDistances();
  const blocks = dcBlocksFrom(distances);
  const cols = dcColumnsFrom(blocks);
  const colWeights = cols.map((colBlocks, ci) => {
    let w = colBlocks.reduce((sum,b) => sum + b.distances.length, 0);
    if(ci === 0) w += 1; // windvak
    return w;
  });
  const maxWeight = Math.max(1, ...colWeights);
  const landscapeHeightPx = Math.min(window.screen.width, window.screen.height);
  const rowHeightPx = landscapeHeightPx / maxWeight;
  return { blocks, cols, maxWeight, rowHeightPx, fits: rowHeightPx >= 24, totalBlocks: blocks.length, totalRows: distances.length };
}

/* ---- Wind ---- */
function dcEffWind(){
  const rad = dcWind.angleDeg * Math.PI/180;
  const sin = Math.sin(rad);
  const eff = dcWind.speedMps * Math.abs(sin);
  let dir = null;
  if(Math.abs(sin) > 1e-6) dir = (dcWind.angleDeg > 0 && dcWind.angleDeg < 180) ? 'R' : 'L';
  return { eff, dir };
}
function dcEffWindStr(){
  const { eff, dir } = dcEffWind();
  const s = eff.toFixed(1);
  return (dir == null || s === '0.0') ? '0.0' : dir + s;
}
function dcClockLabel(){
  const hoursTotal = dcWind.angleDeg / 30;
  let hh = Math.floor(hoursTotal);
  const mm = Math.round((hoursTotal - hh) * 60);
  if(hh === 0) hh = 12;
  return `${hh}:${String(mm).padStart(2,'0')}`;
}
function dcSnapAngle(deg){ return (Math.round(deg/15)*15 + 360) % 360; }
function dcAdjustWindSpeed(step){
  dcWind.speedMps = Math.max(0, Math.min(20, Math.round((dcWind.speedMps + step) * 10) / 10));
  dcSave(DC_WIND_KEY, dcWind);
  if(navigator.vibrate) navigator.vibrate(10);
  dcRenderFullscreen();
  dcFlashWindValue();
}
function dcFlashWindValue(){
  if(!dcOverlayEl) return;
  const el2 = dcOverlayEl.querySelector('.dc-wind-value, .dc-wind-speed-value');
  if(!el2) return;
  el2.classList.add('dc-flash');
  setTimeout(() => { if(el2) el2.classList.remove('dc-flash'); }, 150);
}

/* ---- Waarde-opmaak ---- */
function dcFmtElev(mil){ return mil.toFixed(1); }
function dcFmtWindHold(driftMilPerMps){
  const { eff, dir } = dcEffWind();
  const val = driftMilPerMps * eff;
  const s = val.toFixed(1);
  return (dir == null || s === '0.0') ? '0.0' : dir + s;
}

/* ---- Rotatie: fysieke aanraakcoördinaten -> logische (voor-rotatie) delta.
   Alleen 0/±90° nodig (device/links/rechts), dus eenvoudige branching i.p.v.
   volledige trigonometrie — en dus ook zonder afhankelijkheid van exacte
   viewport-afmetingen op het moment van de aanraking. ---- */
function dcLogicalDelta(dx, dy){
  if(dcRotationDeg === -90) return { dx:-dy, dy:dx };
  if(dcRotationDeg === 90) return { dx:dy, dy:-dx };
  return { dx, dy };
}

/* ---- Generieke tik/swipe-detectie (Pointer Events: werkt met zowel
   touch als muis, dus ook testbaar in een gewone browser). ---- */
function dcAttachSwipeOrTap(el, { onTap, onSwipe }){
  let sx=0, sy=0, active=false;
  el.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; active = true;
    try { el.setPointerCapture(e.pointerId); } catch(err){}
  });
  el.addEventListener('pointerup', e => {
    if(!active) return;
    active = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if(Math.hypot(dx,dy) < 20){ if(onTap) onTap(); }
    else if(onSwipe){ onSwipe(dcLogicalDelta(dx,dy)); }
  });
}
function dcAttachDialDrag(svgEl){
  function handleMove(clientX, clientY){
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    const logical = dcLogicalDelta(clientX - cx, clientY - cy);
    let angle = Math.atan2(logical.dx, -logical.dy) * 180/Math.PI;
    if(angle < 0) angle += 360;
    dcWind.angleDeg = dcSnapAngle(angle);
    dcSave(DC_WIND_KEY, dcWind);
    dcDialLiveUpdate();
  }
  svgEl.addEventListener('pointerdown', e => {
    try { svgEl.setPointerCapture(e.pointerId); } catch(err){}
    handleMove(e.clientX, e.clientY);
    const onMove = ev => handleMove(ev.clientX, ev.clientY);
    svgEl.addEventListener('pointermove', onMove);
    svgEl.addEventListener('pointerup', function onUp(){
      svgEl.removeEventListener('pointermove', onMove);
      svgEl.removeEventListener('pointerup', onUp);
    });
  });
}
function dcDialLiveUpdate(){
  if(!dcOverlayEl) return;
  const svg = dcOverlayEl.querySelector('[data-role="dial"]');
  if(svg){
    const cx=50, cy=50, r=40;
    const rad = dcWind.angleDeg * Math.PI/180;
    const bx = cx + r*Math.sin(rad), by = cy - r*Math.cos(rad);
    const line = svg.querySelector('.dc-dial-line');
    const handle = svg.querySelector('.dc-dial-handle');
    if(line){ line.setAttribute('x2', bx.toFixed(2)); line.setAttribute('y2', by.toFixed(2)); }
    if(handle){ handle.setAttribute('cx', bx.toFixed(2)); handle.setAttribute('cy', by.toFixed(2)); }
  }
  const effEl = dcOverlayEl.querySelector('[data-role="effval"]');
  if(effEl) effEl.textContent = dcEffWindStr();
}

/* ---- Doelen ---- */
function dcToggleTarget(d){
  const idx = dcTargets.indexOf(d);
  if(idx >= 0){ dcTargets.splice(idx,1); }
  else {
    if(dcTargets.length >= 3){ dcShowToast('Max 3 doelen'); return; }
    dcTargets.push(d);
  }
  dcSave(DC_TARGETS_KEY, dcTargets);
  dcRenderFullscreen();
}
function dcShowToast(msg){
  if(!dcOverlayEl) return;
  const toast = dcOverlayEl.querySelector('#dcToast');
  if(!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => { if(toast) toast.hidden = true; }, 1000);
}

/* ---- Fullscreen lifecycle ---- */
function dcOnResize(){ dcApplyRotation(); }
function dcOnVisibility(){ if(!document.hidden && dcOverlayEl) dcAcquireWakeLock(); }
function dcPreventGesture(e){ e.preventDefault(); }
function dcPreventMultiTouch(e){ if(e.touches && e.touches.length > 1) e.preventDefault(); }

function dcApplyRotation(){
  if(!dcOverlayEl) return;
  const isPortrait = window.matchMedia('(orientation: portrait)').matches;
  dcOverlayEl.classList.remove('dc-rot-left','dc-rot-right');
  dcRotationDeg = 0;
  if(dcSettings.wristMode !== 'device' && isPortrait){
    if(dcSettings.wristMode === 'left'){ dcOverlayEl.classList.add('dc-rot-left'); dcRotationDeg = -90; }
    else { dcOverlayEl.classList.add('dc-rot-right'); dcRotationDeg = 90; }
  }
}

async function dcAcquireWakeLock(){
  try {
    if(navigator.wakeLock){ dcWakeLock = await navigator.wakeLock.request('screen'); return; }
  } catch(e){ dcWakeLock = null; }
  dcStartSilentVideoFallback();
}
function dcReleaseWakeLock(){
  if(dcWakeLock){ try { dcWakeLock.release(); } catch(e){} dcWakeLock = null; }
  dcStopSilentVideoFallback();
}
// Best-effort fallback voor toestellen zonder Wake Lock API: neemt zelf een
// paar frames van een leeg canvas op tot een geldige video en speelt die
// geluidloos in een loop af (video afspelen houdt op oudere platforms het
// scherm ook wakker) — geen los video-bestand nodig, puur in-browser gegenereerd.
function dcStartSilentVideoFallback(){
  if(dcFallbackVideo || !window.MediaRecorder) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const stream = canvas.captureStream(1);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type:'video/webm' });
      const video = document.createElement('video');
      video.src = URL.createObjectURL(blob);
      video.loop = true; video.muted = true; video.playsInline = true;
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(video);
      video.play().catch(()=>{});
      dcFallbackVideo = video;
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 300);
  } catch(e){ /* best-effort — Wake Lock is het primaire pad op het doelplatform */ }
}
function dcStopSilentVideoFallback(){
  if(dcFallbackVideo){ dcFallbackVideo.pause(); dcFallbackVideo.remove(); dcFallbackVideo = null; }
}

function dcEnterFullscreen(){
  dcScreen = 'dope';
  dcOverlayEl = document.createElement('div');
  dcOverlayEl.className = 'dc-overlay';
  document.body.appendChild(dcOverlayEl);
  dcOverlayEl.addEventListener('touchmove', dcPreventMultiTouch, { passive:false });
  document.addEventListener('gesturestart', dcPreventGesture);
  dcApplyRotation();
  dcRenderFullscreen();
  dcAcquireWakeLock();
  window.addEventListener('resize', dcOnResize);
  document.addEventListener('visibilitychange', dcOnVisibility);
  dcOrientationMq = window.matchMedia('(orientation: portrait)');
  dcOrientationMq.addEventListener('change', dcApplyRotation);
}
function dcTeardownFullscreen(){
  if(!dcOverlayEl) return;
  dcReleaseWakeLock();
  window.removeEventListener('resize', dcOnResize);
  document.removeEventListener('visibilitychange', dcOnVisibility);
  document.removeEventListener('gesturestart', dcPreventGesture);
  if(dcOrientationMq) dcOrientationMq.removeEventListener('change', dcApplyRotation);
  dcOverlayEl.remove();
  dcOverlayEl = null;
}
// returnTo 'setup' = ⚙ (blijft op de Dope Card-tab, normale layout);
// 'app' = ✕ (verlaat Dope Card helemaal, terug naar de Zero Optic Calculator).
function dcExitFullscreen(returnTo){
  dcTeardownFullscreen();
  if(returnTo === 'app'){ if(typeof switchTab === 'function') switchTab('optic'); }
  else { dcRenderSetupScreenIfActive(); }
}
function dcGoScreen(s){ dcScreen = s; dcRenderFullscreen(); }

/* ---- Strip (rechterstrook: TGT / thema / instellingen / sluiten) ---- */
function dcStripHtml(){
  const n = dcTargets.length;
  return `<div class="dc-strip">
    <button class="dc-strip-btn dc-strip-tgt${n===0?' dc-dim':''}" data-act="tgt">TGT<span>${n||''}</span></button>
    <button class="dc-strip-btn" data-act="theme">${dcSettings.theme==='night'?'☀':'☾'}</button>
    <button class="dc-strip-btn" data-act="settings">⚙</button>
    <button class="dc-strip-btn" data-act="close">✕</button>
  </div>`;
}
function dcWireStrip(){
  dcOverlayEl.querySelectorAll('.dc-strip-btn').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if(act === 'tgt') dcGoScreen('target');
      else if(act === 'theme'){ dcSettings.theme = dcSettings.theme==='night' ? 'day' : 'night'; dcSave(DC_SETTINGS_KEY, dcSettings); dcRenderFullscreen(); }
      else if(act === 'settings') dcExitFullscreen('setup');
      else if(act === 'close') dcExitFullscreen('app');
    });
  });
}

/* ---- Scherm A: Dope grid ---- */
function dcDopeScreenHtml(){
  const distances = dcDistances();
  const blocks = dcBlocksFrom(distances);
  const cols = dcColumnsFrom(blocks);
  const { dir } = dcEffWind();

  const colsHtml = cols.map((colBlocks, ci) => {
    const windCellHtml = ci === 0 ? `
      <div class="dc-wind-cell" data-role="windcell">
        <span class="dc-wind-badge">${dir || '—'}</span>
        <span class="dc-wind-value">${dcEffWind().eff.toFixed(1)}</span>
        <span class="dc-wind-label">EFF WIND m/s</span>
        <span class="dc-wind-sub">${dcWind.speedMps.toFixed(1)} @ ${dcClockLabel()}</span>
      </div>` : '';
    const blocksHtml = colBlocks.map(block => {
      const rowsHtml = block.distances.map((d,i) => {
        const row = dcTable ? dcTable.get(d) : null;
        const elevStr = row && row.elevMil != null ? dcFmtElev(row.elevMil) : '—';
        const windStr = row && row.driftMilPerMps != null ? dcFmtWindHold(row.driftMilPerMps) : '—';
        const selIdx = dcTargets.indexOf(d);
        const selected = selIdx >= 0;
        const isBadgeRow = i === 0 || selected;
        const badgeContent = selected ? (selIdx+1) : block.hundred;
        return `<div class="dc-row${selected?' dc-selected':''}" data-dist="${d}">
          <span class="dc-row-dist${isBadgeRow?' dc-badge':''}">${isBadgeRow ? badgeContent : d}</span>
          <span class="dc-row-elev">${elevStr}</span>
          <span class="dc-row-wind">${windStr}</span>
        </div>`;
      }).join('');
      return `<div class="dc-block" style="flex:${block.distances.length} 1 0;">${rowsHtml}</div>`;
    }).join('');
    return `<div class="dc-grid-col">${windCellHtml}${blocksHtml}</div>`;
  }).join('');

  return `<div class="dc-main"><div class="dc-grid">${colsHtml}</div><div class="dc-toast" id="dcToast" hidden></div></div>${dcStripHtml()}`;
}
function dcWireDopeScreen(){
  dcWireStrip();
  const windCell = dcOverlayEl.querySelector('[data-role="windcell"]');
  if(windCell) dcAttachSwipeOrTap(windCell, {
    onTap: () => dcGoScreen('wind'),
    onSwipe: (logical) => dcAdjustWindSpeed(logical.dy < 0 ? 0.5 : -0.5),
  });
  dcOverlayEl.querySelectorAll('.dc-row').forEach(row => {
    row.addEventListener('click', () => dcToggleTarget(parseInt(row.dataset.dist,10)));
  });
}

/* ---- Scherm B: Windscherm ---- */
function dcDialSvg(){
  const cx=50, cy=50;
  let ticks = '';
  for(let h=0; h<12; h++){
    const angle = h*30;
    const isLong = (h===3 || h===9);
    const rOuter=45, rInner = rOuter - (isLong?10:6);
    const rad = angle*Math.PI/180;
    const x1=cx+rOuter*Math.sin(rad), y1=cy-rOuter*Math.cos(rad);
    const x2=cx+rInner*Math.sin(rad), y2=cy-rInner*Math.cos(rad);
    ticks += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="currentColor" stroke-width="${isLong?2:1}"/>`;
  }
  const rad = dcWind.angleDeg*Math.PI/180;
  const bx = cx + 40*Math.sin(rad), by = cy - 40*Math.cos(rad);
  return `<svg class="dc-dial-svg" viewBox="0 0 100 100" data-role="dial">
    <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="1"/>
    ${ticks}
    <line class="dc-dial-line" x1="50" y1="50" x2="${bx.toFixed(2)}" y2="${by.toFixed(2)}" stroke="currentColor" stroke-width="2"/>
    <circle class="dc-dial-handle" cx="${bx.toFixed(2)}" cy="${by.toFixed(2)}" r="4" fill="currentColor"/>
  </svg>`;
}
function dcWindScreenHtml(){
  return `<div class="dc-main">
    <div class="dc-wind-screen">
      <div class="dc-wind-left">
        <button class="dc-wind-back" data-act="back">&larr; DOPE</button>
        <div class="dc-wind-speed-label">WIND SPEED m/s</div>
        <div class="dc-wind-speed-value" data-role="speedval">${dcWind.speedMps.toFixed(1)}</div>
        <div class="dc-wind-speed-hint">(swipe &uarr;&darr; &plusmn;0.5)</div>
        <div class="dc-wind-pm">
          <button type="button" data-act="minus">&minus;</button>
          <button type="button" data-act="plus">+</button>
        </div>
        <div class="dc-eff-box">
          <div class="dc-eff-box-label">EFF WIND</div>
          <div class="dc-eff-box-value" data-role="effval">${dcEffWindStr()}</div>
        </div>
      </div>
      <div class="dc-wind-right">
        <div class="dc-dial-tgt">TGT</div>
        <div class="dc-dial-wrap">
          <div class="dc-dial-watermark" style="background-image:url('icons/logo.svg')"></div>
          ${dcDialSvg()}
        </div>
      </div>
    </div>
  </div>${dcStripHtml()}`;
}
function dcWireWindScreen(){
  dcWireStrip();
  const back = dcOverlayEl.querySelector('[data-act="back"]');
  if(back) back.addEventListener('click', () => dcGoScreen('dope'));
  const minus = dcOverlayEl.querySelector('[data-act="minus"]');
  const plus = dcOverlayEl.querySelector('[data-act="plus"]');
  if(minus) minus.addEventListener('click', () => dcAdjustWindSpeed(-0.5));
  if(plus) plus.addEventListener('click', () => dcAdjustWindSpeed(0.5));
  const speedVal = dcOverlayEl.querySelector('[data-role="speedval"]');
  if(speedVal) dcAttachSwipeOrTap(speedVal, { onSwipe: (logical) => dcAdjustWindSpeed(logical.dy < 0 ? 0.5 : -0.5) });
  const dial = dcOverlayEl.querySelector('[data-role="dial"]');
  if(dial) dcAttachDialDrag(dial);
}

/* ---- Scherm C: Target card ---- */
function dcTargetScreenHtml(){
  const rowsHtml = dcTargets.length ? dcTargets.map((d,i) => {
    const row = dcTable ? dcTable.get(d) : null;
    const elevStr = row && row.elevMil != null ? dcFmtElev(row.elevMil) : '—';
    const windStr = row && row.driftMilPerMps != null ? dcFmtWindHold(row.driftMilPerMps) : '—';
    const active = dcActiveTargetIdx === i;
    return `<div class="dc-target-row${active?' dc-active':''}" data-idx="${i}">
      <span class="dc-target-num">T${i+1}</span>
      <span class="dc-target-rng">${d}</span>
      <span class="dc-target-vals">${elevStr} ${windStr}</span>
    </div>`;
  }).join('') : `<div class="dc-target-empty">Nog geen doelen geselecteerd — tik op een afstandsregel in de Dope Card.</div>`;
  return `<div class="dc-main">
    <div class="dc-target-screen">
      <div class="dc-target-watermark" style="background-image:url('icons/logo.svg')"></div>
      <div class="dc-target-head">
        <button class="dc-wind-back" data-act="back">&larr; DOPE</button>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="dc-target-eff" data-role="efflabel">EFF ${dcEffWindStr()} m/s</span>
          ${dcTargets.length ? '<button type="button" class="dc-target-clr" data-act="clr">CLR</button>' : ''}
        </div>
      </div>
      <div class="dc-target-rows">${rowsHtml}</div>
    </div>
  </div>${dcStripHtml()}`;
}
function dcWireTargetScreen(){
  dcWireStrip();
  const back = dcOverlayEl.querySelector('[data-act="back"]');
  if(back) back.addEventListener('click', () => dcGoScreen('dope'));
  const clr = dcOverlayEl.querySelector('[data-act="clr"]');
  if(clr) clr.addEventListener('click', () => { dcTargets = []; dcSave(DC_TARGETS_KEY, dcTargets); dcGoScreen('dope'); });
  dcOverlayEl.querySelectorAll('.dc-target-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx,10);
      dcActiveTargetIdx = dcActiveTargetIdx === idx ? null : idx;
      dcRenderFullscreen();
    });
  });
  const effLabel = dcOverlayEl.querySelector('[data-role="efflabel"]');
  if(effLabel) dcAttachSwipeOrTap(effLabel, {
    onTap: () => dcGoScreen('wind'),
    onSwipe: (logical) => dcAdjustWindSpeed(logical.dy < 0 ? 0.5 : -0.5),
  });
}

/* ---- Render-dispatch ---- */
function dcRenderFullscreen(){
  if(!dcOverlayEl) return;
  dcOverlayEl.classList.remove('dc-theme-day','dc-theme-night');
  dcOverlayEl.classList.add(dcSettings.theme === 'night' ? 'dc-theme-night' : 'dc-theme-day');
  const inner = dcScreen === 'dope' ? dcDopeScreenHtml() : dcScreen === 'wind' ? dcWindScreenHtml() : dcTargetScreenHtml();
  dcOverlayEl.innerHTML = `<div class="dc-rotor">${inner}</div>`;
  if(dcScreen === 'dope') dcWireDopeScreen();
  else if(dcScreen === 'wind') dcWireWindScreen();
  else dcWireTargetScreen();
}

/* ======================= SETUP-SCHERM (normale app-layout) ======================= */
function dcRenderSetupScreenIfActive(){
  const root = document.getElementById('dopecardRoot');
  if(root) dcRenderSetup(root);
}
function dcRenderSetup(root){
  if(!root) return;
  const profiles = window.AppliedConceptsProfiles.load();

  if(profiles.length === 0){
    root.innerHTML = `
      <div class="simplepanel-head"><div><h2>Dope Card</h2>
        <p class="sub">Digitale dope-kaart voor op de pols — windklok, live windholds en een target card voor tot 3 doelen.</p>
      </div></div>
      <div class="dc-noprofile">
        <p class="hint">Je hebt nog geen wapenprofiel. Maak er eerst één aan bij "Wapenprofielen" (kaliber, drag model, BC, V0, zero-afstand) — de Dope Card gebruikt datzelfde profiel.</p>
        <button type="button" class="printbtn" id="dcNewProfileBtn" style="width:auto;padding:11px 22px;">Wapenprofiel aanmaken</button>
      </div>
    `;
    root.querySelector('#dcNewProfileBtn').addEventListener('click', () => {
      window.AppliedConceptsProfiles.openNewEditor();
      switchTab('profiles');
    });
    return;
  }

  if(!dcSettings.activeProfileId || !profiles.find(p=>p.id===dcSettings.activeProfileId)){
    dcSettings.activeProfileId = profiles[0].id;
  }

  root.innerHTML = `
    <div class="simplepanel-head"><div><h2>Dope Card</h2>
      <p class="sub">Digitale dope-kaart voor op de pols — windklok, live windholds en een target card voor tot 3 doelen.</p>
    </div></div>

    <fieldset class="dryfire-mode-fieldset">
      <legend>Wapen/munitie-profiel</legend>
      <label for="dcProfile">Actief profiel</label>
      <select id="dcProfile">
        ${profiles.map(p=>`<option value="${p.id}" ${p.id===dcSettings.activeProfileId?'selected':''}>${window.AppliedConceptsProfiles.escapeHtml(p.label||'(zonder naam)')}${p.caliber?' — '+window.AppliedConceptsProfiles.escapeHtml(p.caliber):''}</option>`).join('')}
      </select>
      <p class="hint" id="dcProfileError"></p>
    </fieldset>

    <fieldset class="dryfire-mode-fieldset">
      <legend>Richtmiddelhoogte (HOB)</legend>
      <div class="dryfire-mode-toggle">
        <label><input type="radio" name="dcHobSource" value="auto" ${dcSettings.hobSource==='auto'?'checked':''}> Richtmiddel + montage</label>
        <label><input type="radio" name="dcHobSource" value="manual" ${dcSettings.hobSource==='manual'?'checked':''}> Handmatig</label>
      </div>
      <div id="dcHobAutoFields" ${dcSettings.hobSource!=='auto'?'hidden':''}>
        <div class="dc-hob-row">
          <div>
            <label for="dcSight">Richtmiddel</label>
            <select id="dcSight">${SIGHTS.map(s=>`<option value="${s.id}" ${s.id===dcSettings.sightId?'selected':''}>${s.label}</option>`).join('')}</select>
          </div>
          <div>
            <label for="dcMount">Montage</label>
            <select id="dcMount">${MOUNTS.map(m=>`<option value="${m.id}" ${m.id===dcSettings.mountId?'selected':''}>${m.label}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <label for="dcHobMm">Richtmiddelhoogte (mm)</label>
      <input type="number" id="dcHobMm" step="1" min="0" value="${dcSettings.hobMm}">
    </fieldset>

    <fieldset class="dryfire-mode-fieldset">
      <legend>Omgeving</legend>
      <label for="dcTemp">Temperatuur (°C)</label>
      <input type="number" id="dcTemp" step="1" value="${dcSettings.envTempC}">
      <div class="dryfire-mode-toggle">
        <label><input type="radio" name="dcEnvMode" value="altitude" ${dcSettings.envMode==='altitude'?'checked':''}> Hoogte (m)</label>
        <label><input type="radio" name="dcEnvMode" value="pressure" ${dcSettings.envMode==='pressure'?'checked':''}> Luchtdruk (hPa)</label>
      </div>
      <input type="number" id="dcAltitude" step="10" value="${dcSettings.envAltitudeM}" ${dcSettings.envMode!=='altitude'?'hidden':''}>
      <input type="number" id="dcPressure" step="1" value="${dcSettings.envPressureHpa}" ${dcSettings.envMode!=='pressure'?'hidden':''}>
    </fieldset>

    <fieldset class="dryfire-mode-fieldset">
      <legend>Kaart</legend>
      <div class="row2">
        <div><label for="dcRangeStart">Start (m)</label><input type="number" id="dcRangeStart" step="10" value="${dcSettings.rangeStart}"></div>
        <div><label for="dcRangeEnd">Eind (m)</label><input type="number" id="dcRangeEnd" step="10" value="${dcSettings.rangeEnd}"></div>
      </div>
      <label for="dcRangeInterval">Interval (m)</label>
      <input type="number" id="dcRangeInterval" step="5" value="${dcSettings.rangeInterval}">

      <div class="st-field">Pols-modus</div>
      <div class="dryfire-mode-toggle">
        <label><input type="radio" name="dcWrist" value="device" ${dcSettings.wristMode==='device'?'checked':''}> Volg toestel</label>
        <label><input type="radio" name="dcWrist" value="left" ${dcSettings.wristMode==='left'?'checked':''}> Draai 90° links</label>
        <label><input type="radio" name="dcWrist" value="right" ${dcSettings.wristMode==='right'?'checked':''}> Draai 90° rechts</label>
      </div>

      <div class="st-field">Thema</div>
      <div class="dryfire-mode-toggle">
        <label><input type="radio" name="dcTheme" value="day" ${dcSettings.theme==='day'?'checked':''}> Dag</label>
        <label><input type="radio" name="dcTheme" value="night" ${dcSettings.theme==='night'?'checked':''}> Nacht</label>
      </div>
    </fieldset>

    <div class="dc-preview-box" id="dcPreviewBox"></div>

    <button type="button" class="printbtn" id="dcSaveBtn" style="width:100%;padding:18px;">Opslaan &amp; open Dope Card</button>
  `;

  function syncFromForm(){
    dcSettings.activeProfileId = root.querySelector('#dcProfile').value;
    dcSettings.hobSource = root.querySelector('input[name="dcHobSource"]:checked').value;
    dcSettings.sightId = root.querySelector('#dcSight').value;
    dcSettings.mountId = root.querySelector('#dcMount').value;
    dcSettings.hobMm = parseFloat(root.querySelector('#dcHobMm').value) || 0;
    dcSettings.envTempC = parseFloat(root.querySelector('#dcTemp').value) || 0;
    dcSettings.envMode = root.querySelector('input[name="dcEnvMode"]:checked').value;
    dcSettings.envAltitudeM = parseFloat(root.querySelector('#dcAltitude').value) || 0;
    dcSettings.envPressureHpa = parseFloat(root.querySelector('#dcPressure').value) || 1013.25;
    dcSettings.rangeStart = parseFloat(root.querySelector('#dcRangeStart').value) || 0;
    dcSettings.rangeEnd = parseFloat(root.querySelector('#dcRangeEnd').value) || 0;
    dcSettings.rangeInterval = Math.max(1, parseFloat(root.querySelector('#dcRangeInterval').value) || 1);
    dcSettings.wristMode = root.querySelector('input[name="dcWrist"]:checked').value;
    dcSettings.theme = root.querySelector('input[name="dcTheme"]:checked').value;
  }
  function renderPreview(){
    const f = dcFitCheck();
    const box = root.querySelector('#dcPreviewBox');
    box.className = 'dc-preview-box' + (f.fits ? '' : ' dc-preview-warn');
    box.innerHTML = f.fits
      ? `<strong>${f.totalRows} afstanden</strong> in ${f.totalBlocks} blokken — past naar schatting op één scherm (~${f.rowHeightPx.toFixed(0)}px per regel).`
      : `Te veel afstanden voor één scherm, vergroot interval of verklein bereik (geschat ~${f.rowHeightPx.toFixed(0)}px per regel, minimaal ~24px nodig).`;
    root.querySelector('#dcSaveBtn').disabled = !f.fits;
  }

  root.addEventListener('change', (e) => {
    if(e.target.name === 'dcHobSource') root.querySelector('#dcHobAutoFields').hidden = e.target.value !== 'auto';
    if(e.target.name === 'dcEnvMode'){
      root.querySelector('#dcAltitude').hidden = e.target.value !== 'altitude';
      root.querySelector('#dcPressure').hidden = e.target.value !== 'pressure';
    }
    if(e.target.id === 'dcSight' || e.target.id === 'dcMount'){
      const sight = SIGHTS.find(s=>s.id===root.querySelector('#dcSight').value);
      const mount = MOUNTS.find(m=>m.id===root.querySelector('#dcMount').value);
      let hobIn = null;
      if(mount.id !== 'none' && mount.id !== 'manual_mount') hobIn = mount.hobIn;
      else if(mount.id === 'none') hobIn = sight.hobIn;
      if(hobIn != null) root.querySelector('#dcHobMm').value = (hobIn*25.4).toFixed(0);
    }
    syncFromForm();
    renderPreview();
  });

  root.querySelector('#dcSaveBtn').addEventListener('click', () => {
    syncFromForm();
    const profile = dcGetActiveProfile();
    const input = profile ? window.AppliedConceptsProfiles.toBallisticsInput(profile) : null;
    const errEl = root.querySelector('#dcProfileError');
    if(!input){
      errEl.textContent = 'Dit profiel heeft nog geen geldige ballistische gegevens (kaliber, BC, V0, zero-afstand) — vul deze eerst aan bij Wapenprofielen.';
      return;
    }
    errEl.textContent = '';
    if(!dcFitCheck().fits) return;
    dcSave(DC_SETTINGS_KEY, dcSettings);
    dcRecomputeTable();
    dcEnterFullscreen();
  });

  renderPreview();
}

/* ======================= INIT ======================= */
function initDopeCard(){
  const root = document.getElementById('dopecardRoot');
  const profile = dcGetActiveProfile();
  const input = profile ? window.AppliedConceptsProfiles.toBallisticsInput(profile) : null;
  if(input){
    dcRecomputeTable();
    dcEnterFullscreen();
  } else {
    dcRenderSetup(root);
  }
}

window.AppliedConceptsDopeCard = { init: initDopeCard, stopTimer: dcTeardownFullscreen };
