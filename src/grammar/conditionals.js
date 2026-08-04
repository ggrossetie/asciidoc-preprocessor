// ifdef / ifndef / ifeval / endif recognition and the conditional stack
// (bounded context of §1). Directive lines remain recognized inside
// opaque regions (§4) and are evaluated against the attribute state
// accumulated so far.

import { evaluateIfeval, IfevalSyntaxError } from './ifeval.js';

const DIRECTIVE_LINE = /^(ifdef|ifndef|ifeval|endif)::([^[\]]*)\[(.*)\]$/;

// Splits a "name1,name2" (OR) or "name1+name2" (AND) target into its
// combinator and the list of names.
function parseNames(target) {
  if (target.includes(',') && target.includes('+')) return null; // mixing combinators is not recognized
  if (target.includes('+')) return { combinator: 'and', names: target.split('+').map((s) => s.trim()) };
  return { combinator: 'or', names: target.split(',').map((s) => s.trim()) };
}

function testDefined(names, combinator, attrState) {
  const tests = names.map((n) => attrState.has(n));
  return combinator === 'and' ? tests.every(Boolean) : tests.some(Boolean);
}

// Parses a directive line without consulting any state. Returns null if
// the line is not directive-shaped.
export function parseDirectiveLine(line) {
  const m = DIRECTIVE_LINE.exec(line);
  if (!m) return null;
  const [, type, target, content] = m;
  return { type, target: target.trim(), content };
}

export class ConditionalStack {
  constructor() {
    this._stack = []; // { active, names, type }
  }

  get suppressed() {
    return this._stack.some((frame) => !frame.active);
  }

  get depth() {
    return this._stack.length;
  }

  // Resets bookkeeping used to detect D2 violations at the end of an
  // include unit, without losing the ambient (possibly suppressed) state
  // inherited from the parent unit.
  markUnitStart() {
    return this._stack.length;
  }

  // Returns diagnostics for D2 ("conditionals MUST be balanced within
  // each include unit") given the depth recorded by markUnitStart().
  checkUnitEnd(startDepth) {
    if (this._stack.length === startDepth) return [];
    return [
      {
        rule: 'D2',
        message: `unbalanced conditional: ${this._stack.length - startDepth} directive(s) opened in this include unit are still open at its end`,
      },
    ];
  }

  // Consumes one directive occurrence. Returns:
  //   { kind: 'block' }                     - ifdef/ifndef/ifeval[] block form, or endif
  //   { kind: 'inline', text }               - ifdef/ifndef[text] single-line form, condition true
  //   { kind: 'inline-drop' }                - single-line form, condition false
  //   { kind: 'error', diagnostics: [...] }  - malformed directive (still consumed; total transducer)
  process(directive, attrState) {
    const { type, target, content } = directive;

    if (type === 'endif') {
      if (this._stack.length === 0) {
        return { kind: 'error', diagnostics: [{ rule: 'D2', message: 'endif with no matching ifdef/ifndef/ifeval' }] };
      }
      const frame = this._stack.pop();
      if (target && !frame.names.includes(target)) {
        return {
          kind: 'error',
          diagnostics: [{ rule: 'D2', message: `endif::${target}[] does not match innermost open conditional (${frame.names.join(',')})` }],
        };
      }
      return { kind: 'block' };
    }

    if (type === 'ifeval') {
      if (target !== '') return { kind: 'error', diagnostics: [{ rule: 'D4', message: 'ifeval:: does not take a target' }] };
      let active;
      try {
        active = evaluateIfeval(attrState.resolveReferences(content));
      } catch (err) {
        if (!(err instanceof IfevalSyntaxError)) throw err;
        return { kind: 'error', diagnostics: [{ rule: 'D4', message: err.message }] };
      }
      this._stack.push({ active, names: [], type });
      return { kind: 'block' };
    }

    // ifdef / ifndef
    const parsed = parseNames(target);
    if (!parsed) {
      return { kind: 'error', diagnostics: [{ rule: 'D4', message: `cannot mix "," and "+" in ${type}::${target}[]` }] };
    }
    const defined = testDefined(parsed.names, parsed.combinator, attrState);
    const holds = type === 'ifdef' ? defined : !defined;

    if (content === '') {
      // block form
      this._stack.push({ active: holds, names: parsed.names, type });
      return { kind: 'block' };
    }
    // single-line form: no stack frame, evaluated (and resolved) immediately
    return holds ? { kind: 'inline', text: attrState.resolveReferences(content) } : { kind: 'inline-drop' };
  }
}
