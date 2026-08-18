'use strict';
/* Testar filtermotorn EXAKT som appen laddar den (samma filer, samma parse)
 * mot de anrop YouTube gör vid sök + uppspelning. */
const fs = require('fs');
const path = require('path');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');

const dir = path.join(__dirname, 'filters');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') && f !== 'resources.txt');
const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

const t0 = Date.now();
const engine = ElectronBlocker.parse(text, { loadCosmeticFilters: true, loadNetworkFilters: true });
console.log('parse:', Date.now() - t0, 'ms,', files.length, 'filer,', (text.length / 1e6).toFixed(1), 'MB');

const SRC = 'https://www.youtube.com/results?search_query=test';
const CASES = [
  ['document',   'https://www.youtube.com/results?search_query=test'],
  ['xhr',        'https://www.youtube.com/youtubei/v1/search?prettyPrint=false'],
  ['xhr',        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'],
  ['xhr',        'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false'],
  ['xhr',        'https://www.youtube.com/youtubei/v1/next?prettyPrint=false'],
  ['script',     'https://www.youtube.com/s/player/12345/player_ias.vflset/sv_SE/base.js'],
  ['script',     'https://www.youtube.com/s/desktop/abcdef/jsbin/desktop_polymer.vflset/desktop_polymer.js'],
  ['stylesheet', 'https://www.youtube.com/s/desktop/abcdef/cssbin/www-main-desktop-home-page-skeleton.css'],
  ['image',      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'],
  ['image',      'https://yt3.ggpht.com/ytc/foo=s68-c-k-c0x00ffffff-no-rj'],
  ['media',      'https://rr3---sn-5goeen7z.googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4'],
  ['xhr',        'https://rr3---sn-5goeen7z.googlevideo.com/videoplayback?expire=1&range=0-'],
  ['xhr',        'https://www.youtube.com/api/stats/playback?ns=yt&docid=x'],
  ['xhr',        'https://www.youtube.com/api/stats/watchtime?ns=yt&docid=x'],
  ['xhr',        'https://www.youtube.com/api/stats/qoe?event=streamingstats'],
  ['ping',       'https://www.youtube.com/generate_204'],
  ['xhr',        'https://www.youtube.com/youtubei/v1/log_event?alt=json'],
  ['script',     'https://www.google.com/js/th/abc.js'],
  ['xhr',        'https://play.google.com/log?format=json&hasfast=true'],
  ['image',      'https://www.gstatic.com/youtube/img/promos/growth/foo.webp'],
  ['xhr',        'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/Create'],
  ['font',       'https://fonts.gstatic.com/s/roboto/v30/x.woff2'],
];

let worst = 0;
for (const [type, url] of CASES) {
  const r = Request.fromRawDetails({ type, url, sourceUrl: SRC });
  const s = process.hrtime.bigint();
  const m = engine.match(r);
  const us = Number(process.hrtime.bigint() - s) / 1000;
  worst = Math.max(worst, us);
  const tag = m.match ? (m.redirect ? 'REDIRECT' : 'BLOCK   ') : (m.exception ? 'allow(ex)' : 'pass    ');
  console.log(tag, type.padEnd(10), (us.toFixed(0) + 'µs').padStart(7), url.slice(0, 90));
}
console.log('värsta matchning:', worst.toFixed(0) + 'µs');

// Kosmetik: hur många regler/scriptlets injiceras på youtube.com?
const cos = engine.getCosmeticsFilters({ url: 'https://www.youtube.com/results?search_query=test', hostname: 'www.youtube.com', domain: 'youtube.com' });
console.log('kosmetik: styles', (cos.styles || '').length, 'tecken, scripts:', (cos.scripts || []).length, 'extended:', (cos.extended || []).length);
