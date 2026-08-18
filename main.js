'use strict';
/*
 * Vaka – demo (Electron/Chromium)
 * Arkitektur: varje FÖNSTER är en BrowserWindow som renderar "chrome"
 * (flikar/verktygsrad/startsida/varning) som HTML. Varje fliks webbsida är en
 * WebContentsView som huvudprocessen placerar i fönstrets innehållsyta.
 * Allt fönster-tillstånd (flikar, synlig flik, mått, Krypto-panel) ligger i ett
 * per-fönster "ctx"-objekt i `wins`, nycklat på skalets webContents-id. IPC
 * routas till rätt fönster via `event.sender`.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, clipboard, dialog, shell, safeStorage } = require('electron');
app.setName('Prowl');  // egen datamapp, skild från Vaka
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const { SKOLL, EXTRACT_JS, analyzeContent, verdictFromReport, checkUrl } = require('./scanner');
const auth = require('./auth');

// Auto-uppdatering
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// Riktig filtermotor (EasyList + EasyPrivacy) för nätverks-/kosmetisk blockering.
let ElectronBlocker = null, AdRequest = null;
try { ({ ElectronBlocker } = require('@ghostery/adblocker-electron')); } catch {}
try { ({ Request: AdRequest } = require('@ghostery/adblocker')); }
catch { try { ({ Request: AdRequest } = require('@ghostery/adblocker-electron')); } catch {} }

const KRYPTO_W = 400;
const NET_H = 340;          // nätverksinspektörens dockade höjd
const NET_MAX = 800;        // max antal requests i bufferten per fönster
const wins = new Map();                 // skalets webContents-id -> ctx

function makeCtx(win, incognito) {
  return {
    win, incognito: !!incognito,
    views: new Map(),                   // tabId -> WebContentsView
    incognitoTabs: new Set(),           // tabId:er som kör efemär (inkognito) session
    visibleTab: null,
    bounds: { x: 0, y: 96, width: 1280, height: 700 },
    topInset: 0, leftInset: 0, defaultZoom: 1,
    kryptoView: null, kryptoOpen: false, kryptoFull: false, vakaToken: null,
    net: null, netOpen: false,          // nätverksinspektör (Wireshark-lik, via CDP)
    htmlFull: false, _wasFull: false,   // HTML5-video/element i helskärm
  };
}
function ctxFor(event) { return wins.get(event.sender.id); }
function sendTo(ctx, ...a) { if (ctx && ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(...a); }
function broadcast(...a) { wins.forEach((ctx) => sendTo(ctx, ...a)); if (a[0] === 'download-update') pushDownloadPopups(); }
function pushDownloadPopups() {
  wins.forEach((ctx) => { if (ctx.dlWin && !ctx.dlWin.isDestroyed()) ctx.dlWin.webContents.send('dl-data', downloads); });
}
function positionDlPopup(ctx) {
  if (!ctx || !ctx.dlWin || ctx.dlWin.isDestroyed() || !ctx.win || ctx.win.isDestroyed()) return;
  const cb = ctx.win.getContentBounds(); const w = 380;
  try { ctx.dlWin.setPosition(cb.x + cb.width - w - 10, cb.y + 96); } catch {}
}
function openDlPopup(ctx) {
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  if (ctx.dlWin && !ctx.dlWin.isDestroyed()) { positionDlPopup(ctx); ctx.dlWin.webContents.send('dl-data', downloads); return; }
  const cb = ctx.win.getContentBounds(); const w = 380, h = 470;
  const cw = new BrowserWindow({
    parent: ctx.win, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, show: false, width: w, height: h,
    x: cb.x + cb.width - w - 10, y: cb.y + 96,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ctx.dlWin = cw;
  const repos = () => positionDlPopup(ctx);
  ctx.win.on('move', repos); ctx.win.on('resize', repos);
  cw.loadFile(path.join(__dirname, 'ui', 'downloads.html'));
  cw.webContents.on('did-finish-load', () => { cw.webContents.send('dl-data', downloads); cw.showInactive(); });
  cw.on('closed', () => {
    try { ctx.win.removeListener('move', repos); ctx.win.removeListener('resize', repos); } catch {}
    if (ctx.dlWin === cw) ctx.dlWin = null;
  });
}

/* ────────── Adblocker (kurerad värdlista – demo) ────────── */
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'connect.facebook.net', 'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'adnxs.com',
  'rubiconproject.com', 'pubmatic.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'adsafeprotected.com', 'moatads.com', 'bidswitch.net', 'casalemedia.com',
  'openx.net', 'yieldmo.com', 'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'fullstory.com',
  'clarity.ms', 'bat.bing.com', 'branch.io', 'appsflyer.com', 'adcolony.com', 'inmobi.com',
];
// Spårare (analys/spårning) skiljs från rena annonser så startsidan kan visa dem separat.
const TRACKER_HOSTS = new Set([
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'connect.facebook.net',
  'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com',
  'segment.com', 'segment.io', 'fullstory.com', 'clarity.ms', 'bat.bing.com', 'branch.io', 'appsflyer.com',
]);
let adblockOn = true;
let adblockCount = 0;
function hostCategory(url) {
  try {
    const h = new URL(url).hostname;
    const hit = AD_HOSTS.find((a) => h === a || h.endsWith('.' + a));
    if (!hit) return null;
    return TRACKER_HOSTS.has(hit) ? 'tracker' : 'ad';
  } catch { return null; }
}
// ── Filtermotor: laddas en gång, aktiveras per session ──
let engine = null;
let engineReady = null;
const blockedSessions = new Set();

function loadEngine() {
  if (engineReady) return engineReady;
  engineReady = (async () => {
    if (!ElectronBlocker) return;
    try {
      // Medföljande filterlistor (uBlock + AdGuard-settet) — parsas lokalt, ingen nätverkshämtning.
      const dir = path.join(__dirname, 'filters');
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') && f !== 'resources.txt'); } catch {}
      let text = files
        .map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })
        .join('\n');
      if (process.env.VAKA_FILTER_DROP) {
        const re = new RegExp(process.env.VAKA_FILTER_DROP);
        text = text.split('\n').filter((l) => !re.test(l)).join('\n');
      }
      if (!text.trim()) {
        engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(globalThis.fetch || require('cross-fetch'));
      } else {
        // loadCosmeticFilters => element-göm + scriptlet-injektion (pop-under-/redirect-motgifter à la uBlock/Brave)
        engine = ElectronBlocker.parse(text, { loadCosmeticFilters: process.env.VAKA_NO_COSMETICS ? false : true, loadNetworkFilters: true });
        try {
          const { Resources } = require('@ghostery/adblocker-electron');
          const resTxt = fs.readFileSync(path.join(dir, 'resources.txt'), 'utf8');
          engine.resources = Resources.parse(resTxt, { checksum: 'vaka' });   // 149 scriptlets: window.open-defuser m.fl.
        } catch {}
      }
      engine.on('request-blocked', (request) => {
        adblockCount++;
        broadcast('adblock:count', adblockCount);
        broadcast('adblock:hit', hostCategory(request.url) === 'tracker' ? 'tracker' : 'ad');
      });
      // Kosmetik/scriptlet-injektion i Electron 33 (registerPreloadScript saknas → vi kör setPreloads i enableEngineOn)
      try {
        ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
        ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
        ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => engine.onInjectCosmeticFilters(e, url, msg));
        ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => engine.onIsMutationObserverEnabled(e));
      } catch {}
      if (adblockOn) for (const s of blockedSessions) { try { enableEngineOn(s); } catch {} }
    } catch { /* faller tillbaka på hostCategory-vakten om parsning misslyckas */ }
  })();
  return engineReady;
}

function ghosteryPreloadPath() {
  try { return require.resolve('@ghostery/adblocker-electron-preload'); } catch { return null; }
}
// Aktivera motorn på en session: nätverksblockering + kosmetik/scriptlet-preload (Electron 33-kompatibelt).
// Allowlist: blockera ALDRIG anrop till inloggnings-/konto-domäner (annars kan 2FA-verifiering m.m. hänga)
const ADBLOCK_ALLOW = /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.io|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|okta\.com|auth0\.com|duosecurity\.com)$/i;
function adblockAllowHost(url) { try { return ADBLOCK_ALLOW.test(new URL(url).hostname); } catch { return false; } }
function enableEngineOn(sess) {
  if (!engine) return;
  try {
    sess.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => engine.onHeadersReceived(d, cb));
    sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      if (adblockAllowHost(d.url)) { cb({}); return; }   // släpp igenom GitHub/inloggnings-anrop orört
      engine.onBeforeRequest(d, cb);
    });
  } catch {}
  try {
    const p = ghosteryPreloadPath();
    if (p) { const cur = sess.getPreloads() || []; if (!cur.includes(p)) sess.setPreloads([...cur, p]); }
  } catch {}
}
function disableEngineOn(sess) {
  try { sess.webRequest.onHeadersReceived(null); sess.webRequest.onBeforeRequest(null); } catch {}
  try { const p = ghosteryPreloadPath(); if (p) sess.setPreloads((sess.getPreloads() || []).filter((x) => x !== p)); } catch {}
}

function installAdblockOn(sess) {
  blockedSessions.add(sess);
  if (engine && adblockOn) enableEngineOn(sess);
  else loadEngine();
}

// Ska den här navigeringen/popupen dödas direkt? (annons/tracker/skräp-schema)
function isBlockedTarget(url, sourceUrl) {
  if (!/^https?:/i.test(url)) return true;            // javascript:, data:, blob:, about:blank-kedjor
  try {
    if (engine && AdRequest) {
      const r = AdRequest.fromRawDetails({ type: 'document', url, sourceUrl: sourceUrl || url });
      if (engine.match(r).match) return true;
    }
  } catch {}
  return !!hostCategory(url);
}
// När vi ersätter user-agent-strängen slutar Chromium skicka Sec-CH-UA-client hints.
// En "Chrome" utan client hints ser bot-aktig ut för Google → vi återinför dem så de
// matchar vår UA (Chrome-version ur UA, plattform ur process.platform).
function chMajor() { return (app.userAgentFallback.match(/Chrome\/(\d+)/) || [])[1] || '130'; }
function chPlatform() {
  return process.platform === 'win32' ? 'Windows'
       : process.platform === 'darwin' ? 'macOS' : 'Linux';
}
function applyClientHints(sess) {
  try {
    const v = chMajor();
    const brand = `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="99"`;
    const plat = `"${chPlatform()}"`;
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      h['sec-ch-ua'] = brand;
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = plat;
      cb({ requestHeaders: h });
    });
  } catch {}
}

let incognitoAdblockDone = false;
function ensureIncognitoAdblock() {
  if (incognitoAdblockDone) return;
  incognitoAdblockDone = true;
  try { const s = session.fromPartition('skoll-incognito'); applyClientHints(s); installAdblockOn(s); trackDownloads(s); } catch {}
}

/* ── Tor (oanvänd – behållen som referens) ── */
const TOR_DIR = path.join(__dirname, 'tor');
const TOR_SOCKS = 9250;
let torProc = null;
let torState = 'off';
function setTorState(s) { torState = s; broadcast('tor-state', s); }
ipcMain.handle('tor:state', () => torState);

/* Metadata-bedömning + checkUrl finns i scanner.js (delas med testriggen). */
async function dailyImage() {
  try {
    const res = await fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=sv-SE',
      { signal: AbortSignal.timeout(6000) });
    const j = await res.json(); const img = j?.images?.[0];
    if (img?.url) return { url: 'https://www.bing.com' + img.url, credit: img.copyright || '' };
  } catch {}
  return { url: null, credit: '' };
}

/* ────────── Vy-hantering (per fönster) ────────── */
function canGo(wc, dir) {
  try { return dir < 0 ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward(); }
  catch { return dir < 0 ? wc.canGoBack() : wc.canGoForward(); }
}
function applyBounds(ctx) {
  if (!ctx) return;
  const b = ctx.bounds;
  const full = ctx.kryptoOpen && ctx.kryptoFull;              // Krypto i helskärm (täcker webbytan)
  const kw = (ctx.kryptoOpen && !full) ? KRYPTO_W : 0;        // sidopanelens bredd (0 i helskärm – panelen ligger ovanpå)
  const nh = ctx.netOpen ? NET_H : 0;                         // nätverksinspektörens höjd (dockad längst ner)
  const R = Math.round;
  if (ctx.htmlFull && ctx.visibleTab && ctx.views.has(ctx.visibleTab)) {   // video/element i helskärm → täck HELA fönstret
    const cb = ctx.win.getContentBounds();
    ctx.views.get(ctx.visibleTab).setBounds({ x: 0, y: 0, width: R(cb.width), height: R(cb.height) });
    if (ctx.kryptoView) ctx.kryptoView.setVisible(false);
    return;
  }
  if (ctx.visibleTab && ctx.views.has(ctx.visibleTab)) {
    ctx.views.get(ctx.visibleTab).setBounds({ x: R(b.x + ctx.leftInset), y: R(b.y + ctx.topInset), width: R(b.width - kw - ctx.leftInset), height: R(b.height - ctx.topInset - nh) });
  }
  if (ctx.kryptoView) {
    ctx.kryptoView.setVisible(ctx.kryptoOpen);
    if (ctx.kryptoOpen) {
      if (full) ctx.kryptoView.setBounds({ x: R(b.x + ctx.leftInset), y: R(b.y), width: R(b.width - ctx.leftInset), height: R(b.height) });
      else ctx.kryptoView.setBounds({ x: R(b.x + b.width - KRYPTO_W), y: R(b.y), width: KRYPTO_W, height: R(b.height) });
    }
  }
}
function raiseKrypto(ctx) { if (ctx && ctx.kryptoView) ctx.win.contentView.addChildView(ctx.kryptoView); }
function showOnly(ctx, tabId) {
  ctx.visibleTab = tabId;
  ctx.views.forEach((v, id) => v.setVisible(id === tabId));
  applyBounds(ctx); raiseKrypto(ctx);
}
/* ── Högerklicksmeny (Chromium-lik) ── */
async function savePage(ctx, wc) {
  const r = await dialog.showSaveDialog(ctx.win, { defaultPath: 'sida.html', filters: [{ name: 'Webbsida', extensions: ['html'] }] });
  if (!r.canceled && r.filePath) { try { await wc.savePage(r.filePath, 'HTMLComplete'); } catch {} }
}
async function showQR(ctx, url) {
  try { const dataUrl = await QRCode.toDataURL(url, { width: 260, margin: 1, color: { dark: '#0e2a47', light: '#ffffff' } }); sendTo(ctx, 'show-qr', url, dataUrl); } catch {}
}
/* Skriv ut: finns en skrivare → systemets utskriftsdialog. Annars faller vi
 * tillbaka på PDF (som Chromes "Spara som PDF") så knappen ALLTID gör något. */
async function makePdf(ctx, wc) {
  try {
    const data = await wc.printToPDF({ printBackground: true });
    let name = 'utskrift';
    try { name = (new URL(wc.getURL()).hostname.replace(/^www\./, '') || 'utskrift'); } catch {}
    const file = path.join(app.getPath('downloads'), name + '-' + Date.now() + '.pdf');
    fs.writeFileSync(file, data);
    await shell.openPath(file);
    sendTo(ctx, 'toast', 'Ingen skrivare hittades – sparade sidan som PDF och öppnade den.');
  } catch { sendTo(ctx, 'toast', 'Kunde inte skriva ut sidan.'); }
}
async function printPage(ctx, wc) {
  let printers = [];
  try { printers = await wc.getPrintersAsync(); } catch {}
  if (printers && printers.length) { try { wc.print({}); return; } catch {} }
  await makePdf(ctx, wc);
}
function buildContextMenu(ctx, wc, params) {
  const nav = wc.navigationHistory;
  const url = wc.getURL();
  const t = [];
  t.push({ label: 'Tillbaka', enabled: nav.canGoBack(), click: () => { try { nav.goBack(); } catch { wc.goBack(); } } });
  t.push({ label: 'Framåt', enabled: nav.canGoForward(), click: () => { try { nav.goForward(); } catch { wc.goForward(); } } });
  t.push({ label: 'Läs in igen', click: () => wc.reload() });
  t.push({ type: 'separator' });
  if (params.linkURL) {
    t.push({ label: 'Öppna länk i ny flik', click: () => sendTo(ctx, 'open-new-tab', params.linkURL) });
    t.push({ label: 'Kopiera länkadress', click: () => clipboard.writeText(params.linkURL) });
    t.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    t.push({ label: 'Spara bild som…', click: () => wc.downloadURL(params.srcURL) });
    t.push({ label: 'Kopiera bildadress', click: () => clipboard.writeText(params.srcURL) });
    t.push({ type: 'separator' });
  }
  if (params.isEditable) {
    t.push({ label: 'Klipp ut', role: 'cut', enabled: params.editFlags.canCut });
    t.push({ label: 'Kopiera', role: 'copy', enabled: params.editFlags.canCopy });
    t.push({ label: 'Klistra in', role: 'paste', enabled: params.editFlags.canPaste });
    t.push({ type: 'separator' });
  } else if (params.selectionText && params.selectionText.trim()) {
    const sel = params.selectionText.trim();
    const short = sel.length > 24 ? sel.slice(0, 24) + '…' : sel;
    t.push({ label: 'Kopiera', role: 'copy' });
    t.push({ label: `Sök på Google efter "${short}"`, click: () => sendTo(ctx, 'open-new-tab', 'https://www.google.com/search?q=' + encodeURIComponent(sel)) });
    t.push({ type: 'separator' });
  }
  t.push({ label: 'Spara som…', click: () => savePage(ctx, wc) });
  t.push({ label: 'Skriv ut…', click: () => printPage(ctx, wc) });
  t.push({ label: 'Skapa QR-kod för sidan', click: () => showQR(ctx, url) });
  t.push({ label: 'Översätt till svenska', click: () => sendTo(ctx, 'open-new-tab', 'https://translate.google.com/translate?sl=auto&tl=sv&u=' + encodeURIComponent(url)) });
  t.push({ type: 'separator' });
  t.push({ label: 'Visa sidans källa', click: () => sendTo(ctx, 'open-tab-raw', 'view-source:' + url) });
  t.push({ label: 'Inspektera', click: () => { try { wc.inspectElement(params.x, params.y); } catch {} } });
  Menu.buildFromTemplate(t).popup({ window: ctx.win });
}

/* Högerklicksmeny på skalet (startsida, verktygsrad, adressfält) – native-vyerna
 * har sin egen (buildContextMenu); skalets webContents hade ingen alls. */
function buildShellMenu(ctx, wc, params) {
  const t = [];
  if (params.isEditable) {
    t.push({ label: 'Klipp ut', role: 'cut', enabled: params.editFlags.canCut });
    t.push({ label: 'Kopiera', role: 'copy', enabled: params.editFlags.canCopy });
    t.push({ label: 'Klistra in', role: 'paste', enabled: params.editFlags.canPaste });
    t.push({ type: 'separator' });
    t.push({ label: 'Markera allt', role: 'selectAll' });
  } else if (params.selectionText && params.selectionText.trim()) {
    t.push({ label: 'Kopiera', role: 'copy' });
  } else {
    t.push({ label: 'Ny flik', click: () => sendTo(ctx, 'open-new-tab') });
    t.push({ label: 'Nytt fönster', click: () => createWindow(false) });
    t.push({ label: 'Ny inkognitoflik', click: () => sendTo(ctx, 'new-incognito') });
    const clip = (clipboard.readText() || '').trim();
    if (clip) {
      const short = clip.length > 32 ? clip.slice(0, 32) + '…' : clip;
      t.push({ type: 'separator' });
      t.push({ label: `Klistra in och gå till "${short}"`, click: () => sendTo(ctx, 'open-new-tab', clip) });
    }
    t.push({ type: 'separator' });
    t.push({ label: 'Historik', click: () => sendTo(ctx, 'open-history') });
    t.push({ label: 'Inställningar', click: () => sendTo(ctx, 'open-settings') });
  }
  if (t.length) Menu.buildFromTemplate(t).popup({ window: ctx.win });
}

function ensureView(ctx, tabId) {
  if (ctx.views.has(tabId)) return ctx.views.get(tabId);
  const incognito = ctx.incognito || ctx.incognitoTabs.has(tabId);
  if (incognito) ensureIncognitoAdblock();
  const wp = { preload: path.join(__dirname, 'content-preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false };
  if (incognito) wp.partition = 'skoll-incognito';
  const view = new WebContentsView({ webPreferences: wp });
  view.setVisible(false);
  ctx.win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.__ctx = ctx;                       // för routing av innehålls-IPC (t.ex. pw:capture)
  // Brave-stil popup-hantering: filtermotorn (EasyLists popup-/annons-regler) avgör.
  // Nedladdningar rörs ALDRIG av det här — en download går via session.will-download,
  // aldrig genom window.open/navigering. Därför är även window.open-nedladdningar säkra.
  wc.setWindowOpenHandler((details) => {
    const url = details.url || '';
    if (adblockOn && (!/^https?:/i.test(url) || isBlockedTarget(url, wc.getURL()))) {
      return { action: 'deny' };                                  // annons/pop-under/skräp-schema → död
    }
    if (url) sendTo(ctx, 'open-new-tab', url);                     // äkta ny flik (Ctrl/mitten-klick, target=_blank, window.open)
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    // Ad/tracker-mål → blockera helt.
    if (adblockOn && isBlockedTarget(url, wc.getURL())) { e.preventDefault(); return; }
    // Samma origin (formulär-POST, 2FA-kod, fler-stegs-inloggning) → låt navigeringen ske NATIVT så POST-datan
    // bevaras. preventDefault + omladdning via loadURL blir en GET → koden/formuläret tappas (GitHub-2FA-buggen).
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(wc.getURL()).origin; } catch {}
    if (sameOrigin) return;
    // Korsdomän-länkklick → scanna först via guardedNavigate (som förut).
    e.preventDefault();
    sendTo(ctx, 'link-navigate', tabId, url);
  });
  wc.on('will-redirect', (e, url) => {
    if (adblockOn && isBlockedTarget(url, wc.getURL())) { try { e.preventDefault(); } catch {} }
  });
  wc.on('did-navigate', (_e, url) => sendTo(ctx, 'did-navigate', tabId, url, canGo(wc, -1), canGo(wc, 1)));
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) sendTo(ctx, 'did-navigate', tabId, url, canGo(wc, -1), canGo(wc, 1)); });
  wc.on('page-title-updated', (_e, title) => sendTo(ctx, 'title', tabId, title));
  wc.on('page-favicon-updated', (_e, favs) => sendTo(ctx, 'favicon', tabId, (favs || [])[0] || null));
  wc.on('did-start-loading', () => sendTo(ctx, 'loading', tabId, true));
  wc.on('did-stop-loading', () => sendTo(ctx, 'loading', tabId, false));
  wc.on('dom-ready', () => { try { if (ctx.defaultZoom !== 1) wc.setZoomFactor(ctx.defaultZoom); } catch {} });
  wc.on('context-menu', (_e, params) => { try { buildContextMenu(ctx, wc, params); } catch {} });
  // Video/element går i helskärm (sidans egen fullscreen-knapp) → täck HELA skärmen
  wc.on('enter-html-full-screen', () => { ctx._wasFull = ctx.win.isFullScreen(); ctx.htmlFull = true; try { ctx.win.setFullScreen(true); } catch {} applyBounds(ctx); });
  wc.on('leave-html-full-screen', () => { ctx.htmlFull = false; try { if (!ctx._wasFull) ctx.win.setFullScreen(false); } catch {} applyBounds(ctx); });
  wc.on('did-finish-load', async () => {
    try {
      const url = wc.getURL();
      if (!/^https?:/i.test(url)) return;
      const feats = await wc.executeJavaScript(EXTRACT_JS).catch(() => null);
      const res = analyzeContent(feats);
      if (res) sendTo(ctx, 'content-warning', tabId, url, res);
    } catch {}
  });
  ctx.views.set(tabId, view);
  if (ctx.netOpen) attachNet(ctx, wc);   // fånga trafik direkt om inspektören är öppen
  raiseKrypto(ctx);
  return view;
}

/* ────────── IPC – globala tjänster (fönsteroberoende) ────────── */
ipcMain.handle('skoll:check-url', (_e, url) => checkUrl(url));
ipcMain.handle('skoll:daily-image', () => dailyImage());
ipcMain.handle('skoll:adblock-toggle', async (_e, on) => {
  adblockOn = !!on;
  await loadEngine();
  for (const s of blockedSessions) {
    try { adblockOn ? enableEngineOn(s) : disableEngineOn(s); } catch {}
  }
  return adblockOn;
});
ipcMain.handle('skoll:adblock-state', () => ({ on: adblockOn, count: adblockCount }));
/* Vaka mejl-inloggning: proxar till backend (send-code/verify-code/session/logout). */
async function vakaAuthCall(pathname, body) {
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/vaka/auth/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch (e) { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern. Kontrollera din uppkoppling.' }; }
}
ipcMain.handle('auth:login', (_e, d) => vakaAuthCall('login', { email: d && d.email, password: d && d.password }));
ipcMain.handle('auth:signup', (_e, d) => vakaAuthCall('signup', { email: d && d.email, password: d && d.password, name: d && d.name }));
ipcMain.handle('auth:verify-code', (_e, d) => vakaAuthCall('verify-code', { email: d && d.email, code: d && d.code }));
ipcMain.handle('auth:reset-request', (_e, d) => vakaAuthCall('reset-request', { email: d && d.email }));
ipcMain.handle('auth:reset-confirm', (_e, d) => vakaAuthCall('reset-confirm', { email: d && d.email, code: d && d.code, password: d && d.password }));
ipcMain.handle('auth:session', (_e, d) => vakaAuthCall('session', { token: d && d.token }));
ipcMain.handle('auth:logout', (_e, d) => vakaAuthCall('logout', { token: d && d.token }));
ipcMain.handle('auth:delete', (_e, d) => vakaAuthCall('delete', { token: d && d.token }));
/* Prowl Socialt: profil (användarnamn+bild), vänner, chatt. */
async function socialCall(pathname, body) {
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/social/' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) j.error = 'http_' + r.status;
    return j;
  } catch (e) { return { ok: false, error: 'unreachable', message: 'Kunde inte nå servern.' }; }
}
ipcMain.handle('social:me', (_e, d) => socialCall('me', { token: d && d.token }));
ipcMain.handle('social:profile', (_e, d) => socialCall('profile', { token: d && d.token, username: d && d.username, avatar: d && d.avatar }));
ipcMain.handle('social:friend-request', (_e, d) => socialCall('friend/request', { token: d && d.token, username: d && d.username }));
ipcMain.handle('social:friend-respond', (_e, d) => socialCall('friend/respond', { token: d && d.token, username: d && d.username, accept: d && d.accept }));
ipcMain.handle('social:friends', (_e, d) => socialCall('friends', { token: d && d.token }));
ipcMain.handle('social:messages', (_e, d) => socialCall('messages', { token: d && d.token, chat: d && d.chat, since: d && d.since }));
ipcMain.handle('social:send', (_e, d) => socialCall('send', { token: d && d.token, chat: d && d.chat, body: d && d.body }));
ipcMain.handle('social:edit', (_e, d) => socialCall('edit', { token: d && d.token, id: d && d.id, body: d && d.body }));
ipcMain.handle('social:chatavatar', (_e, d) => socialCall('chatavatar', { token: d && d.token, chat: d && d.chat, avatar: d && d.avatar }));

/* ── Lösenord — PER KONTO, låsta när man är utloggad ── */
const PW_FILE = path.join(app.getPath('userData'), 'skoll-passwords.json');   // legacy (migreras in i kontot vid första inlogg)
const PW_DIR = path.join(app.getPath('userData'), 'passwords');
let currentAcctKey = null;                                                    // vilket Prowl-konto som är inloggat (kaka-valv + lösenord)
function keyHash(k) { return crypto.createHash('sha1').update(String(k || '')).digest('hex'); }
function pwFileFor(key) { return path.join(PW_DIR, 'pw-' + keyHash(key) + '.json'); }
function loadPw() {
  if (!currentAcctKey) return [];                                             // utloggad → lösenord låsta
  try { return JSON.parse(fs.readFileSync(pwFileFor(currentAcctKey), 'utf8')); } catch { return []; }
}
function savePwList(l) {
  if (!currentAcctKey) return;
  try { fs.mkdirSync(PW_DIR, { recursive: true }); fs.writeFileSync(pwFileFor(currentAcctKey), JSON.stringify(l), { mode: 0o600 }); } catch {}
}
ipcMain.handle('pw:list', () => loadPw());
ipcMain.handle('pw:get', (_e, origin) => loadPw().find((p) => p.origin === origin) || null);
ipcMain.handle('pw:save', (_e, c) => {
  const l = loadPw();
  const i = l.findIndex((p) => p.origin === c.origin && p.username === c.username);
  const rec = { id: c.id || ('p' + Date.now() + Math.floor(Math.random() * 1000)), origin: c.origin, username: c.username || '', password: c.password || '', autofill: c.autofill !== false };
  if (i >= 0) l[i] = { ...l[i], ...rec }; else l.unshift(rec);
  savePwList(l); return { ok: true };
});
ipcMain.handle('pw:set-autofill', (_e, o) => {
  o = o || {}; const l = loadPw();
  const p = l.find((x) => x.origin === o.origin && (o.username == null || x.username === o.username));
  if (p) { p.autofill = !!o.on; savePwList(l); }
  return { ok: true };
});
ipcMain.handle('pw:delete', (_e, id) => { savePwList(loadPw().filter((p) => p.id !== id)); return { ok: true }; });
/* ── Kaka-valv per konto: logga ut → spara+rensa webbsession; logga in → återställ (samma tjänster tillbaka) ── */
const COOKIE_DIR = path.join(app.getPath('userData'), 'session-cookies');
function cookieFileFor(key) { return path.join(COOKIE_DIR, 'ck-' + keyHash(key) + '.json'); }
async function saveAccountCookies(key) {
  if (!key) return;
  try {
    const cookies = await session.defaultSession.cookies.get({});
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(cookieFileFor(key), JSON.stringify(cookies), { mode: 0o600 });
  } catch {}
}
async function restoreAccountCookies(key) {
  if (!key) return;
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(cookieFileFor(key), 'utf8')); } catch { return; }
  for (const c of arr) {
    try {
      const host = (c.domain || '').replace(/^\./, '');
      if (!host || !c.name) continue;
      const set = { url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'), name: c.name, value: c.value, path: c.path || '/' };
      if (c.domain) set.domain = c.domain;
      if (c.secure) set.secure = true;
      if (c.httpOnly) set.httpOnly = true;
      if (typeof c.expirationDate === 'number') set.expirationDate = c.expirationDate;
      if (c.sameSite) set.sameSite = c.sameSite;
      await session.defaultSession.cookies.set(set);
    } catch {}
  }
}
async function clearWebSession() { try { await session.defaultSession.clearStorageData(); } catch {} }
function reloadVisible(ctx) { try { if (ctx && ctx.visibleTab && ctx.views.has(ctx.visibleTab)) ctx.views.get(ctx.visibleTab).webContents.reload(); } catch {} }
function migratePwLegacy(key) {   // första inloggningen: flytta ev. gamla (icke-konto) lösenord in i kontot
  try { if (!fs.existsSync(pwFileFor(key)) && fs.existsSync(PW_FILE)) { fs.mkdirSync(PW_DIR, { recursive: true }); fs.copyFileSync(PW_FILE, pwFileFor(key)); } } catch {}
}
// Sätt inloggat konto UTAN att röra webbsessionen (vid uppstart — sessionen ligger redan kvar på disk)
ipcMain.handle('session:setkey', (_e, d) => { currentAcctKey = (d && d.key) || null; if (currentAcctKey) migratePwLegacy(currentAcctKey); return { ok: true }; });
// Inloggning: sätt kontonyckel (lösenordsvalvet). Rör ALDRIG webbsessionen — cookies (Google m.fl.) ska överleva.
ipcMain.handle('session:login', async (_e, d) => {
  const key = d && d.key; currentAcctKey = key || null;
  if (key) migratePwLegacy(key);
  return { ok: true };
});
// Utloggning ur Prowl-kontot: lås lösenordsvalvet, men behåll webbsessionen (man förblir inloggad i Google m.fl.).
ipcMain.handle('session:logout', async (_e, d) => {
  currentAcctKey = null;
  return { ok: true };
});
ipcMain.on('pw:capture', (e, c) => {
  if (!currentAcctKey) return;             // utloggad → spara/erbjud inte lösenord
  if (!c || !c.password) return;
  const l = loadPw();
  if (l.find((p) => p.origin === c.origin && p.username === c.username && p.password === c.password)) return;
  sendTo(e.sender.__ctx, 'pw-offer', c);   // erbjud i fönstret där sidan ligger
});

/* ── Vaka Wallet (kort-plånbok, E2E-krypterad på enheten) ──
 * Zero-knowledge: korten lämnar ALDRIG datorn. På disk ligger bara chiffertext
 * (AES-256-GCM). Nyckeln är slumpad per enhet och slås själv in i OS:ets
 * nyckelring via Electrons safeStorage (Keychain/libsecret/DPAPI) – finns ingen
 * nyckelring hamnar den i en chmod 600-fil. Vi (företaget) kan alltså inte läsa
 * korten, och inget kort-nummer syns i klartext på disk. */
const WALLET_FILE = path.join(app.getPath('userData'), 'vaka-wallet.dat');
const WALLET_KEY_FILE = path.join(app.getPath('userData'), 'vaka-wallet.key');
let _walletKey = null;
function walletKey() {
  if (_walletKey) return _walletKey;
  let raw = null;
  try {
    if (fs.existsSync(WALLET_KEY_FILE)) {
      const blob = fs.readFileSync(WALLET_KEY_FILE);
      let b64;
      try { b64 = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.decryptString(blob) : blob.toString('utf8'); }
      catch { b64 = blob.toString('utf8'); }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 32) raw = buf;
    }
  } catch {}
  if (!raw) {
    raw = crypto.randomBytes(32);
    const b64 = raw.toString('base64');
    try {
      const out = (safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage.encryptString(b64) : Buffer.from(b64, 'utf8');
      fs.writeFileSync(WALLET_KEY_FILE, out, { mode: 0o600 });
    } catch {}
  }
  _walletKey = raw;
  return raw;
}
function walletEncrypt(str) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', walletKey(), iv);
  const enc = Buffer.concat([c.update(str, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function walletDecrypt(buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', walletKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function loadCards() { try { return JSON.parse(walletDecrypt(fs.readFileSync(WALLET_FILE))); } catch { return []; } }
function saveCards(l) { try { fs.writeFileSync(WALLET_FILE, walletEncrypt(JSON.stringify(l)), { mode: 0o600 }); } catch {} }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function cardBrand(num) {
  const n = digits(num);
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^6(011|5)/.test(n)) return 'Discover';
  return 'Kort';
}
/* Publik vy (för listan) – ALDRIG fullt nummer/CVC. */
function cardPublic(c) { return { id: c.id, brand: c.brand || cardBrand(c.number), holder: c.holder || '', last4: digits(c.number).slice(-4), exp: c.exp || '', nick: c.nick || '' }; }
function normCard(c, id) {
  const num = digits(c.number);
  return { id: id || c.id || ('c' + Date.now() + Math.floor(Math.random() * 1000)), holder: (c.holder || '').trim(), number: num, exp: (c.exp || '').trim(), cvc: digits(c.cvc), nick: (c.nick || '').trim(), brand: cardBrand(num) };
}
ipcMain.handle('wallet:list', () => loadCards().map(cardPublic));
ipcMain.handle('wallet:get', (_e, id) => loadCards().find((c) => c.id === id) || null); // fullt kort – för redigering/autofyll
ipcMain.handle('wallet:save', (_e, c) => {
  const l = loadCards();
  if (c.id) { const i = l.findIndex((x) => x.id === c.id); if (i >= 0) { l[i] = normCard(c, c.id); saveCards(l); return { ok: true, id: c.id }; } }
  const rec = normCard(c);
  const dup = l.findIndex((x) => digits(x.number).slice(-4) === digits(rec.number).slice(-4) && x.exp === rec.exp);
  if (dup >= 0) l[dup] = normCard(c, l[dup].id); else l.unshift(rec);
  saveCards(l); return { ok: true, id: rec.id };
});
ipcMain.handle('wallet:delete', (_e, id) => { saveCards(loadCards().filter((c) => c.id !== id)); return { ok: true }; });
/* Sida upptäckte ett kassaformulär → erbjud autofyll (om vi har kort). */
ipcMain.on('wallet:field-detected', (e) => {
  try { if (!loadCards().length) return; const ctx = e.sender.__ctx; if (!ctx) return; ctx._walletFillWc = e.sender; sendTo(ctx, 'wallet-fill-offer', loadCards().map(cardPublic)); } catch {}
});
/* Skalet bad om att fylla i ett visst kort → skicka fullt kort till just den sidan. */
ipcMain.on('wallet:fill-now', (e, id) => {
  try { const ctx = ctxFor(e); if (!ctx || !ctx._walletFillWc || ctx._walletFillWc.isDestroyed()) return; const card = loadCards().find((c) => c.id === id) || loadCards()[0]; if (card) ctx._walletFillWc.send('wallet-do-fill', card); } catch {}
});
/* Sida fångade ett nytt kort i en kassa → erbjud att spara. */
ipcMain.on('wallet:capture', (e, c) => {
  try {
    if (!c || digits(c.number).length < 12) return;
    const num = digits(c.number);
    if (loadCards().some((x) => digits(x.number) === num)) return; // har redan kortet
    sendTo(e.sender.__ctx, 'wallet-offer', { holder: c.holder || '', number: num, exp: c.exp || '', cvc: digits(c.cvc), brand: cardBrand(num), last4: num.slice(-4) });
  } catch {}
});

/* ── Nedladdningar + nedladdningsskydd ──
 * Två lager, precis som Chrome/Brave (fast vårt eget):
 *   1) Moln-hash-rykte — vi räknar filens SHA-256 lokalt och skickar BARA hashen
 *      till vårt Säkerkoll-moln (aldrig själva filen). Molnet slår den mot vår
 *      hotdatabas (1M+ kända skadliga filer, à la Google Safe Browsing) och svarar
 *      farlig/ren. Funkar för alla användare utan lokal antivirus.
 *   2) Lokal ClamAV — extra signaturlager om det råkar finnas installerat.
 * Vid träff i något lager: flytta filen till karantän + varna ("Behåll ändå" finns). */
const CLAMSCAN = ['/usr/bin/clamscan', '/usr/local/bin/clamscan'].find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
const QUARANTINE = path.join(app.getPath('userData'), 'quarantine');
try { fs.mkdirSync(QUARANTINE, { recursive: true }); } catch {}
const downloads = [];
/* Fingeravtryck (SHA-256) av en färdig fil — det enda som skickas till molnet. */
function sha256File(file) {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}
/* Fråga vårt moln-nedladdningsskydd om filens hash är känd skadlig. */
async function cloudDownloadCheck(rec) {
  const hash = await sha256File(rec.path);
  if (!hash) return null;
  rec.sha256 = hash;
  try {
    const r = await fetch(SKOLL + '/api/sakerkoll/download-check', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sha256: hash, filename: rec.filename, size: rec.total, url: rec.url }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.verdict === 'dangerous') return { threat: j.threat || 'Känd skadlig fil' };
    if (j && j.ok) return { clean: true };
  } catch {}
  return null; // nådde inte molnet → obekräftat
}
/* Lokal ClamAV som extra lager (om installerat). Löser {threat} eller null. */
function clamScanFile(file) {
  return new Promise((resolve) => {
    if (!CLAMSCAN) return resolve(null);
    let out = ''; let p;
    try { p = spawn(CLAMSCAN, ['--no-summary', '--stdout', file]); }
    catch { return resolve(null); }
    if (p.stdout) p.stdout.on('data', (d) => { out += d; });
    if (p.stderr) p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('exit', (code) => {
      if (code === 1) { const m = out.match(/:\s*(.+?)\s+FOUND/); resolve({ threat: (m && m[1]) || 'Okänt hot' }); }
      else resolve(null); // 0 = ren, 2 = fel
    });
  });
}
/* Flytta en farlig fil till karantän och varna renderaren. */
function quarantineThreat(rec, threat) {
  rec.threat = threat;
  let q = path.join(QUARANTINE, rec.id + '__' + rec.filename);
  try { fs.renameSync(rec.path, q); } catch { try { fs.copyFileSync(rec.path, q); fs.unlinkSync(rec.path); } catch { q = null; } }
  rec.quarantine = q; rec.state = 'infected'; rec.scan = 'infected';
  broadcast('download-update', rec);
  broadcast('download-threat', { id: rec.id, filename: rec.filename, threat: rec.threat });
}
/* Skyddar en färdig nedladdning: moln-hash-rykte först, sen lokal ClamAV. */
async function scanDownload(rec) {
  if (!rec.path) { rec.state = 'completed'; rec.scan = 'unscanned'; broadcast('download-update', rec); return; }
  rec.state = 'scanning'; rec.scan = 'scanning'; broadcast('download-update', rec);
  const cloud = await cloudDownloadCheck(rec);          // 1) moln-hash-rykte
  if (cloud && cloud.threat) { quarantineThreat(rec, cloud.threat); return; }
  const local = await clamScanFile(rec.path);           // 2) lokal ClamAV (om finns)
  if (local && local.threat) { quarantineThreat(rec, local.threat); return; }
  rec.state = 'completed';
  rec.scan = ((cloud && cloud.clean) || CLAMSCAN) ? 'clean' : 'unscanned';
  broadcast('download-update', rec);
}
function trackDownloads(sess) {
  sess.on('will-download', (_e, item) => {
    const id = 'd' + Date.now() + Math.floor(Math.random() * 1000);
    const savePath = path.join(app.getPath('downloads'), item.getFilename());
    try { item.setSavePath(savePath); } catch {}
    const rec = { id, filename: item.getFilename(), url: item.getURL(), path: savePath, total: item.getTotalBytes(), received: 0, state: 'progressing', scan: null };
    downloads.unshift(rec);
    broadcast('download-update', rec);
    try { const fw = BrowserWindow.getFocusedWindow(); let c = fw ? wins.get(fw.webContents.id) : null; if (!c) c = wins.values().next().value; if (c) openDlPopup(c); } catch {}
    item.on('updated', (_e2, state) => { rec.received = item.getReceivedBytes(); rec.state = state; broadcast('download-update', rec); });
    item.once('done', (_e2, state) => {
      rec.received = item.getReceivedBytes();
      if (state === 'completed') scanDownload(rec);
      else { rec.state = state; broadcast('download-update', rec); }
    });
  });
}
ipcMain.handle('dl:list', () => downloads);
ipcMain.on('dl:popup-toggle', (e) => { const ctx = wins.get(e.sender.id); if (!ctx) return; if (ctx.dlWin && !ctx.dlWin.isDestroyed()) ctx.dlWin.close(); else openDlPopup(ctx); });
ipcMain.on('dl:popup-close', (e) => { const cw = BrowserWindow.fromWebContents(e.sender); if (cw && !cw.isDestroyed()) cw.close(); });
ipcMain.on('dl:open', (_e, id) => { const r = downloads.find((d) => d.id === id); if (r && r.state !== 'infected' && r.state !== 'deleted') shell.openPath(r.path).catch(() => {}); });
ipcMain.on('dl:folder', (_e, id) => { const r = downloads.find((d) => d.id === id); if (r && r.state !== 'infected' && r.state !== 'deleted') shell.showItemInFolder(r.path); });
ipcMain.on('dl:remove-threat', (_e, id) => {
  const r = downloads.find((d) => d.id === id); if (!r) return;
  try { if (r.quarantine) fs.unlinkSync(r.quarantine); } catch {}
  r.quarantine = null; r.state = 'deleted'; r.scan = 'deleted'; broadcast('download-update', r);
});
ipcMain.on('dl:keep-anyway', (_e, id) => {
  const r = downloads.find((d) => d.id === id); if (!r) return;
  try { if (r.quarantine) fs.renameSync(r.quarantine, r.path); } catch { try { if (r.quarantine) { fs.copyFileSync(r.quarantine, r.path); fs.unlinkSync(r.quarantine); } } catch {} }
  r.quarantine = null; r.state = 'completed'; r.scan = 'overridden'; broadcast('download-update', r);
});

/* ────────── IPC – per fönster (routas via event.sender) ────────── */
ipcMain.on('view:load', (e, tabId, url) => { const ctx = ctxFor(e); if (!ctx) return; ensureView(ctx, tabId).webContents.loadURL(url).catch(() => {}); showOnly(ctx, tabId); });
ipcMain.on('view:show', (e, tabId) => { const ctx = ctxFor(e); if (ctx) showOnly(ctx, tabId); });
ipcMain.on('view:hide', (e) => { const ctx = ctxFor(e); if (!ctx) return; ctx.views.forEach((v) => v.setVisible(false)); ctx.visibleTab = null; });
ipcMain.on('view:bounds', (e, r) => { const ctx = ctxFor(e); if (ctx) { ctx.bounds = r; applyBounds(ctx); } });
ipcMain.on('view:inset-top', (e, px) => { const ctx = ctxFor(e); if (ctx) { ctx.topInset = Math.max(0, px | 0); applyBounds(ctx); } });
ipcMain.on('view:inset-left', (e, px) => { const ctx = ctxFor(e); if (ctx) { ctx.leftInset = Math.max(0, px | 0); applyBounds(ctx); } });
ipcMain.on('view:incognito', (e, id) => { const ctx = ctxFor(e); if (ctx) ctx.incognitoTabs.add(id); });
ipcMain.on('view:default-zoom', (e, f) => { const ctx = ctxFor(e); if (!ctx) return; ctx.defaultZoom = f; ctx.views.forEach((v) => { try { v.webContents.setZoomFactor(f); } catch {} }); });
ipcMain.on('view:zoom', (e, id, dir) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const v = ctx.views.get(id); if (!v) return;
  const wc = v.webContents;
  const z = dir === 0 ? 1 : Math.min(3, Math.max(0.4, wc.getZoomFactor() + dir * 0.1));
  wc.setZoomFactor(z);
});
ipcMain.on('view:print', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) printPage(ctx, v.webContents); });
ipcMain.on('view:back', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) try { v.webContents.navigationHistory.goBack(); } catch { v.webContents.goBack(); } });
ipcMain.on('view:forward', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) try { v.webContents.navigationHistory.goForward(); } catch { v.webContents.goForward(); } });
ipcMain.on('view:reload', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) v.webContents.reload(); });
ipcMain.on('view:stop', (e, id) => { const ctx = ctxFor(e); if (!ctx) return; const v = ctx.views.get(id); if (v) v.webContents.stop(); });
ipcMain.on('view:destroy', (e, id) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const v = ctx.views.get(id);
  if (v) { try { ctx.win.contentView.removeChildView(v); } catch {} try { v.webContents.close(); } catch {} ctx.views.delete(id); }
  ctx.incognitoTabs.delete(id);
  if (ctx.visibleTab === id) ctx.visibleTab = null;
});
ipcMain.on('app:fullscreen', (e) => { const ctx = ctxFor(e); if (ctx) ctx.win.setFullScreen(!ctx.win.isFullScreen()); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('win:do-close', (e) => {
  const ctx = wins.get(e.sender.id); if (ctx) ctx.forceClose = true;
  const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close();
});
// Öppna den flytande "Stäng alla flikar?"-notisen (eget litet fönster ovanför sidan,
// så inget gråas ut och hela sidan är kvar). Skalet ber om den när flikar > 1.
ipcMain.on('open-close-confirm', (e, count) => {
  const ctx = wins.get(e.sender.id); if (!ctx) return;
  const parent = BrowserWindow.fromWebContents(e.sender); if (!parent) return;
  if (ctx.confirmWin && !ctx.confirmWin.isDestroyed()) { ctx.confirmWin.focus(); return; }
  const cb = parent.getContentBounds();
  const w = 372, h = 210;
  const cw = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.png'),
    parent, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, width: w, height: h,
    x: cb.x + cb.width - w - 14, y: cb.y + 92,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ctx.confirmWin = cw;
  cw.loadFile(path.join(__dirname, 'ui', 'confirm.html'), { query: { n: String(count || 0) } });
  cw.on('closed', () => { if (ctx.confirmWin === cw) ctx.confirmWin = null; });
});
ipcMain.on('close-confirm-done', (e, res) => {
  const cw = BrowserWindow.fromWebContents(e.sender);
  const parent = cw ? cw.getParentWindow() : null;
  if (cw && !cw.isDestroyed()) cw.close();
  if (!parent) return;
  if (res && res.ok) {
    const ctx = wins.get(parent.webContents.id);
    if (res.again) parent.webContents.send('persist-skip-close');
    if (ctx) ctx.forceClose = true;
    parent.close();
  }
});

ipcMain.on('open-app-menu', (e) => {
  const ctx = ctxFor(e); if (!ctx) return;
  const t = [
    { label: 'Ny flik', accelerator: 'CmdOrCtrl+T', click: () => sendTo(ctx, 'open-new-tab') },
    { label: 'Nytt fönster', accelerator: 'CmdOrCtrl+N', click: () => createWindow(false) },
    { label: 'Nytt inkognitofönster', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow(true) },
    { label: 'Ny inkognitoflik', click: () => sendTo(ctx, 'new-incognito') },
    { type: 'separator' },
    { label: 'Lösenord och autofyll', click: () => sendTo(ctx, 'open-passwords') },
    { label: 'Historik', click: () => sendTo(ctx, 'open-history') },
    { label: 'Bokmärken och listor', click: () => sendTo(ctx, 'open-bookmarks') },
    { label: 'Nedladdade filer', click: () => sendTo(ctx, 'open-downloads') },
    { type: 'separator' },
    { label: 'Zooma in', click: () => sendTo(ctx, 'menu-zoom', 1) },
    { label: 'Zooma ut', click: () => sendTo(ctx, 'menu-zoom', -1) },
    { label: 'Återställ zoom', click: () => sendTo(ctx, 'menu-zoom', 0) },
    { label: 'Helskärm', accelerator: 'F11', click: () => ctx.win.setFullScreen(!ctx.win.isFullScreen()) },
    { label: 'Skriv ut…', accelerator: 'CmdOrCtrl+P', click: () => sendTo(ctx, 'menu-print') },
    { label: 'Fler verktyg', submenu: [
      { label: 'Utvecklarverktyg', accelerator: 'F12', click: () => { const v = ctx.views.get(ctx.visibleTab); if (v) try { v.webContents.openDevTools(); } catch {} } },
      { label: 'Rensa surfdata', click: () => {
        try { session.defaultSession.clearStorageData(); } catch {}
        try { session.fromPartition('skoll-incognito').clearStorageData(); } catch {}
        sendTo(ctx, 'clear-data');
      } },
    ] },
    { type: 'separator' },
    { label: 'Hjälp & om', click: () => sendTo(ctx, 'open-settings', 'om') },
    { label: 'Inställningar', click: () => sendTo(ctx, 'open-settings') },
    { label: 'Avsluta', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(t).popup({ window: ctx.win });
});

/* ── Krypto-panel (per fönster) ── */
function loadKrypto(ctx, mode) {
  if (!ctx.kryptoView) return;
  if (ctx.kryptoView._mode === mode) return;   // redan rätt innehåll
  ctx.kryptoView._mode = mode;
  if (mode === 'pro') {
    ctx.kryptoView.webContents.loadFile(path.join(__dirname, 'ui', 'krypto.html')).catch(() => {});
  } else {
    const hash = mode === 'signedout' ? 'signedout' : 'nopro';
    ctx.kryptoView.webContents.loadFile(path.join(__dirname, 'ui', 'krypto-lock.html'), { hash }).catch(() => {});
  }
}
ipcMain.on('krypto:toggle', (e, open, mode, token) => {
  const ctx = ctxFor(e); if (!ctx) return;
  ctx.kryptoOpen = !!open;
  if (token) ctx.vakaToken = token;   // vaka-session-token för Krypto-chattens API-anrop
  if (ctx.kryptoOpen) {
    if (!ctx.kryptoView) {
      ctx.kryptoView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'krypto-preload.js'), contextIsolation: true } });
      ctx.win.contentView.addChildView(ctx.kryptoView);
      const wc = ctx.kryptoView.webContents;
      wc.setWindowOpenHandler(({ url }) => { sendTo(ctx, 'open-new-tab', url); return { action: 'deny' }; });
      // Panelen får ALDRIG navigera till en webbplats – bara våra egna file://-sidor.
      // Allt annat (även säkerkoll.se) öppnas som en ny flik i stället.
      wc.on('will-navigate', (ev, url) => {
        if (url.startsWith('https://krypto.local/')) {
          ev.preventDefault();
          if (url.includes('login')) sendTo(ctx, 'open-login');
          else if (url.includes('recheck')) sendTo(ctx, 'krypto-recheck');
        } else if (!url.startsWith('file:')) {
          ev.preventDefault(); sendTo(ctx, 'open-new-tab', url);
        }
      });
    }
    ctx.kryptoView.webContents.__ctx = ctx;
    loadKrypto(ctx, mode || 'nopro');
  }
  applyBounds(ctx);
});
// Skicka en färdig fråga (från "Var ska jag börja?"-quizet) in i Krypto-panelen.
ipcMain.on('krypto:prefill', (e, text) => {
  const ctx = ctxFor(e) || e.sender.__ctx; if (!ctx || !ctx.kryptoView) return;
  try { ctx.kryptoView.webContents.send('krypto-prefill', String(text || '')); } catch {}
});
// Krypto helskärm på/av: panelen täcker hela webbytan (enklare att läsa/skriva långa rapporter).
ipcMain.on('krypto:expand', (e, full) => {
  const ctx = ctxFor(e) || e.sender.__ctx; if (!ctx) return;
  ctx.kryptoFull = !!full;
  applyBounds(ctx); raiseKrypto(ctx);
});

/* ────────── Nätverksinspektör (Wireshark-lik, via Chrome DevTools-protokollet) ──────────
 * Kopplar CDP-debuggern till varje fliks webContents och lyssnar på Network-domänen,
 * precis som DevTools Network-fliken. Vi får metod, URL, status, typ, storlek, timing,
 * request-/response-headers, POST-data och (på begäran) response-body. Allt lokalt. */
function netShortHost(u) { try { return new URL(u).host; } catch { return ''; } }
function attachNet(ctx, wc) {
  try {
    if (!wc || wc.isDestroyed() || wc._netAttached) return;
    try { wc.debugger.attach('1.3'); } catch { return; }   // redan attachad (t.ex. DevTools öppen)
    wc._netAttached = true;
    wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 20000000, maxResourceBufferSize: 10000000 }).catch(() => {});
    wc.debugger.on('message', (_e, method, params) => { try { onNetMsg(ctx, wc, method, params); } catch {} });
    wc.debugger.on('detach', () => { wc._netAttached = false; });
    wc.once('destroyed', () => { try { if (wc._netAttached) wc.debugger.detach(); } catch {} });
  } catch {}
}
function onNetMsg(ctx, wc, method, params) {
  const net = ctx.net; if (!net) return;
  if (method === 'Network.requestWillBeSent') {
    const req = params.request || {};
    const r = {
      id: params.requestId, _wc: wc, method: req.method || 'GET', url: req.url || '',
      reqHeaders: req.headers || {}, postData: req.postData || '',
      type: params.type || '', status: 0, mime: '', respHeaders: {}, remoteIP: '', size: 0,
      t0: params.timestamp || 0, t1: 0, done: false, failed: false, errorText: '',
    };
    net.records.set(r.id, r); net.order.push(r.id);
    while (net.order.length > NET_MAX) { const old = net.order.shift(); net.records.delete(old); }
  } else if (method === 'Network.responseReceived') {
    const r = net.records.get(params.requestId); if (!r) return;
    const resp = params.response || {};
    r.status = resp.status || 0; r.mime = resp.mimeType || ''; r.respHeaders = resp.headers || {};
    r.remoteIP = resp.remoteIPAddress || ''; r.type = params.type || r.type;
    sendNetRow(ctx, r);
  } else if (method === 'Network.loadingFinished') {
    const r = net.records.get(params.requestId); if (!r) return;
    r.done = true; r.size = params.encodedDataLength || r.size; r.t1 = params.timestamp || r.t1;
    sendNetRow(ctx, r);
  } else if (method === 'Network.loadingFailed') {
    const r = net.records.get(params.requestId); if (!r) return;
    r.done = true; r.failed = true; r.errorText = params.errorText || ''; r.t1 = params.timestamp || r.t1;
    sendNetRow(ctx, r);
  }
}
function netSummary(r) {
  return { id: r.id, method: r.method, url: r.url, host: netShortHost(r.url), status: r.failed ? 'FAIL' : (r.status || 0), type: r.type || '', mime: r.mime || '', size: r.size || 0, ms: (r.t1 && r.t0) ? Math.round((r.t1 - r.t0) * 1000) : 0, failed: !!r.failed };
}
function sendNetRow(ctx, r) { sendTo(ctx, 'net-row', netSummary(r)); }
ipcMain.on('net:toggle', (e, open) => {
  const ctx = ctxFor(e); if (!ctx) return;
  ctx.netOpen = !!open;
  if (!ctx.net) ctx.net = { records: new Map(), order: [] };
  if (ctx.netOpen) {
    ctx.views.forEach((v) => attachNet(ctx, v.webContents));
    ctx.net.order.forEach((id) => { const r = ctx.net.records.get(id); if (r && (r.status || r.failed)) sendNetRow(ctx, r); });
  }
  applyBounds(ctx);
});
ipcMain.on('net:clear', (e) => { const ctx = ctxFor(e); if (ctx && ctx.net) { ctx.net.records.clear(); ctx.net.order = []; } });
ipcMain.handle('net:detail', async (e, id) => {
  const ctx = ctxFor(e); if (!ctx || !ctx.net) return null;
  const r = ctx.net.records.get(id); if (!r) return null;
  let body = '', base64 = false, bodyErr = '';
  if (!r.failed && r.method !== 'OPTIONS') {
    try { const res = await r._wc.debugger.sendCommand('Network.getResponseBody', { requestId: id }); body = res.body || ''; base64 = !!res.base64Encoded; }
    catch (err) { bodyErr = String((err && err.message) || err || ''); }
  }
  return {
    id, method: r.method, url: r.url, status: r.status, type: r.type, mime: r.mime, remoteIP: r.remoteIP || '',
    reqHeaders: r.reqHeaders || {}, respHeaders: r.respHeaders || {}, postData: r.postData || '',
    body, base64, bodyErr, failed: !!r.failed, errorText: r.errorText || '', size: r.size || 0,
  };
});

/* Krypto-chatt: proxar till Säkerkolls AI-API med fönstrets kontonummer, så
 * kontonumret aldrig behöver ligga i panelen. Samma /ai/chat som webbens assistent. */
const KRYPTO_LOG = path.join(app.getPath('userData'), 'krypto-chat.log');
function klog(o) { try { fs.appendFileSync(KRYPTO_LOG, new Date().toISOString() + ' ' + JSON.stringify(o) + '\n'); } catch {} }
ipcMain.handle('krypto:chat', async (e, messages) => {
  const ctx = e.sender.__ctx;
  const token = ctx && ctx.vakaToken;
  if (!token) { klog({ stage: 'no-token' }); return { ok: false, needLogin: true, message: 'Logga in med din mejl (kontoknappen) för att låsa upp Krypto.' }; }
  const payload = { vaka_token: token, messages: (Array.isArray(messages) ? messages : []).slice(-16) };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(SKOLL + '/api/sakerkoll/ai/chat', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) { klog({ stage: 'http', attempt, status: r.status, error: json.error, msgCount: payload.messages.length }); return { ok: false, error: json.error, message: json.message || 'Något gick fel. Försök igen om en stund.' }; }
      klog({ stage: 'ok', attempt, used: json.used });
      return { ok: true, reply: json.reply };
    } catch (err) {
      klog({ stage: 'throw', attempt, err: String(err && (err.name || err.message || err)) });
      if (attempt === 2) return { ok: false, message: 'Kunde inte nå Krypto just nu. Kontrollera din uppkoppling och försök igen.' };
      await new Promise((r) => setTimeout(r, 800)); // kort backoff, försök igen en gång
    }
  }
});

// Krypto som agent: panelen skickar hit kommandon (t.ex. byt sökmotor, av/på skydd).
// Fönster-/process-actions körs här; UI-inställningar rel:as vidare till skalet.
ipcMain.on('krypto:action', (e, a) => {
  try {
    const ctx = e.sender.__ctx; if (!ctx || !a || !a.name) return;
    const name = String(a.name).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o');
    if (name === 'inkognito' || name === 'incognito') { createWindow(true); return; }
    if (name === 'nedladdningar' || name === 'downloads') { sendTo(ctx, 'open-downloads'); return; }
    if (name === 'losenord' || name === 'autofyll' || name === 'autofill') { sendTo(ctx, 'open-passwords'); return; }
    if (name === 'wallet' || name === 'planbok' || name === 'kort' || name === 'vaka wallet') { sendTo(ctx, 'open-settings', 'wallet'); return; }
    // sokmotor / adblock / realtidsskydd / minska_rorelse sköts i skalet
    sendTo(ctx, 'krypto-set', a);
  } catch {}
});

/* ────────── Kortkommandon (Chromium-lika) ──────────
 * Acceleratorerna i popup-menyerna är bara etiketter. Riktiga genvägar fångas
 * här via before-input-event på VARJE webContents (skal + flik-vyer + Krypto),
 * så de funkar även när fokus ligger i en webbsida. */
function ctxForWc(wc) { return wins.get(wc.id) || wc.__ctx || null; }
function activeView(ctx) { return ctx && ctx.visibleTab ? ctx.views.get(ctx.visibleTab) : null; }
function handleShortcut(wc, input) {
  if (input.type !== 'keyDown') return false;
  const ctx = ctxForWc(wc);
  if (!ctx) return false;
  const mod = input.control || input.meta;      // Ctrl (eller Cmd på mac)
  const shift = input.shift;
  const k = (input.key || '').toLowerCase();
  if (mod && !shift && k === 't') { sendTo(ctx, 'open-new-tab'); return true; }
  if (mod && !shift && k === 'n') { createWindow(false); return true; }
  if (mod && shift && k === 'n') { createWindow(true); return true; }
  if (mod && !shift && k === 'w') { sendTo(ctx, 'close-tab'); return true; }
  if (mod && !shift && k === 'l') { try { ctx.win.webContents.focus(); } catch {} sendTo(ctx, 'focus-address'); return true; }
  if (mod && shift && k === 'r') { const v = activeView(ctx); if (v) v.webContents.reloadIgnoringCache(); return true; }
  if (mod && !shift && k === 'r') { const v = activeView(ctx); if (v) v.webContents.reload(); return true; }
  if (mod && !shift && k === 'p') { const v = activeView(ctx); if (v) printPage(ctx, v.webContents); return true; }
  if (mod && (k === '+' || k === '=')) { sendTo(ctx, 'menu-zoom', 1); return true; }
  if (mod && (k === '-' || k === '_')) { sendTo(ctx, 'menu-zoom', -1); return true; }
  if (mod && k === '0') { sendTo(ctx, 'menu-zoom', 0); return true; }
  if (mod && !shift && k === 'q') { app.quit(); return true; }
  if (k === 'f11') { ctx.win.setFullScreen(!ctx.win.isFullScreen()); return true; }
  if (k === 'f12' || (mod && shift && k === 'i')) { const v = activeView(ctx); if (v) try { v.webContents.openDevTools(); } catch {} return true; }
  if (k === 'f5') { const v = activeView(ctx); if (v) v.webContents.reload(); return true; }
  return false;
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (ev, input) => { try { if (handleShortcut(wc, input)) ev.preventDefault(); } catch {} });
  // Context-meny: bara för skalets webContents (native flik-vyer har sin egen i ensureView).
  wc.on('context-menu', (_ev, params) => { const ctx = wins.get(wc.id); if (ctx) { try { buildShellMenu(ctx, wc, params); } catch {} } });
});

/* ────────── Fönster ────────── */
function createWindow(incognito) {
  const win = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: incognito ? '#0a0512' : '#0e2a47',
    title: incognito ? 'Prowl – Inkognito' : 'Prowl',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const id = win.webContents.id;
  const ctx = makeCtx(win, incognito);
  wins.set(id, ctx);
  win.loadFile(path.join(__dirname, 'ui', 'shell.html'), incognito ? { query: { incognito: '1' } } : {});
  win.on('resize', () => sendTo(ctx, 'window-resized'));
  win.on('enter-full-screen', () => applyBounds(ctx));   // räkna om vy-bounds när övergången är klar
  win.on('leave-full-screen', () => applyBounds(ctx));
  // Bekräfta innan man stänger ett fönster med flera flikar (Brave-likt). Skalet
  // avgör om dialogen behövs (det vet flik-antalet) och kallar win:do-close när OK.
  win.on('close', (e) => {
    if (ctx.forceClose) return;                    // redan bekräftat → stäng på riktigt
    e.preventDefault();
    if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('confirm-close');
    else { ctx.forceClose = true; win.destroy(); }
  });
  win.on('closed', () => {
    ctx.views.forEach((v) => { try { v.webContents.close(); } catch {} });
    ctx.views.clear();
    if (ctx.kryptoView) { try { ctx.kryptoView.webContents.close(); } catch {} ctx.kryptoView = null; }
    wins.delete(id);
  });
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const all = BrowserWindow.getAllWindows();
    if (all.length) { const w = all[all.length - 1]; if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

app.whenReady().then(() => {
  // Presentera oss som vanlig Chrome — annars ser sajter (t.ex. Google) "Electron"
  // + appnamnet i user-agent och tror att det är en bot ("unusual traffic").
  try {
    app.userAgentFallback = app.userAgentFallback
      .replace(/ sakerkoll-browser\/\S+/i, '')
      .replace(/ Electron\/\S+/i, '');
    session.defaultSession.setUserAgent(app.userAgentFallback);
  } catch {}
  applyClientHints(session.defaultSession);
  installAdblockOn(session.defaultSession);
  trackDownloads(session.defaultSession);
  // Ingen OS-menyrad (File/Edit/View…) i fönstret — webbläsaren har sin egen ≡-meny.
  // På macOS behålls en riktig meny (systemets menyrad + Cmd+C/V/A m.m.).
  try {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }
  } catch {}
  createWindow(false);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(false); });
  startAutoUpdate();
});

// Auto-uppdatering (Linux/AppImage): hämtar nya versioner i bakgrunden och
// installerar dem nästa gång Vaka startas om — ingen ominstallation för hand.
function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
// macOS kan inte tyst-uppdatera osignerad (Squirrel kräver signering) → notifiera i stället.
function checkMacUpdate() {
  const f = globalThis.fetch;
  if (!f) return;
  const ping = () => f('https://api.github.com/repos/northcrafto/prowl-dl/releases/latest', { headers: { 'User-Agent': 'Prowl' } })
    .then((r) => r.json())
    .then((j) => {
      const latest = ((j && j.tag_name) || '').replace(/^v/, '');
      if (latest && semverGt(latest, app.getVersion())) {
        broadcast('toast', 'Ny version av Prowl (' + latest + ') finns — ladda ner på vaka-web-lovat.vercel.app');
      }
    }).catch(() => {});
  setTimeout(ping, 6000);
  setInterval(ping, 6 * 60 * 60 * 1000);
}

function startAutoUpdate() {
  if (process.platform === 'darwin') { checkMacUpdate(); return; }  // mac: notis (osignerad)
  if (!autoUpdater) return;
  const log = (m) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), m + '\n'); } catch {} };
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => log('checking @ ' + app.getVersion()));
    autoUpdater.on('update-available', (i) => log('available ' + (i && i.version)));
    autoUpdater.on('update-not-available', (i) => log('up-to-date ' + (i && i.version)));
    autoUpdater.on('update-downloaded', (info) => {
      log('downloaded ' + (info && info.version));
      broadcast('toast', 'Prowl ' + ((info && info.version) || '') + ' är hämtad — uppdateras nästa gång du startar om.');
      broadcast('update-ready', (info && info.version) || '');
    });
    autoUpdater.on('error', (e) => log('error ' + (e && e.message)));
    const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch {} };
    setTimeout(check, 5000);
    setInterval(check, 6 * 60 * 60 * 1000);
  } catch {}
}
ipcMain.on('update:install', () => { try { if (autoUpdater) autoUpdater.quitAndInstall(false, true); } catch {} });
app.on('will-quit', () => { if (torProc) { try { torProc.kill(); } catch {} } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
