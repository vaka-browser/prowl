/* Repro: laddar chatgpt.com med samma adblock-motor + scriptlets som appen
 * och skriver ut sidans konsolfel. Kör: npx electron repro_chatgpt.js --no-sandbox */
'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronBlocker, Resources } = require('@ghostery/adblocker-electron');

const URL_TO_TEST = process.argv.includes('--no-adblock') ? null : true;

async function makeEngine() {
  const dir = path.join(__dirname, 'filters');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') && f !== 'resources.txt');
  const skip = process.env.SKIP_LIST || '';
  const text = files
    .filter((f) => !skip.split(',').includes(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n') + '\n' + (process.env.EXTRA_FILTERS || '');
  const engine = ElectronBlocker.parse(text, { loadCosmeticFilters: true, loadNetworkFilters: true });
  const resTxt = fs.readFileSync(path.join(dir, 'resources.txt'), 'utf8');
  engine.resources = Resources.parse(resTxt, { checksum: 'vaka' });
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => engine.onInjectCosmeticFilters(e, url, msg));
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => engine.onIsMutationObserverEnabled(e));
  return engine;
}

app.whenReady().then(async () => {
  app.userAgentFallback = app.userAgentFallback
    .replace(/ sakerkoll-browser\/\S+/i, '')
    .replace(/ Electron\/\S+/i, '');
  session.defaultSession.setUserAgent(app.userAgentFallback);

  if (!process.argv.includes('--no-adblock')) {
    const engine = await makeEngine();
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => engine.onHeadersReceived(d, cb));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => engine.onBeforeRequest(d, cb));
    if (!process.argv.includes('--no-scriptlets')) {
      const p = require.resolve('@ghostery/adblocker-electron-preload');
      session.defaultSession.setPreloads([p]);
      console.log('[repro] scriptlet-preload PÅ');
    } else {
      console.log('[repro] scriptlet-preload AV');
    }
    console.log('[repro] adblock PÅ');
  } else {
    console.log('[repro] adblock AV');
  }

  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false } });
  let errors = 0;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || /RangeError|Maximum call stack/i.test(message)) {
      errors++;
      console.log(`[console] nivå=${level} ${message.slice(0, 300)}  (${sourceId}:${line})`);
    }
  });
  win.webContents.on('did-finish-load', () => console.log('[repro] did-finish-load'));
  win.webContents.on('did-fail-load', (_e, ec, desc) => console.log('[repro] did-fail-load', ec, desc));
  await win.loadURL('https://chatgpt.com/').catch((e) => console.log('[repro] loadURL-fel:', e.message));
  setTimeout(async () => {
    const state = await win.webContents.executeJavaScript(
      `(function(){ try { var t=(document.body&&document.body.innerText||'').slice(0,400); return JSON.stringify({title:document.title, text:t}); } catch(e){ return 'evalfel: '+e.message } })()`
    ).catch((e) => 'exec-fel: ' + e.message);
    console.log('[repro] sidstatus:', state);
    console.log('[repro] konsolfel totalt:', errors);
    app.exit(0);
  }, 12000);
});
