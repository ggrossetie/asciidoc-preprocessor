// Side-by-side harness: runs one comparison case through
//
//   1. Asciidoctor.js                  (parser-clocked preprocessor, the JS reference)
//   2. Asciidoctor (Ruby), if installed (parser-clocked preprocessor, the historical reference)
//   3. the transducer, whose output is then parsed by the same Asciidoctor
//      (stream-clocked preprocessor + an ordinary parser over its output)
//
// and reports, for each, the rendered text and the log messages. Running
// the *same* parser in (1) and (3) isolates the one thing that differs:
// the preprocessing model.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import * as asciidoctor from 'asciidoctor';

import { transduce } from '../src/transducer.js';
import { intrinsicAttributes } from '../src/intrinsic-attributes.js';

// Transducer output is final: any directive-shaped line in it is content
// (it came from an escaped directive, a non-AsciiDoc include, ...). It is
// re-escaped so that the downstream parser's own reader leaves it alone.
const DIRECTIVE_SHAPED = /^(?:ifdef|ifndef|ifeval|endif)::\S*\[.*\]$|^include::[^\s[].*\[.*\]$/;

// Ruby Asciidoctor is driven through its API (not its CLI: under `npm run`,
// node_modules/.bin/asciidoctor — the JS CLI — shadows the gem's).
const RUBY_DRIVER = `
require 'asciidoctor'
require 'json'
o = JSON.parse(ENV['ADOC_OPTS'])
if o['version']
  puts "Asciidoctor (Ruby) #{Asciidoctor::VERSION}"
  exit
end
logger = Asciidoctor::MemoryLogger.new
Asciidoctor::LoggerManager.logger = logger
html = Asciidoctor.convert($stdin.read, safe: o['safe'].to_sym, base_dir: o['dir'], attributes: o['attributes'], standalone: false)
messages = logger.messages.map do |m|
  msg = m[:message]
  text, loc = msg.is_a?(Hash) ? [msg[:text], msg[:source_location]] : [msg.to_s, nil]
  loc = loc ? " (#{loc})" : ''
  "#{m[:severity]}: #{text}#{loc}"
end
puts JSON.generate({ html: html, messages: messages })
`;

let rubyAvailable;
export function hasRubyAsciidoctor() {
  if (rubyAvailable === undefined) {
    const r = spawnSync('ruby', ['-e', RUBY_DRIVER], { encoding: 'utf8', env: { ...process.env, ADOC_OPTS: '{"version":true}' } });
    rubyAvailable = r.status === 0 ? r.stdout.trim() : null;
  }
  return rubyAvailable;
}

function materialize(c) {
  const dir = mkdtempSync(join(tmpdir(), 'adoc-cmp-'));
  for (const [name, content] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return { dir };
}

// API attributes -> transducer seed ("value@" is a soft set, null an unset).
function toSeed(attrs = {}) {
  const seed = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'string' && v.endsWith('@')) seed[k] = { value: v.slice(0, -1), soft: true };
    else seed[k] = v;
  }
  return seed;
}

async function runJs(text, { dir, safe, attributes }) {
  const logger = new asciidoctor.MemoryLogger();
  const html = await asciidoctor.convert(text, { safe, base_dir: dir, attributes: { ...attributes }, logger });
  const messages = logger.getMessages().map((m) => {
    const loc = m.getSourceLocation?.();
    return `${m.getSeverity()}: ${m.getText()}${loc ? ` (${loc})` : ''}`;
  });
  return { html, messages };
}

function runRuby(text, { dir, safe, attributes }) {
  const r = spawnSync('ruby', ['-e', RUBY_DRIVER], {
    input: text,
    encoding: 'utf8',
    env: { ...process.env, ADOC_OPTS: JSON.stringify({ dir, safe, attributes }) },
  });
  if (r.status !== 0) throw new Error(`ruby asciidoctor failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Rendered text: tags removed, entities decoded, whitespace normalized —
// what a reader of the output actually sees.
export function renderedText(html) {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;/g, '’')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export async function runCase(c, { ruby = false } = {}) {
  const { dir } = materialize(c);
  const safe = c.safe ?? 'unsafe';
  const attributes = c.attributes ?? {};
  const ctx = { dir, safe, attributes };

  // The main document is passed as a string (as Asciidoctor receives it
  // here: <stdin>, with base_dir as the include root).
  const t = transduce(
    c.src,
    { baseDir: dir, safe, attributes: { ...intrinsicAttributes({ safe, docdir: dir }), ...toSeed(attributes) } },
  );
  const transducedSource = t.lines.map((l) => (DIRECTIVE_SHAPED.test(l) ? `\\${l}` : l)).join('\n');

  const clean = (r) => ({ ...r, messages: r.messages.map((m) => m.replaceAll(`${dir}/`, '')) });
  const js = clean(await runJs(c.src, ctx));
  const pipelineJs = clean(await runJs(transducedSource, ctx));
  const result = {
    transducer: {
      lines: t.lines,
      diagnostics: t.diagnostics.map((d) => `${d.severity ?? 'error'}: [${d.rule}] ${d.message}${d.line ? ` (${d.file.replace(dir + '/', '')}:${d.line})` : ''}`),
      provenance: t.provenance.map((p) => ({ ...p, file: p.file.replace(dir + '/', '') })),
    },
    js: { text: renderedText(js.html), messages: js.messages },
    pipelineJs: { text: renderedText(pipelineJs.html), messages: pipelineJs.messages },
  };
  result.verdictJs = result.js.text === result.pipelineJs.text ? 'same' : 'different';

  if (ruby && hasRubyAsciidoctor()) {
    const rb = clean(runRuby(c.src, ctx));
    const pipelineRb = clean(runRuby(transducedSource, ctx));
    result.ruby = { text: renderedText(rb.html), messages: rb.messages };
    result.pipelineRuby = { text: renderedText(pipelineRb.html), messages: pipelineRb.messages };
    result.verdictRuby = result.ruby.text === result.pipelineRuby.text ? 'same' : 'different';
    result.rubyVsJs = result.ruby.text === result.js.text ? 'same' : 'different';
  }
  return result;
}
