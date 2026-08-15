'use strict';
/* Prowl – skalets logik. Webbsidorna renderas av huvudprocessen
 * (WebContentsView); här styr vi flikar, adressfält, granskning och varning. */

const $ = (id) => document.getElementById(id);
const viewsEl = $('views');
const newtabpage = $('newtabpage');
const incogpage = $('incogpage');
const addressInput = $('address');
const shieldEl = $('shield');

let tabs = [];
let active = null;
let seq = 0;
let _greetCache = { key: null, text: '' };   // deklareras tidigt – greet() anropas under init (TDZ-fix)
const byId = (id) => tabs.find((t) => t.id === id);

// Inkognitofönster: alla dess flikar körs som inkognito och skalet får det mörka temat.
const windowIncognito = new URLSearchParams(location.search).has('incognito');
if (windowIncognito) document.body.classList.add('incog');

/* ── URL-hjälp ── */
const ENGINES = {
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
};
let searchEngine = 'google';
try { const e = localStorage.getItem('skoll-engine'); if (e && ENGINES[e]) searchEngine = e; } catch {}
function searchUrl(q) {
  // Vanligt: vald sökmotor. Inkognito: alltid DuckDuckGo (mer privat).
  if (active && active.incognito) return ENGINES.duckduckgo.url + encodeURIComponent(q);
  return (ENGINES[searchEngine] || ENGINES.google).url + encodeURIComponent(q);
}
function normalizeUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (/^(https?|file|about):/i.test(s)) return s;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s;
  return searchUrl(s);
}
function pretty(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '') + u.search; }
  catch { return url; }
}

/* ── Innehållsytans mått → huvudprocessen ── */
function sendBounds() {
  const r = viewsEl.getBoundingClientRect();
  window.view.bounds({ x: r.x, y: r.y, width: r.width, height: r.height });
}
window.addEventListener('resize', sendBounds);
window.view.onWindowResized(sendBounds);

/* ── Snabb lokal fara-koll (omedelbar) ── */
function instantDanger(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const list = ['farlig.exempel.se', 'bank-verifiering.se', 'testsafebrowsing.appspot.com'];
    return list.some((d) => h === d || h.endsWith('.' + d)) || /phish|malware|bluff|scam/i.test(h);
  } catch { return false; }
}
const localDanger = () => ({ status: 'danger', title: 'Den här sidan ser farlig ut', reasons: [
  'Prowl känner igen den här som en bluff-/phishingsida.',
  'Sidor som denna försöker lura dig att lämna lösenord, BankID eller kortuppgifter.'] });

/* ── Flikar ── */
function createTab(url, incognito) {
  if (incognito === undefined) incognito = windowIncognito;  // inkognitofönster → alla flikar inkognito
  const tab = { id: ++seq, url: null, title: incognito ? 'Inkognito' : 'Ny flik', favicon: null, cleared: new Set(), bypassed: new Set(), canBack: false, canForward: false, verdict: null, warning: null, toastDismissed: new Set(), entering: true, incognito: !!incognito, overlay: null };
  if (incognito) window.view.markIncognito(tab.id);
  tabs.push(tab); switchTab(tab);
  saveOpenTabs();
  setTimeout(() => { tab.entering = false; }, 280);
  if (url) guardedNavigate(tab, url);
  return tab;
}
// ── Öppna flikar sparas så de kommer tillbaka nästa gång browsern öppnas ──
const OPEN_TABS_KEY = 'skoll-open-tabs';
function saveOpenTabs() {
  if (windowIncognito) return;                                  // inkognito sparas aldrig
  try {
    const urls = tabs.filter((t) => !t.incognito && t.url).map((t) => t.url);
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(urls));
  } catch {}
}
function restoreTabs() {
  if (windowIncognito) { createTab(null); return; }
  let urls = [];
  try { urls = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '[]'); } catch {}
  urls = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u);
  if (!urls.length) { createTab(null); return; }
  const first = createTab(urls[0]);
  for (let i = 1; i < urls.length; i++) createTab(urls[i]);
  if (first) switchTab(first);                                  // första fliken aktiv igen
}
// Full-sides-rutor (inställningar m.m.) hör till fliken de öppnades på.
const OVERLAY_IDS = ['settings', 'login', 'bookmarks', 'bgpick', 'qr'];
function hideOverlayElements() { OVERLAY_IDS.forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); }); }
function showActiveTab() {
  hideInfobar();
  if (active && active.url) {
    newtabpage.classList.add('hidden'); incogpage.classList.add('hidden');
    window.view.show(active.id);
    if (protectionOn && active.warning && active.warning.url === active.url && !active.toastDismissed.has(active.warning.url)) {
      showInfobar(active.warning.res, active, active.url);
    }
  } else {
    window.view.hide();
    if (active && active.incognito) { newtabpage.classList.add('hidden'); incogpage.classList.remove('hidden'); }
    else { incogpage.classList.add('hidden'); newtabpage.classList.remove('hidden'); greet(); }
  }
}
function switchTab(tab) {
  active = tab;
  document.body.classList.toggle('incog', !!tab.incognito);
  $('search-engine').textContent = tab.incognito ? 'DuckDuckGo' : (ENGINES[searchEngine] || ENGINES.google).label;
  addressInput.value = tab.url ? pretty(tab.url) : '';
  setShield(tab.url ? (protectionOn ? (tab.verdict ? tab.verdict.status : 'ok') : 'off') : 'home');
  hideOverlayElements();
  hideDanger();
  if (tab.overlay) { window.view.hide(); const el = $(tab.overlay); if (el) el.classList.remove('hidden'); }
  else showActiveTab();
  renderTabs(); updateNavButtons(); updateStar();
}
function closeTab(tab) {
  const i = tabs.indexOf(tab); if (i < 0) return;
  window.view.destroy(tab.id);
  tabs.splice(i, 1);
  saveOpenTabs();
  if (!tabs.length) { createTab(null); return; }
  if (active === tab) switchTab(tabs[Math.max(0, i - 1)]); else renderTabs();
}
function renderTabs() {
  const host = $('tabs'); host.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === active ? ' active' : '') + (tab.entering ? ' entering' : '') + (tab.incognito ? ' incognito' : '');
    const fav = tab.incognito
      ? `<span class="fav"><svg class="ic" style="width:15px;height:15px"><use href="#i-incognito" /></svg></span>`
      : (tab.favicon
        ? `<span class="fav"><img src="${tab.favicon}" onerror="this.style.visibility='hidden'"></span>`
        : `<span class="fav"><svg class="ic" style="width:15px;height:15px"><use href="#${tab.url ? 'i-globe' : 'i-shield'}" /></svg></span>`);
    el.innerHTML = `${fav}<span class="ttl">${escapeHtml(tab.title || 'Ny flik')}</span><button class="tclose"><svg class="ic" style="width:13px;height:13px"><use href="#i-close" /></svg></button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tclose')) { e.stopPropagation(); closeTab(tab); } else switchTab(tab);
    });
    host.appendChild(el);
  });
}
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ── Navigering ── */
function guardedNavigate(tab, raw, opts = {}) {
  const url = normalizeUrl(raw); if (!url) return;
  hideDanger();
  if (protectionOn && !opts.bypass && instantDanger(url)) { tab.verdict = localDanger(); showDanger(tab, url, tab.verdict); return; }
  if (opts.bypass) { tab.bypassed.add(url); tab.cleared.add(url); }
  loadInTab(tab, url);
}
function loadInTab(tab, url) {
  tab.url = url;
  tab.warning = null;
  if (tab === active) { newtabpage.classList.add('hidden'); incogpage.classList.add('hidden'); hideInfobar(); addressInput.value = pretty(url); setShield(protectionOn ? 'checking' : 'off'); }
  window.view.load(tab.id, url);
}
function backgroundCheck(tab, url) {
  if (!protectionOn) { if (tab === active) setShield('off'); return; }
  if (tab.cleared.has(url) || tab.bypassed.has(url)) { if (tab === active) setShield(tab.verdict ? tab.verdict.status : 'ok'); return; }
  tab.cleared.add(url);
  if (tab === active) setShield('checking');
  window.skoll.checkUrl(url).then((res) => {
    const v = res && res.verdict; if (!v) return; tab.verdict = v;
    if (v.status === 'danger' && tab.url === url && !tab.bypassed.has(url)) {
      window.view.stop(tab.id);
      if (tab === active) { window.view.hide(); setShield('danger'); }
      showDanger(tab, url, v);
    } else if (tab === active) setShield(v.status);
  }).catch(() => { if (tab === active) setShield('unknown'); });
}

/* ── Händelser från huvudprocessen ── */
window.view.onLinkNavigate((id, url) => { const t = byId(id); if (t) guardedNavigate(t, url); });
window.view.onDidNavigate((id, url, b, f) => {
  const t = byId(id); if (!t) return;
  t.url = url; t.canBack = b; t.canForward = f;
  saveOpenTabs();
  if (t.warning && t.warning.url !== url) { t.warning = null; if (t === active) hideInfobar(); }
  if (t === active) { addressInput.value = pretty(url); updateNavButtons(); updateStar(); }
  backgroundCheck(t, url);
});
window.view.onTitle((id, title) => { const t = byId(id); if (t) { t.title = title; renderTabs(); if (t.url && !t.incognito) pushHistory(t.url, title, t.favicon); } });
window.view.onFavicon((id, fav) => { const t = byId(id); if (t) { t.favicon = fav; renderTabs(); } });
window.view.onLoading((id, loading) => { const t = byId(id); if (t && t === active) $('reload').textContent = loading ? '✕' : '⟳'; });
window.view.onOpenNewTab((url) => createTab(url));
window.view.onNewIncognito(() => createTab(null, true));

/* ── Bekräfta stängning med flera flikar (flytande Brave-lik notis) ──
 * Skalet avgör om notisen behövs (det vet flik-antalet); main visar den i ett eget
 * litet fönster ovanför sidan så inget gråas ut. */
let skipCloseConfirm = false;
try { skipCloseConfirm = localStorage.getItem('skoll-skip-close-confirm') === '1'; } catch {}
window.view.onConfirmClose(() => {
  if (tabs.length <= 1 || skipCloseConfirm) { window.view.doClose(); return; }  // en flik / valt bort → stäng direkt
  window.view.openCloseConfirm(tabs.length);
});
window.view.onPersistSkipClose(() => {
  try { localStorage.setItem('skoll-skip-close-confirm', '1'); } catch {}
  skipCloseConfirm = true;
});
window.view.onOpenTabRaw((rawUrl) => {
  const t = createTab(null);
  t.bypassed.add(rawUrl); t.cleared.add(rawUrl);
  loadInTab(t, rawUrl);
});
window.view.onShowQR((url, dataUrl) => {
  $('qr-img').src = dataUrl;
  $('qr-url').textContent = url;
  hideInfobar();
  window.view.hide();
  hideOverlayElements();
  if (active) active.overlay = 'qr';
  $('qr').classList.remove('hidden');
});

/* ── Innehållsvarning (liten notis över sidan) ── */
const infobar = $('infobar');
let infobarState = null;
function showInfobar(res, tab, url) {
  $('pwbar').style.display = 'none';
  const danger = res.level === 'danger';
  infobar.style.background = danger ? 'linear-gradient(90deg,#c0433d,#a5352f)' : 'linear-gradient(90deg,#cf9128,#a97c22)';
  $('infobar-ico').style.background = 'rgba(255,255,255,.22)';
  $('infobar-ico').innerHTML = `<svg class="ic ic-sm"><use href="#${danger ? 'i-shield-x' : 'i-shield-alert'}" /></svg>`;
  $('infobar-text').textContent = (res.flags && res.flags[0]) || 'Den här sidan ser farlig ut.';
  infobar.style.display = 'flex';
  infobarState = { tab, url };
  window.view.insetTop(56);
}
function hideInfobar() {
  if (infobar.style.display === 'none') return;
  infobar.style.display = 'none';
  infobarState = null;
  window.view.insetTop(0);
}
window.view.onContentWarning((id, url, res) => {
  if (!protectionOn) return;
  const t = byId(id); if (!t || t.toastDismissed.has(url)) return;
  t.warning = { url, res };
  if (t === active && t.url === url) showInfobar(res, t, url);
});
$('infobar-leave').addEventListener('click', () => {
  const st = infobarState; hideInfobar();
  if (!st) return;
  st.tab.warning = null;
  if (st.tab.canBack) { window.view.back(st.tab.id); window.view.show(st.tab.id); }
  else { st.tab.url = null; switchTab(st.tab); }
});
$('infobar-stay').addEventListener('click', () => {
  const st = infobarState;
  if (st) { st.tab.toastDismissed.add(st.url); st.tab.warning = null; }
  hideInfobar();
});

/* ── Varningsskärm ── */
let pending = null;
function showDanger(tab, url, verdict) {
  if (url && !countedDangers.has(url)) { countedDangers.add(url); bumpStat('dangers', 1); }  // räkna en gång per farlig sida
  if (tab === active) window.view.hide();
  $('danger-title').textContent = verdict.title || 'Den här sidan ser farlig ut';
  $('danger-target').textContent = url;
  const box = $('danger-reasons'); box.innerHTML = '';
  (verdict.reasons || []).forEach((r) => {
    const row = document.createElement('div'); row.className = 'danger-reason';
    row.innerHTML = `<svg class="ic ic-sm" style="color:var(--color-warn);flex:none;margin-top:1px"><use href="#i-shield-alert" /></svg><span>${escapeHtml(r)}</span>`;
    box.appendChild(row);
  });
  pending = { tab, url };
  if (tab === active) { $('danger').classList.remove('hidden'); setShield('danger'); }
}
function hideDanger() { $('danger').classList.add('hidden'); }
$('danger-proceed').addEventListener('click', () => {
  if (!pending) return; const { tab, url } = pending; hideDanger(); guardedNavigate(tab, url, { bypass: true });
});
$('danger-back').addEventListener('click', () => {
  hideDanger();
  if (active && active.canBack) { window.view.back(active.id); window.view.show(active.id); }
  else if (active) { active.url = null; switchTab(active); }
});

/* ── Sköld ── */
function setShield(status) {
  const icon = { home: 'i-shield', ok: 'i-shield-check', checking: 'i-shield-search', warn: 'i-shield-alert', danger: 'i-shield-x', unknown: 'i-shield', off: 'i-shield-off' }[status] || 'i-shield';
  shieldEl.className = 'shield-wrap shield-' + status;
  shieldEl.innerHTML = `<svg class="ic ic-sm"><use href="#${icon}" /></svg>`;
}

/* ── Verktygsrad ── */
/* autocomplete kopplas längre ner (attachAutocomplete) */
$('back').addEventListener('click', () => { if (active) window.view.back(active.id); });
$('forward').addEventListener('click', () => { if (active) window.view.forward(active.id); });
$('reload').addEventListener('click', () => { if (active) ($('reload').textContent === '✕' ? window.view.stop(active.id) : window.view.reload(active.id)); });
$('newtab-btn').addEventListener('click', () => createTab(null));
function updateNavButtons() {
  $('back').disabled = !(active && active.canBack);
  $('forward').disabled = !(active && active.canForward);
}

/* ── Adblock ── */
async function initAdblock() {
  const st = await window.skoll.adblockState();
  $('adcount').textContent = st.count;
  $('adblock').classList.toggle('off', !st.on);
  window.skoll.onAdblockCount((n) => { $('adcount').textContent = n; });

/* ── Skyddsstatistik på startsidan (kumulativt, sparat lokalt) ── */
let stats = { ads: 0, trackers: 0, dangers: 0 };
try { const s = JSON.parse(localStorage.getItem('skoll-stats')); if (s) stats = { ads: s.ads | 0, trackers: s.trackers | 0, dangers: s.dangers | 0 }; } catch {}
const countedDangers = new Set();
function renderStats() {
  const f = (n) => (n || 0).toLocaleString('sv-SE');
  if ($('stat-ads')) $('stat-ads').textContent = f(stats.ads);
  if ($('stat-trackers')) $('stat-trackers').textContent = f(stats.trackers);
  if ($('stat-dangers')) $('stat-dangers').textContent = f(stats.dangers);
}
function bumpStat(key, n) {
  stats[key] = (stats[key] || 0) + (n || 1);
  try { localStorage.setItem('skoll-stats', JSON.stringify(stats)); } catch {}
  renderStats();
}
window.skoll.onAdblockHit((type) => bumpStat(type === 'tracker' ? 'trackers' : 'ads', 1));
renderStats();
}
$('adblock').addEventListener('click', () => setAdblock($('adblock').classList.contains('off')));

/* ── Krypto (kräver inloggning + Pro) ── */
let kryptoOpen = false;
function kryptoMode() { return account ? (account.pro ? 'pro' : 'nopro') : 'signedout'; }
let pendingKryptoAfterLogin = false;
function openKrypto(open) {
  if (open && !account) { pendingKryptoAfterLogin = true; openLogin(); return; }
  kryptoOpen = open;
  window.view.kryptoToggle(open, kryptoMode(), account ? account.token : null);
  $('krypto-btn').classList.toggle('off', !open);
}
$('krypto-btn').addEventListener('click', () => openKrypto(!kryptoOpen));
async function refreshPro() {
  if (!account || !account.token) return;
  try {
    const r = await window.auth.session(account.token);
    if (r && r.ok) { account.pro = !!r.pro; if (r.name) account.name = r.name; localStorage.setItem('skoll-account', JSON.stringify(account)); }
    // Logga ALDRIG ut automatiskt: en stängd browser ska förbli inloggad om man var inloggad.
    // "no_session" kan vara en tillfällig serverhicka — behåll kontot lokalt tills användaren själv loggar ut.
  } catch {}
  if (pendingKryptoAfterLogin) { pendingKryptoAfterLogin = false; openKrypto(true); return; }
  if (kryptoOpen) openKrypto(true); // ladda om panelen med rätt läge
}
// Knappar inifrån Pro-väggen (krypto-lock.html)
window.view.onOpenLogin(() => openLogin());
window.view.onKryptoRecheck(async () => {
  if (!account) { openLogin(); return; }
  await refreshPro();
  if (account && !account.pro) showToast('Ingen aktiv Pro hittades på ditt konto ännu.');
});

/* ── Inställningar (realtidsskydd + annonsblockerare, på som standard) ── */
let protectionOn = true;
try { if (localStorage.getItem('skoll-protection') === 'off') protectionOn = false; } catch {}
function setProtection(on) {
  protectionOn = on;
  try { localStorage.setItem('skoll-protection', on ? 'on' : 'off'); } catch {}
  $('tgl-protection').checked = on;
  if (active && active.url) setShield(on ? (active.verdict ? active.verdict.status : 'ok') : 'off');
}
async function setAdblock(on) {
  await window.skoll.adblockToggle(on);
  $('adblock').classList.toggle('off', !on);
  $('tgl-adblock').checked = on;
}
function openSettings() {
  window.view.hide(); hideInfobar();
  $('tgl-protection').checked = protectionOn;
  $('tgl-adblock').checked = !$('adblock').classList.contains('off');
  $('seg-fav').classList.toggle('on', topSitesMode === 'favorites');
  $('seg-freq').classList.toggle('on', topSitesMode === 'frequent');
  $('tgl-krypto').checked = $('krypto-btn').style.display !== 'none';
  $('tgl-motion').checked = reduceMotion;
  renderEngines(); renderLangs(); applyZoomSeg();
  showSettingsCat(account ? 'konto' : 'utseende');
  hideOverlayElements();
  if (active) active.overlay = 'settings';
  $('settings').classList.remove('hidden');
}
function closeSettings() {
  if (active) active.overlay = null;
  $('settings').classList.add('hidden');
  showActiveTab();
}
function showSettingsCat(cat) {
  document.querySelectorAll('#settings-nav .set-tab').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
  document.querySelectorAll('#settings .set-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.cat !== cat));
  if (cat === 'wallet' && typeof renderWallet === 'function') renderWallet();
  if (cat === 'kalender' && typeof renderCal === 'function') renderCal();
  if (cat === 'konto' && typeof renderKonto === 'function') renderKonto();
  if (cat === 'vanner' && typeof renderFriends === 'function') renderFriends();
  if (cat !== 'vanner' && typeof stopChatPoll === 'function') stopChatPoll();
}
function renderEngines() {
  const list = $('engine-list'); if (!list) return; list.innerHTML = '';
  Object.keys(ENGINES).forEach((k) => {
    const el = document.createElement('div'); el.className = 'engine-opt' + (searchEngine === k ? ' on' : '');
    el.innerHTML = `<span class="engine-radio"></span><span>${ENGINES[k].label}</span>`;
    el.addEventListener('click', () => {
      searchEngine = k; try { localStorage.setItem('skoll-engine', k); } catch {}
      if (active && !active.incognito) $('search-engine').textContent = ENGINES[k].label;
      renderEngines();
    });
    list.appendChild(el);
  });
}
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
document.querySelectorAll('#settings-nav .set-tab').forEach((b) => b.addEventListener('click', () => showSettingsCat(b.dataset.cat)));
$('tgl-protection').addEventListener('change', (e) => setProtection(e.target.checked));
$('tgl-adblock').addEventListener('change', (e) => setAdblock(e.target.checked));
/* Krypto-kategori */
$('open-krypto-btn').addEventListener('click', () => {
  closeSettings();
  openKrypto(true);
});
$('tgl-krypto').addEventListener('change', (e) => {
  $('krypto-btn').style.display = e.target.checked ? '' : 'none';
  try { localStorage.setItem('skoll-krypto-btn', e.target.checked ? '1' : '0'); } catch {}
});
/* Språk */
function renderLangs() {
  const list = $('lang-list'); if (!list) return; list.innerHTML = '';
  [['sv', 'Svenska', true], ['en', 'English', false]].forEach(([code, label, real]) => {
    let cur = 'sv'; try { cur = localStorage.getItem('skoll-lang') || 'sv'; } catch {}
    const el = document.createElement('div'); el.className = 'engine-opt' + (cur === code ? ' on' : '');
    el.innerHTML = `<span class="engine-radio"></span><span>${label}</span>` + (real ? '' : '<span style="margin-left:auto;font-size:11px;color:#8ba3bf;">snart</span>');
    el.addEventListener('click', () => {
      if (!real) { showToast('Fler språk är på väg.'); return; }
      try { localStorage.setItem('skoll-lang', code); } catch {}
      renderLangs();
    });
    list.appendChild(el);
  });
}
/* Tillgänglighet: sidzoom + minska rörelse */
let defaultZoom = 100;
try { const z = parseInt(localStorage.getItem('skoll-zoom'), 10); if (z) defaultZoom = z; } catch {}
function applyZoomSeg() { [90, 100, 110, 125].forEach((z) => $('zoom-' + z).classList.toggle('on', z === defaultZoom)); }
[90, 100, 110, 125].forEach((z) => $('zoom-' + z).addEventListener('click', () => {
  defaultZoom = z; try { localStorage.setItem('skoll-zoom', String(z)); } catch {}
  window.view.defaultZoom(z / 100); applyZoomSeg();
}));
let reduceMotion = false;
try { reduceMotion = localStorage.getItem('skoll-motion') === '1'; } catch {}
document.body.classList.toggle('reduce-motion', reduceMotion);
$('tgl-motion').addEventListener('change', (e) => {
  reduceMotion = e.target.checked;
  document.body.classList.toggle('reduce-motion', reduceMotion);
  try { localStorage.setItem('skoll-motion', reduceMotion ? '1' : '0'); } catch {}
});

/* ── Tema (ljust/mörkt) ── */
let theme = 'light';
try { const t = localStorage.getItem('skoll-theme'); if (t === 'dark' || t === 'light') theme = t; } catch {}
document.documentElement.dataset.theme = theme;
function setTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('skoll-theme', theme); } catch {}
  const l = $('seg-light'), d = $('seg-dark');
  if (l) l.classList.toggle('on', theme === 'light');
  if (d) d.classList.toggle('on', theme === 'dark');
}
if ($('seg-light')) $('seg-light').addEventListener('click', () => setTheme('light'));
if ($('seg-dark')) $('seg-dark').addEventListener('click', () => setTheme('dark'));
setTheme(theme);

/* ── Krypto-agent: låt AI:n ändra inställningar via naturligt språk ── */
function kryptoOnOff(v) { v = ('' + (v || '')).toLowerCase().trim(); return !/(^av$|off|nej|stäng|stang|inaktiv|false|^0$|\bav\b)/.test(v); }
function matchEngine(v) {
  v = ('' + (v || '')).toLowerCase();
  if (/duck|ddg/.test(v)) return 'duckduckgo';
  if (/brave/.test(v)) return 'brave';
  if (/startpage|start ?page/.test(v)) return 'startpage';
  if (/google/.test(v)) return 'google';
  return ENGINES[v] ? v : null;
}
function setEngine(k) {
  if (!ENGINES[k]) return false;
  searchEngine = k; try { localStorage.setItem('skoll-engine', k); } catch {}
  if (active && !active.incognito) $('search-engine').textContent = ENGINES[k].label;
  try { renderEngines(); } catch {}
  return true;
}
function setReduceMotion(on) {
  reduceMotion = on; document.body.classList.toggle('reduce-motion', on);
  try { localStorage.setItem('skoll-motion', on ? '1' : '0'); } catch {}
  const t = $('tgl-motion'); if (t) t.checked = on;
}
function applyKryptoSetting(a) {
  if (!a || !a.name) return;
  const name = ('' + a.name).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o');
  const val = a.value; let msg = '';
  if (name === 'adblock' || name === 'annonsblockerare') { const on = kryptoOnOff(val); setAdblock(on); msg = 'Annonsblockerare ' + (on ? 'på' : 'av'); }
  else if (name === 'realtidsskydd' || name === 'skydd') { const on = kryptoOnOff(val); setProtection(on); msg = 'Realtidsskydd ' + (on ? 'på' : 'av'); }
  else if (name === 'minska_rorelse' || name === 'reduce_motion' || name === 'rorelse') { const on = kryptoOnOff(val); setReduceMotion(on); msg = 'Minska rörelse ' + (on ? 'på' : 'av'); }
  else if (name === 'sokmotor' || name === 'sok') { const k = matchEngine(val); if (k && setEngine(k)) msg = 'Sökmotor: ' + ENGINES[k].label; }
  else if (name === 'nedladdningar' || name === 'downloads') { try { openDownloads(); } catch {} msg = 'Visar nedladdningar'; }
  else if (name === 'kop' || name === 'buy' || name === 'bestall' || name === 'betala') {
    if (typeof startKryptoPurchase === 'function') startKryptoPurchase(val);
  }
  if (msg && typeof showToast === 'function') showToast('⚙ ' + msg);
}
window.view.onKryptoSet(applyKryptoSetting);
try { if (localStorage.getItem('skoll-krypto-btn') === '0') $('krypto-btn').style.display = 'none'; } catch {}
window.view.defaultZoom(defaultZoom / 100);
$('settings-reset').addEventListener('click', () => {
  try { ['skoll-bg', 'skoll-topsites', 'skoll-engine'].forEach((k) => localStorage.removeItem(k)); } catch {}
  setProtection(true); setAdblock(true);
  searchEngine = 'google'; topSitesMode = 'favorites';
  applyStoredBg(); applyTopSitesMode(); renderEngines();
  if (active && !active.incognito) $('search-engine').textContent = 'Google';
});

/* ── Inloggning med mejl + engångskod ── */
let account = null;   // { email, token, pro }
try { account = JSON.parse(localStorage.getItem('skoll-account')); } catch {}
if (account && !account.token) account = null;  // gammalt kontonummer-format → nollställ
let pendingEmail = null;
let pendingLogin = null;   // (kvar, oanvänt)
let pendingSubmit = null;  // { type:'login'|'signup', email, password, name } för 2FA-koden + "skicka ny kod"
let pendingResetEmail = null;  // glömt-lösenord-flödet
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
function updateAccountBtn() { $('account-btn').classList.toggle('on', !!account); greet(); }
function setLoginView(name) {
  const map = { login: 'login-form', signup: 'login-signup', code: 'login-code', reset: 'login-reset', resetconfirm: 'login-reset-confirm', account: 'login-account-view' };
  for (const k in map) { const el = $(map[k]); if (el) el.style.display = (k === name) ? 'block' : 'none'; }
}
function openLogin() {
  window.view.hide(); hideInfobar();
  if (account) {
    setLoginView('account');
    $('login-email-shown').textContent = (account.name ? account.name + ' · ' : '') + (account.email || '');
    $('login-pro-badge').style.display = account.pro ? 'inline-flex' : 'none';
  } else {
    $('login-email').value = ''; $('login-pw').value = ''; $('login-error').style.display = 'none';
    setLoginView('login');
    setTimeout(() => $('login-email').focus(), 30);
  }
  hideOverlayElements();
  if (active) active.overlay = 'login';
  $('login').classList.remove('hidden');
}
function closeLogin() {
  if (active) active.overlay = null;
  $('login').classList.add('hidden');
  showActiveTab();
}
function accountKey(a) { a = a || account; if (!a) return null; return 'k:' + (a.email || a.name || a.token || 'user'); }
function loginAs(token, email, pro, name) {
  account = { token, email: email || '', pro: !!pro, name: name || '' };
  localStorage.setItem('skoll-account', JSON.stringify(account));
  updateAccountBtn();
  try { window.session.login(accountKey(account)); } catch {}   // återställ kontots webbsession + lås upp lösenord
  if (pendingKryptoAfterLogin) { pendingKryptoAfterLogin = false; openKrypto(true); }
  else if (kryptoOpen) openKrypto(true);
}
function doLogout(reopenKrypto) {
  const t = account && account.token;
  const sk = account ? accountKey(account) : null;
  account = null; localStorage.removeItem('skoll-account'); updateAccountBtn();
  if (sk) { try { window.session.logout(sk); } catch {} }   // spara + rensa webbsession (utloggad ur Gmail m.fl.) + lås lösenord
  if (t) { try { window.auth.logout(t); } catch {} }
  setLoginView('login');
  if (reopenKrypto !== false && kryptoOpen) openKrypto(true);  // lås Krypto igen
}
function busyBtn(id, busy, busyText, text) {
  const b = $(id); if (!b) return; b.disabled = busy; b.style.opacity = busy ? '0.7' : '1'; b.textContent = busy ? busyText : text;
}
async function doLogin() {
  const email = $('login-email').value.trim().toLowerCase();
  const pw = $('login-pw').value;
  const err = $('login-error');
  if (!EMAIL_RE.test(email)) { err.textContent = 'Fyll i en giltig mejladress.'; err.style.display = 'block'; return; }
  if (!pw) { err.textContent = 'Fyll i ditt lösenord.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  busyBtn('login-submit', true, 'Loggar in…', 'Logga in');
  let r; try { r = await window.auth.login(email, pw); } catch { r = { ok: false }; }
  busyBtn('login-submit', false, 'Loggar in…', 'Logga in');
  if (!r || !r.ok) { err.textContent = (r && r.message) || 'Inloggningen misslyckades.'; err.style.display = 'block'; return; }
  if (r.needCode) { pendingEmail = email; pendingSubmit = { type: 'login', email, password: pw }; showCodeStep(); return; }
  loginAs(r.token, r.email, r.pro, r.name); closeLogin();
}
async function doSignup() {
  const name = $('signup-name').value.trim();
  const email = $('signup-email').value.trim().toLowerCase();
  const pw = $('signup-pw').value;
  const err = $('signup-error');
  if (!name) { err.textContent = 'Fyll i ditt namn.'; err.style.display = 'block'; return; }
  if (!EMAIL_RE.test(email)) { err.textContent = 'Fyll i en giltig mejladress.'; err.style.display = 'block'; return; }
  if (pw.length < 6) { err.textContent = 'Lösenordet måste vara minst 6 tecken.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  busyBtn('signup-submit', true, 'Skapar konto…', 'Skapa konto');
  let r; try { r = await window.auth.signup(email, pw, name); } catch { r = { ok: false }; }
  busyBtn('signup-submit', false, 'Skapar konto…', 'Skapa konto');
  if (!r || !r.ok) { err.textContent = (r && r.message) || 'Kunde inte skapa kontot.'; err.style.display = 'block'; return; }
  if (r.needCode) { pendingEmail = email; pendingSubmit = { type: 'signup', email, password: pw, name }; showCodeStep(); return; }
  loginAs(r.token, r.email, r.pro, r.name); closeLogin();
}
function showCodeStep() {
  $('code-email-shown').textContent = pendingEmail || '';
  $('login-code-input').value = ''; $('code-error').style.display = 'none';
  setLoginView('code');
  setTimeout(() => $('login-code-input').focus(), 30);
}
async function doVerifyCode() {
  const code = $('login-code-input').value.replace(/\D/g, '');
  const err = $('code-error');
  if (code.length !== 6) { err.textContent = 'Koden är 6 siffror.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  busyBtn('code-submit', true, 'Verifierar…', 'Verifiera');
  let r; try { r = await window.auth.verifyCode(pendingEmail, code); } catch { r = { ok: false }; }
  busyBtn('code-submit', false, 'Verifierar…', 'Verifiera');
  if (!r || !r.ok) { err.textContent = (r && r.message) || 'Fel kod. Försök igen.'; err.style.display = 'block'; return; }
  loginAs(r.token, r.email, r.pro, r.name); closeLogin();
}
async function doResendCode() {
  if (!pendingSubmit) return;
  $('code-error').style.display = 'none';
  try {
    if (pendingSubmit.type === 'login') await window.auth.login(pendingSubmit.email, pendingSubmit.password);
    else await window.auth.signup(pendingSubmit.email, pendingSubmit.password, pendingSubmit.name);
    showToast('Ny kod skickad till din mejl.');
  } catch {}
}
/* ── Glömt lösenord ── */
async function doResetRequest() {
  const email = $('reset-email').value.trim().toLowerCase();
  const err = $('reset-error');
  if (!EMAIL_RE.test(email)) { err.textContent = 'Fyll i en giltig mejladress.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  busyBtn('reset-send', true, 'Skickar…', 'Skicka kod');
  try { await window.auth.resetRequest(email); } catch {}
  busyBtn('reset-send', false, 'Skickar…', 'Skicka kod');
  pendingResetEmail = email;
  $('reset-code').value = ''; $('reset-pw').value = ''; $('reset-confirm-error').style.display = 'none';
  setLoginView('resetconfirm');
  setTimeout(() => $('reset-code').focus(), 30);
}
async function doResetConfirm() {
  const code = $('reset-code').value.replace(/\D/g, '');
  const pw = $('reset-pw').value;
  const err = $('reset-confirm-error');
  if (code.length !== 6) { err.textContent = 'Koden är 6 siffror.'; err.style.display = 'block'; return; }
  if (pw.length < 6) { err.textContent = 'Lösenordet måste vara minst 6 tecken.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  busyBtn('reset-confirm-submit', true, 'Sparar…', 'Återställ lösenord');
  let r; try { r = await window.auth.resetConfirm(pendingResetEmail, code, pw); } catch { r = { ok: false }; }
  busyBtn('reset-confirm-submit', false, 'Sparar…', 'Återställ lösenord');
  if (!r || !r.ok) { err.textContent = (r && r.message) || 'Kunde inte återställa lösenordet.'; err.style.display = 'block'; return; }
  loginAs(r.token, r.email, r.pro, r.name);
  showToast('Lösenordet är ändrat.');
  closeLogin();
}
async function doResetResend() {
  if (!pendingResetEmail) return;
  $('reset-confirm-error').style.display = 'none';
  try { await window.auth.resetRequest(pendingResetEmail); showToast('Ny kod skickad.'); } catch {}
}
// Visa/dölj-lösenord (öga-knapparna)
document.querySelectorAll('.pw-eye').forEach((b) => {
  b.addEventListener('click', () => {
    const inp = $(b.dataset.target); if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    b.style.opacity = inp.type === 'text' ? '1' : '0.55';
  });
});
$('account-btn').addEventListener('click', () => openAccount());
$('kn-logout') && $('kn-logout').addEventListener('click', () => { doLogout(); renderKonto(); });
$('kn-login') && $('kn-login').addEventListener('click', () => openLogin());
$('kn-delete') && $('kn-delete').addEventListener('click', showConfirmDelete);
$('kn-avatar') && $('kn-avatar').addEventListener('click', () => { const fl = $('kn-avatar-file'); if (fl) fl.click(); });
$('kn-avatar-file') && $('kn-avatar-file').addEventListener('change', knHandleAvatar);
$('kn-save-prof') && $('kn-save-prof').addEventListener('click', knSaveProfile);
$('fr-back') && $('fr-back').addEventListener('click', closeChat);
$('fr-send-btn') && $('fr-send-btn').addEventListener('click', socSend);
$('fr-send-in') && $('fr-send-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') socSend(); });
$('fr-chat-av') && $('fr-chat-av').addEventListener('click', () => { if (socChat && socChat.indexOf('dm:') !== 0) return; });
$('login-close').addEventListener('click', () => { pendingKryptoAfterLogin = false; closeLogin(); });
$('qr-close').addEventListener('click', () => { if (active) active.overlay = null; $('qr').classList.add('hidden'); showActiveTab(); });
$('login-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-pw').focus(); });
$('login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('login-submit').addEventListener('click', doLogin);
$('to-signup').addEventListener('click', () => { $('signup-name').value = ''; $('signup-email').value = ''; $('signup-pw').value = ''; $('signup-error').style.display = 'none'; setLoginView('signup'); setTimeout(() => $('signup-name').focus(), 20); });
$('to-login').addEventListener('click', () => { setLoginView('login'); setTimeout(() => $('login-email').focus(), 20); });
$('signup-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signup-email').focus(); });
$('signup-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signup-pw').focus(); });
$('signup-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignup(); });
$('signup-submit').addEventListener('click', doSignup);
$('login-code-input').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('login-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyCode(); });
$('code-submit').addEventListener('click', doVerifyCode);
$('code-resend').addEventListener('click', doResendCode);
$('code-back').addEventListener('click', () => { setLoginView(pendingSubmit && pendingSubmit.type === 'signup' ? 'signup' : 'login'); });
$('to-reset').addEventListener('click', () => { $('reset-email').value = $('login-email').value || ''; $('reset-error').style.display = 'none'; setLoginView('reset'); setTimeout(() => $('reset-email').focus(), 20); });
$('reset-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') doResetRequest(); });
$('reset-send').addEventListener('click', doResetRequest);
$('reset-back').addEventListener('click', () => { setLoginView('login'); setTimeout(() => $('login-email').focus(), 20); });
$('reset-code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
$('reset-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doResetConfirm(); });
$('reset-confirm-submit').addEventListener('click', doResetConfirm);
$('reset-confirm-back').addEventListener('click', () => setLoginView('reset'));
$('reset-resend').addEventListener('click', doResetResend);
$('logout-btn').addEventListener('click', () => doLogout());
updateAccountBtn();
// (session-återställning körs SIST i filen — se slutet)

/* ── Startsida ── */
function tickClock() { $('nt-clock').textContent = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }); }
// Liten personlig hälsning på startsidan – läser användarnamnet + tiden.
function greet() {
  const el = $('nt-greet'); if (!el) return;
  let name = (account && account.name) ? account.name.split(' ')[0]
    : ((account && account.email) ? (account.email.split('@')[0].match(/^[a-zA-ZåäöÅÄÖ]+/) || [''])[0] : '');
  if (name) name = name[0].toUpperCase() + name.slice(1);   // snyggare i hälsningen
  const h = new Date().getHours();
  let b;
  if (h >= 5 && h < 10) b = { e: '☀️', t: ['God morgon', 'Morgonpigg', 'Ny dag väntar'] };
  else if (h >= 10 && h < 12) b = { e: '🌤️', t: ['God förmiddag', 'Härlig förmiddag'] };
  else if (h >= 12 && h < 14) b = { e: '🍽️', t: ['Lunchdags snart?', 'Mitt på dagen', 'God middag'] };
  else if (h >= 14 && h < 18) b = { e: '🌇', t: ['God eftermiddag', 'Trevlig eftermiddag'] };
  else if (h >= 18 && h < 22) b = { e: '🌆', t: ['God kväll', 'Skön kväll'] };
  else if (h >= 22 || h < 3) b = { e: '🌙', t: ['Lite sent', 'Uppe sent', 'Nattsurfning'] };
  else b = { e: '😴', t: ['Mitt i natten', 'Dags att sova snart?', 'Sena timmar'] }; // 03–05
  const key = name + '|' + h;                          // stabil inom samma timme + namn
  if (_greetCache.key !== key) {
    const g = b.t[Math.floor(Math.random() * b.t.length)];
    _greetCache = { key, text: (name ? g + ', ' + name : g) + ' ' + b.e };
  }
  el.textContent = _greetCache.text;
}
async function loadDailyImage() {
  try {
    const { url, credit } = await window.skoll.dailyImage();
    if (url) { const img = new Image(); img.onload = () => { $('nt-bg').style.backgroundImage = `url("${url}")`; }; img.src = url; if (credit) $('nt-credit').textContent = credit; }
  } catch {}
}
const DEFAULT_SHORTCUTS = [
  { label: 'HackerOne', url: 'https://hackerone.com' }, { label: 'Bugcrowd', url: 'https://bugcrowd.com' },
  { label: 'Intigriti', url: 'https://www.intigriti.com' }, { label: 'YesWeHack', url: 'https://www.yeswehack.com' },
  { label: 'Hack The Box', url: 'https://www.hackthebox.com' }, { label: 'TryHackMe', url: 'https://tryhackme.com' },
  { label: 'Exploit-DB', url: 'https://www.exploit-db.com' }, { label: 'PortSwigger', url: 'https://portswigger.net' },
];
function getShortcuts() { try { const s = JSON.parse(localStorage.getItem('skoll-shortcuts')); if (Array.isArray(s)) return s; } catch {} return DEFAULT_SHORTCUTS.slice(); }
function saveShortcuts(l) { localStorage.setItem('skoll-shortcuts', JSON.stringify(l)); }
// Engångsmigrering till hacker-genvägar (pivot till hacker-browser)
try { if (!localStorage.getItem('vaka-hacker-shortcuts')) { localStorage.setItem('skoll-shortcuts', JSON.stringify(DEFAULT_SHORTCUTS)); localStorage.setItem('vaka-hacker-shortcuts', '1'); } } catch {}
let addingShortcut = false;

function topSites() {
  return getHistory().slice().sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 8).map((e) => {
    let label = e.url; try { label = new URL(e.url).hostname.replace(/^www\./, ''); } catch {}
    return { label, url: e.url };
  });
}
function renderShortcuts() {
  const host = $('shortcuts'); host.innerHTML = '';
  const freq = topSitesMode === 'frequent';
  (freq ? topSites() : getShortcuts()).forEach((sc, idx) => {
    const el = document.createElement('div'); el.className = 'sc';
    let hostn = ''; let letter = '•';
    try { hostn = new URL(normalizeUrl(sc.url)).hostname.replace(/^www\./, ''); letter = (hostn[0] || '•').toUpperCase(); } catch {}
    const removeBtn = freq ? '' : `<button class="sc-remove" title="Ta bort"><svg class="ic" style="width:12px;height:12px;stroke-width:2.4"><use href="#i-close" /></svg></button>`;
    el.innerHTML = `
      <div class="sc-tilewrap">
        <div class="sc-tile"><span class="sc-letter">${escapeHtml(letter)}</span></div>
        ${removeBtn}
      </div>
      <div class="sc-label">${escapeHtml(sc.label)}</div>`;
    const tile = el.querySelector('.sc-tile');
    const letterEl = el.querySelector('.sc-letter');
    if (hostn) {
      const img = document.createElement('img'); img.className = 'sc-fav'; img.alt = '';
      img.addEventListener('load', () => { letterEl.style.display = 'none'; });
      img.addEventListener('error', () => { img.remove(); });
      img.src = `https://icons.duckduckgo.com/ip3/${hostn}.ico`;
      tile.appendChild(img);
    }
    tile.addEventListener('click', () => { if (active) guardedNavigate(active, sc.url); });
    if (!freq) el.querySelector('.sc-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      const n = getShortcuts(); n.splice(idx, 1); saveShortcuts(n); renderShortcuts();
    });
    host.appendChild(el);
  });

  if (freq) return;
  if (addingShortcut) {
    const bar = document.createElement('div'); bar.className = 'sc-addbar';
    bar.innerHTML = `<input type="text" placeholder="https://hemsida.com" spellcheck="false" />`;
    const input = bar.querySelector('input');
    const commit = () => {
      const val = input.value.trim();
      if (val) {
        const url = normalizeUrl(val);
        let label = url; try { label = new URL(url).hostname.replace(/^www\./, ''); } catch {}
        const n = getShortcuts(); n.push({ label, url }); saveShortcuts(n);
      }
      addingShortcut = false; renderShortcuts();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { addingShortcut = false; renderShortcuts(); }
    });
    input.addEventListener('blur', () => { if (addingShortcut) { addingShortcut = false; renderShortcuts(); } });
    host.appendChild(bar);
    setTimeout(() => input.focus(), 20);
  } else {
    const add = document.createElement('div'); add.className = 'sc sc-add';
    add.innerHTML = `<div class="sc-tilewrap"><div class="sc-tile"><svg class="ic"><use href="#i-plus" /></svg></div></div><div class="sc-label">Lägg till</div>`;
    add.addEventListener('click', () => { addingShortcut = true; renderShortcuts(); });
    host.appendChild(add);
  }
}
$('incog-search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && active) guardedNavigate(active, $('incog-search').value); });

/* ── Adressfält-autocomplete (från historiken) ── */
const suggestEl = $('omni-suggest');
const sug = { items: [], sel: -1, input: null, anchor: null, open: false, comp: null };
function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function historyMatches(q) {
  q = (q || '').trim().toLowerCase();
  if (!q || (active && active.incognito)) return [];       // ingen historik-autocomplete i inkognito
  const seen = new Set(); const scored = [];
  for (const e of getHistory()) {
    const host = domainOf(e.url); if (!host || seen.has(host)) continue;
    if (!host.startsWith(q)) continue;                       // BARA domäner som BÖRJAR med det man skrivit
    seen.add(host); scored.push({ url: e.url, host, title: e.title || host, favicon: e.favicon, n: e.n || 0 });
  }
  scored.sort((a, b) => (b.n || 0) - (a.n || 0));           // mest besökta först
  return scored.slice(0, 7);
}
function bestCompletion(q) {
  q = (q || '').trim().toLowerCase();
  if (!q || /[\s/]/.test(q) || (active && active.incognito)) return null;
  const items = getHistory().slice().sort((a, b) => (b.n || 0) - (a.n || 0));
  for (const e of items) { const host = domainOf(e.url); if (host.startsWith(q) && host.length > q.length) return { host, url: 'https://' + host }; }
  return null;
}
function positionSug() {
  if (!sug.anchor) return;
  const r = sug.anchor.getBoundingClientRect();
  suggestEl.style.left = r.left + 'px'; suggestEl.style.top = (r.bottom + 5) + 'px'; suggestEl.style.width = r.width + 'px';
}
function renderSug() {
  suggestEl.innerHTML = '';
  sug.items.forEach((it, i) => {
    const el = document.createElement('div'); el.className = 'sug' + (i === sug.sel ? ' sel' : '');
    const fav = it.favicon ? `<img src="${it.favicon}" onerror="this.style.display='none'">` : '<svg class="ic ic-sm"><use href="#i-globe"/></svg>';
    el.innerHTML = `<span class="sfav">${fav}</span><span class="smeta"><span class="surl">${escapeHtml(it.host)}</span><span class="stitle">${escapeHtml(it.title)}</span></span>`;
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickSug(it); });
    suggestEl.appendChild(el);
  });
}
function openSug() { if (!sug.open) { sug.open = true; window.view.hide(); } positionSug(); suggestEl.classList.add('on'); }
function closeSug(restore) { suggestEl.classList.remove('on'); sug.items = []; sug.sel = -1; if (sug.open) { sug.open = false; if (restore !== false) showActiveTab(); } }
function updateSug(q) {
  const inp = sug.input; if (!inp) return;
  sug.items = historyMatches(q);
  if (sug.items.length && document.activeElement === inp && (q || '').trim()) { renderSug(); openSug(); } else closeSug();
}
function pickSug(it) { closeSug(false); if (active) guardedNavigate(active, it.url); }
function attachAutocomplete(inp, anchor) {
  inp.addEventListener('input', (e) => {
    const typed = inp.value;                                // vad användaren faktiskt skrivit (t.ex. "ver")
    sug.input = inp; sug.anchor = anchor; sug.sel = -1;
    const forward = e.inputType && e.inputType.indexOf('insert') === 0;
    if (forward) {
      const c = bestCompletion(typed);
      if (c) { inp.value = typed + c.host.slice(typed.length); inp.setSelectionRange(typed.length, inp.value.length); sug.comp = c; }
      else sug.comp = null;
    } else sug.comp = null;
    updateSug(typed);
  });
  inp.addEventListener('keydown', (e) => {
    const openList = suggestEl.classList.contains('on') && sug.items.length;
    if (openList && e.key === 'ArrowDown') { e.preventDefault(); sug.sel = (sug.sel + 1) % sug.items.length; renderSug(); return; }
    if (openList && e.key === 'ArrowUp') { e.preventDefault(); sug.sel = (sug.sel - 1 + sug.items.length) % sug.items.length; renderSug(); return; }
    if (openList && e.key === 'Escape') { e.preventDefault(); closeSug(); inp.value = (active && active.url) ? pretty(active.url) : ''; return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (openList && sug.sel >= 0) { pickSug(sug.items[sug.sel]); return; }
      if (sug.comp && inp.value.toLowerCase() === sug.comp.host) { closeSug(false); if (active) guardedNavigate(active, sug.comp.url); return; }
      closeSug(false); if (active) guardedNavigate(active, inp.value);
    }
  });
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) closeSug(); }, 120));
}
attachAutocomplete(addressInput, $('omnibox'));
attachAutocomplete($('nt-search'), $('nt-search'));
window.addEventListener('resize', () => { if (sug.open) positionSug(); });

/* ── Bakgrundsval ── */
const CURATED_BG = [10, 1018, 1039, 1043, 1015, 1057, 1061, 1069, 29, 164, 180, 225]
  .map((id) => ({ thumb: `https://picsum.photos/id/${id}/320/200`, full: `https://picsum.photos/id/${id}/1920/1080` }));
function applyStoredBg() {
  let bg = null; try { bg = localStorage.getItem('skoll-bg'); } catch {}
  if (!bg || bg === 'daily') { loadDailyImage(); return; }
  $('nt-bg').style.backgroundImage = `url("${bg}")`;
  $('nt-credit').textContent = '';
}
function setBg(val) {
  try { localStorage.setItem('skoll-bg', val); } catch {}
  $('nt-credit').textContent = '';
  if (val === 'daily') loadDailyImage();
  else $('nt-bg').style.backgroundImage = `url("${val}")`;
}
function renderBgGrid() {
  const g = $('bg-grid'); g.innerHTML = '';
  CURATED_BG.forEach((b) => {
    const el = document.createElement('button'); el.className = 'bg-thumb';
    el.style.backgroundImage = `url("${b.thumb}")`;
    el.addEventListener('click', () => { setBg(b.full); closeBgPick(); });
    g.appendChild(el);
  });
}
function openBgPick() { renderBgGrid(); $('bgpick').classList.remove('hidden'); }
function closeBgPick() { $('bgpick').classList.add('hidden'); }
$('settings-bg-btn').addEventListener('click', openBgPick);
$('bgpick-close').addEventListener('click', closeBgPick);
$('bg-daily').addEventListener('click', () => { setBg('daily'); closeBgPick(); });
$('bg-upload-btn').addEventListener('click', () => $('bg-file').click());
$('bg-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1920; let w = img.width, h = img.height;
      if (w > max) { h = Math.round(h * max / w); w = max; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try { setBg(c.toDataURL('image/jpeg', 0.85)); } catch {}
      closeBgPick();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
});

/* ── Huvudmeny + toast ── */
let toastTimer = null;
function showToast(msg) {
  const el = $('apptoast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}
$('menu-btn').addEventListener('click', () => window.view.openMenu());
window.view.onToast((m) => showToast(m));
window.view.onOpenSettings((cat) => { openSettings(); if (cat) showSettingsCat(cat); });
window.view.onMenuZoom((dir) => { if (active && active.url) window.view.zoom(active.id, dir); });
window.view.onMenuPrint(() => { if (active && active.url) window.view.print(active.id); });
window.view.onCloseTab(() => { if (active) closeTab(active); });
window.view.onFocusAddress(() => { addressInput.focus(); addressInput.select(); });
window.view.onClearData(() => { try { localStorage.removeItem('skoll-history'); } catch {} if (typeof historyOpen !== 'undefined' && historyOpen) renderHistory(); showToast('Surfdata rensad.'); });

/* ── Historik ── */
function getHistory() { try { const h = JSON.parse(localStorage.getItem('skoll-history')); return Array.isArray(h) ? h : []; } catch { return []; } }
function pushHistory(url, title, favicon) {
  if (!/^https?:/i.test(url)) return;
  const all = getHistory();
  const prev = all.find((e) => e.url === url);
  const n = ((prev && prev.n) || 0) + 1;
  let h = all.filter((e) => e.url !== url);
  h.unshift({ url, title: title || (prev && prev.title) || url, favicon: favicon || (prev && prev.favicon) || null, t: Date.now(), n });
  if (h.length > 500) h = h.slice(0, 500);
  try { localStorage.setItem('skoll-history', JSON.stringify(h)); } catch {}
}
let historyOpen = false;
function renderHistory() {
  const list = $('history-list'); list.innerHTML = '';
  const h = getHistory();
  if (!h.length) { list.innerHTML = '<div style="padding:16px;color:#8ba3bf;font-size:13px">Ingen historik än.</div>'; return; }
  h.forEach((e) => {
    const row = document.createElement('div'); row.className = 'hist-row';
    const fav = e.favicon
      ? `<img class="hist-fav" src="${e.favicon}">`
      : `<span class="hist-fav" style="display:grid;place-items:center;color:#8ba3bf"><svg class="ic" style="width:13px;height:13px"><use href="#i-globe" /></svg></span>`;
    row.innerHTML = `${fav}<div class="hist-txt"><div class="hist-title">${escapeHtml(e.title)}</div><div class="hist-url">${escapeHtml(e.url.replace(/^https?:\/\/(www\.)?/, ''))}</div></div>`;
    row.addEventListener('click', () => { closeHistory(); if (active) guardedNavigate(active, e.url); });
    list.appendChild(row);
  });
}
function openHistory() { renderHistory(); $('history').classList.remove('hidden'); window.view.insetLeft(320); historyOpen = true; }
function closeHistory() { $('history').classList.add('hidden'); window.view.insetLeft(0); historyOpen = false; }
window.view.onOpenHistory(() => { historyOpen ? closeHistory() : openHistory(); });
$('history-close').addEventListener('click', closeHistory);

/* ── Bokmärken ── */
function getBookmarks() { try { const b = JSON.parse(localStorage.getItem('skoll-bookmarks')); return Array.isArray(b) ? b : []; } catch { return []; } }
function saveBookmarks(l) { try { localStorage.setItem('skoll-bookmarks', JSON.stringify(l)); } catch {} }
function isBookmarked(url) { return getBookmarks().some((b) => b.url === url); }
function updateStar() { $('bm-star').classList.toggle('on', !!(active && active.url && isBookmarked(active.url))); }
$('bm-star').addEventListener('click', () => {
  if (!active || !active.url) return;
  let l = getBookmarks();
  if (isBookmarked(active.url)) l = l.filter((b) => b.url !== active.url);
  else l.unshift({ url: active.url, title: active.title || active.url, favicon: active.favicon || null });
  saveBookmarks(l); updateStar();
});
function rowFav(favicon) {
  return favicon ? `<img class="hist-fav" src="${favicon}">` : `<span class="hist-fav" style="display:grid;place-items:center;color:#8ba3bf"><svg class="ic" style="width:13px;height:13px"><use href="#i-globe" /></svg></span>`;
}
function openBookmarks() {
  window.view.hide();
  const list = $('bookmarks-list'); list.innerHTML = '';
  const b = getBookmarks();
  if (!b.length) list.innerHTML = '<div style="padding:16px;color:#8ba3bf;font-size:13px">Inga bokmärken än.</div>';
  b.forEach((e) => {
    const row = document.createElement('div'); row.className = 'hist-row';
    row.innerHTML = `${rowFav(e.favicon)}<div class="hist-txt"><div class="hist-title">${escapeHtml(e.title)}</div><div class="hist-url">${escapeHtml(e.url.replace(/^https?:\/\/(www\.)?/, ''))}</div></div><button class="row-btn" title="Ta bort"><svg class="ic ic-sm"><use href="#i-trash" /></svg></button>`;
    row.addEventListener('click', () => { closeBookmarks(); if (active) guardedNavigate(active, e.url); });
    row.querySelector('.row-btn').addEventListener('click', (ev) => { ev.stopPropagation(); saveBookmarks(getBookmarks().filter((x) => x.url !== e.url)); openBookmarks(); updateStar(); });
    list.appendChild(row);
  });
  hideOverlayElements();
  if (active) active.overlay = 'bookmarks';
  $('bookmarks').classList.remove('hidden');
}
function closeBookmarks() { if (active) active.overlay = null; $('bookmarks').classList.add('hidden'); showActiveTab(); }
$('bookmarks-close').addEventListener('click', closeBookmarks);
window.view.onOpenBookmarks(() => openBookmarks());

/* ── Nedladdningar ── */
const dlMap = new Map();
function fmtBytes(n) { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }
function renderDownloads() {
  const list = $('downloads-list'); list.innerHTML = '';
  const items = [...dlMap.values()];
  if (!items.length) { list.innerHTML = '<div style="padding:16px;color:#8ba3bf;font-size:13px">Inga nedladdningar än.</div>'; return; }
  items.forEach((d) => {
    const row = document.createElement('div'); row.className = 'hist-row'; row.style.cursor = 'default';
    const done = d.state === 'completed';
    const scanning = d.state === 'scanning', infected = d.state === 'infected', removed = d.state === 'deleted';
    let status, col = '#8ba3bf';
    if (d.state === 'progressing') status = `${fmtBytes(d.received)} / ${fmtBytes(d.total)}`;
    else if (scanning) { status = 'Skannar efter virus…'; col = 'var(--color-terra)'; }
    else if (infected) { status = '⚠ Blockerad — ' + (d.threat || 'hot'); col = 'var(--color-danger)'; }
    else if (removed) { status = 'Borttagen (virus)'; col = 'var(--color-danger)'; }
    else if (done) { status = d.scan === 'overridden' ? 'Klar (behållen trots varning)' : (d.scan === 'clean' ? 'Säker ✓' : 'Klar'); col = 'var(--color-safe)'; }
    else { status = d.state === 'cancelled' ? 'Avbruten' : 'Misslyckades'; }
    const useIco = infected || removed ? 'i-shield-x' : (scanning ? 'i-shield' : 'i-download');
    row.innerHTML = `<span class="hist-fav" style="display:grid;place-items:center;color:${col}"><svg class="ic ic-sm"><use href="#${useIco}" /></svg></span><div class="hist-txt"><div class="hist-title">${escapeHtml(d.filename)}</div><div class="hist-url" style="color:${infected || removed ? 'var(--color-danger)' : ''}">${escapeHtml(status)}</div></div>` + (done ? `<button class="row-btn" title="Visa i mapp"><svg class="ic ic-sm"><use href="#i-folder" /></svg></button>` : '');
    if (done) { const b = row.querySelector('.row-btn'); if (b) b.addEventListener('click', () => window.dl.folder(d.id)); }
    list.appendChild(row);
  });
}
window.dl.onUpdate((r) => { dlMap.set(r.id, r); if ($('downloads-list')) renderDownloads(); });
/* Farlig nedladdning stoppad → varningsbar */
let threatId = null;
window.dl.onThreat((t) => {
  threatId = t.id;
  $('dlthreat-msg').innerHTML = '<b>' + escapeHtml(t.filename) + '</b> kan innehålla <b>' + escapeHtml(t.threat) + '</b>. Vi flyttade den åt sidan så den inte kan skada din dator. Är du säker på att filen är trygg kan du behålla den ändå.';
  $('dlthreat').style.display = 'block';
  showToast('⚠ Farlig nedladdning stoppad');
});
function hideThreat() { $('dlthreat').style.display = 'none'; threatId = null; }
$('dlthreat-remove').addEventListener('click', () => { if (threatId) window.dl.removeThreat(threatId); hideThreat(); showToast('Filen togs bort.'); });
$('dlthreat-keep').addEventListener('click', () => { if (threatId) window.dl.keepAnyway(threatId); hideThreat(); showToast('Filen behölls i Nedladdningar.'); });
$('dlthreat-close').addEventListener('click', hideThreat);
async function openDownloads() {
  openSettings(); showSettingsCat('nedladdningar');
  const server = await window.dl.list().catch(() => []);
  (server || []).forEach((d) => dlMap.set(d.id, d));
  renderDownloads();
}
window.view.onOpenDownloads(() => openDownloads());

/* ── Lösenord ── */
async function renderPasswords() {
  const list = $('passwords-list'); list.innerHTML = '';
  const items = await window.pw.list().catch(() => []);
  if (!items.length) { list.innerHTML = '<div style="padding:16px;color:#8ba3bf;font-size:13px">Inga sparade lösenord än.</div>'; return; }
  items.forEach((p) => {
    const row = document.createElement('div'); row.className = 'hist-row'; row.style.cursor = 'default';
    let host = p.origin; try { host = new URL(p.origin).hostname.replace(/^www\./, ''); } catch {}
    row.innerHTML = `<span class="hist-fav" style="display:grid;place-items:center;color:#8ba3bf"><svg class="ic ic-sm"><use href="#i-key" /></svg></span><div class="hist-txt"><div class="hist-title">${escapeHtml(host)} · ${escapeHtml(p.username || '')}</div><div class="hist-url"><span class="pw-dots">••••••••</span></div></div><button class="row-btn" data-a="eye" title="Visa"><svg class="ic ic-sm"><use href="#i-eye" /></svg></button><button class="row-btn" data-a="del" title="Ta bort"><svg class="ic ic-sm"><use href="#i-trash" /></svg></button>`;
    const dots = row.querySelector('.pw-dots');
    row.querySelector('[data-a=eye]').addEventListener('click', () => { dots.textContent = dots.textContent.startsWith('•') ? p.password : '••••••••'; });
    row.querySelector('[data-a=del]').addEventListener('click', async () => { await window.pw.del(p.id); renderPasswords(); });
    list.appendChild(row);
  });
}
function openPasswords() { openSettings(); showSettingsCat('losenord'); renderPasswords(); }
window.view.onOpenPasswords(() => openPasswords());
$('pw-add-btn').addEventListener('click', async () => {
  const origin = $('pw-add-origin').value.trim(); const username = $('pw-add-user').value.trim(); const password = $('pw-add-pass').value;
  if (!origin || !password) return;
  let o = origin; try { o = new URL(normalizeUrl(origin)).origin; } catch {}
  await window.pw.save({ origin: o, username, password });
  $('pw-add-origin').value = ''; $('pw-add-user').value = ''; $('pw-add-pass').value = '';
  renderPasswords();
});

/* ── Spara lösenord-bar (fråga vid inloggning) ── */
let pwOfferCred = null;
function hidePwbar() { $('pwbar').style.display = 'none'; if ($('infobar').style.display === 'none') window.view.insetTop(0); }
window.pw.onOffer((c) => {
  pwOfferCred = c;
  let host = c.origin; try { host = new URL(c.origin).hostname.replace(/^www\./, ''); } catch {}
  $('pwbar-sub').textContent = (c.username ? c.username + ' · ' : '') + host;
  hideInfobar();
  $('pwbar').style.display = 'flex';
  window.view.insetTop(56);
});
$('pwbar-save').addEventListener('click', async () => { if (pwOfferCred) await window.pw.save(pwOfferCred); pwOfferCred = null; hidePwbar(); });
$('pwbar-no').addEventListener('click', () => { pwOfferCred = null; hidePwbar(); });

/* ── Prowl Wallet ── */
function fmtNum(s) { return (s || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim(); }
function fmtExp(s) { const d = (s || '').replace(/\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
let wlEditing = null; // kort-id under redigering, 'new', eller null
async function renderWallet() {
  const wrap = $('wallet-list'); if (!wrap) return;
  const cards = await window.wallet.list().catch(() => []);
  wrap.innerHTML = '';
  if (wlEditing === 'new') wrap.appendChild(walletEditForm(null));
  if (!cards.length && wlEditing !== 'new') {
    wrap.innerHTML = '<div style="padding:14px;color:var(--color-navy-700);font-size:13px;opacity:.7">Inga sparade kort än. Lägg till ett här eller spara vid din nästa betalning.</div>';
    return;
  }
  cards.forEach((c) => {
    if (wlEditing === c.id) { wrap.appendChild(walletEditCard(c)); return; }
    const el = document.createElement('div'); el.className = 'wl-card';
    el.innerHTML = `<div class="wl-card-face"><span class="wl-chip"></span><div class="wl-card-info"><div class="wl-card-num">•••• •••• •••• ${escapeHtml(c.last4 || '••••')}</div><div class="wl-card-meta"><span>${escapeHtml(c.holder || 'Kortinnehavare')}</span><span>${escapeHtml(c.exp || 'MM/ÅÅ')}</span></div></div><span class="wl-brand">${escapeHtml(c.brand || 'Kort')}</span></div>
      <div class="wl-card-actions"><button class="wl-btn" data-a="edit"><svg class="ic ic-sm"><use href="#i-settings" /></svg>Ändra</button><button class="wl-btn wl-del" data-a="del"><svg class="ic ic-sm"><use href="#i-trash" /></svg>Ta bort</button></div>`;
    el.querySelector('[data-a=edit]').addEventListener('click', () => { wlEditing = c.id; renderWallet(); });
    el.querySelector('[data-a=del]').addEventListener('click', async () => { await window.wallet.del(c.id); if (wlEditing === c.id) wlEditing = null; renderWallet(); });
    wrap.appendChild(el);
  });
}
function walletEditCard(pub) {
  const el = document.createElement('div'); el.className = 'wl-card';
  el.innerHTML = `<div class="wl-card-face"><span class="wl-chip"></span><div class="wl-card-info"><div class="wl-card-num">•••• •••• •••• ${escapeHtml(pub.last4 || '••••')}</div><div class="wl-card-meta"><span>Ändra kortuppgifter</span></div></div><span class="wl-brand">${escapeHtml(pub.brand || 'Kort')}</span></div>`;
  el.appendChild(walletEditForm(pub.id));
  return el;
}
function walletEditForm(id) {
  const form = document.createElement('div'); form.className = 'wl-edit';
  form.innerHTML = `
    <div class="wl-full"><label class="wl-lbl">Kortinnehavare</label><input class="wl-in" data-f="holder" placeholder="Namn på kortet" /></div>
    <div class="wl-full"><label class="wl-lbl">Kortnummer</label><input class="wl-in" data-f="number" inputmode="numeric" placeholder="1234 5678 9012 3456" /></div>
    <div><label class="wl-lbl">Giltig t.o.m.</label><input class="wl-in" data-f="exp" inputmode="numeric" placeholder="MM/ÅÅ" maxlength="5" /></div>
    <div><label class="wl-lbl">CVC</label><input class="wl-in" data-f="cvc" inputmode="numeric" placeholder="123" maxlength="4" /></div>
    <div class="wl-save"><button class="btn btn-safe" data-a="save" style="height:40px;padding:0 18px;">Spara kort</button><button class="wl-btn" data-a="cancel" style="height:40px">Avbryt</button></div>`;
  const g = (f) => form.querySelector(`[data-f=${f}]`);
  g('number').addEventListener('input', (e) => { const p = e.target.selectionStart; e.target.value = fmtNum(e.target.value); });
  g('exp').addEventListener('input', (e) => { e.target.value = fmtExp(e.target.value); });
  if (id) window.wallet.get(id).then((c) => { if (!c) return; g('holder').value = c.holder || ''; g('number').value = fmtNum(c.number); g('exp').value = c.exp || ''; g('cvc').value = c.cvc || ''; });
  form.querySelector('[data-a=cancel]').addEventListener('click', () => { wlEditing = null; renderWallet(); });
  form.querySelector('[data-a=save]').addEventListener('click', async () => {
    const num = g('number').value.replace(/\D/g, '');
    if (num.length < 12) { g('number').style.borderColor = '#c25340'; return; }
    await window.wallet.save({ id: id || undefined, holder: g('holder').value, number: num, exp: g('exp').value, cvc: g('cvc').value });
    wlEditing = null; renderWallet(); showToast('Kort sparat – krypterat på din dator.');
  });
  return form;
}
function openWallet() { openSettings(); showSettingsCat('wallet'); renderWallet(); }
$('wallet-add-btn') && $('wallet-add-btn').addEventListener('click', () => { wlEditing = 'new'; renderWallet(); setTimeout(() => { const f = document.querySelector('#wallet-list .wl-in[data-f=number]'); if (f) f.focus(); }, 0); });
$('wl-buy-toggle') && $('wl-buy-toggle').addEventListener('change', (e) => { try { localStorage.setItem('vaka-krypto-buy', e.target.checked ? '1' : '0'); } catch {} showToast(e.target.checked ? '🤖 Krypto får nu handla åt dig – du godkänner varje köp.' : 'Krypto handlar inte längre åt dig.'); });

/* ═══ Konto, socialt lager (vänner & chatt) & Krypto-köp — porterat från Vaka (utan familj) ═══ */
/* ── Kontosida (profil i Inställningar) + radera konto ── */
function openAccount() { if (account) { openSettings(); showSettingsCat('konto'); } else { openLogin(); } }
async function renderKonto() {
  const si = $('kn-signedin'), so = $('kn-signedout');
  if (!si) return;
  if (!account) { si.style.display = 'none'; if (so) so.style.display = 'block'; return; }
  si.style.display = 'block'; if (so) so.style.display = 'none';
  const nm = account.name || (account.isChild ? 'Barnkonto' : (account.email ? account.email.split('@')[0] : 'Du'));
  $('kn-avatar').innerHTML = escapeHtml((nm[0] || '?').toUpperCase());
  $('kn-name').textContent = nm;
  $('kn-email').textContent = account.isChild ? 'Barnkonto (loggar in med kod)' : (account.email || '');
  $('kn-badge').style.display = account.pro ? 'inline-flex' : 'none';
  const rows = [['Typ', account.isChild ? 'Barnkonto' : 'Vuxenkonto'], ['Status', account.pro ? 'Prowl Pro' : 'Gratis']];
  if (account.email && !account.isChild) rows.push(['Mejl', account.email]);
  $('kn-rows').innerHTML = rows.map((r) => '<div class="kn-row"><span class="k">' + r[0] + '</span><span class="v">' + escapeHtml(r[1]) + '</span></div>').join('');
  const dz = $('kn-danger'); if (dz) dz.style.display = account.isChild ? 'none' : 'block';
  const pm = $('kn-prof-msg'); if (pm) pm.textContent = '';
  await loadSocMe();
  if (socMe) {
    const un = $('kn-username'); if (un) un.value = socMe.username || '';
    if (socMe.avatar) $('kn-avatar').innerHTML = '<img src="' + socMe.avatar + '" alt="">';
  }
}
function showConfirmDelete() {
  if (!account || account.isChild || document.getElementById('kn-delmodal')) return;
  const ov = document.createElement('div'); ov.id = 'kn-delmodal';
  ov.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(5,12,22,.5);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px);';
  ov.innerHTML = '<div style="width:min(420px,94vw);background:#fff;border-radius:18px;padding:24px;box-shadow:0 30px 70px rgba(8,20,35,.4)">'
    + '<div style="font-size:34px;text-align:center;margin-bottom:8px">⚠️</div>'
    + '<div style="font-size:18px;font-weight:800;color:var(--color-navy-900);text-align:center;margin-bottom:8px">Ta bort kontot?</div>'
    + '<p style="font-size:13.5px;color:rgb(28 43 58 / .6);text-align:center;margin-bottom:18px;line-height:1.5">Ditt konto och all data (Pro, barn, inställningar) raderas permanent. Det går inte att ångra.</p>'
    + '<div style="display:flex;gap:9px"><button id="kn-del-cancel" class="btn btn-ghost" style="flex:1;height:44px">Avbryt</button><button id="kn-del-yes" class="kn-del-btn" style="flex:1;height:44px">Ja, ta bort</button></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#kn-del-cancel').addEventListener('click', close);
  ov.querySelector('#kn-del-yes').addEventListener('click', async () => {
    const btn = ov.querySelector('#kn-del-yes'); btn.disabled = true; btn.textContent = 'Tar bort…';
    let r; try { r = await window.auth.deleteAccount(account.token); } catch { r = { ok: false }; }
    if (!r || !r.ok) { btn.disabled = false; btn.textContent = 'Ja, ta bort'; showToast((r && r.message) || 'Kunde inte ta bort kontot.'); return; }
    close(); doLogout(false); renderKonto(); showToast('Ditt konto är borttaget.');
  });
}
/* ── Socialt: profil, vänner & chatt ── */
let socMe = null, socChat = null, socChatName = '', socPoll = null, socLastTs = 0, socMembers = {}, socSeen = {}, socLoading = false;
async function loadSocMe() {
  if (!account || !account.token) { socMe = null; return null; }
  try { const r = await window.social.me(account.token); if (r && r.ok) socMe = r; } catch {}
  return socMe;
}
function socAvatar(av, name, size) {
  const s = size || 38;
  if (av) return '<img src="' + av + '" style="width:' + s + 'px;height:' + s + 'px;border-radius:50%;object-fit:cover;flex:none;">';
  const init = ((name || '?')[0] || '?').toUpperCase();
  return '<span style="width:' + s + 'px;height:' + s + 'px;border-radius:50%;background:linear-gradient(135deg,#2f5f88,#2f8fd4);color:#fff;display:grid;place-items:center;font-weight:800;font-size:' + Math.round(s * 0.42) + 'px;flex:none;">' + escapeHtml(init) + '</span>';
}
async function renderFriends() {
  const wrap = $('fr-body'); if (!wrap) return;
  if ($('fr-list')) $('fr-list').style.display = 'block';
  if ($('fr-chat')) $('fr-chat').style.display = 'none';
  stopChatPoll();
  if (!account) { wrap.innerHTML = '<p class="set-lead">Logga in för att lägga till vänner och chatta.</p>'; return; }
  await loadSocMe();
  if (!socMe || !socMe.username) {
    wrap.innerHTML = '<div class="fr-note">Välj ett <b>användarnamn</b> i Konto-fliken först, så kan du lägga till vänner.</div><button id="fr-go-konto" class="btn btn-safe" style="height:40px;padding:0 16px;">Gå till Konto</button>';
    const g = $('fr-go-konto'); if (g) g.addEventListener('click', () => showSettingsCat('konto'));
    return;
  }
  let data = {}; try { data = await window.social.friends(account.token); } catch {}
  const friends = (data && data.friends) || [], incoming = (data && data.incoming) || [];
  let html = '<div class="fr-add"><input id="fr-add-in" class="fam-in" placeholder="@användarnamn" spellcheck="false" style="flex:1;"><button id="fr-add-btn" class="btn btn-safe flex-none" style="height:40px;padding:0 14px;">Lägg till</button></div>';
  if (incoming.length) {
    html += '<div class="fr-sub">Vänförfrågningar</div>';
    html += incoming.map((f) => '<div class="fr-row"><div class="fr-id">' + socAvatar(f.avatar, f.username) + '<span class="fr-name">@' + escapeHtml(f.username || '') + '</span></div><div style="display:flex;gap:6px;flex:none;"><button class="fr-acc" data-u="' + escapeHtml(f.username) + '">Acceptera</button><button class="fr-dec" data-u="' + escapeHtml(f.username) + '">×</button></div></div>').join('');
  }
  html += '<div class="fr-sub">Chattar</div>';
  if (friends.length) html += friends.map((f) => '<div class="fr-row fr-open" data-chat="dm:' + escapeHtml(f.username) + '" data-name="@' + escapeHtml(f.username) + '"><div class="fr-id">' + socAvatar(f.avatar, f.username) + '<span class="fr-name">@' + escapeHtml(f.username || '') + '</span></div><span class="fr-go">›</span></div>').join('');
  else html += '<div class="fr-none">Inga vänner än – lägg till någon med deras användarnamn.</div>';
  wrap.innerHTML = html;
  $('fr-add-btn').addEventListener('click', socAddFriend);
  $('fr-add-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') socAddFriend(); });
  wrap.querySelectorAll('.fr-acc').forEach((b) => b.addEventListener('click', async () => { await window.social.friendRespond(account.token, b.dataset.u, true); renderFriends(); }));
  wrap.querySelectorAll('.fr-dec').forEach((b) => b.addEventListener('click', async () => { await window.social.friendRespond(account.token, b.dataset.u, false); renderFriends(); }));
  wrap.querySelectorAll('.fr-open').forEach((r) => r.addEventListener('click', () => openChat(r.dataset.chat, r.dataset.name)));
}
async function socAddFriend() {
  const inp = $('fr-add-in'); if (!inp) return;
  const un = (inp.value || '').trim().replace(/^@/, ''); if (!un) return;
  const r = await window.social.friendRequest(account.token, un).catch(() => ({ ok: false }));
  if (!r || !r.ok) { showToast((r && r.message) || 'Kunde inte lägga till.'); return; }
  inp.value = '';
  showToast(r.state === 'friends' ? 'Ni är vänner nu!' : r.state === 'sent' ? 'Vänförfrågan skickad.' : 'Förfrågan finns redan.');
  renderFriends();
}
function openChat(chat, name) {
  socChat = chat; socChatName = name || 'Chatt'; socLastTs = 0; socSeen = {}; socMembers = {};
  $('fr-list').style.display = 'none'; $('fr-chat').style.display = 'flex';
  $('fr-chat-title').textContent = socChatName;
  $('fr-msgs').innerHTML = '';
  setChatAvatar(null);
  loadMessages();
  stopChatPoll(); socPoll = setInterval(loadMessages, 3000);
}
function stopChatPoll() { if (socPoll) { clearInterval(socPoll); socPoll = null; } }
function closeChat() { stopChatPoll(); socChat = null; renderFriends(); }
async function loadMessages() {
  if (!socChat || !account || socLoading) return;   // in-flight-vakt → ingen stapling vid seg uppkoppling
  socLoading = true;
  let r; try { r = await window.social.messages(account.token, socChat, socLastTs); } catch { socLoading = false; return; }
  socLoading = false;
  if (!r || !r.ok) return;
  if (r.members) Object.assign(socMembers, r.members);   // avatarer cachas (skickas en gång per svar)
  setChatAvatar(r.chatAvatar);
  const box = $('fr-msgs'); if (!box) return;
  const hidden = socHiddenSet();
  let added = false;
  (r.messages || []).forEach((m) => {
    if (m.ts > socLastTs) socLastTs = m.ts;
    if (socSeen[m.id] || hidden.has(m.id)) return;   // dedup + lokalt raderade
    socSeen[m.id] = true; box.appendChild(msgEl(m)); added = true;
  });
  if (added) box.scrollTop = box.scrollHeight;
}
function msgEl(m) {
  const d = document.createElement('div'); d.className = 'fr-msg' + (m.mine ? ' mine' : '');
  d.dataset.id = m.id;
  const av = socMembers[m.username];
  d.innerHTML = (m.mine ? '' : socAvatar(av, m.username, 30)) + '<div class="fr-bub"><div class="fr-bub-name">@' + escapeHtml(m.username || '') + '</div>' + escapeHtml(m.body) + (m.edited ? ' <span class="fr-ed">(ändrad)</span>' : '') + '</div>';
  const bub = d.querySelector('.fr-bub'); bub.style.cursor = 'pointer';
  bub.addEventListener('click', (e) => { e.stopPropagation(); msgMenu(m, bub); });
  return d;
}
function socHiddenSet() { try { return new Set(JSON.parse(localStorage.getItem('vaka-hidden-msgs') || '[]')); } catch { return new Set(); } }
function hideMsgLocal(id) {
  const s = socHiddenSet(); s.add(id);
  try { localStorage.setItem('vaka-hidden-msgs', JSON.stringify([...s])); } catch {}
  const el = document.querySelector('.fr-msg[data-id="' + id + '"]'); if (el) el.remove();
}
function setChatAvatar(chatAvatar) {
  const el = $('fr-chat-av'); if (!el) return;
  let av = chatAvatar;
  if (!av && socChat && socChat.indexOf('dm:') === 0) av = socMembers[socChat.slice(3)];
  el.innerHTML = av ? '<img src="' + av + '" style="width:100%;height:100%;object-fit:cover;">' : (socChat === 'family' ? '👪' : '@');
  el.style.cursor = (socChat === 'family') ? 'pointer' : 'default';
}
function refreshChat() { const box = $('fr-msgs'); if (box) box.innerHTML = ''; socLastTs = 0; socSeen = {}; loadMessages(); }
function closeMsgMenu() { const m = $('fr-msgmenu'); if (m) m.remove(); }
function msgMenu(m, anchorEl) {
  closeMsgMenu();
  const menu = document.createElement('div'); menu.id = 'fr-msgmenu';
  menu.style.cssText = 'position:fixed;z-index:250;background:#fff;border:1px solid var(--color-line);border-radius:12px;box-shadow:0 12px 34px rgba(8,20,35,.22);padding:5px;min-width:158px;';
  const item = (label, danger, fn) => {
    const b = document.createElement('button'); b.textContent = label;
    b.style.cssText = 'display:block;width:100%;text-align:left;padding:9px 12px;border:0;background:none;border-radius:8px;font-size:13px;cursor:pointer;color:' + (danger ? '#b23636' : 'var(--color-navy-900)') + ';';
    b.addEventListener('mouseenter', () => (b.style.background = 'var(--color-paper)'));
    b.addEventListener('mouseleave', () => (b.style.background = 'none'));
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMsgMenu(); fn(); });
    menu.appendChild(b);
  };
  item('Kopiera', false, () => { try { navigator.clipboard.writeText(m.body); } catch {} showToast('Kopierat'); });
  if (m.mine) item('Redigera', false, () => startEdit(m));
  item('Radera för mig', true, () => hideMsgLocal(m.id));
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('click', closeMsgMenu, { once: true }), 0);
}
function startEdit(m) {
  const bub = document.querySelector('.fr-msg[data-id="' + m.id + '"] .fr-bub'); if (!bub) return;
  bub.innerHTML = '<input class="fr-edit-in">';
  const inp = bub.querySelector('.fr-edit-in'); inp.value = m.body; inp.focus(); inp.select();
  let done = false;
  const save = async () => {
    if (done) return; done = true;
    const nb = (inp.value || '').trim();
    if (!nb || nb === m.body) { refreshChat(); return; }
    const r = await window.social.edit(account.token, m.id, nb).catch(() => ({ ok: false }));
    if (!r || !r.ok) showToast('Kunde inte redigera.');
    refreshChat();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { done = true; refreshChat(); } });
  inp.addEventListener('blur', save);
}
async function socSend() {
  const inp = $('fr-send-in'); if (!inp || !socChat) return;
  const body = (inp.value || '').trim(); if (!body) return;
  inp.value = '';
  const r = await window.social.send(account.token, socChat, body).catch(() => ({ ok: false }));
  if (!r || !r.ok) { showToast('Kunde inte skicka.'); inp.value = body; return; }
  loadMessages();
}
/* Profil: bild-uppladdning + användarnamn (i Konto) */
function knResizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); // vit botten (PNG-transparens → JPEG)
        const m = Math.min(img.width, img.height), sx = (img.width - m) / 2, sy = (img.height - m) / 2;
        ctx.drawImage(img, sx, sy, m, m, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('img'));
      img.src = reader.result; // data: URL (tillåts av CSP, till skillnad från blob:)
    };
    reader.readAsDataURL(file);
  });
}
async function knHandleAvatar(e) {
  const file = e.target.files && e.target.files[0]; if (!file || !account) return;
  const dataUrl = await knResizeImage(file, 96).catch(() => null);
  e.target.value = '';
  if (!dataUrl) { showToast('Kunde inte läsa bilden.'); return; }
  const r = await window.social.profile(account.token, undefined, dataUrl).catch(() => ({ ok: false }));
  if (!r || !r.ok) { showToast((r && r.message) || 'Kunde inte spara bilden.'); return; }
  socMe = socMe || {}; socMe.avatar = dataUrl;
  $('kn-avatar').innerHTML = '<img src="' + dataUrl + '" alt="">';
  showToast('Profilbild uppdaterad.');
}
async function knSaveProfile() {
  if (!account) return;
  const un = ($('kn-username').value || '').trim().replace(/^@/, '');
  const msg = $('kn-prof-msg');
  const r = await window.social.profile(account.token, un || undefined, undefined).catch(() => ({ ok: false }));
  if (!r || !r.ok) { if (msg) { msg.textContent = (r && r.message) || 'Kunde inte spara.'; msg.style.color = '#c25340'; } return; }
  socMe = socMe || {}; socMe.username = r.username;
  if (msg) { msg.textContent = 'Sparat ✓'; msg.style.color = 'var(--color-safe)'; }
}

/* ── Krypto handlar åt användaren (tillstånd + säkerhetskoll + bekräftelse) ── */
function kbuyAllowed() { try { return localStorage.getItem('vaka-krypto-buy') === '1'; } catch { return false; } }
function cardLabel(c) { return (c.brand || 'Kort') + ' •• ' + (c.last4 || '····'); }
function kbuyOverlay(inner) {
  const ov = document.createElement('div'); ov.id = 'kbuy-modal';
  ov.style.cssText = 'position:fixed;inset:0;z-index:210;background:rgba(5,12,22,.55);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px);';
  ov.innerHTML = '<div style="width:min(430px,95vw);background:#fff;border-radius:20px;padding:24px;box-shadow:0 30px 80px rgba(8,20,35,.45)">' + inner + '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  return ov;
}
function startKryptoPurchase(val) {
  if (document.getElementById('kbuy-modal')) return;
  const p = ('' + val).split('|').map((s) => s.trim());
  const order = { desc: p[0] || 'Köp', merchant: p[1] || 'Butik', amount: p[2] || '' };
  if (!kbuyAllowed()) return showBuyConsent(order);
  showBuyConfirm(order);
}
function showBuyConsent(order) {
  const ov = kbuyOverlay(
    '<div style="font-size:32px;text-align:center;margin-bottom:8px">🛍️</div>'
    + '<div style="font-size:18px;font-weight:800;text-align:center;color:var(--color-navy-900);margin-bottom:8px">Låta Krypto handla åt dig?</div>'
    + '<p style="font-size:13.5px;color:rgb(28 43 58 / .62);text-align:center;line-height:1.55;margin-bottom:18px">Krypto vill kunna köpa saker åt dig med dina sparade kort. Du får alltid <b>godkänna varje köp</b> innan betalning – och kan stänga av det när som helst i Prowl Wallet.</p>'
    + '<div style="display:flex;gap:9px"><button id="kbuy-no" class="btn btn-ghost" style="flex:1;height:44px">Nej tack</button><button id="kbuy-yes" class="btn btn-safe" style="flex:1;height:44px">Tillåt</button></div>');
  ov.querySelector('#kbuy-no').addEventListener('click', () => { ov.remove(); showToast('Krypto handlar inte utan ditt tillstånd.'); });
  ov.querySelector('#kbuy-yes').addEventListener('click', () => { try { localStorage.setItem('vaka-krypto-buy', '1'); } catch {} const t = $('wl-buy-toggle'); if (t) t.checked = true; ov.remove(); showBuyConfirm(order); });
}
async function showBuyConfirm(order) {
  let cards = []; try { cards = await window.wallet.list(); } catch {}
  if (!cards || !cards.length) {
    const ov = kbuyOverlay(
      '<div style="font-size:32px;text-align:center;margin-bottom:8px">💳</div>'
      + '<div style="font-size:17px;font-weight:800;text-align:center;color:var(--color-navy-900);margin-bottom:8px">Inget kort sparat</div>'
      + '<p style="font-size:13.5px;color:rgb(28 43 58 / .62);text-align:center;margin-bottom:18px">Lägg till ett kort i Prowl Wallet så kan Krypto betala åt dig.</p>'
      + '<div style="display:flex;gap:9px"><button id="kbuy-cancel" class="btn btn-ghost" style="flex:1;height:44px">Avbryt</button><button id="kbuy-wallet" class="btn btn-safe" style="flex:1;height:44px">Öppna Wallet</button></div>');
    ov.querySelector('#kbuy-cancel').addEventListener('click', () => ov.remove());
    ov.querySelector('#kbuy-wallet').addEventListener('click', () => { ov.remove(); openWallet(); });
    return;
  }
  const opts = cards.map((c, i) => '<option value="' + i + '">' + escapeHtml(cardLabel(c)) + '</option>').join('');
  const ov = kbuyOverlay(
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><span style="font-size:26px">🤖</span><div style="font-size:16px;font-weight:800;color:var(--color-navy-900)">Krypto vill göra ett köp åt dig</div></div>'
    + '<div style="background:var(--color-paper);border:1px solid var(--color-line);border-radius:14px;padding:14px 16px;margin-bottom:14px">'
    +   '<div style="font-size:15px;font-weight:700;color:var(--color-navy-900)">' + escapeHtml(order.desc) + '</div>'
    +   '<div style="font-size:13px;color:rgb(28 43 58 / .6);margin-top:2px">från ' + escapeHtml(order.merchant) + '</div>'
    +   (order.amount ? '<div style="font-size:22px;font-weight:800;color:var(--color-navy-900);margin-top:8px">' + escapeHtml(order.amount) + '</div>' : '')
    + '</div>'
    + '<label style="display:block;font-size:12px;font-weight:700;color:rgb(28 43 58 / .7);margin-bottom:6px">Betala med</label>'
    + '<select id="kbuy-card" style="width:100%;height:42px;border:1px solid var(--color-line);border-radius:11px;padding:0 12px;font-size:14px;color:var(--color-navy-900);background:#fff;margin-bottom:14px">' + opts + '</select>'
    + '<div id="kbuy-scan" style="border:1px solid rgba(23,138,90,.25);background:rgba(23,138,90,.05);border-radius:13px;padding:12px 14px;font-size:12.5px;color:var(--color-navy-900);line-height:1.7"></div>'
    + '<p style="font-size:13px;font-weight:700;color:var(--color-navy-900);text-align:center;margin:14px 0">Är du säker på att detta är rätt?</p>'
    + '<div style="display:flex;gap:9px"><button id="kbuy-cancel" class="btn btn-ghost" style="flex:1;height:46px">Avbryt</button><button id="kbuy-go" class="btn btn-safe" style="flex:1;height:46px">Ja, godkänn köp</button></div>'
    + '<div style="font-size:11px;color:rgb(28 43 58 / .4);text-align:center;margin-top:12px">🔒 Demoläge – ingen riktig betalning genomförs.</div>');
  const scan = ov.querySelector('#kbuy-scan');
  const renderScan = () => {
    const c = cards[+ov.querySelector('#kbuy-card').value] || cards[0];
    scan.innerHTML = '<div style="font-weight:700;margin-bottom:4px">🔎 Kryptos koll innan betalning</div>'
      + '✓ Betalar med ' + escapeHtml(cardLabel(c)) + '<br>'
      + '✓ Mottagare: ' + escapeHtml(order.merchant) + '<br>'
      + '⚠ Dubbelkolla: rätt vara (<b>' + escapeHtml(order.desc) + '</b>)' + (order.amount ? ' och rätt summa (<b>' + escapeHtml(order.amount) + '</b>)' : '') + '?';
  };
  renderScan();
  ov.querySelector('#kbuy-card').addEventListener('change', renderScan);
  ov.querySelector('#kbuy-cancel').addEventListener('click', () => { ov.remove(); showToast('Köpet avbröts.'); });
  ov.querySelector('#kbuy-go').addEventListener('click', () => {
    const c = cards[+ov.querySelector('#kbuy-card').value] || cards[0];
    const btn = ov.querySelector('#kbuy-go'); btn.disabled = true; btn.textContent = 'Betalar…';
    setTimeout(() => {
      ov.firstElementChild.innerHTML = '<div style="text-align:center;padding:8px 4px">'
        + '<div style="font-size:40px;margin-bottom:8px">✅</div>'
        + '<div style="font-size:18px;font-weight:800;color:var(--color-navy-900);margin-bottom:6px">Beställning lagd!</div>'
        + '<p style="font-size:13.5px;color:rgb(28 43 58 / .62);line-height:1.55;margin-bottom:6px">' + escapeHtml(order.desc) + ' från <b>' + escapeHtml(order.merchant) + '</b>' + (order.amount ? ' – ' + escapeHtml(order.amount) : '') + ' betalt med ' + escapeHtml(cardLabel(c)) + '.</p>'
        + '<p style="font-size:12px;color:rgb(28 43 58 / .45);margin-bottom:16px">Demo – ingen riktig betalning gjordes.</p>'
        + '<button id="kbuy-done" class="btn btn-safe" style="height:44px;padding:0 26px">Klar</button></div>';
      ov.querySelector('#kbuy-done').addEventListener('click', () => ov.remove());
    }, 900);
  });
}


/* ── Wallet-notiser (spara vid köp / fyll i) ── */
function hideBar(id) { $(id).style.display = 'none'; const open = ['infobar', 'pwbar', 'wsavebar', 'wfillbar'].some((b) => $(b) && $(b).style.display === 'flex'); if (!open) window.view.insetTop(0); }
function showBar(id) { ['infobar', 'pwbar', 'wsavebar', 'wfillbar'].forEach((b) => { if (b !== id && $(b)) $(b).style.display = 'none'; }); $(id).style.display = 'flex'; window.view.insetTop(56); }
let wlSaveOffer = null;
window.wallet.onOffer((c) => {
  wlSaveOffer = c;
  $('wsavebar-sub').textContent = `${c.brand || 'Kort'} •••• ${c.last4} · sparas krypterat på din dator`;
  showBar('wsavebar');
});
$('wsavebar-save').addEventListener('click', async () => { if (wlSaveOffer) await window.wallet.save(wlSaveOffer); wlSaveOffer = null; hideBar('wsavebar'); showToast('Kort sparat i Prowl Wallet.'); });
$('wsavebar-no').addEventListener('click', () => { wlSaveOffer = null; hideBar('wsavebar'); });
let wlFillId = null;
window.wallet.onFillOffer((cards) => {
  if (!cards || !cards.length) return;
  const c = cards[0]; wlFillId = c.id;
  $('wfillbar-sub').textContent = `${c.brand || 'Kort'} •••• ${c.last4}${c.holder ? ' · ' + c.holder : ''}`;
  showBar('wfillbar');
});
$('wfillbar-fill').addEventListener('click', () => { if (wlFillId) window.wallet.fillNow(wlFillId); hideBar('wfillbar'); });
$('wfillbar-no').addEventListener('click', () => { wlFillId = null; hideBar('wfillbar'); });

/* ── Toppsajter-läge (mina genvägar / mest besökta) ── */
let topSitesMode = 'favorites';
try { if (localStorage.getItem('skoll-topsites') === 'frequent') topSitesMode = 'frequent'; } catch {}
function applyTopSitesMode() {
  $('seg-fav').classList.toggle('on', topSitesMode === 'favorites');
  $('seg-freq').classList.toggle('on', topSitesMode === 'frequent');
  renderShortcuts();
}
$('seg-fav').addEventListener('click', () => { topSitesMode = 'favorites'; try { localStorage.setItem('skoll-topsites', 'favorites'); } catch {} applyTopSitesMode(); });
$('seg-freq').addEventListener('click', () => { topSitesMode = 'frequent'; try { localStorage.setItem('skoll-topsites', 'frequent'); } catch {} applyTopSitesMode(); });

/* ── Start ── */
tickClock(); setInterval(tickClock, 15000);
greet(); setInterval(greet, 60000); // uppdatera hälsningen om timmen rullar över
applyStoredBg(); applyTopSitesMode(); initAdblock();
sendBounds();
restoreTabs();
setTimeout(sendBounds, 300);

/* ── Hacker-intro (enkel välkomst, första gången) ── */
function runHackerIntro(force) {
  try { if (!force && localStorage.getItem('vaka-hacker-intro-v3')) return; } catch {}
  const ov = $('hxintro'); if (!ov) return;
  ov.style.display = 'flex'; void ov.offsetWidth; ov.classList.remove('gone');
  let done = false;
  function finish() {
    if (done) return; done = true;
    try { localStorage.setItem('vaka-hacker-intro-v3', '1'); } catch {}
    ov.classList.add('gone');
    setTimeout(() => { ov.style.display = 'none'; }, 550);
    const s = $('nt-search'); if (s) try { s.focus(); } catch {}
    setTimeout(runKryptoCoach, 500);   // visa vägvisaren efter intron
  }
  ov.addEventListener('click', finish);
  document.addEventListener('keydown', (e) => { if (ov.style.display !== 'none' && (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ')) finish(); });
}

/* ── Krypto-vägvisare: pekar på Krypto-knappen och förklarar vad den gör ── */
function runKryptoCoach() {
  try { if (localStorage.getItem('prowl-krypto-coach-v2')) return; } catch {}
  const btn = $('krypto-btn'), co = $('kcoach'); if (!btn || !co) return;
  const ring = $('kcoach-ring'), card = $('kcoach-card');
  function place() {
    const r = btn.getBoundingClientRect(); if (!r.width) return;
    ring.style.left = (r.left - 6) + 'px'; ring.style.top = (r.top - 6) + 'px';
    ring.style.width = (r.width + 12) + 'px'; ring.style.height = (r.height + 12) + 'px';
    card.style.top = (r.bottom + 16) + 'px';
    card.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
  }
  place(); co.style.display = 'block';
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  function done() { co.style.display = 'none'; window.removeEventListener('resize', onResize); try { localStorage.setItem('prowl-krypto-coach-v2', '1'); } catch {} }
  $('kcoach-later').onclick = done;
  co.onclick = (e) => { if (e.target === co) done(); };
  $('kcoach-open').onclick = () => { done(); try { btn.click(); } catch {} };
}

window.__hackerIntro = () => runHackerIntro(true);
window.__kryptoCoach = () => { try { localStorage.removeItem('prowl-krypto-coach-v2'); } catch {}; runKryptoCoach(); };
runHackerIntro(false);
// Om intron redan visats (flaggan satt) hoppar den över — visa då vägvisaren ändå.
setTimeout(() => { const ov = $('hxintro'); if (!ov || ov.style.display === 'none') runKryptoCoach(); }, 900);

/* ── "Var ska jag börja?"-quiz — matchar nybörjaren mot rätt program ── */
const QUIZ = [
  { key: 'level', eyebrow: 'Steg 1 av 4', q: 'Hur van är du vid bug bounty?', opts: [
    { v: 'ny', t: 'Helt ny', d: 'Aldrig hittat en bugg än' },
    { v: 'lite', t: 'Testat lite', d: 'Kan grunderna, sökt lite' },
    { v: 'van', t: 'Van hunter', d: 'Har rapporterat förut' },
  ] },
  { key: 'vuln', eyebrow: 'Steg 2 av 4', q: 'Vad vill du helst jaga?', opts: [
    { v: 'idor', t: 'Åtkomstbuggar (IDOR/BOLA)', d: 'Se eller ändra andras data' },
    { v: 'xss', t: 'XSS & injektioner', d: 'Skript, SQLi m.m.' },
    { v: 'ssrf', t: 'SSRF / RCE', d: 'Avancerat och tungt' },
    { v: 'recon', t: 'Recon & subdomäner', d: 'Hitta glömda system' },
    { v: 'ddos', t: 'DoS / DDoS', d: 'Sänka en tjänst' },
    { v: 'vetinte', t: 'Vet inte än', d: 'Överraska mig' },
  ] },
  { key: 'payout', eyebrow: 'Steg 3 av 4', q: 'Vad är målet med pengarna?', opts: [
    { v: 'lara', t: 'Lära mig först', d: 'Pengar kan vänta' },
    { v: 'lagom', t: 'Lagom betalt', d: 'Jämnt flöde av medel-bounties' },
    { v: 'hogt', t: 'Sikta högt', d: 'Stora bounties' },
  ] },
  { key: 'target', eyebrow: 'Steg 4 av 4', q: 'Vilka mål gillar du mest?', opts: [
    { v: 'web', t: 'Webbappar', d: '' },
    { v: 'api', t: 'API:er', d: '' },
    { v: 'mobil', t: 'Mobilappar', d: '' },
    { v: 'web3', t: 'Web3 / krypto', d: '' },
    { v: 'alla', t: 'Spelar ingen roll', d: '' },
  ] },
];
const QN = {
  level: { ny: 'nybörjare', lite: 'har testat lite', van: 'van hunter' },
  vuln: { idor: 'åtkomstbuggar (IDOR/BOLA)', xss: 'XSS & injektioner', ssrf: 'SSRF/RCE', recon: 'recon & subdomäner', ddos: 'DoS/DDoS', vetinte: 'lite av varje' },
  payout: { lara: 'lära dig först', lagom: 'lagom betalt', hogt: 'stora bounties' },
  target: { web: 'webbappar', api: 'API:er', mobil: 'mobilappar', web3: 'web3/krypto', alla: 'alla sorters mål' },
};
let quizAns = {}, quizStep = 0;
function openQuiz() { quizAns = {}; quizStep = 0; $('quiz').classList.add('on'); renderQuiz(); }
function closeQuiz() { $('quiz').classList.remove('on'); }
function renderQuizProg() {
  const p = $('quiz-prog'); p.innerHTML = '';
  for (let i = 0; i < QUIZ.length; i++) { const el = document.createElement('i'); if (quizStep >= QUIZ.length || i <= quizStep) el.className = 'on'; p.appendChild(el); }
}
function renderQuiz() {
  renderQuizProg();
  const body = $('quiz-body');
  if (quizStep >= QUIZ.length) { renderResult(); return; }
  const step = QUIZ[quizStep];
  body.innerHTML = '<div class="quiz-eyebrow">' + step.eyebrow + '</div><div class="quiz-q">' + step.q + '</div><div class="quiz-opts"></div>' + (quizStep > 0 ? '<button class="quiz-back">← Tillbaka</button>' : '');
  const opts = body.querySelector('.quiz-opts');
  step.opts.forEach((o) => {
    const b = document.createElement('button'); b.className = 'quiz-opt';
    b.innerHTML = '<div style="flex:1"><div class="qo-t">' + escapeHtml(o.t) + '</div>' + (o.d ? '<div class="qo-d">' + escapeHtml(o.d) + '</div>' : '') + '</div><span style="opacity:.5">→</span>';
    b.addEventListener('click', () => { quizAns[step.key] = o.v; quizStep++; renderQuiz(); });
    opts.appendChild(b);
  });
  const back = body.querySelector('.quiz-back'); if (back) back.addEventListener('click', () => { quizStep = Math.max(0, quizStep - 1); renderQuiz(); });
}
function recommend(a) {
  let platform, url, initial, why, payout;
  const steps = [];
  if (a.target === 'web3') {
    platform = 'Immunefi'; url = 'https://immunefi.com'; initial = '∎';
    why = 'Web3 och smarta kontrakt betalar överlägset mest — ofta motsvarande hundratusentals kronor per bugg — och Immunefi äger den nischen.';
    payout = 'Mycket högt, men kräver att du kan smarta kontrakt (Solidity).';
  } else if (a.level === 'ny' || a.payout === 'lara') {
    platform = 'TryHackMe'; url = 'https://tryhackme.com'; initial = 'T';
    why = 'Du bygger grunderna riskfritt i labbmiljö innan du går på skarpa program. Snabbaste vägen från noll till din första riktiga bugg.';
    payout = '0 kr i början — men du lär dig fortast här.';
    steps.push('Kör TryHackMe-banorna som tränar ' + QN.vuln[a.vuln] + '.');
    steps.push('När du känner dig redo: ta ett VDP-program på HackerOne (rykte, inte pengar) för att öva skarpt.');
    steps.push('Hittar du något — Krypto → Skriv rapport gör rapporten åt dig.');
  } else if (a.payout === 'hogt' || a.level === 'van') {
    platform = 'HackerOne'; url = 'https://hackerone.com'; initial = 'h';
    why = 'Störst utbud av välbetalda program och flest mål. Här finns de stora bountysen — men också mest konkurrens, så välj program med brett scope.';
    payout = 'Högt möjligt — de bästa buggarna kräver skarpa skills.';
  } else {
    platform = 'Intigriti'; url = 'https://www.intigriti.com'; initial = '◆';
    why = 'Europeiska program med bra betalt och mindre trängsel än de allra största — perfekt när du kan grunderna och vill börja tjäna på riktigt.';
    payout = 'Lagom och jämnt — mindre konkurrens än de största.';
  }
  const tip = {
    idor: 'IDOR/BOLA är vanligt, lätt att förstå och ofta välbetalt — perfekt förstabugg. Leta API-tunga program.',
    xss: 'XSS trivs där användare matar in text (kommentarer, profiler). Sikta på webbappar med mycket inmatning.',
    ssrf: 'SSRF/RCE betalar högt men är svårare och mer konkurrensutsatt — bra att växa in i.',
    recon: 'Recon lönar sig på program med brett/wildcard-scope (*.exempel.com) — hitta glömda subdomäner.',
    ddos: '',
    vetinte: 'Börja med IDOR/åtkomstbuggar — lättast att förstå och bland det vanligaste som betalas ut.',
  }[a.vuln];
  let warning = '';
  if (a.vuln === 'ddos') warning = 'DoS/DDoS är förbjudet i så gott som alla bug bounty-program — det ger ban, inte bounty. Sikta i stället på logik- och rate-limit-buggar (t.ex. att kringgå en spärr) som visar samma svaghet utan att sänka tjänsten.';
  if (!steps.length) {
    steps.push('Öppna ' + platform + ' och leta ett program som tar ' + QN.vuln[a.vuln] + ' och passar ' + QN.target[a.target] + '.');
    steps.push('Läs scope-sidan NOGA — testa bara det som uttryckligen står i scope.');
    steps.push('Hittar du något: Krypto → Skriv rapport gör en färdig rapport åt dig.');
  }
  const prompt = 'Jag är ' + QN.level[a.level] + ', vill helst jaga ' + QN.vuln[a.vuln] + ', siktar på ' + QN.payout[a.payout] + ' och gillar ' + QN.target[a.target] + '. Ge mig en konkret startplan: vilket program eller plattform ska jag börja på, hur hittar jag rätt scope, och exakt vad gör jag först?';
  return { platform, url, initial, why, payout, tip, warning, steps, prompt };
}
function renderResult() {
  const r = recommend(quizAns);
  $('quiz-body').innerHTML =
    '<div class="quiz-eyebrow">Din matchning</div>'
    + '<div class="qr-platform"><div class="qr-badge">' + r.initial + '</div><div><div class="qr-plabel">Börja här</div><div class="qr-pname">' + escapeHtml(r.platform) + '</div></div></div>'
    + '<div class="qr-why">' + escapeHtml(r.why) + '</div>'
    + '<div class="qr-meta"><div class="qr-chip"><b>Betalning:</b> ' + escapeHtml(r.payout) + '</div>'
    + (r.tip ? '<div class="qr-chip"><b>Din grej:</b> ' + escapeHtml(r.tip) + '</div>' : '') + '</div>'
    + (r.warning ? '<div class="qr-warn">⚠️ ' + escapeHtml(r.warning) + '</div>' : '')
    + '<ol class="qr-steps">' + r.steps.map((s, i) => '<li><span class="n">' + (i + 1) + '</span><span>' + escapeHtml(s) + '</span></li>').join('') + '</ol>'
    + '<div class="qr-actions"><button class="qr-btn primary" id="qr-open">Öppna ' + escapeHtml(r.platform) + '</button><button class="qr-btn ghost" id="qr-plan">Få en plan av Krypto</button></div>'
    + '<button class="qr-retake" id="qr-retake">Gör om quizet</button>';
  $('qr-open').addEventListener('click', () => { closeQuiz(); if (active) guardedNavigate(active, r.url); });
  $('qr-plan').addEventListener('click', () => { closeQuiz(); openKrypto(true); setTimeout(() => { try { window.view.kryptoPrefill(r.prompt); } catch {} }, 750); });
  $('qr-retake').addEventListener('click', () => { quizAns = {}; quizStep = 0; renderQuiz(); });
}
if ($('quiz-launch')) $('quiz-launch').addEventListener('click', openQuiz);
if ($('quiz-close')) $('quiz-close').addEventListener('click', closeQuiz);
if ($('quiz')) $('quiz').addEventListener('click', (e) => { if (e.target === $('quiz')) closeQuiz(); });

/* ── Prowl Calendar — planera & spåra program att hacka ── */
const CAL_KEY = 'prowl-calendar';
const CAL_STATUS = [
  { k: 'todo', label: 'Att hacka', color: '#5f7793' },
  { k: 'doing', label: 'Pågår', color: '#e0a44c' },
  { k: 'done', label: 'Hackade', color: '#33a06a' },
];
function calLoad() { try { const a = JSON.parse(localStorage.getItem(CAL_KEY)); return Array.isArray(a) ? a : []; } catch { return []; } }
function calSave() { try { localStorage.setItem(CAL_KEY, JSON.stringify(calItems)); } catch {} }
let calItems = calLoad();
let calView = new Date(); calView.setDate(1);
let calFilterDate = null, calEditId = null;
function calMeta(k) { return CAL_STATUS.find((s) => s.k === k) || CAL_STATUS[0]; }
function calFmt(d) { if (!d) return ''; try { return new Date(d + 'T00:00:00').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }); } catch { return d; } }
function renderCal() { renderCalMonth(); renderCalAgenda(); }
function renderCalMonth() {
  const host = $('cal-month'); if (!host) return;
  const y = calView.getFullYear(), m = calView.getMonth();
  const monthName = calView.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayStr = isoToday();
  const byDate = {}; calItems.forEach((it) => { if (it.date) (byDate[it.date] = byDate[it.date] || []).push(it); });
  let html = '<div class="cal-mhead2"><span class="cal-title">' + monthName + '</span><span class="cal-nav"><button data-nav="-1">‹</button><button data-nav="0">i dag</button><button data-nav="1">›</button></span></div><div class="cal-grid">';
  ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'].forEach((w) => html += '<div class="cal-wd">' + w + '</div>');
  for (let i = 0; i < startDow; i++) html += '<div class="cal-day other">' + (prevDays - startDow + 1 + i) + '</div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const items = byDate[ds] || [];
    const dots = items.slice(0, 3).map((it) => '<span class="dot" style="background:' + calMeta(it.status).color + '"></span>').join('');
    html += '<div class="cal-day' + (ds === todayStr ? ' today' : '') + (ds === calFilterDate ? ' sel' : '') + '" data-day="' + ds + '">' + d + '<span class="dots">' + dots + '</span></div>';
  }
  host.innerHTML = html + '</div>';
  host.querySelectorAll('.cal-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.nav === '0') { calView = new Date(); calView.setDate(1); } else calView.setMonth(calView.getMonth() + parseInt(b.dataset.nav, 10));
    renderCalMonth();
  }));
  host.querySelectorAll('.cal-day[data-day]').forEach((el) => el.addEventListener('click', () => {
    const ds = el.dataset.day;
    if (calItems.some((it) => it.date === ds)) { calFilterDate = (calFilterDate === ds ? null : ds); renderCal(); }
    else openCalModal(null, ds);
  }));
}
function isoToday() { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); }
function calCap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function isoOffset(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function calDayHeader(ds) {
  try {
    const dt = new Date(ds + 'T00:00:00');
    const wd = calCap(dt.toLocaleDateString('sv-SE', { weekday: 'long' }));
    const dm = dt.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });
    let rel = '';
    if (ds === isoToday()) rel = ' · i dag';
    else if (ds === isoOffset(1)) rel = ' · i morgon';
    else if (ds === isoOffset(-1)) rel = ' · i går';
    return wd + ' ' + dm + rel;
  } catch { return ds; }
}
/* Agenda: alla dina sparade dagar och vad du har att göra, grupperat per dag. */
function renderCalAgenda() {
  const host = $('cal-board'); if (!host) return;
  host.className = 'cal-agenda';
  let items = calItems.slice();
  if (calFilterDate) items = items.filter((it) => it.date === calFilterDate);
  const groups = {};
  items.forEach((it) => { const k = it.date || ''; (groups[k] = groups[k] || []).push(it); });
  const keys = Object.keys(groups).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1));
  let html = '';
  if (calFilterDate) html += '<div class="cal-filterbar"><span>' + calDayHeader(calFilterDate) + '</span><span class="fb-right"><button id="cal-addhere">+ lägg till</button><button id="cal-clearfilter">visa alla</button></span></div>';
  if (!keys.length) {
    host.innerHTML = html + '<div class="cal-empty" style="padding:26px 10px">' + (calFilterDate ? 'Inget sparat den här dagen.' : 'Inga program sparade än.<br>Tryck <b>+ Program</b> eller klicka en dag i kalendern.') + '</div>';
    wireCalAgenda(host); return;
  }
  keys.forEach((k) => {
    const label = k === '' ? 'Utan datum' : calDayHeader(k);
    html += '<div class="cal-daygroup"><div class="cal-dayhead">' + label + '</div>' + groups[k].map(calAgendaItem).join('') + '</div>';
  });
  host.innerHTML = html;
  wireCalAgenda(host);
}
function calAgendaItem(it) {
  const meta = calMeta(it.status);
  const plat = it.platform ? ' · ' + escapeHtml(it.platform) : '';
  const notes = it.notes ? '<div class="ai-notes">' + escapeHtml(it.notes) + '</div>' : '';
  return '<div class="cal-aitem" data-id="' + it.id + '"><span class="ci-dot" style="background:' + meta.color + '"></span>'
    + '<div class="ai-main"><div class="ci-name">' + escapeHtml(it.name) + '</div><div class="ci-meta">' + escapeHtml(meta.label) + plat + '</div>' + notes + '</div>'
    + '<button class="ai-status" data-id="' + it.id + '" title="Byt status" style="border-color:' + meta.color + ';color:' + meta.color + '">' + escapeHtml(meta.label) + '</button></div>';
}
function wireCalAgenda(host) {
  const cf = document.getElementById('cal-clearfilter'); if (cf) cf.addEventListener('click', () => { calFilterDate = null; renderCal(); });
  const ah = document.getElementById('cal-addhere'); if (ah) ah.addEventListener('click', () => openCalModal(null, calFilterDate));
  host.querySelectorAll('.cal-aitem').forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => { if (e.target.closest('.ai-status')) return; openCalModal(id); });
  });
  host.querySelectorAll('.ai-status').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); calCycle(b.dataset.id); }));
}
function calCycle(id) {
  const it = calItems.find((x) => x.id === id); if (!it) return;
  const i = CAL_STATUS.findIndex((s) => s.k === it.status);
  it.status = CAL_STATUS[(i + 1) % CAL_STATUS.length].k;
  calSave(); renderCal();
}
function calPlatformOptions(sel) {
  const plats = ['', ...(typeof DEFAULT_SHORTCUTS !== 'undefined' ? DEFAULT_SHORTCUTS.map((s) => s.label) : [])];
  if (sel && plats.indexOf(sel) < 0) plats.push(sel);
  return plats.map((p) => '<option value="' + escapeHtml(p) + '"' + (p === sel ? ' selected' : '') + '>' + (p ? escapeHtml(p) : '— välj —') + '</option>').join('');
}
function openCalModal(id, presetDate) {
  calEditId = id || null;
  const it = id ? calItems.find((x) => x.id === id) : null;
  $('cal-mtitle').textContent = it ? 'Redigera program' : 'Nytt program';
  $('cal-f-name').value = it ? it.name : '';
  $('cal-f-name').style.borderColor = '';
  $('cal-f-plat').innerHTML = calPlatformOptions(it ? it.platform : '');
  $('cal-f-status').innerHTML = CAL_STATUS.map((s) => '<option value="' + s.k + '"' + ((it ? it.status : 'todo') === s.k ? ' selected' : '') + '>' + s.label + '</option>').join('');
  $('cal-f-date').value = it ? (it.date || '') : (presetDate || '');
  $('cal-f-notes').value = it ? (it.notes || '') : '';
  $('cal-f-del').style.display = it ? '' : 'none';
  $('cal-modal').classList.add('on');
  setTimeout(() => { try { $('cal-f-name').focus(); } catch {} }, 0);
}
function closeCalModal() { $('cal-modal').classList.remove('on'); calEditId = null; }
if ($('cal-add')) $('cal-add').addEventListener('click', () => openCalModal(null));
if ($('cal-mclose')) $('cal-mclose').addEventListener('click', closeCalModal);
if ($('cal-modal')) $('cal-modal').addEventListener('click', (e) => { if (e.target === $('cal-modal')) closeCalModal(); });
if ($('cal-f-save')) $('cal-f-save').addEventListener('click', () => {
  const name = $('cal-f-name').value.trim();
  if (!name) { $('cal-f-name').style.borderColor = '#c25340'; return; }
  const data = { name, platform: $('cal-f-plat').value, status: $('cal-f-status').value, date: $('cal-f-date').value || null, notes: $('cal-f-notes').value.trim() };
  if (calEditId) { const it = calItems.find((x) => x.id === calEditId); if (it) Object.assign(it, data); }
  else calItems.unshift({ id: 'k' + Date.now() + Math.floor(Math.random() * 1000), ...data, created: Date.now() });
  calSave(); closeCalModal(); renderCal();
});
if ($('cal-f-del')) $('cal-f-del').addEventListener('click', () => { if (calEditId) { calItems = calItems.filter((x) => x.id !== calEditId); calSave(); } closeCalModal(); renderCal(); });

/* ── Nätverksinspektör (Wireshark-lik) ── */
let netRows = new Map(), netSel = null, netFilter = '', netOpen = false, netRenderPending = false;
function netToggle(open) {
  netOpen = (open === undefined) ? !netOpen : open;
  window.net.toggle(netOpen);
  $('netpanel').classList.toggle('on', netOpen);
  $('net-btn').classList.toggle('active', netOpen);
  if (netOpen) { renderNetRows(); setTimeout(() => { try { $('np-filter').focus(); } catch {} }, 0); }
}
function netStatusClass(s) { if (s === 'FAIL') return 'sfail'; const n = parseInt(s, 10); if (!n) return 's0'; if (n < 300) return 's2'; if (n < 400) return 's3'; if (n < 500) return 's4'; return 's5'; }
function netFmtSize(b) { if (!b) return '—'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' kB'; return (b / 1048576).toFixed(1) + ' MB'; }
function netUrlPath(u) { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } }
function netPass(r) { if (!netFilter) return true; return (r.url + ' ' + r.method + ' ' + r.status + ' ' + r.type).toLowerCase().indexOf(netFilter) >= 0; }
function scheduleNetRender() { if (netRenderPending) return; netRenderPending = true; setTimeout(() => { netRenderPending = false; renderNetRows(); }, 150); }
function renderNetRows() {
  const tb = $('np-rows'); if (!tb) return;
  const arr = [...netRows.values()].filter(netPass);
  $('np-count').textContent = netRows.size + ' requests' + (netFilter ? (' · ' + arr.length + ' visas') : '');
  tb.innerHTML = arr.map((r) => {
    const st = r.status === 0 ? '·' : (r.status === 'FAIL' ? 'FAIL' : r.status);
    return '<tr data-id="' + escapeHtml(String(r.id)) + '"' + (r.id === netSel ? ' class="sel"' : '') + '>'
      + '<td class="np-m">' + escapeHtml(r.method) + '</td>'
      + '<td class="np-st ' + netStatusClass(r.status) + '">' + escapeHtml(String(st)) + '</td>'
      + '<td class="np-host" title="' + escapeHtml(r.host) + '">' + escapeHtml(r.host) + '</td>'
      + '<td class="np-path" title="' + escapeHtml(r.url) + '">' + escapeHtml(netUrlPath(r.url)) + '</td>'
      + '<td class="np-type">' + escapeHtml(r.type || '') + '</td>'
      + '<td class="np-size">' + netFmtSize(r.size) + '</td>'
      + '<td class="np-ms">' + (r.ms ? r.ms + ' ms' : '') + '</td></tr>';
  }).join('');
  tb.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => netSelect(tr.dataset.id)));
}
function netKV(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return '<div class="np-kv"><span class="k">—</span><span class="v"></span></div>';
  return '<div class="np-kv">' + keys.map((k) => '<span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(String(obj[k])) + '</span>').join('') + '</div>';
}
function renderNetDetail(d) {
  const host = $('np-detail'); if (!host) return;
  if (!d) { host.innerHTML = '<div class="np-empty">Klicka på en request för att se headers och body.</div>'; return; }
  if (d.loading) { host.innerHTML = '<div class="np-empty">Hämtar…</div>'; return; }
  let bodyTxt;
  if (d.base64) bodyTxt = '(binär data · base64)\n' + (d.body ? d.body.slice(0, 600) + '…' : '');
  else bodyTxt = (d.body || '').slice(0, 20000) || (d.bodyErr ? '[body ej tillgänglig: ' + d.bodyErr + ']' : '(tom)');
  host.innerHTML =
    '<div class="np-durl">' + escapeHtml(d.method) + ' ' + escapeHtml(d.url) + '</div>'
    + '<div class="np-sec"><h4>Allmänt</h4>' + netKV({ Status: d.failed ? ('FAIL ' + (d.errorText || '')) : d.status, Typ: d.type, MIME: d.mime, 'Remote IP': d.remoteIP || '—', Storlek: netFmtSize(d.size) }) + '</div>'
    + '<div class="np-sec"><h4>Request-headers</h4>' + netKV(d.reqHeaders) + '</div>'
    + (d.postData ? '<div class="np-sec"><h4>Request-body</h4><div class="np-pre">' + escapeHtml(d.postData.slice(0, 10000)) + '</div></div>' : '')
    + '<div class="np-sec"><h4>Response-headers</h4>' + netKV(d.respHeaders) + '</div>'
    + '<div class="np-sec"><h4>Response-body</h4><div class="np-pre">' + escapeHtml(bodyTxt) + '</div></div>';
}
async function netSelect(id) {
  netSel = id;
  $('np-rows').querySelectorAll('tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === id));
  renderNetDetail({ loading: true });
  const d = await window.net.detail(id).catch(() => null);
  if (netSel === id) renderNetDetail(d);
}
if ($('net-btn')) $('net-btn').addEventListener('click', () => netToggle());
if ($('np-close')) $('np-close').addEventListener('click', () => netToggle(false));
if ($('np-clear')) $('np-clear').addEventListener('click', () => { window.net.clear(); netRows.clear(); netSel = null; renderNetRows(); renderNetDetail(null); });
if ($('np-filter')) $('np-filter').addEventListener('input', () => { netFilter = $('np-filter').value.toLowerCase(); renderNetRows(); });
window.net.onRow((r) => { netRows.set(r.id, r); if (netOpen) scheduleNetRender(); });

// ── Session-återställning vid uppstart — körs SIST så all state är deklarerad ──
// Rensa ALDRIG webbsessionen vid start: cookies (Google-inlogg m.m.) ska överleva att man stänger browsern.
if (account && account.token) { try { window.session.setkey(accountKey(account)); } catch {} refreshPro(); }
else { try { window.session.setkey(null); } catch {} }
