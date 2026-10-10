import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4321;

const PAGE_SIZES = {
  a4: { width: '210mm', height: '297mm', format: 'A4' },
  letter: { width: '8.5in', height: '11in', format: 'Letter' },
  legal: { width: '8.5in', height: '14in', format: 'Legal' },
  a5: { width: '148mm', height: '210mm', format: 'A5' },
  a3: { width: '297mm', height: '420mm', format: 'A3' },
  tabloid: { width: '11in', height: '17in', format: 'Tabloid' },
};

const MERMAID_THEMES = ['default', 'neutral', 'dark', 'forest', 'base'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 40 },
});

/* ------------------------------------------------------------------ */
/* markdown rendering                                                  */
/* ------------------------------------------------------------------ */

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    return '';
  },
});

// Mermaid fences become <pre class="mermaid"> so the client can draw them.
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
  const code = token.content;
  if (info === 'mermaid' || info === 'mmd') {
    return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>\n`;
  }
  if (info) {
    const lang = info.match(/^\S+/)[0];
    const cls = `hljs language-${md.utils.escapeHtml(lang)}`;
    return `<pre><code class="${cls}">${md.utils.escapeHtml(code)}</code></pre>\n`;
  }
  return `<pre><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>\n`;
};

const slugify = (s) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);

function renderDoc({ content }, { options }) {
  const env = { headings: [] };
  const tokens = md.parse(content || '', env);

  const slugCounts = new Map();
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    let slug = slugify(text) || 'section';
    const n = slugCounts.get(slug) || 0;
    slugCounts.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    token.attrSet('id', slug);
    env.headings.push({ level: Number(token.tag.slice(1)), text, slug });
  });

  let body = md.renderer.render(tokens, md.options, env);
  body = body.replace(/<img (?![^>]*loading=)/gi, '<img loading="lazy" ');

  const base = options.imageBaseUrl ? String(options.imageBaseUrl).replace(/\/+$/, '') + '/' : '';
  if (base) {
    body = body.replace(/(<img[^>]*?\ssrc=")([^"]*)(")/gi, (m, a, src, c) =>
      /^(data:|https?:|\/)/i.test(src) ? m : `${a}${base}${src}${c}`
    );
  }

  return { html: body, headings: env.headings };
}

/* ------------------------------------------------------------------ */
/* html document                                                       */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function tocHtml(headings, maxLevel) {
  const items = headings.filter((h) => h.level >= 2 && h.level <= maxLevel);
  if (items.length < 2) return '';
  const min = Math.min(...items.map((i) => i.level));
  return `
  <nav class="toc">
    <div class="toc-title">Contents</div>
    <ul>
      ${items
        .map(
          (h) =>
            `<li class="toc-l${h.level}"><a href="#${h.slug}">${esc(
              h.text.replace(/`/g, '')
            )}</a></li>`
        )
        .join('\n')}
    </ul>
  </nav>`;
}

const mmToPx = (v) => (parseFloat(v) || 0) * (96 / 25.4);

function pagePx(options) {
  const size = PAGE_SIZES[options.pageSize] || PAGE_SIZES.a4;
  const m = Number(options.margin || 18);
  return {
    pw: Math.round(mmToPx(size.width) - mmToPx(m * 2)),
    ph: Math.round(mmToPx(size.height) - mmToPx(m * 2 + 10)),
  };
}

function styles(options) {
  const o = options;
  const size = PAGE_SIZES[o.pageSize] || PAGE_SIZES.a4;
  const orient = o.orientation === 'landscape' ? 'landscape' : 'portrait';
  const margin = `${o.margin || 18}mm`;
  const scale = Number(o.fontScale || 100) / 100;
  const { pw, ph } = pagePx(o);
  const font = o.font === 'serif'
    ? '"Iowan Old Style", "Charter", Georgia, "Times New Roman", serif'
    : o.font === 'mono'
      ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
      : '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

  return `
  @page { size: ${size.width} ${size.height} ${orient}; margin: ${margin}; }
  :root {
    --accent: ${o.accent || '#2f6f4f'};
    --fg: ${o.theme === 'dark' ? '#e6e6e6' : '#1f2328'};
    --bg: ${o.theme === 'dark' ? '#0f141b' : '#ffffff'};
    --muted: ${o.theme === 'dark' ? '#9aa4b2' : '#57606a'};
    --rule: ${o.theme === 'dark' ? '#2b3138' : '#d8dee4'};
    --code-bg: ${o.theme === 'dark' ? '#151b23' : '#f6f8fa'};
    --hl-bg: ${o.theme === 'dark' ? '#11161d' : '#fbfcfd'};
    --err-bg: ${o.theme === 'dark' ? '#33161a' : '#fff1f0'};
    --err-fg: ${o.theme === 'dark' ? '#ffb3ad' : '#82071e'};
    --err-line: ${o.theme === 'dark' ? '#8d2b34' : '#d1242f'};
  }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html { -webkit-text-size-adjust: 100%; background: var(--bg); }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: ${font};
    font-size: ${(11 * scale).toFixed(2)}pt;
    line-height: 1.62;
    counter-reset: fig h2;
  }
  .page { padding: 0; }
  .cover {
    min-height: calc(100vh - ${(2 * (parseFloat(o.margin || 18) * 3.7795)).toFixed(1)}px);
    display: flex; flex-direction: column; justify-content: center;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 1.6em; padding-bottom: 1.2em;
  }
  .cover h1 { font-size: 2.5em; margin: 0 0 .35em; line-height: 1.15; letter-spacing: -.02em; }
  .cover .meta { color: var(--muted); font-size: .95em; display: flex; gap: 1.2em; flex-wrap: wrap; }
  .cover .rule { width: 64px; height: 3px; background: var(--accent); border-radius: 2px; margin-bottom: 1.4em; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .55em; font-weight: 650; letter-spacing: -.01em; break-after: avoid; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid var(--rule); }
  h3 { font-size: 1.18em; } h4 { font-size: 1.03em; color: var(--muted); }
  p { margin: 0 0 1em; orphans: 2; widows: 2; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
  strong { font-weight: 650; }
  ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
  li { margin: .25em 0; }
  li > ul, li > ol { margin-bottom: .2em; }
  blockquote {
    margin: 1.2em 0; padding: .1em 0 .1em 1.1em;
    border-left: 3px solid var(--accent); color: var(--muted); font-style: italic;
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
  img, video, svg { max-width: 100%; height: auto; }
  figure { margin: 1.4em 0; text-align: center; break-inside: avoid; }
  figcaption { color: var(--muted); font-size: .9em; margin-top: .5em; }
  table { border-collapse: collapse; width: 100%; margin: 1.3em 0; font-size: .95em; break-inside: avoid; }
  th, td { border: 1px solid var(--rule); padding: .5em .7em; text-align: left; vertical-align: top; }
  thead th { background: var(--code-bg); font-weight: 620; }
  tbody tr:nth-child(even) { background: color-mix(in srgb, var(--code-bg) 55%, transparent); }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: .88em; background: var(--code-bg); padding: .15em .38em; border-radius: 5px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--rule); border-radius: 10px;
    padding: .9em 1.05em; overflow: hidden; break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: .86em; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #b3599e; }
  .hljs-string, .hljs-attr { color: #2d7a4f; }
  .hljs-number, .hljs-built_in { color: #b5651d; }
  .hljs-comment, .hljs-quote { color: var(--muted); font-style: italic; }
  .hljs-title, .hljs-function, .hljs-section { color: #2a5db0; }
  .hljs-type, .hljs-class .hljs-title { color: #1f7a8c; }
  ${o.theme === 'dark' ? `
  .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #dd7bd0; }
  .hljs-string, .hljs-attr { color: #7ad48f; }
  .hljs-number, .hljs-built_in { color: #e0a25c; }
  .hljs-title, .hljs-function, .hljs-section { color: #7bb4f5; }
  .hljs-type, .hljs-class .hljs-title { color: #64d4d0; }` : ''}
  pre.mermaid {
    background: transparent; border: 0; padding: .8em 0; text-align: center;
    font-family: inherit; white-space: normal; line-height: 1.4;
    display: flex; align-items: center; justify-content: center;
  }
  pre.mermaid[data-failed="1"] {
    background: var(--err-bg); border: 1px dashed var(--err-line); color: var(--err-fg);
    text-align: left; white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace;
    font-size: .82em; padding: .8em; line-height: 1.5;
  }
  .mermaid svg { max-width: 100% !important; width: auto !important; max-height: 92vh; height: auto !important; display: block; }
  .mermaid[data-failed="1"] { display: block; }
  .toc { break-inside: avoid; background: var(--code-bg); border: 1px solid var(--rule); border-radius: 12px; padding: 1em 1.2em; margin: 1.5em 0 2em; }
  .toc-title { font-weight: 680; font-size: .8em; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: .6em; }
  .toc ul { list-style: none; padding: 0; margin: 0; }
  .toc li { margin: .18em 0; }
  .toc a { border: 0; color: inherit; }
  .toc-l3 { padding-left: 1.1em; font-size: .95em; }
  .toc-l4 { padding-left: 2.2em; font-size: .9em; color: var(--muted); }
  .doc-footer { margin-top: 2.5em; padding-top: .8em; border-top: 1px solid var(--rule); color: var(--muted); font-size: .82em; display: flex; justify-content: space-between; gap: 1em; }
  .page-break { break-after: page; }
  .doc + .doc { break-before: page; }

  /* screen preview only: fixed page canvas with page-boundary guides */
  @media screen {
    html { background: ${o.theme === 'dark' ? '#070a0e' : '#eef1f4'}; }
    body { background: ${o.theme === 'dark' ? '#070a0e' : '#eef1f4'}; }
    .page { position: relative; width: ${pw}px; min-height: ${ph}px; margin: 0 auto; background: var(--bg); box-shadow: 0 1px 3px #0f172a22, 0 8px 24px #0f172a14; overflow: hidden; }
    .content { position: relative; z-index: 1; }
    .doc { position: relative; z-index: 1; }
    .cover { min-height: ${ph}px; }
    .guides { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
    .guides i { display: block; height: ${ph}px; border-bottom: 1px dashed #c3cedb; }
    .guides i:first-child { border-top: 1px dashed #c3cedb; }
  }
  `;
}

function buildHtml(payload) {
  const options = { ...payload.options };
  const docs = payload.docs || [];
  const multi = docs.length > 1;
  const rendered = docs.map((doc) => ({ ...doc, ...renderDoc(doc, { options }) }));

  const sections = rendered
    .map((doc, idx) => {
      const headings = doc.headings;
      const firstH1 = headings.find((h) => h.level === 1);
      const title =
        (idx === 0 && options.title) || doc.title || firstH1?.text || doc.name || 'Document';
      const showCover = options.cover && idx === 0;
      const showToc = options.toc && idx === 0;
      const date = options.date || new Date().toISOString().slice(0, 10);
      return `
<section class="doc" id="doc-${idx}">
  ${
    showCover
      ? `<div class="cover">
    <div class="rule"></div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      ${options.author ? `<span>${esc(options.author)}</span>` : ''}
      <span>${esc(date)}</span>
      ${multi ? `<span>${docs.length} documents</span>` : ''}
    </div>
  </div>`
      : ''
  }
  ${showToc ? tocHtml(headings, Number(options.tocDepth) || 3) : ''}
  <div class="content">${doc.html}</div>
  ${
    options.footer
      ? `<div class="doc-footer"><span>${esc(title)}</span><span>${esc(date)}</span></div>`
      : ''
  }
</section>`;
    })
    .join('\n');

  const mermaidTheme = MERMAID_THEMES.includes(options.mermaidTheme) ? options.mermaidTheme : 'default';
  const { pw, ph } = pagePx(options);

  return `<!doctype html>
<html lang="en" data-page-w="${pw}" data-page-h="${ph}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docs[0]?.title || docs[0]?.name || 'Document')}</title>
<style>${styles(options)}</style>
</head>
<body>
<div class="page">
${options.guides === false ? '' : `<div class="guides">${Array.from({ length: 40 }, () => '<i></i>').join('')}</div>`}
${sections}
</div>
<script src="/vendor/mermaid.min.js"></script>
<script>
(function () {
  var cfg = {
    startOnLoad: false,
    theme: ${JSON.stringify(options.theme === 'dark' ? 'dark' : mermaidTheme)},
    securityLevel: 'strict',
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: ${Math.round(13 * Number(options.fontScale || 100) / 100)},
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
    sequence: { useMaxWidth: false, wrap: true },
    gantt: { useMaxWidth: false },
    er: { useMaxWidth: false },
  };
  function fail(node, err) {
    node.innerHTML = '';
    node.setAttribute('data-failed', '1');
    var head = document.createElement('div');
    head.style.cssText = 'font:600 .8em ui-monospace,Menlo,monospace;letter-spacing:.05em;text-transform:uppercase;margin-bottom:.45em';
    head.textContent = 'Diagram not rendered';
    var msg = document.createElement('div');
    msg.style.cssText = 'white-space:pre-wrap;opacity:.85';
    var raw = node.getAttribute('data-source') || '';
    var detail = (err && (err.str || err.message)) || 'Invalid diagram syntax';
    msg.textContent = detail.split('\\n').slice(0, 4).join('\\n') + '\\n\\nSource:\\n' + raw.trim();
    node.appendChild(head);
    node.appendChild(msg);
  }
  function run() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
    mermaid.initialize(cfg);
    if (!nodes.length) return Promise.resolve(0);
    nodes.forEach(function (n) { n.setAttribute('data-source', n.textContent); });
    return Promise.resolve(mermaid.run({ nodes: nodes })).then(
      function () { return nodes.length; },
      function (e) {
        nodes.forEach(function (n) { if (!n.querySelector('svg')) fail(n, e); });
        return nodes.length;
      }
    ).then(function () {
      var bad = 0;
      nodes.forEach(function (n) {
        var svg = n.querySelector('svg');
        if (svg && svg.querySelector('.error-icon, .error-text, [id*="error"]')) {
          fail(n, { str: 'Syntax error in this diagram' });
          bad++;
        }
        if (!n.querySelector('svg') && !n.getAttribute('data-failed')) fail(n, null);
      });
      return { total: nodes.length, failed: bad };
    });
  }
  function announce() {
    var r = document.documentElement.getBoundingClientRect();
    var msg = {
      source: 'md2pdf',
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      width: Math.max(document.body.scrollWidth, ${pw}),
      pageW: ${pw},
      pageH: ${ph},
      diagrams: window.__diagramCount || 0,
      failed: window.__diagramFailed || 0,
    };
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  window.addEventListener('message', function (e) {
    if (e.data === 'md2pdf:ping') announce();
  });
  window.addEventListener('load', announce);
  window.addEventListener('resize', announce);
  window.__announce = announce;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { announce(); }).observe(document.body);
  }
  window.__mermaid = run();
  window.__ready = false;
  window.__mermaid.then(function (r) {
    window.__diagramCount = r.total;
    window.__diagramFailed = r.failed;
    window.__ready = true;
    document.documentElement.setAttribute('data-ready', '1');
    announce();
  }).catch(function (e) {
    window.__ready = true;
    announce();
  });
  setTimeout(announce, 1500);
})();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* document store for preview + pdf                                    */
/* ------------------------------------------------------------------ */

const store = new Map();
const TTL = 1000 * 60 * 30;

function putDoc(payload) {
  const id = crypto.randomUUID();
  store.set(id, { payload, at: Date.now() });
  for (const [k, v] of store) if (Date.now() - v.at > TTL) store.delete(k);
  return id;
}

/* ------------------------------------------------------------------ */
/* chrome discovery                                                    */
/* ------------------------------------------------------------------ */

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let browserPromise = null;

function launchBrowser() {
  const executablePath = chromePath();
  if (!executablePath) {
    throw Object.assign(
      new Error(
        'No Chrome/Chromium binary found. Set CHROME_PATH to a Chrome or Chromium executable.'
      ),
      { status: 500 }
    );
  }
  return puppeteer
    .launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--allow-file-access-from-files',
      ],
    })
    .then((b) => {
      b.on('disconnected', () => {
        if (browserPromise) browserPromise = null;
      });
      return b;
    })
    .catch((err) => {
      browserPromise = null;
      throw err;
    });
}

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
  }
  browserPromise = launchBrowser();
  return browserPromise;
}

// A dead browser should not surface as "Protocol error: Connection closed."
async function newPage() {
  try {
    return await (await getBrowser()).newPage();
  } catch {
    return (await getBrowser()).newPage();
  }
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  '/vendor',
  express.static(path.join(__dirname, 'node_modules/mermaid/dist'), {
    maxAge: '1d',
    setHeaders(res, p) {
      if (p.endsWith('.js')) res.type('application/javascript');
    },
  })
);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

function normalizeDocs(input) {
  const docs = Array.isArray(input) ? input : input ? [input] : [];
  return docs
    .map((d) => ({
      name: d.name || 'document.md',
      title: d.title || '',
      content: typeof d.content === 'string' ? d.content : '',
    }))
    .filter((d) => d.content.length);
}

app.post('/api/render', (req, res) => {
  const docs = normalizeDocs(req.body.docs);
  if (!docs.length) return res.status(400).json({ error: 'No Markdown content received.' });
  const options = req.body.options || {};
  res.type('html').send(buildHtml({ docs, options }));
});

app.get('/render', (req, res) => {
  const docs = normalizeDocs(
    req.query.docs ? JSON.parse(String(req.query.docs)) : []
  );
  if (!docs.length) return res.status(400).send('No content');
  res.type('html').send(buildHtml({ docs, options: req.query.options || {} }));
});

app.post('/api/pdf', upload.array('files', 40), async (req, res) => {
  try {
    const options = req.body.options ? JSON.parse(req.body.options) : {};
    let docs = [];
    if (req.files?.length) {
      docs = req.files.map((f) => ({
        name: f.originalname,
        content: f.buffer.toString('utf8'),
      }));
    } else if (req.body.markdown) {
      docs = [{ name: 'document.md', content: String(req.body.markdown) }];
    }
    if (!docs.length) {
      return res.status(400).json({ error: 'Upload at least one .md file.' });
    }

    const id = putDoc({ docs, options });
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      let page;
      try {
        page = await newPage();
        await page.emulateMediaType('print');
        await page.setViewport({ width: 1280, height: 1600, deviceScaleFactor: 1 });
        await page.goto(`http://127.0.0.1:${PORT}/doc/${id}`, {
          waitUntil: 'networkidle0',
          timeout: 60000,
        });
        await page.waitForFunction('window.__ready === true', { timeout: 45000 });
        const stats = await page.evaluate(() => ({
          diagrams: window.__diagramCount || 0,
          failed: window.__diagramFailed || 0,
        }));

        const size = PAGE_SIZES[options.pageSize] || PAGE_SIZES.a4;
        const margin = Number(options.margin || 18);
        const showNumbers = options.pageNumbers !== false;
        const docTitle = options.title || docs[0].title || path.parse(docs[0].name).name;
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          format: size.format,
          landscape: options.orientation === 'landscape',
          margin: { top: margin + 4, right: margin, bottom: margin + 6, left: margin },
          displayHeaderFooter: showNumbers,
          headerTemplate: '<div></div>',
          footerTemplate: showNumbers
            ? `<div style="width:100%;font-size:8px;color:#8b949e;font-family:Helvetica,Arial,sans-serif;padding:0 ${margin}mm;display:flex;justify-content:space-between;">
              <span>${esc(docTitle)}</span>
              <span class="pageNumber"></span>
             </div>`
            : '<div></div>',
        });

        const base = docTitle.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'document';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
        res.setHeader('X-Diagram-Count', String(stats.diagrams));
        res.setHeader('X-Diagram-Failed', String(stats.failed));
        res.send(Buffer.from(pdf));
        store.delete(id);
        return;
      } catch (err) {
        lastErr = err;
        if (page) await page.close().catch(() => {});
        // A dropped browser connection is worth one more try with a fresh instance.
        if (attempt === 0 && /Connection closed|Session closed|Target closed/i.test(err.message || '')) {
          console.warn('[pdf] retrying with a fresh browser:', err.message);
          browserPromise = null;
          continue;
        }
        break;
      }
    }
    console.error('[pdf]', lastErr);
    store.delete(id);
    res.status(lastErr?.status || 500).json({ error: lastErr?.message || 'PDF generation failed.' });
  } catch (err) {
    console.error('[pdf]', err);
    res.status(err.status || 500).json({ error: err.message || 'PDF generation failed.' });
  }
});

app.get('/doc/:id', (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry) return res.status(404).send('Document expired');
  res.type('html').send(buildHtml(entry.payload));
});

app.get('/api/health', (req, res) => {
  const exe = chromePath();
  res.json({
    ok: true,
    browser: exe ? path.basename(exe) : null,
    browserPath: exe,
    mermaid: '11.4.1',
  });
});

app.post('/api/exit', async () => {
  if (browserPromise) (await browserPromise).close().catch(() => {});
  process.exit(0);
});



app.listen(PORT, () => {
  const exe = chromePath();
  console.log(`md2pdf  ->  http://localhost:${PORT}`);
  console.log(`pdf engine: ${exe || 'NONE FOUND (set CHROME_PATH)'}`);
});
