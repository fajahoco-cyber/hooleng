#!/usr/bin/env node
/*
 * فایل‌های سایت و کتابخانه‌های ظاهری را دانلود می‌کند و پوشه‌ی www را برای اپ اندروید می‌سازد.
 * ورودی: متغیر محیطی SITE_URL  (مثلاً https://example.com/)
 * اگر SKIP_LIBS=1 باشد دانلود کتابخانه‌ها از CDN انجام نمی‌شود (فقط برای تست).
 */
const fs = require('fs');
const path = require('path');

const SITE = String(process.env.SITE_URL || '').trim();
if (!/^https?:\/\//i.test(SITE)) { console.error('خطا: SITE_URL درست تنظیم نشده است.'); process.exit(1); }
const BASE = SITE.replace(/\/?$/, '/');
const OUT = path.join(__dirname, '..', 'www');

const PAGES = ['index.html', 'dashboard.html', 'register.html', 'bulk-register.html', 'delivery.html', 'return.html', 'search.html',
  'details.html', 'excel.html', 'sync.html', 'cod.html', 'offline.html', 'settings.html'];
const REQUIRED_PAGES = ['index.html', 'dashboard.html', 'delivery.html', 'offline.html'];
const FILES = [['style.css', true], ['app.js', true], ['avatar.jpg', false], ['icon-512.png', false]];

// [آدرس CDN، مسیر محلی، آیا فایل‌های داخل CSS (فونت‌ها) هم دانلود شوند، ضروری؟]
const LIBS = [
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.rtl.min.css', 'assets/bootstrap.rtl.min.css', false, true],
  ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js', 'assets/bootstrap.bundle.min.js', false, true],
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css', 'assets/fa/css/all.min.css', true, true],
  ['https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css', 'assets/vazirmatn/Vazirmatn-font-face.css', true, true],
  ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'assets/xlsx.full.min.js', false, true],
  ['https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js', 'assets/html5-qrcode.min.js', false, false]
];

async function get(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (build-www)' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function save(rel, buf) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
}
function norm(p) {
  const out = [];
  for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
  return out.join('/');
}
function resolveUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  const u = new URL(base);
  if (rel.startsWith('/')) return u.origin + rel;
  return u.origin + '/' + norm(u.pathname.replace(/[^/]*$/, '') + rel);
}
const looksBlocked = (buf) => /server is denied|Forbidden/i.test(buf.toString('utf8', 0, 800)) && buf.length < 2000;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const report = [];
  let failed = false;

  for (const p of PAGES) {
    try {
      const buf = await get(BASE + p);
      if (buf.length < 200 || looksBlocked(buf)) throw new Error('پاسخ نامعتبر یا مسدود (۴۰۳)');
      save(p, buf); report.push(['ok', p]);
    } catch (e) {
      const req = REQUIRED_PAGES.includes(p);
      report.push([req ? 'FAIL' : 'skip', `${p} (${e.message})`]);
      if (req) failed = true;
    }
  }
  for (const [f, req] of FILES) {
    try { save(f, await get(BASE + f)); report.push(['ok', f]); }
    catch (e) { report.push([req ? 'FAIL' : 'skip', `${f} (${e.message})`]); if (req) failed = true; }
  }

  const map = {};
  if (process.env.SKIP_LIBS !== '1') {
    const saveLib = async (url, rel, isCss) => {
      const buf = await get(url);
      save(rel, buf); report.push(['ok', rel]);
      if (isCss) {
        const css = buf.toString('utf8');
        const refs = new Set();
        css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => { if (!/^data:/i.test(ref) && ref[0] !== '#') refs.add(ref.replace(/[?#].*$/, '')); return m; });
        for (const ref of refs) {
          if (!ref) continue;
          try {
            const sub = norm(path.posix.dirname(rel) + '/' + ref);
            if (!sub.startsWith('assets/')) continue;
            save(sub, await get(resolveUrl(url, ref).replace(/\[/g, '%5B').replace(/\]/g, '%5D')));
            report.push(['ok', sub]);
          } catch (e) { report.push(['skip', `${ref} (${e.message})`]); }
        }
      }
    };
    for (const [url, rel, isCss, required] of LIBS) {
      try { await saveLib(url, rel, isCss); map[url] = rel; }
      catch (e) { report.push([required ? 'FAIL' : 'skip', `${rel} (${e.message})`]); if (required) failed = true; }
    }
  }

  // جایگزینی آدرس CDN با فایل محلی + آدرس سایت برای درخواست‌های API
  const inject = `<script>window.SITE_BASE=${JSON.stringify(BASE)};</script>`;
  for (const p of PAGES) {
    const fp = path.join(OUT, p);
    if (!fs.existsSync(fp)) continue;
    let html = fs.readFileSync(fp, 'utf8');
    for (const [url, rel] of Object.entries(map)) html = html.split(url).join(rel);
    if (!html.includes('window.SITE_BASE')) html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
    fs.writeFileSync(fp, html);
  }
  save('build-info.json', Buffer.from(JSON.stringify({ site: BASE, built: new Date().toISOString() })));

  for (const [s, t] of report) console.log(`${s.padEnd(5)} ${t}`);
  if (failed) { console.error('\nساخت www ناموفق بود: فایل‌های ضروری (بالا با FAIL) دانلود نشدند.'); process.exit(1); }
  console.log(`\nwww آماده است (${report.filter(r => r[0] === 'ok').length} فایل).`);
})().catch((e) => { console.error(e); process.exit(1); });
