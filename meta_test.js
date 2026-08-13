'use strict';
/* Snabbtest av metadata-bedömningen (ingen browser). Kör: node meta_test.js <url> [url...] */
const { checkUrl } = require('./scanner');
(async () => {
  const urls = process.argv.slice(2);
  const out = [];
  for (const u of urls) {
    let r;
    try { r = await checkUrl(u); } catch (e) { r = { verdict: { status: 'error', reasons: [String(e)] } }; }
    out.push({ url: u, status: r.verdict.status, reasons: r.verdict.reasons });
    process.stderr.write(`${u} -> ${r.verdict.status}\n`);
  }
  console.log(JSON.stringify(out, null, 2));
})();
