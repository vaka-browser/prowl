'use strict';
/* Körs i varje webbsidas kontext (isolerat). Sköter autofyll av sparade
 * inloggningar och fångar nya när du loggar in. Allt defensivt – får aldrig
 * krascha sidan. */
const { ipcRenderer } = require('electron');

function findFields() {
  const pw = document.querySelector('input[type=password]');
  if (!pw) return null;
  const scope = pw.form || document;
  const inputs = Array.from(scope.querySelectorAll('input'));
  let user = null;
  for (const inp of inputs) {
    if (inp === pw) break;
    const t = (inp.type || 'text').toLowerCase();
    if (['text', 'email', 'tel'].includes(t) || /user|email|e-?post|login|namn/i.test(inp.name || '')) user = inp;
  }
  if (!user) user = inputs.find((i) => i !== pw && ['text', 'email', 'tel'].includes((i.type || 'text').toLowerCase())) || null;
  return { pw, user };
}

let _creds; // cred-cache per origin: undefined=ej hämtat, null=inget sparat, obj=inloggning
async function getCreds() {
  if (_creds !== undefined) return _creds;
  try { _creds = await ipcRenderer.invoke('pw:get', location.origin); } catch { _creds = null; }
  return _creds;
}
async function autofill() {
  try {
    const f = findFields(); if (!f) return;
    const creds = await getCreds();
    if (!creds || creds.autofill === false) return;   // inget sparat, eller autofyll avstängt för sidan
    if (f.user && !f.user.value) { f.user.value = creds.username; f.user.dispatchEvent(new Event('input', { bubbles: true })); }
    if (f.pw && !f.pw.value) { f.pw.value = creds.password; f.pw.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch {}
}

function hookCapture() {
  try {
    let last = null;          // senast ifyllda inloggning – uppdateras medan man skriver
    let sentSig = '';         // dedup: skicka inte samma inloggning två gånger
    function capture() {
      const f = findFields();
      if (f && f.pw && f.pw.value) last = { origin: location.origin, username: (f && f.user && f.user.value) || '', password: f.pw.value };
    }
    function fire() {
      if (!last || !last.password) return;
      const sig = last.origin + '|' + last.username + '|' + last.password;
      if (sig === sentSig) return;
      sentSig = sig;
      ipcRenderer.send('pw:capture', last);
    }
    const LOGINBTN = /logga ?in|logga|sign ?in|log ?in|login|fortsätt|forts|continue|nästa|next|verifiera|verify|submit|skicka/i;
    // Håll inloggningen i minnet medan användaren skriver – så värdet finns kvar även om sidans JS tömmer fältet.
    document.addEventListener('input', (e) => { const t = e.target; if (t && t.tagName === 'INPUT') capture(); }, true);
    // 1) Klassiskt <form>-submit.
    document.addEventListener('submit', () => { capture(); setTimeout(fire, 0); }, true);
    // 2) Klick på inloggningsknapp (SPA/JS-login helt utan form-submit).
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest && e.target.closest('button,[type=submit],[role=button],a,input[type=submit],input[type=button]');
      if (!t) return;
      const txt = ((t.innerText || t.textContent || '') + ' ' + (t.value || '') + ' ' + ((t.getAttribute && t.getAttribute('aria-label')) || '')).trim();
      if (LOGINBTN.test(txt)) { capture(); setTimeout(fire, 250); }
    }, true);
    // 3) Enter i lösenords-/inloggningsfält.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (t && t.tagName === 'INPUT' && ['password', 'text', 'email', 'tel'].includes((t.type || '').toLowerCase())) { capture(); setTimeout(fire, 250); }
    }, true);
    // 4) SPA: lösenordsfältet försvinner ur DOM (inloggningen gick igenom, vyn byttes) → erbjud att spara.
    try {
      const mo = new MutationObserver(() => { if (last && last.password && !document.querySelector('input[type=password]')) fire(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  } catch {}
}

/* ── Vaka Wallet: kortfält i kassor ──────────────────────────────────────
 * Hittar kortfält (nummer/giltighet/CVC/namn) via autocomplete-attribut och
 * vanliga namn/id-mönster. När du klickar i ett kortfält i en kassa fälls en
 * liten väljare ut under fältet med dina sparade kort (Chrome-stil) – ett
 * klick fyller i hela kortet. Vid köp fångas nya kort → erbjudande om att
 * spara. Väljaren ritas i en shadow-DOM så sajtens CSS inte kan röra den, och
 * bara märke/sista fyra/innehavare finns i DOM:en – hela kortnumret hämtas
 * först när du valt ett kort, direkt från det krypterade valvet. */
const CARD_SEL = 'input, select, [contenteditable="true"]';
function fieldHay(el) {
  try {
    return [el.getAttribute && el.getAttribute('autocomplete'), el.name, el.id,
      el.getAttribute && el.getAttribute('aria-label'), el.placeholder,
      el.getAttribute && el.getAttribute('data-testid')]
      .map((s) => (s || '').toLowerCase()).join(' ');
  } catch { return ''; }
}
function pick(re, extra) {
  const els = Array.from(document.querySelectorAll(CARD_SEL));
  for (const el of els) {
    if (el.type === 'hidden' || el.type === 'password') continue;
    const hay = fieldHay(el);
    if (re.test(hay)) return el;
    if (extra && extra.test(hay)) return el;
  }
  return null;
}
const RE_NUMBER = /\bcc-number\b|cardnumber|card-number|cardnum|ccnum|\bcc-num\b/;
const RE_NUMBER2 = /\bcard\b.*\bnumber\b|\bnumber\b.*\bcard\b/;
const RE_EXP = /\bcc-exp\b|cc-expiry|card-expiry|\bexpiry\b|\bexp-date\b|expiration|\bmm\s*\/?\s*yy\b/;
const RE_MM = /(^|[^a-z])mm([^a-z]|$)/;
const RE_YY = /(^|[^a-z])yy(yy)?([^a-z]|$)/;
const RE_CVC = /\bcc-csc\b|\bcvc\b|\bcvv\b|\bcsc\b|security-code|securitycode/;
const RE_HOLDER = /\bcc-name\b|cardholder|card-name|card-holder|name-on-card|nameoncard/;
/* Ett svep över formuläret där varje fält får EN roll. Ordningen är viktig:
 * "cc-exp-month" är en månadsrullgardin, inte ett samlat giltighetsfält. */
function findCardFields() {
  const number = pick(RE_NUMBER, RE_NUMBER2);
  if (!number) return null;
  const scope = number.form || document;               // håll oss i kassan – inte hela sidan
  const f = { number, exp: null, expMonth: null, expYear: null, cvc: null, holder: null };
  for (const el of Array.from(scope.querySelectorAll(CARD_SEL))) {
    if (el === number || el.type === 'hidden' || el.type === 'password') continue;
    const h = fieldHay(el);
    if (!f.cvc && RE_CVC.test(h)) { f.cvc = el; continue; }
    if (!f.holder && RE_HOLDER.test(h)) { f.holder = el; continue; }
    if (/month|year/.test(h)) {                        // delad giltighet
      if (!f.expMonth && /month/.test(h)) f.expMonth = el;
      else if (!f.expYear && /year/.test(h)) f.expYear = el;
      continue;
    }
    const mm = RE_MM.test(h), yy = RE_YY.test(h);
    if (!f.exp && mm && yy) { f.exp = el; continue; }   // "MM/ÅÅ" i ett och samma fält
    if (!f.exp && RE_EXP.test(h)) { f.exp = el; continue; }
    if (!f.expMonth && mm) { f.expMonth = el; continue; }
    if (!f.expYear && yy) { f.expYear = el; continue; }
  }
  if (f.exp) { f.expMonth = null; f.expYear = null; }   // samlat fält vinner över delade
  return f;
}
function isCardField(el, f) {
  return !!el && (el === f.number || el === f.exp || el === f.expMonth || el === f.expYear || el === f.cvc || el === f.holder);
}
/* Sätt värde så att även React/Vue-kassor uppfattar det (native setter + input/change). */
function setVal(el, v, force) {
  if (!el || v == null || v === '') return;
  try {
    if (el.isContentEditable) { if (!force && el.textContent) return; el.textContent = v; }
    else {
      if (el.value && !force) return;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, v); else el.value = v;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {}
}
/* Rullgardin (månad/år): välj den option vars värde eller text matchar. */
function setSelect(el, cands, force) {
  if (!el || !el.options) return false;
  if (el.selectedIndex > 0 && !force) return true;
  const want = cands.filter(Boolean).map((s) => String(s).replace(/^0+/, '') || '0');
  for (const o of Array.from(el.options)) {
    for (const cand of [o.value, o.textContent]) {
      const c = String(cand || '').trim().replace(/^0+/, '');
      if (c && want.includes(c)) { setVal(el, o.value, true); return true; }
    }
  }
  return false;
}
function expParts(exp) {
  const d = String(exp || '').replace(/\D/g, '');
  if (d.length < 3) return null;
  const mm = d.slice(0, 2), rest = d.slice(2);
  return { mm, yy2: rest.slice(-2), yy4: rest.length >= 4 ? rest.slice(-4) : '20' + rest.slice(-2) };
}
function fillCard(f, card) {
  if (!f || !card) return;
  setVal(f.number, card.number, true);
  setVal(f.holder, card.holder, true);
  setVal(f.cvc, card.cvc, true);
  const p = expParts(card.exp);
  if (f.exp) {
    // Behåll sajtens egen formatering om fältet bara tar siffror (maxlength 4/5).
    const ml = parseInt(f.exp.getAttribute && f.exp.getAttribute('maxlength'), 10);
    setVal(f.exp, p && ml === 4 ? p.mm + p.yy2 : card.exp, true);
  }
  if (p && f.expMonth && !setSelect(f.expMonth, [p.mm], true)) setVal(f.expMonth, p.mm, true);
  if (p && f.expYear && !setSelect(f.expYear, [p.yy4, p.yy2], true)) {
    const ml = parseInt(f.expYear.getAttribute && f.expYear.getAttribute('maxlength'), 10);
    setVal(f.expYear, ml === 2 ? p.yy2 : p.yy4, true);
  }
}
function readCard(f) {
  const val = (el) => (el ? (el.isContentEditable ? el.textContent : el.value) || '' : '');
  let exp = val(f.exp);
  if (!exp && (f.expMonth || f.expYear)) {
    const m = val(f.expMonth), y = val(f.expYear);
    if (m && y) exp = String(m).padStart(2, '0') + '/' + String(y).slice(-2);
  }
  return { number: val(f.number), exp, cvc: val(f.cvc), holder: val(f.holder) };
}

/* ── Kortväljaren (fälls ut under fältet man klickar i) ── */
let wlHost = null, wlShadow = null, wlField = null, wlFields = null, wlRows = [], wlIdx = -1, wlBusy = false;
const WL_CSS = `
:host{all:initial}
.box{position:fixed;z-index:2147483647;min-width:270px;max-width:460px;box-sizing:border-box;
  font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#fff;color:#0e2a47;border:1px solid rgba(14,42,71,.14);border-radius:12px;
  box-shadow:0 12px 34px rgba(14,42,71,.22);overflow:hidden;padding:4px}
.hd{display:flex;align-items:center;gap:6px;padding:7px 10px 6px;font-size:11px;font-weight:700;
  letter-spacing:.03em;text-transform:uppercase;color:rgba(14,42,71,.45)}
.hd svg{width:13px;height:13px;flex:none}
.row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer}
.row:hover,.row.on{background:rgba(14,42,71,.07)}
.badge{flex:none;width:34px;height:23px;border-radius:5px;background:linear-gradient(135deg,#0e2a47,#1e4b7a);
  color:#fff;font-size:8px;font-weight:800;display:flex;align-items:center;justify-content:center;letter-spacing:.02em}
.t{min-width:0;flex:1}
.t1{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t2{font-size:11px;color:rgba(14,42,71,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sep{height:1px;background:rgba(14,42,71,.1);margin:4px 6px}
.mng{padding:8px 10px;border-radius:9px;cursor:pointer;font-size:12px;font-weight:600;color:rgba(14,42,71,.62)}
.mng:hover,.mng.on{background:rgba(14,42,71,.07);color:#0e2a47}
.box.dark{background:#141b24;color:#e8eef6;border-color:rgba(255,255,255,.12);box-shadow:0 12px 34px rgba(0,0,0,.55)}
.box.dark .hd{color:rgba(232,238,246,.45)}
.box.dark .row:hover,.box.dark .row.on,.box.dark .mng:hover,.box.dark .mng.on{background:rgba(255,255,255,.09)}
.box.dark .t2{color:rgba(232,238,246,.5)}
.box.dark .sep{background:rgba(255,255,255,.12)}
.box.dark .mng{color:rgba(232,238,246,.6)}`;
/* Följ SIDANS ljusa/mörka läge (inte systemets) – annars blir väljaren mörk på en vit kassa. */
function pageIsDark(el) {
  try {
    let n = el;
    while (n && n.nodeType === 1) {
      const m = (getComputedStyle(n).backgroundColor || '').match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(',').map(Number), a = p.length > 3 ? p[3] : 1;
        if (a > 0.2) return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255 < 0.5;
      }
      n = n.parentElement;
    }
    const cs = getComputedStyle(document.documentElement).colorScheme || '';
    if (/dark/.test(cs) && !/light/.test(cs)) return true;
  } catch {}
  return false;
}
const BRAND_TAG = { Visa: 'VISA', Mastercard: 'MC', Amex: 'AMEX', Discover: 'DISC' };
function wlClose() {
  try { if (wlHost) wlHost.remove(); } catch {}
  wlHost = null; wlShadow = null; wlField = null; wlFields = null; wlRows = []; wlIdx = -1;
}
function wlPosition() {
  if (!wlHost || !wlField || !wlShadow) return;
  const box = wlShadow.querySelector('.box'); if (!box) return;
  let r;
  try { r = wlField.getBoundingClientRect(); } catch { return wlClose(); }
  if (!r || (!r.width && !r.height)) return wlClose();                       // fältet borta/dolt
  const vw = window.innerWidth, vh = window.innerHeight;
  box.style.width = Math.max(270, Math.min(460, Math.round(r.width))) + 'px';
  const h = box.offsetHeight || 140, w = box.offsetWidth || 280;
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - 4 - h > 8) top = r.top - 4 - h;            // fäll uppåt om det inte får plats
  box.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
  box.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
}
function wlHighlight(i) {
  wlIdx = i;
  wlRows.forEach((el, n) => el.classList.toggle('on', n === i));
}
async function wlPickRow(i) {
  const el = wlRows[i]; if (!el || wlBusy) return;
  const f = wlFields;
  if (el.dataset.act === 'manage') { wlClose(); try { ipcRenderer.send('wallet:open-manager'); } catch {} return; }
  wlBusy = true;
  try {
    const card = await ipcRenderer.invoke('wallet:get', el.dataset.id);
    wlClose();
    if (card) fillCard(f, card);
  } catch { wlClose(); } finally { wlBusy = false; }
}
async function wlOpen(field, fields) {
  if (wlHost && wlField === field) return;                                    // redan öppen för fältet
  let menu = null;
  try { menu = await ipcRenderer.invoke('wallet:menu'); } catch {}
  if (!menu || !menu.cards || !menu.cards.length) return;
  if (document.activeElement !== field) return;                               // fokus hann flytta
  wlClose();
  wlFields = fields; wlField = field;
  const L = menu.labels || {};
  wlHost = document.createElement('vaka-wallet-picker');
  const sh = wlHost.attachShadow({ mode: 'closed' });
  wlShadow = sh;
  const st = document.createElement('style'); st.textContent = WL_CSS; sh.appendChild(st);
  const box = document.createElement('div'); box.className = 'box' + (pageIsDark(field) ? ' dark' : ''); sh.appendChild(box);
  const hd = document.createElement('div'); hd.className = 'hd';
  hd.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/></svg>';
  hd.appendChild(document.createTextNode(L.choose || 'Välj kort'));
  box.appendChild(hd);
  wlRows = [];
  for (const c of menu.cards) {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.id = c.id;
    const b = document.createElement('div'); b.className = 'badge'; b.textContent = BRAND_TAG[c.brand] || 'KORT';
    const t = document.createElement('div'); t.className = 't';
    const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = (c.nick || c.brand || 'Kort') + ' •••• ' + (c.last4 || '');
    const t2 = document.createElement('div'); t2.className = 't2';
    t2.textContent = [c.holder, c.exp ? (L.exp || 'Giltigt till') + ' ' + c.exp : ''].filter(Boolean).join(' · ');
    t.appendChild(t1); if (t2.textContent) t.appendChild(t2);
    row.appendChild(b); row.appendChild(t);
    box.appendChild(row); wlRows.push(row);
  }
  const sep = document.createElement('div'); sep.className = 'sep'; box.appendChild(sep);
  const mng = document.createElement('div'); mng.className = 'mng'; mng.dataset.act = 'manage';
  mng.textContent = L.manage || 'Hantera kort';
  box.appendChild(mng); wlRows.push(mng);
  // Klick i väljaren får aldrig ta fokus från fältet (då stängs den).
  box.addEventListener('pointerdown', (e) => e.preventDefault(), true);
  box.addEventListener('mousedown', (e) => e.preventDefault(), true);
  wlRows.forEach((el, i) => {
    el.addEventListener('mouseenter', () => wlHighlight(i));
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); wlPickRow(i); });
  });
  (document.body || document.documentElement).appendChild(wlHost);
  wlPosition();
}
function wlMaybeOpen(target) {
  try {
    if (!target || !target.tagName || target === wlHost) return;
    const f = findCardFields(); if (!f) return;
    if (!isCardField(target, f)) { if (wlHost) wlClose(); return; }
    wlOpen(target, f);
  } catch {}
}
function walletRun() {
  try {
    // Väljaren: öppna när man klickar/tabbar in i ett kortfält – funkar även på
    // kassor som ritas ut i efterhand (delegerat på document).
    document.addEventListener('focusin', (e) => wlMaybeOpen(e.target), true);
    document.addEventListener('click', (e) => wlMaybeOpen(e.target), true);
    document.addEventListener('pointerdown', (e) => { if (wlHost && e.target !== wlHost && e.target !== wlField) wlClose(); }, true);
    document.addEventListener('focusout', (e) => { if (wlHost && e.target === wlField) setTimeout(() => { if (wlHost && document.activeElement !== wlField) wlClose(); }, 120); }, true);
    document.addEventListener('keydown', (e) => {
      if (!wlHost) return;
      if (e.key === 'Escape') { wlClose(); e.stopPropagation(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const n = wlRows.length; if (!n) return;
        wlHighlight(((wlIdx + (e.key === 'ArrowDown' ? 1 : -1)) + n) % n);
        return;
      }
      if (e.key === 'Enter' && wlIdx >= 0) { e.preventDefault(); e.stopPropagation(); wlPickRow(wlIdx); return; }
      if (e.key === 'Tab') wlClose();
    }, true);
    window.addEventListener('scroll', () => wlPosition(), true);
    window.addEventListener('resize', () => wlPosition());
    window.addEventListener('pagehide', wlClose);

    // Fånga kort vid köp (submit eller klick på köp-knapp) → erbjud att spara.
    const capture = () => {
      try {
        const f = findCardFields(); if (!f) return;
        const c = readCard(f);
        if (c.number.replace(/\D/g, '').length >= 12) ipcRenderer.send('wallet:capture', c);
      } catch {}
    };
    document.addEventListener('submit', capture, true);
    document.addEventListener('click', (e) => { const t = e.target && e.target.closest && e.target.closest('button,[type=submit],a'); if (t && /betala|köp|pay|order|slutför|checkout|purchase/i.test(t.textContent || '')) setTimeout(capture, 0); }, true);
  } catch {}
}
/* Bakåtkompatibelt: skalet kan fortfarande be oss fylla i ett kort. */
ipcRenderer.on('wallet-do-fill', (_e, card) => {
  try { const f = findCardFields(); if (f) fillCard(f, card); } catch {}
});

function run() {
  autofill(); hookCapture(); walletRun();
  // Autofyll igen när inloggningsrutan dyker upp senare (SPA/dynamiskt) eller vid route-byte – inte bara vid sidladdning.
  try {
    let done = false, timer = null;
    const attempt = () => { if (!done) autofill(); };
    const mo = new MutationObserver(() => { if (done) return; if (document.querySelector('input[type=password]')) { clearTimeout(timer); timer = setTimeout(attempt, 200); } });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('input', (e) => { const t = e.target; if (t && t.tagName === 'INPUT' && t.type === 'password' && t.value) done = true; }, true);
    const reset = () => { _creds = undefined; done = false; setTimeout(attempt, 250); };
    window.addEventListener('popstate', reset);
    ['pushState', 'replaceState'].forEach((k) => { const o = history[k]; if (o) history[k] = function () { const r = o.apply(this, arguments); reset(); return r; }; });
  } catch {}
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
