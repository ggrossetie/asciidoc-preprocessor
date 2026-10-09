// ifdef / ifndef / ifeval / endif recognition and the conditional stack
// (bounded context of §1). Directive lines remain recognized inside
// opaque regions (§4) and are evaluated against the attribute state
// accumulated so far.
//
// The stack discipline reproduces Asciidoctor's PreprocessorReader
// (#preprocess_conditional_directive) exactly; what differs is only *when*
// it runs (stream-clocked here, parser-clocked there).

import { evaluateIfeval, isIfevalExpression, IfevalSyntaxError } from './ifeval.js';

// Same shape as Asciidoctor's ConditionalDirectiveRx: an optional escaping
// backslash, a target without spaces whose first "," or "+" decides the
// combinator, and a non-empty optional bracket content.
const DIRECTIVE_LINE = /^(\\)?(ifdef|ifndef|ifeval|endif)::(\S*?(?:([,+])\S*?)?)\[(.+)?\]$/;

// Parses a directive line without consulting any state. Returns null if
// the line is not directive-shaped.
export function parseDirectiveLine(line) {
  const m = DIRECTIVE_LINE.exec(line);
  if (!m) return null;
  const [, escaped, type, target, delimiter, content] = m;
  return { escaped: Boolean(escaped), type, target, delimiter: delimiter ?? null, content: content ?? '' };
}

function testDefined(target, delimiter, attrState) {
  if (delimiter === ',') return target.split(',').some((n) => attrState.has(n));
  if (delimiter === '+') return target.split('+').every((n) => attrState.has(n));
  return attrState.has(target);
}

const directiveText = ({ type, target, content }) => `${type}::${target}[${content}]`;

export class ConditionalStack {
  constructor() {
    this._stack = []; // { type, target, expr, skip, skipping }
    this._skipping = false;
  }

  get suppressed() {
    return this._skipping;
  }

  get depth() {
    return this._stack.length;
  }

  // Records the depth at the start of an include unit, without losing the
  // ambient (possibly suppressed) state inherited from the parent unit.
  markUnitStart() {
    return this._stack.length;
  }

  // Returns diagnostics for D2 ("conditionals MUST be balanced within
  // each include unit") given the depth recorded by markUnitStart().
  // Asciidoctor itself only reports conditionals still open at the end of
  // the whole document ("detected unterminated preprocessor conditional
  // directive"); a conditional spanning include units is legal there.
  checkUnitEnd(startDepth) {
    if (this._stack.length <= startDepth) return [];
    return [
      {
        rule: 'D2',
        severity: 'warning',
        message: `unbalanced conditional: ${this._stack.length - startDepth} directive(s) opened in this include unit are still open at its end`,
      },
    ];
  }

  // Asciidoctor-compatible end-of-document report.
  checkDocumentEnd() {
    return this._stack.map((f) => ({
      rule: 'unterminated-conditional',
      severity: 'error',
      message: `detected unterminated preprocessor conditional directive: ${f.type}::${f.target ?? ''}[${f.expr ?? ''}]`,
    }));
  }

  // Consumes one (unescaped) directive occurrence. Returns:
  //   { kind: 'consumed' }                   - the directive line produces no output
  //   { kind: 'inline', text }               - single-line form, condition true: the
  //                                            line is *replaced* by text, which the
  //                                            caller feeds back into the stream
  //   { kind: 'error', diagnostics: [...] }  - malformed / unmatched directive (still
  //                                            consumed; the transducer is total)
  process(directive, attrState) {
    const { type, content } = directive;
    const noTarget = directive.target === '';
    const target = directive.target.toLowerCase();

    if (type === 'endif') {
      if (content) return error('directive', `malformed preprocessor directive - text not permitted: ${directiveText(directive)}`);
      if (this._stack.length === 0) return error('D2', `unmatched preprocessor directive: endif::${target}[]`);
      const top = this._stack[this._stack.length - 1];
      if (!noTarget && target !== top.target) {
        // Asciidoctor does not pop on a mismatch: the open conditional stays open.
        return error('D2', `mismatched preprocessor directive: endif::${target}[], expected endif::${top.target ?? ''}[]`);
      }
      this._stack.pop();
      this._skipping = this._stack.length === 0 ? false : this._stack[this._stack.length - 1].skipping;
      return { kind: 'consumed' };
    }

    let skip;
    if (this._skipping) {
      // Inside a false branch only nesting is tracked; nothing is evaluated.
      if (type === 'ifeval') {
        if (!(noTarget && content && isIfevalExpression(content))) return { kind: 'consumed' };
      } else if (noTarget) {
        return { kind: 'consumed' };
      }
      skip = false;
    } else if (type === 'ifeval') {
      if (!noTarget) return error('directive', `malformed preprocessor directive - target not permitted: ${directiveText(directive)}`);
      if (!content) return error('directive', 'malformed preprocessor directive - missing expression: ifeval::[]');
      try {
        skip = !evaluateIfeval(content, attrState);
      } catch (err) {
        if (!(err instanceof IfevalSyntaxError)) throw err;
        return error('directive', err.message);
      }
    } else {
      if (noTarget) return error('directive', `malformed preprocessor directive - missing target: ${type}::[${content}]`);
      const defined = testDefined(target, directive.delimiter, attrState);
      skip = type === 'ifdef' ? !defined : defined;
    }

    if (type === 'ifeval') {
      if (skip) this._skipping = true;
      this._stack.push({ type, target: null, expr: content, skip, skipping: this._skipping });
      return { kind: 'consumed' };
    }
    if (content) {
      // Single-line form: no frame; the text replaces the directive line.
      return !this._skipping && !skip ? { kind: 'inline', text: content.trimEnd() } : { kind: 'consumed' };
    }
    if (skip) this._skipping = true;
    this._stack.push({ type, target, expr: null, skip, skipping: this._skipping });
    return { kind: 'consumed' };
  }
}

function error(rule, message) {
  return { kind: 'error', diagnostics: [{ rule, severity: 'error', message }] };
}
