/* ---------------------------------------------------------------------
   Applied Concepts — Wapenprofielen (weapon profiles)
   CRUD UI + localStorage persistence. Hold per afstand wordt live
   berekend via js/ballistics.js; windcall is een handmatig veld per
   afstand (geen automatische windberekening).
--------------------------------------------------------------------- */

const AC_PROFILES_KEY = 'ac_weapon_profiles_v1';
const AC_DOPE_DISTANCES_M = [100,200,300,400,500,600,700,800,900,1000];
const AC_MS_PER_FPS = 1/3.280839895;

function acLoadProfiles(){
  try {
    const raw = JSON.parse(localStorage.getItem(AC_PROFILES_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch(e){ return []; }
}
function acSaveProfiles(list){
  localStorage.setItem(AC_PROFILES_KEY, JSON.stringify(list));
}
function acGenId(){
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function acGenLogId(){
  return 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// Round-count log per profile — a plain history of shooting days (+ optional
// "onderhoud uitgevoerd" markers), not an automatic threshold/warning system
// (that was an explicit choice: the app doesn't assume a maintenance interval
// on the user's behalf, it just gives them the numbers to judge it themselves).
// Sorted by date (not insertion order) so a session logged late, out of
// order, still lands in the right place relative to a maintenance marker.
function acSortedRoundLog(profile){
  return (profile.roundLog || []).slice().sort((a,b)=> (a.date||'').localeCompare(b.date||''));
}
function acRoundsSinceMaintenance(profile){
  let sum = 0;
  acSortedRoundLog(profile).forEach(entry=>{
    if(entry.type === 'maintenance') sum = 0;
    else sum += parseFloat(entry.rounds) || 0;
  });
  return sum;
}
function acRoundsTotal(profile){
  return (profile.roundLog || []).filter(e=>e.type!=='maintenance').reduce((s,e)=>s+(parseFloat(e.rounds)||0), 0);
}
function acEscapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function acFmtMil(v){
  if(v == null || isNaN(v)) return '—';
  const s = v>=0 ? '+' : '';
  return s + v.toFixed(2);
}

function acMuzzleVelocityFps(profile){
  let v = parseFloat(profile.muzzleVelocity);
  let unit = profile.muzzleVelocityUnit;
  if(!(v > 0)){
    // Fall back to the pre-unit-toggle field (profiles saved by an older cached version).
    v = parseFloat(profile.muzzleVelocityMs);
    unit = 'ms';
  }
  if(!(v > 0)) return null;
  return unit === 'fps' ? v : v / AC_MS_PER_FPS;
}
function acSightHeightCm(profile){
  let v = parseFloat(profile.sightHeight);
  let unit = profile.sightHeightUnit;
  if(!(v >= 0) || isNaN(v)){
    // Fall back to the pre-unit-toggle field (profiles saved by an older cached version).
    v = parseFloat(profile.sightHeightCm);
    unit = 'cm';
  }
  if(!(v >= 0) || isNaN(v)) return 0;
  return unit === 'in' ? v * 2.54 : v;
}

// BC is dimensionless and, for every real G1/G7-modeled projectile, falls
// somewhere around 0.1-1.2 — values like 100 or 1000 are a data-entry
// mistake (e.g. typing "315" meaning 0.315), not a valid high-BC bullet.
// An effective BC outside this range is rejected outright rather than fed
// to the solver, which would otherwise silently produce a near-driftless
// (way too flat) trajectory and badly wrong holds.
const AC_BC_MAX_SANE = 1.5;

function acBcSanityError(bc, customDragFactor){
  if(!(bc > 0)) return null; // "not filled in yet" is handled separately, not an error
  const effective = bc * (customDragFactor > 0 ? customDragFactor : 1);
  if(effective > AC_BC_MAX_SANE){
    return `Effectieve BC (${effective.toFixed(2)}) is niet realistisch — BC ligt voor vrijwel elk projectiel tussen 0,1 en 1,0. Waarschijnlijk een tikfout (bv. "315" i.p.v. "0,315").`;
  }
  return null;
}

// Raw stored profile -> the {dragModel,bc,customDragFactor,muzzleVelocityFps,
// sightHeightCm,zeroDistanceM} shape the ballistics solver takes, with unit
// conversion and BC sanity-checking applied. Shared by the hold-table
// functions below and by Dope Card (which needs the same conversion but
// feeds its own distances/atmosphere into computeDopeCardTable instead of
// computeHoldTableMil's fixed-ICAO table).
function acProfileToBallisticsInput(profile){
  const muzzleVelocityFps = acMuzzleVelocityFps(profile);
  if(!profile.bc || !muzzleVelocityFps || !profile.zeroDistanceM) return null;
  const bc = parseFloat(profile.bc);
  const customDragFactor = parseFloat(profile.customDragFactor) || 1;
  if(acBcSanityError(bc, customDragFactor)) return null;
  const input = {
    dragModel: profile.dragModel || 'G7',
    bc,
    customDragFactor,
    muzzleVelocityFps,
    sightHeightCm: acSightHeightCm(profile),
    zeroDistanceM: parseFloat(profile.zeroDistanceM),
  };
  if(!(input.bc > 0) || !(input.muzzleVelocityFps > 0) || !(input.zeroDistanceM > 0)) return null;
  return input;
}

// Parseert "1:10" / "1:9.5" -> 10 / 9.5 (twist in inch per omwenteling).
function acParseTwistIn(str){
  const m = String(str||'').match(/1\s*:\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}
// Alles wat de Miller-stabiliteitsformule (-> spin drift, Dope Card) nodig
// heeft. Los van toBallisticsInput omdat het optioneel is (spin drift is een
// uitbreiding, geen vereiste voor de gewone hold-tabel) — null als er
// velden ontbreken, zodat de aanroeper spin drift dan gewoon niet aanbiedt.
function acProfileSpinDriftParams(profile){
  const bulletWeightGr = parseFloat(profile.bulletWeightGr);
  const bulletDiameterIn = parseFloat(profile.bulletDiameterIn);
  const bulletLengthIn = parseFloat(profile.bulletLengthIn);
  const twistIn = acParseTwistIn(profile.twistRateIn);
  const muzzleVelocityFps = acMuzzleVelocityFps(profile);
  if(!(bulletWeightGr > 0) || !(bulletDiameterIn > 0) || !(bulletLengthIn > 0) || !(twistIn > 0) || !(muzzleVelocityFps > 0)) return null;
  return { bulletWeightGr, bulletDiameterIn, bulletLengthIn, twistIn, muzzleVelocityFps };
}

function acProfileHoldTable(profile){
  const input = acProfileToBallisticsInput(profile);
  if(!input) return null;
  try {
    return window.AppliedConceptsBallistics.computeHoldTableMil(input, AC_DOPE_DISTANCES_M);
  } catch(e){
    console.error('Ballistics error', e);
    return null;
  }
}

// Hold (MIL) at an arbitrary distance (not limited to the 100m dope-table stations) —
// used by Dry Fire's "willekeurig" mode, which trains in-between distances too.
function acProfileHoldAtDistance(profile, distanceM){
  const muzzleVelocityFps = acMuzzleVelocityFps(profile);
  if(!profile.bc || !muzzleVelocityFps || !profile.zeroDistanceM) return null;
  const bc = parseFloat(profile.bc);
  const customDragFactor = parseFloat(profile.customDragFactor) || 1;
  if(acBcSanityError(bc, customDragFactor)) return null;
  const input = {
    dragModel: profile.dragModel || 'G7',
    bc,
    customDragFactor,
    muzzleVelocityFps,
    sightHeightCm: acSightHeightCm(profile),
    zeroDistanceM: parseFloat(profile.zeroDistanceM),
  };
  if(!(input.bc > 0) || !(input.muzzleVelocityFps > 0) || !(input.zeroDistanceM > 0)) return null;
  try {
    return window.AppliedConceptsBallistics.computeHoldTableMil(input, [distanceM]).get(Math.round(distanceM));
  } catch(e){
    console.error('Ballistics error', e);
    return null;
  }
}

// Windcall is manual per dope-table station — for an in-between distance, linearly
// interpolate between the two nearest stations that actually have a windcall filled in.
function acInterpolateWindcall(profile, distanceM){
  const dope = profile.dope || {};
  const known = AC_DOPE_DISTANCES_M
    .filter(d => dope[d] && dope[d].windcallMil != null)
    .map(d => [d, dope[d].windcallMil]);
  if(known.length === 0) return null;
  const exact = known.find(([d]) => d === distanceM);
  if(exact) return exact[1];
  let lower = null, upper = null;
  known.forEach(([d, v]) => {
    if(d <= distanceM && (!lower || d > lower[0])) lower = [d, v];
    if(d >= distanceM && (!upper || d < upper[0])) upper = [d, v];
  });
  if(lower && upper && lower[0] !== upper[0]){
    const t = (distanceM - lower[0]) / (upper[0] - lower[0]);
    return lower[1] + t * (upper[1] - lower[1]);
  }
  return lower ? lower[1] : (upper ? upper[1] : null);
}

let acProfilesUI = { mode: 'list', editingId: null, draft: null };

function acBlankProfile(){
  return {
    id: null, label: '', caliber: '', bulletWeightGr: '', bulletLengthIn: '', bulletDiameterIn: '',
    dragModel: 'G7', bc: '', customDragFactor: '', muzzleVelocity: '', muzzleVelocityUnit: 'ms',
    zeroDistanceM: 100, sightHeight: 5, sightHeightUnit: 'cm', twistRateIn: '', dope: {},
    roundLog: [],
  };
}

function renderProfilesTab(){
  const root = document.getElementById('profilesRoot');
  if(!root) return;
  if(acProfilesUI.mode === 'edit') acRenderProfileEditor(root);
  else acRenderProfileList(root);
}

function acRenderProfileList(root){
  const profiles = acLoadProfiles();
  root.innerHTML = `
    <div class="simplepanel-head">
      <div>
        <h2>Wapenprofielen</h2>
        <p class="sub">Vul de munitie- en optiekgegevens van je systeem in — de app berekent automatisch de hold per afstand (standaardatmosfeer op zeeniveau, geen wind/spin drift). Deze profielen gebruik je in Turret Tape en Dry Fire; windcall vul je zelf in op basis van je eigen geverifieerde dope.</p>
      </div>
      <button class="printbtn profile-newbtn" id="profileNewBtn">+ Nieuw wapenprofiel</button>
    </div>
    <div class="profile-list" id="profileListGrid"></div>
  `;
  const grid = root.querySelector('#profileListGrid');
  if(profiles.length === 0){
    grid.innerHTML = `<div class="train-placeholder"><span class="train-placeholder-icon">＋</span><span>Nog geen wapenprofielen — maak je eerste profiel aan</span></div>`;
  } else {
    grid.innerHTML = profiles.map(p => {
      const sinceM = acRoundsSinceMaintenance(p);
      const totalR = acRoundsTotal(p);
      const roundsLine = totalR > 0
        ? `${sinceM} schoten sinds onderhoud${sinceM!==totalR ? ` · ${totalR} totaal` : ''}`
        : 'Nog geen schoten gelogd';
      return `
      <div class="profile-card">
        <div class="profile-card-head">
          <span class="profile-card-name">${acEscapeHtml(p.label || 'Naamloos profiel')}</span>
          <span class="profile-card-caliber">${acEscapeHtml(p.caliber||'')}</span>
        </div>
        <div class="profile-card-meta">
          ${p.bulletWeightGr ? p.bulletWeightGr+' gr · ' : ''}${p.dragModel||''} BC ${p.bc||'?'} · ${p.muzzleVelocity? p.muzzleVelocity+' '+(p.muzzleVelocityUnit==='fps'?'fps':'m/s'):'?'} · zero ${p.zeroDistanceM||'?'} m
        </div>
        <div class="profile-card-rounds">${roundsLine}</div>
        <div class="profile-card-actions">
          <button class="profile-editbtn" data-id="${p.id}">Bewerken</button>
          <button class="profile-delbtn" data-id="${p.id}">Verwijderen</button>
        </div>
      </div>
    `;
    }).join('');
  }
  root.querySelector('#profileNewBtn').addEventListener('click', ()=>{
    acProfilesUI = { mode:'edit', editingId:null, draft: acBlankProfile() };
    renderProfilesTab();
  });
  grid.querySelectorAll('.profile-editbtn').forEach(b=>b.addEventListener('click', ()=>{
    const p = acLoadProfiles().find(x=>x.id===b.dataset.id);
    acProfilesUI = { mode:'edit', editingId:b.dataset.id, draft: JSON.parse(JSON.stringify(p)) };
    renderProfilesTab();
  }));
  grid.querySelectorAll('.profile-delbtn').forEach(b=>b.addEventListener('click', ()=>{
    if(!confirm('Dit wapenprofiel verwijderen?')) return;
    acSaveProfiles(acLoadProfiles().filter(p=>p.id!==b.dataset.id));
    renderProfilesTab();
  }));
}

const AC_CALIBERS = ['5.56x45mm','.308 Win','7.62x51mm NATO','.300 Win Mag','.300 PRC','.338 Lapua Mag','.338 Norma Mag','6.5 Creedmoor','6.5 PRC','.50 BMG'];
// Kogeldiameter per kaliber (inch) — voor de Miller-stabiliteitsformule
// (spin drift). Losstaand van de kaliber-tekst zelf, want die is niet
// betrouwbaar te parsen (".308 Win" toevallig wel de diameter, "7.62x51mm
// NATO" niet) — vandaar een expliciete tabel + een eigen, overschrijfbaar
// veld in plaats van er iets uit te raden.
const AC_CALIBER_DIAMETER_IN = {
  '5.56x45mm': 0.224, '.308 Win': 0.308, '7.62x51mm NATO': 0.308,
  '.300 Win Mag': 0.308, '.300 PRC': 0.308,
  '.338 Lapua Mag': 0.338, '.338 Norma Mag': 0.338,
  '6.5 Creedmoor': 0.264, '6.5 PRC': 0.264, '.50 BMG': 0.510,
};

// Indicatieve fabrieksladingen — vult dragModel/BC/V0 in ter referentie; de
// gebruiker wordt er expliciet op gewezen dat dit een startpunt is, geen
// vervanging voor een eigen chrono/dope. Toegevoegd voor Dope Card, maar
// hoort hier thuis: het is dezelfde "Munitie"-sectie als voor elk ander profiel.
const AC_AMMO_PRESETS = [
  { label:'5.56 M193 55gr', dragModel:'G1', bc:0.243, v0Ms:940 },
  { label:'5.56 M855 62gr', dragModel:'G7', bc:0.151, v0Ms:900 },
  { label:'5.56 Mk262 77gr', dragModel:'G7', bc:0.190, v0Ms:820 },
  { label:'7.62 M80 147gr', dragModel:'G7', bc:0.200, v0Ms:830 },
  { label:'7.62 M118LR 175gr', dragModel:'G7', bc:0.243, v0Ms:790 },
  { label:'6.5 CM 140gr ELD-M', dragModel:'G7', bc:0.326, v0Ms:820 },
  { label:'.338 LM Lapua Scenar-L 250gr (Lock Base)', dragModel:'G7', bc:0.313, v0Ms:905 },
];

function acRenderProfileEditor(root){
  const p = acProfilesUI.draft;
  root.innerHTML = `
    <div class="simplepanel-head">
      <div>
        <h2>${p.id || acProfilesUI.editingId ? 'Wapenprofiel bewerken' : 'Nieuw wapenprofiel'}</h2>
        <p class="sub">Munitie- en optiekgegevens voor de ballistische berekening. Alle velden worden lokaal op dit apparaat bewaard.</p>
      </div>
    </div>
    <form id="profileForm" class="profile-form">
      <div class="profile-form-grid">
        <fieldset>
          <legend>Wapen</legend>
          <label for="pfLabel">Naam / label</label>
          <input type="text" id="pfLabel" placeholder="bv. MSR .338 #2" value="${acEscapeHtml(p.label)}">

          <label for="pfCaliberSelect">Kaliber</label>
          <select id="pfCaliberSelect">
            ${AC_CALIBERS.map(c=>`<option value="${c}" ${p.caliber===c?'selected':''}>${c}</option>`).join('')}
            <option value="__custom__" ${!AC_CALIBERS.includes(p.caliber) ? 'selected' : ''}>Anders / handmatig</option>
          </select>
          <input type="text" id="pfCaliber" placeholder="bv. 9x19mm" value="${acEscapeHtml(p.caliber)}" ${AC_CALIBERS.includes(p.caliber) ? 'hidden' : ''}>
          <!-- iOS Safari geeft een <input list=datalist> geen betrouwbare dropdown-UI — vandaar een echte <select>, met deze vrije-tekstinvoer als fallback voor kalibers die er niet in staan. -->

          <label for="pfTwist">Twist rate</label>
          <input type="text" id="pfTwist" placeholder="bv. 1:10" value="${acEscapeHtml(p.twistRateIn)}">
          <p class="hint">Rechtsdraaiend aangenomen (verreweg de meeste moderne geweren) — samen met kogeldiameter, -lengte en -gewicht gebruikt voor de spin drift-berekening in Dope Card.</p>
        </fieldset>

        <fieldset>
          <legend>Munitie</legend>
          <label for="pfAmmoPreset">Snelle preset</label>
          <select id="pfAmmoPreset">
            <option value="">— kies een fabrieksladingprofiel —</option>
            ${AC_AMMO_PRESETS.map((preset,i)=>`<option value="${i}">${acEscapeHtml(preset.label)}</option>`).join('')}
          </select>
          <p class="hint">Indicatieve waarden, verifieer met eigen chrono/data — vult hieronder drag model, BC en V0 in.</p>

          <label for="pfBulletWeight">Bullet weight (gr)</label>
          <input type="number" id="pfBulletWeight" step="0.1" min="0" value="${acEscapeHtml(p.bulletWeightGr)}">

          <label for="pfBulletDiameter">Kogeldiameter (inch)</label>
          <input type="number" id="pfBulletDiameter" step="0.001" min="0" value="${acEscapeHtml(p.bulletDiameterIn)}">
          <p class="hint">Automatisch ingevuld op basis van het kaliber hierboven — overschrijf indien nodig.</p>

          <label for="pfBulletLength">Bullet length (inch)</label>
          <input type="number" id="pfBulletLength" step="0.001" min="0" value="${acEscapeHtml(p.bulletLengthIn)}">

          <label for="pfDragModel">Drag model</label>
          <select id="pfDragModel">
            <option value="G7" ${p.dragModel==='G7'?'selected':''}>G7 (boat-tail / long-range match)</option>
            <option value="G1" ${p.dragModel==='G1'?'selected':''}>G1 (algemeen / flat-base)</option>
          </select>

          <div class="row2">
            <div>
              <label for="pfBc">Ballistic coefficient (BC)</label>
              <input type="number" id="pfBc" step="0.001" min="0" max="2" value="${acEscapeHtml(p.bc)}">
            </div>
            <div>
              <label for="pfDragFactor">Custom drag factor</label>
              <input type="number" id="pfDragFactor" step="0.001" min="0" placeholder="1.0" value="${acEscapeHtml(p.customDragFactor)}">
            </div>
          </div>
          <p class="hint">BC ligt voor vrijwel elk projectiel tussen 0,1 en 1,0 (G1 doorgaans hoger dan G7 voor dezelfde kogel) — géén waarde als 100 of 1000 invullen. Custom drag factor is een optionele vermenigvuldiger op de BC (leeg = 1,0) voor als jouw kogel niet precies het standaard G1/G7-profiel volgt.</p>

          <label for="pfMv">Mondingssnelheid V0</label>
          <div class="row2">
            <input type="number" id="pfMv" step="1" min="0" value="${acEscapeHtml(p.muzzleVelocity)}">
            <select id="pfMvUnit">
              <option value="ms" ${p.muzzleVelocityUnit!=='fps'?'selected':''}>m/s</option>
              <option value="fps" ${p.muzzleVelocityUnit==='fps'?'selected':''}>fps</option>
            </select>
          </div>
        </fieldset>

        <fieldset>
          <legend>Montage &amp; zero</legend>
          <label for="pfSightHeight">Sight height</label>
          <div class="row2">
            <input type="number" id="pfSightHeight" step="0.01" min="0" value="${acEscapeHtml(p.sightHeight)}">
            <select id="pfSightHeightUnit">
              <option value="cm" ${p.sightHeightUnit!=='in'?'selected':''}>cm</option>
              <option value="in" ${p.sightHeightUnit==='in'?'selected':''}>inch</option>
            </select>
          </div>

          <label for="pfZero">Zero-afstand (m)</label>
          <input type="number" id="pfZero" step="1" min="1" value="${acEscapeHtml(p.zeroDistanceM)}">

          <p class="hint">Berekening gebruikt een vaste standaardatmosfeer (zeeniveau, 15°C) — geen hoogte/temperatuur-invoer. Beschouw de hold als uitgangspunt en controleer altijd met live-fire dope.</p>
        </fieldset>
      </div>

      <div class="dope-section">
        <h3>Dope-tabel (MIL)</h3>
        <p class="hint">Hold wordt automatisch berekend zodra bovenstaande gegevens compleet zijn. Windcall vul je zelf in per afstand.</p>
        <div id="dopeTableWrap"></div>
      </div>

      <div class="profile-form-actions">
        <button type="submit" class="printbtn" id="profileSaveBtn">Profiel opslaan</button>
        <button type="button" class="profile-cancelbtn" id="profileCancelBtn">Annuleren</button>
      </div>
    </form>

    <div class="maintenance-section" id="maintenanceSection"></div>
  `;

  const form = root.querySelector('#profileForm');
  const fieldIds = {
    label:'pfLabel', caliber:'pfCaliber', twistRateIn:'pfTwist',
    bulletWeightGr:'pfBulletWeight', bulletLengthIn:'pfBulletLength', bulletDiameterIn:'pfBulletDiameter', dragModel:'pfDragModel',
    bc:'pfBc', customDragFactor:'pfDragFactor', muzzleVelocity:'pfMv', muzzleVelocityUnit:'pfMvUnit',
    sightHeight:'pfSightHeight', sightHeightUnit:'pfSightHeightUnit', zeroDistanceM:'pfZero',
  };

  function syncDraftFromForm(){
    Object.entries(fieldIds).forEach(([key, id])=>{ p[key] = form.querySelector('#'+id).value; });
  }
  function renderDopeTable(){
    const holdTable = acProfileHoldTable(p);
    const bcError = acBcSanityError(parseFloat(p.bc), parseFloat(p.customDragFactor) || 1);
    const wrap = root.querySelector('#dopeTableWrap');
    wrap.innerHTML = `
      ${bcError ? `<p class="warn">${acEscapeHtml(bcError)}</p>` : ''}
      <table class="dope-table">
        <thead><tr><th>Afstand</th><th>Hold (MIL)</th><th>Windcall (MIL)</th></tr></thead>
        <tbody>${AC_DOPE_DISTANCES_M.map(d=>{
          const hold = holdTable ? holdTable.get(d) : null;
          const wc = (p.dope && p.dope[d] && p.dope[d].windcallMil != null) ? p.dope[d].windcallMil : '';
          return `<tr>
            <td>${d} m</td>
            <td class="dope-hold">${holdTable ? (hold==null ? '—' : acFmtMil(hold)) : '—'}</td>
            <td><input type="number" step="0.01" class="dope-windcall" data-dist="${d}" value="${acEscapeHtml(wc)}" placeholder="—"></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      ${holdTable || bcError ? '' : '<p class="hint">Vul kaliber, BC, mondingssnelheid en zero-afstand in om de hold te berekenen.</p>'}
    `;
    wrap.querySelectorAll('.dope-windcall').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        p.dope = p.dope || {};
        const d = inp.dataset.dist;
        const val = inp.value === '' ? null : parseFloat(inp.value);
        p.dope[d] = { windcallMil: val };
      });
    });
  }

  form.addEventListener('input', (e)=>{
    if(e.target.classList.contains('dope-windcall')) return; // has its own listener; avoid rebuilding the table mid-keystroke
    syncDraftFromForm();
    renderDopeTable();
  });
  root.querySelector('#pfCaliberSelect').addEventListener('change', (e)=>{
    const customInput = form.querySelector('#pfCaliber');
    if(e.target.value === '__custom__'){
      customInput.hidden = false;
      customInput.value = AC_CALIBERS.includes(p.caliber) ? '' : p.caliber;
      customInput.focus();
    } else {
      customInput.hidden = true;
      customInput.value = e.target.value;
      if(AC_CALIBER_DIAMETER_IN[e.target.value] != null) form.querySelector('#pfBulletDiameter').value = AC_CALIBER_DIAMETER_IN[e.target.value];
    }
    syncDraftFromForm();
    renderDopeTable();
  });
  root.querySelector('#pfAmmoPreset').addEventListener('change', (e)=>{
    const preset = AC_AMMO_PRESETS[e.target.value];
    if(!preset) return;
    form.querySelector('#pfDragModel').value = preset.dragModel;
    form.querySelector('#pfBc').value = preset.bc;
    form.querySelector('#pfMv').value = preset.v0Ms;
    form.querySelector('#pfMvUnit').value = 'ms';
    syncDraftFromForm();
    renderDopeTable();
  });
  renderDopeTable();

  // Round-count log is persisted immediately (not gated behind "Profiel
  // opslaan") — logging a range day is its own action, and shouldn't be
  // lost if the user later hits "Annuleren" on an unrelated ballistic-field
  // edit. Persisting also re-syncs from the live form first, so an
  // in-progress ballistic edit never gets silently reverted by this.
  function persistProfile(){
    syncDraftFromForm();
    const list = acLoadProfiles();
    const idx = list.findIndex(x=>x.id===acProfilesUI.editingId);
    if(idx>=0){ list[idx] = { ...p, id: acProfilesUI.editingId }; acSaveProfiles(list); }
  }
  function addSession(){
    const dateEl = root.querySelector('#mlDate');
    const roundsEl = root.querySelector('#mlRounds');
    const noteEl = root.querySelector('#mlNote');
    const rounds = parseFloat(roundsEl.value);
    if(!(rounds > 0)){ roundsEl.focus(); return; }
    p.roundLog = p.roundLog || [];
    p.roundLog.push({ id: acGenLogId(), type:'session', date: dateEl.value || new Date().toISOString().slice(0,10), rounds, note: noteEl.value.trim() });
    persistProfile();
    renderMaintenanceSection();
  }
  function addMaintenanceMarker(){
    p.roundLog = p.roundLog || [];
    p.roundLog.push({ id: acGenLogId(), type:'maintenance', date: new Date().toISOString().slice(0,10), note:'' });
    persistProfile();
    renderMaintenanceSection();
  }
  function deleteLogEntry(logId){
    p.roundLog = (p.roundLog || []).filter(e=>e.id!==logId);
    persistProfile();
    renderMaintenanceSection();
  }
  function renderMaintenanceSection(){
    const wrap = root.querySelector('#maintenanceSection');
    if(!acProfilesUI.editingId){
      wrap.innerHTML = `
        <h3>Onderhoud — schietdagen</h3>
        <p class="hint">Sla dit profiel eerst op (hierboven) om schietdagen te kunnen loggen.</p>
      `;
      return;
    }
    const sinceM = acRoundsSinceMaintenance(p);
    const totalR = acRoundsTotal(p);
    const sortedLog = acSortedRoundLog(p).reverse();
    const today = new Date().toISOString().slice(0,10);
    wrap.innerHTML = `
      <h3>Onderhoud — schietdagen</h3>
      <p class="hint">Log na een schietdag hoeveel patronen je hebt verschoten, zodat je inzicht houdt in wanneer onderhoud weer aan de beurt is — de app bepaalt zelf geen interval, dat beoordeel je zelf.</p>
      <div class="maintenance-summary">
        <div class="maintenance-stat"><span class="maintenance-stat-num">${sinceM}</span><span class="maintenance-stat-label">sinds laatste onderhoud</span></div>
        <div class="maintenance-stat"><span class="maintenance-stat-num">${totalR}</span><span class="maintenance-stat-label">totaal gelogd</span></div>
      </div>
      <div class="maintenance-add-row">
        <input type="date" id="mlDate" value="${today}">
        <input type="number" id="mlRounds" min="1" step="1" placeholder="aantal patronen">
        <input type="text" id="mlNote" placeholder="notitie (optioneel)">
        <button type="button" class="printbtn" id="mlAddBtn">+ Schietdag loggen</button>
      </div>
      <button type="button" class="profile-cancelbtn maintenance-resetbtn" id="mlMaintBtn">Onderhoud uitgevoerd — teller resetten</button>
      ${sortedLog.length ? `
      <table class="maintenance-log-table">
        <thead><tr><th>Datum</th><th>Type</th><th>Patronen</th><th>Notitie</th><th></th></tr></thead>
        <tbody>${sortedLog.map(e=>`
          <tr class="${e.type==='maintenance'?'maintenance-row':''}">
            <td>${acEscapeHtml(e.date||'—')}</td>
            <td>${e.type==='maintenance'?'Onderhoud':'Schietdag'}</td>
            <td>${e.type==='maintenance'?'—':(e.rounds||0)}</td>
            <td>${acEscapeHtml(e.note||'')}</td>
            <td><button type="button" class="maintenance-delbtn" data-log-id="${e.id}" title="Verwijderen">×</button></td>
          </tr>
        `).join('')}</tbody>
      </table>` : '<p class="hint">Nog geen schietdagen gelogd.</p>'}
    `;
    wrap.querySelector('#mlAddBtn').addEventListener('click', addSession);
    wrap.querySelector('#mlMaintBtn').addEventListener('click', ()=>{
      if(!confirm('Onderhoud markeren als uitgevoerd vandaag? De teller "sinds laatste onderhoud" gaat terug naar 0 — de geschiedenis blijft bewaard.')) return;
      addMaintenanceMarker();
    });
    wrap.querySelectorAll('.maintenance-delbtn').forEach(b=>b.addEventListener('click', ()=>{
      deleteLogEntry(b.dataset.logId);
    }));
  }
  renderMaintenanceSection();

  root.querySelector('#profileCancelBtn').addEventListener('click', ()=>{
    acProfilesUI = { mode:'list', editingId:null, draft:null };
    renderProfilesTab();
  });

  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    syncDraftFromForm();
    const list = acLoadProfiles();
    if(acProfilesUI.editingId){
      const idx = list.findIndex(x=>x.id===acProfilesUI.editingId);
      if(idx>=0) list[idx] = { ...p, id: acProfilesUI.editingId };
    } else {
      list.push({ ...p, id: acGenId() });
    }
    acSaveProfiles(list);
    acProfilesUI = { mode:'list', editingId:null, draft:null };
    renderProfilesTab();
  });
}

// Opens the profile editor directly (used by the Dry Fire tab's "maak wapenprofiel aan" link).
function acOpenNewProfileEditor(){
  acProfilesUI = { mode:'edit', editingId:null, draft: acBlankProfile() };
  renderProfilesTab();
}

window.AppliedConceptsProfiles = {
  render: renderProfilesTab,
  openNewEditor: acOpenNewProfileEditor,
  load: acLoadProfiles,
  DOPE_DISTANCES_M: AC_DOPE_DISTANCES_M,
  holdTableFor: acProfileHoldTable,
  holdAtDistance: acProfileHoldAtDistance,
  interpolateWindcall: acInterpolateWindcall,
  bcSanityError: acBcSanityError,
  fmtMil: acFmtMil,
  escapeHtml: acEscapeHtml,
  toBallisticsInput: acProfileToBallisticsInput,
  spinDriftParams: acProfileSpinDriftParams,
};
