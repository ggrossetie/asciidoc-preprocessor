// Intrinsic and derived attributes.
//
// Directives very often test attributes the author never wrote:
// `ifdef::backend-html5[]`, `ifdef::basebackend-html[]`,
// `ifeval::["{doctype}" == "book"]`, `ifdef::safe-mode-secure[]`, ...
// In Asciidoctor these are seeded by the Document constructor. In the
// transducer model they are *seed state supplied by the processor
// interface* (§2): this module computes the same seed, so that a
// processor embedding the transducer can pass it as `options.attributes`.
//
// Locking follows Asciidoctor: the defaults are soft (a document may
// override them), while the processor-owned ones (asciidoctor,
// asciidoctor-version, safe-mode-*, docdir, user-home, max-include-depth,
// allow-uri-read when absent, embedded) are locked.

const DEFAULT_ATTRIBUTES = {
  'attribute-undefined': 'drop-line',
  'attribute-missing': 'skip',
  'appendix-caption': 'Appendix',
  'appendix-refsig': 'Appendix',
  'caution-caption': 'Caution',
  'chapter-refsig': 'Chapter',
  'example-caption': 'Example',
  'figure-caption': 'Figure',
  'important-caption': 'Important',
  'last-update-label': 'Last updated',
  'note-caption': 'Note',
  'part-refsig': 'Part',
  prewrap: '',
  sectids: '',
  'section-refsig': 'Section',
  'table-caption': 'Table',
  'tip-caption': 'Tip',
  'toc-placement': 'auto',
  'toc-title': 'Table of Contents',
  'untitled-label': 'Untitled',
  'version-label': 'Version',
  'warning-caption': 'Warning',
};

const SAFE_MODES = { unsafe: 0, safe: 1, server: 10, secure: 20 };
const DEFAULT_EXTENSIONS = { html: '.html', docbook: '.xml', pdf: '.pdf', epub: '.epub', manpage: '.man', asciidoc: '.adoc' };
const BACKEND_ALIASES = { html: 'html5', docbook: 'docbook5' };

export function safeModeLevel(safe) {
  if (typeof safe === 'number') return safe;
  return SAFE_MODES[safe ?? 'secure'];
}

export function backendTraits(backend) {
  const basebackend = backend.replace(/\d+$/, '');
  let outfilesuffix = DEFAULT_EXTENSIONS[basebackend];
  let filetype;
  if (outfilesuffix) filetype = outfilesuffix.slice(1);
  else {
    filetype = basebackend;
    outfilesuffix = `.${filetype}`;
  }
  return { basebackend, filetype, outfilesuffix };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateAttributes(now) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const offset = -now.getTimezoneOffset();
  const tz = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${tz}`;
  const year = String(now.getFullYear());
  return {
    localdate: date,
    localyear: year,
    localtime: time,
    localdatetime: `${date} ${time}`,
    docdate: date,
    docyear: year,
    doctime: time,
    docdatetime: `${date} ${time}`,
  };
}

// Returns a seed for AttributeState: { name: value } for locked entries,
// { name: { value, soft: true } } for overridable defaults, and
// { name: null } for locked-absent ones.
export function intrinsicAttributes({
  backend = 'html5',
  doctype = 'article',
  safe = 'secure',
  standalone = false,
  docdir = process.cwd(),
  userHome = process.env.HOME ?? '.',
  version = '4.0.7',
  now = new Date(),
} = {}) {
  const soft = (value) => ({ value, soft: true });
  const seed = {};
  for (const [k, v] of Object.entries(DEFAULT_ATTRIBUTES)) seed[k] = soft(v);

  const level = safeModeLevel(safe);
  const safeName = Object.keys(SAFE_MODES).find((k) => SAFE_MODES[k] === level);

  // processor-owned, locked
  seed.asciidoctor = '';
  seed['asciidoctor-version'] = version;
  seed['safe-mode-name'] = safeName;
  seed[`safe-mode-${safeName}`] = '';
  seed['safe-mode-level'] = String(level);
  seed['max-include-depth'] = '64';
  seed['allow-uri-read'] = null;
  seed.docdir = level >= SAFE_MODES.server ? '' : docdir;
  seed['user-home'] = level >= SAFE_MODES.server ? '.' : userHome;
  if (!standalone) {
    seed.embedded = '';
    seed.notitle = soft('');
  }

  const realBackend = BACKEND_ALIASES[backend] ?? backend;
  const traits = backendTraits(realBackend);
  Object.assign(seed, {
    doctype: soft(doctype),
    [`doctype-${doctype}`]: soft(''),
    backend: soft(realBackend),
    [`backend-${realBackend}`]: soft(''),
    [`backend-${realBackend}-doctype-${doctype}`]: soft(''),
    basebackend: soft(traits.basebackend),
    [`basebackend-${traits.basebackend}`]: soft(''),
    [`basebackend-${traits.basebackend}-doctype-${doctype}`]: soft(''),
    filetype: soft(traits.filetype),
    [`filetype-${traits.filetype}`]: soft(''),
    outfilesuffix: soft(traits.outfilesuffix),
    stylesdir: soft('.'),
    iconsdir: soft('./images/icons'),
  });
  if (traits.filetype === 'html') seed.htmlsyntax = soft('html');
  for (const [k, v] of Object.entries(dateAttributes(now))) seed[k] = soft(v);
  return seed;
}

// Within the document header, setting `doctype` or `backend` also
// rewrites the attributes derived from them (doctype-book,
// backend-html5-doctype-book, basebackend-html, ...), as Asciidoctor's
// Document#update_doctype_attributes / #update_backend_attributes do.
// Past the header, Asciidoctor only updates the attribute itself; so does
// the transducer. Returns true if `name` was handled here.
export function applyDerivedHeaderAttribute(name, value, state) {
  if (name === 'doctype') {
    const current = state.get('doctype');
    if (!value || value === current) return true;
    if (!state.set('doctype', value)) return true;
    const backend = state.get('backend');
    const basebackend = state.get('basebackend');
    if (current) {
      state.unset(`doctype-${current}`);
      if (backend) state.unset(`backend-${backend}-doctype-${current}`);
      if (basebackend) state.unset(`basebackend-${basebackend}-doctype-${current}`);
    }
    if (backend) state.set(`backend-${backend}-doctype-${value}`, '');
    if (basebackend) state.set(`basebackend-${basebackend}-doctype-${value}`, '');
    state.set(`doctype-${value}`, '');
    return true;
  }
  if (name === 'backend') {
    const next = BACKEND_ALIASES[value] ?? value;
    const current = state.get('backend');
    if (!next || next === current) return true;
    if (!state.set('backend', next)) return true;
    const doctype = state.get('doctype');
    if (current) {
      state.unset(`backend-${current}`);
      if (doctype) state.unset(`backend-${current}-doctype-${doctype}`);
    }
    if (doctype) state.set(`backend-${next}-doctype-${doctype}`, '');
    state.set(`backend-${next}`, '');
    const traits = backendTraits(next);
    const currentFiletype = state.get('filetype');
    if (currentFiletype) state.unset(`filetype-${currentFiletype}`);
    state.set('filetype', traits.filetype);
    state.set(`filetype-${traits.filetype}`, '');
    state.set('outfilesuffix', traits.outfilesuffix);
    const currentBase = state.get('basebackend');
    if (traits.basebackend !== currentBase) {
      if (currentBase) {
        state.unset(`basebackend-${currentBase}`);
        if (doctype) state.unset(`basebackend-${currentBase}-doctype-${doctype}`);
      }
      if (doctype) state.set(`basebackend-${traits.basebackend}-doctype-${doctype}`, '');
      state.set(`basebackend-${traits.basebackend}`, '');
      state.set('basebackend', traits.basebackend);
    }
    return true;
  }
  return false;
}
