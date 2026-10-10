const $ = (sel) => document.querySelector(sel);
const els = {
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  filelist: $('#filelist'),
  tabs: $('#tabs'),
  editmeta: $('#editmeta'),
  source: $('#source'),
  pv: $('#pv'),
  sheet: $('#sheet'),
  stage: $('#stage'),
  empty: $('#empty'),
  spinner: $('#spinner'),
  zoom: $('#zoom'),
  engine: $('#engine'),
  export: $('#btnExport'),
  toast: $('#toast'),
};

const store = {
  docs: [],
  activeId: null,
  options: {},
  busy: false,
};

let uid = 0;
const nextId = () => `d${++uid}`;

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

function loadOptions() {
  const form = document.querySelectorAll('[data-opt]');
  const saved = JSON.parse(localStorage.getItem('md2pdf.options') || '{}');
  store.options = saved;
  form.forEach((el) => {
    const key = el.dataset.opt;
    if (saved[key] === undefined) return;
    if (el.type === 'checkbox') el.checked = !!saved[key];
    else el.value = saved[key];
  });
  form.forEach((el) => {
    const key = el.dataset.opt;
    if (el.type === 'checkbox') store.options[key] = el.checked;
    else store.options[key] = el.value;
  });
}

function saveOptions() {
  localStorage.setItem('md2pdf.options', JSON.stringify(store.options));
}

document.querySelectorAll('[data-opt]').forEach((el) => {
  const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(evt, () => {
    const key = el.dataset.opt;
    store.options[key] = el.type === 'checkbox' ? el.checked : el.value;
    saveOptions();
    if (el.type !== 'text' || key === 'imageBaseUrl') scheduleRender();
  });
});

/* ------------------------------------------------------------------ */
/* docs                                                                */
/* ------------------------------------------------------------------ */

function isMd(name) {
  return /\.(md|markdown|mdown|mkd|mdtxt|text)$/i.test(name);
}

function addDoc(name, content, { activate = true, fromDisk = true } = {}) {
  const doc = { id: nextId(), name, content, dirty: false, fromDisk };
  store.docs.push(doc);
  if (activate || !store.activeId) store.activeId = doc.id;
  if (!fromDisk) doc.dirty = true;
  return doc;
}

function closeDoc(id) {
  const idx = store.docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  store.docs.splice(idx, 1);
  if (store.activeId === id) {
    store.activeId = store.docs[Math.min(idx, store.docs.length - 1)]?.id || null;
  }
  renderChrome();
  if (!store.docs.length) clearPreview();
  else scheduleRender();
}

function activeDoc() {
  return store.docs.find((d) => d.id === store.activeId) || null;
}

function wireDoc() {
  localStorage.setItem(
    'md2pdf.session',
    JSON.stringify({
      docs: store.docs.map((d) => ({ name: d.name, content: d.content })),
      active: store.activeId,
    })
  );
}

async function handleFiles(fileList) {
  const files = [...fileList];
  const md = files.filter((f) => isMd(f.name));
  const skipped = files.length - md.length;
  for (const f of md) addDoc(f.name, await f.text());
  renderChrome();
  scheduleRender();
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped (not Markdown)`);
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((t) =>
  document.addEventListener(t, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    els.dropzone.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((t) =>
  document.addEventListener(t, (e) => {
    if (t === 'drop') {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    }
    if (e.target === document.documentElement || t === 'dragleave') {
      els.dropzone.classList.remove('over');
    }
  })
);

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
    return;
  }
  const text = e.clipboardData?.getData('text/plain');
  if (!text || document.activeElement === els.source) return;
  if (/\.(md|markdown)\b/.test(e.target?.value || '')) return;
  addDoc('pasted.md', text, { fromDisk: false });
  renderChrome();
  els.source.value = text;
  scheduleRender();
});

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function renderChrome() {
  els.filelist.innerHTML = '';
  els.tabs.innerHTML = '';

  for (const doc of store.docs) {
    const row = document.createElement('div');
    row.className = 'file' + (doc.id === store.activeId ? ' active' : '');
    row.innerHTML = `<span class="fname"></span><span class="fmeta">${doc.content.length}b</span><button class="x" title="Remove">&times;</button>`;
    row.querySelector('.fname').textContent = doc.name + (doc.dirty ? ' *' : '');
    row.onclick = (e) => {
      if (e.target.classList.contains('x')) return;
      store.activeId = doc.id;
      els.source.value = doc.content;
      renderChrome();
      scheduleRender();
    };
    row.querySelector('.x').onclick = () => closeDoc(doc.id);
    els.filelist.appendChild(row);

    const tab = document.createElement('button');
    tab.className = 'tab' + (doc.id === store.activeId ? ' active' : '');
    tab.textContent = doc.name;
    tab.onclick = () => {
      store.activeId = doc.id;
      els.source.value = doc.content;
      renderChrome();
      scheduleRender();
    };
    els.tabs.appendChild(tab);
  }

  const doc = activeDoc();
  if (doc) {
    const words = doc.content.trim().split(/\s+/).filter(Boolean).length;
    const lines = doc.content.split('\n').length;
    els.editmeta.textContent = `${lines} lines · ${words} words`;
  } else {
    els.editmeta.textContent = '';
  }

  els.export.disabled = !store.docs.length || store.busy;
}

/* ------------------------------------------------------------------ */
/* editor                                                              */
/* ------------------------------------------------------------------ */

let typeTimer = null;
els.source.addEventListener('input', () => {
  const doc = activeDoc();
  if (!doc) return;
  doc.content = els.source.value;
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    wireDoc();
    renderChrome();
  }, 700);
  scheduleRender();
});

els.source.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    exportPdf();
  }
});

/* ------------------------------------------------------------------ */
/* preview render                                                      */
/* ------------------------------------------------------------------ */

let renderSeq = 0;
let renderTimer = null;

function scheduleRender(delay = 320) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(doRender, delay);
}

function clearPreview() {
  els.pv.classList.add('hidden');
  els.empty.hidden = false;
  els.source.value = '';
}

const page = { w: 794, h: 1123, height: 1123 };

function layoutPage() {
  const pw = page.w;
  const full = Math.max(page.h, Math.ceil(page.height));
  els.pv.style.width = pw + 'px';
  els.pv.style.height = full + 'px';

  const stage = els.stage;
  const avail = stage.clientWidth - 44;
  const z = els.zoom.value === 'fit' ? Math.min(1, avail / pw) : parseFloat(els.zoom.value);
  els.pv.style.transform = `scale(${z})`;
  els.sheet.style.width = pw * z + 'px';
  els.sheet.style.height = full * z + 'px';
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'md2pdf') return;
  page.w = d.pageW || page.w;
  page.h = d.pageH || page.h;
  page.height = d.height || page.height;
  page.diagrams = d.diagrams;
  page.failed = d.failed;
  els.empty.hidden = true;
  els.pv.classList.remove('hidden');
  els.spinner.hidden = true;
  layoutPage();
});

async function doRender() {
  const seq = ++renderSeq;
  const docs = store.docs.filter((d) => d.content.trim());
  if (!docs.length) {
    clearPreview();
    return;
  }
  els.spinner.hidden = false;
  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docs: docs.map((d) => ({ name: d.name, title: '', content: d.content })),
        options: store.options,
      }),
    });
    const html = await res.text();
    if (seq !== renderSeq) return;
    if (!res.ok) throw new Error(html.slice(0, 200));
    els.pv.srcdoc = html;
    els.empty.hidden = true;
    els.pv.classList.remove('hidden');
    requestPing();
  } catch (err) {
    els.spinner.hidden = true;
    toast('Preview failed: ' + err.message, true);
  }
}

let pingTimer = null;
function requestPing() {
  clearInterval(pingTimer);
  let tries = 0;
  pingTimer = setInterval(() => {
    try {
      els.pv.contentWindow?.postMessage('md2pdf:ping', '*');
    } catch {}
    if (++tries > 12) clearInterval(pingTimer);
  }, 250);
}

els.zoom.addEventListener('change', layoutPage);
$('#btnRefresh').addEventListener('click', () => doRender());
window.addEventListener('resize', () => layoutPage());

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

async function exportPdf() {
  if (store.busy || !store.docs.length) return;
  store.busy = true;
  els.export.disabled = true;
  els.export.textContent = 'Rendering...';
  toast('Rendering PDF, diagrams included...');
  try {
    const fd = new FormData();
    for (const d of store.docs) fd.append('files', new Blob([d.content], { type: 'text/markdown' }), d.name);
    fd.append('options', JSON.stringify(store.options));
    const res = await fetch('/api/pdf', { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    const diagrams = res.headers.get('X-Diagram-Count');
    const failed = res.headers.get('X-Diagram-Failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'document.pdf';
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const n = Number(diagrams || 0);
    const bad = Number(failed || 0);
    toast(
      `Saved ${name}` +
        (n ? ` · ${n} Mermaid diagram${n === 1 ? '' : 's'} rendered` : '') +
        (bad ? ` · ${bad} failed, see the note in the PDF` : ''),
      bad > 0
    );
  } catch (err) {
    toast('Export failed: ' + err.message, true);
  } finally {
    store.busy = false;
    els.export.textContent = 'Export PDF';
    renderChrome();
  }
}

els.export.addEventListener('click', exportPdf);

$('#btnClear').addEventListener('click', () => {
  if (!store.docs.length) return;
  store.docs = [];
  store.activeId = null;
  localStorage.removeItem('md2pdf.session');
  renderChrome();
  clearPreview();
});

$('#btnSample').addEventListener('click', () => {
  if (store.docs.length) {
    store.docs = [];
    store.activeId = null;
  }
  addDoc('sample.md', SAMPLE);
  els.source.value = SAMPLE;
  renderChrome();
  scheduleRender(0);
});

/* ------------------------------------------------------------------ */
/* toast + health                                                      */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg, isErr = false) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (isErr ? ' err' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 4200);
}

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.browser) {
      els.engine.textContent = `engine: ${h.browser}`;
      els.engine.className = 'pill pill-ok';
      els.engine.title = h.browserPath;
    } else {
      els.engine.textContent = 'no Chrome found';
      els.engine.className = 'pill pill-warn';
      els.engine.title = 'Set CHROME_PATH to a Chrome or Chromium binary';
    }
  })
  .catch(() => {
    els.engine.textContent = 'engine offline';
    els.engine.className = 'pill pill-warn';
  });

/* ------------------------------------------------------------------ */
/* sample                                                              */
/* ------------------------------------------------------------------ */

const SAMPLE = `# Release Pipeline

A short tour of every diagram type the converter supports.

## Architecture

\`\`\`mermaid
flowchart TD
  A[Markdown file] --> B{Renderer}
  B --> C[HTML preview]
  B --> D[PDF export]
  C --> E[(Browser)]
  D --> F[(Download)]
  subgraph Runtime
    B
    G[Mermaid 11]
  end
\`\`\`

## Request lifecycle

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web UI
  participant S as Server
  participant C as Chrome
  U->>W: Upload README.md
  W->>S: POST /api/render
  S-->>W: HTML + Mermaid
  U->>W: Export PDF
  W->>S: POST /api/pdf
  S->>C: page.goto
  C-->>S: SVG diagrams ready
  S-->>W: application/pdf
\`\`\`

## Effort split

\`\`\`mermaid
pie showData
  "Mermaid rendering" : 45
  "Typography" : 20
  "Page layout" : 20
  "Transport" : 15
\`\`\`

## Plan

| Phase | Scope | Status |
| --- | --- | --- |
| Parse | markdown-it, GFM tables | done |
| Diagrams | mermaid 11, 5 themes | done |
| Export | headless Chrome print | done |

1. Load one or many \`.md\` files.
2. Tune layout options on the left.
3. Export, page numbers included.

> Diagrams scale to the page width and never split across pages.

---

Rendered locally. Nothing leaves the machine.
`;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

loadOptions();
try {
  const session = JSON.parse(localStorage.getItem('md2pdf.session') || 'null');
  if (session?.docs?.length) {
    for (const d of session.docs) addDoc(d.name, d.content, { activate: false });
    store.activeId =
      store.docs.find((d) => d.id === session.active)?.id || store.docs[0].id;
  }
} catch {}

const first = activeDoc();
if (first) {
  els.source.value = first.content;
  renderChrome();
  scheduleRender(0);
} else {
  renderChrome();
}

window.addEventListener('beforeunload', () => {
  if (activeDoc()) wireDoc();
});
