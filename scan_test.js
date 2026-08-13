'use strict';
/* Testrigg: laddar en lista sajter headless och kör EXAKT appens skanner. */
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('fs');
const { EXTRACT_JS, analyzeContent, checkUrl } = require('./scanner');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const urls = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3] || '/home/mint/scan-report.json';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  const wc = view.webContents;

  const results = [];
  for (const url of urls) {
    const r = { url };
    try {
      const metaP = checkUrl(url).catch(() => null);
      await Promise.race([wc.loadURL(url).catch(() => {}), wait(13000)]);
      await wait(1800);
      r.finalUrl = wc.getURL();
      const feats = await wc.executeJavaScript(EXTRACT_JS).catch(() => null);
      r.feats = feats;
      r.content = analyzeContent(feats);
      const meta = await metaP;
      r.metadata = meta ? meta.verdict.status : 'error';
    } catch (e) { r.error = String(e); }
    results.push(r);
    process.stderr.write(`✓ ${url}  content=${r.content ? r.content.level : 'ok'}  meta=${r.metadata || '?'}\n`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2)); // löpande, överlever ev. hängning
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stderr.write('KLART\n');
  app.quit();
});
