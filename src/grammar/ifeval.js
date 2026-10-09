// The ifeval::[] expression evaluator.
//
// Contrary to a widespread belief (and to an earlier version of this
// README), Asciidoctor does *not* evaluate the bracket content as Ruby. It
// implements a closed binary-comparison grammar (Asciidoctor's
// EvalExpressionRx + PreprocessorReader#resolve_expr_val), reproduced
// here exactly:
//
//   ifeval-expr = operand *SP op *SP operand
//   op          = "==" / "!=" / "<=" / ">=" / "<" / ">"
//
// Each operand first has its attribute references resolved (missing
// references are dropped), then is typed:
//
//   "..." / '...'      -> string (quotes removed)
//   empty              -> nil
//   true / false       -> boolean
//   whitespace only    -> " "
//   contains "."       -> float  (Ruby String#to_f: leading numeric prefix, else 0.0)
//   anything else      -> integer (Ruby String#to_i: leading numeric prefix, else 0)
//
// So `"5" < "10"` compares *strings* (false) while `5 < 10` compares
// integers (true), and an unquoted word like `yes` is the integer 0.
// Comparing incompatible types (e.g. 1 < "a", nil > 1) raises in Ruby;
// Asciidoctor rescues the error and treats the condition as false.

const EXPR = /^(.+?) *([=!><]=|[><]) *(.+)$/;

export class IfevalSyntaxError extends Error {}

class IncomparableError extends Error {}

const RUBY_INT_PREFIX = /^\s*([+-]?\d+(?:_\d+)*)/;
const RUBY_FLOAT_PREFIX = /^\s*([+-]?(?:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?)/;

function rubyToI(s) {
  const m = RUBY_INT_PREFIX.exec(s);
  return m ? parseInt(m[1].replaceAll('_', ''), 10) : 0;
}

function rubyToF(s) {
  const m = RUBY_FLOAT_PREFIX.exec(s);
  return m ? parseFloat(m[1].replaceAll('_', '')) : 0;
}

export function resolveOperand(raw, attrState) {
  let val = raw;
  let quoted = false;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    quoted = true;
    val = val.slice(1, -1);
  }
  if (val.includes('{')) val = attrState.substitute(val, 'drop').text;
  if (quoted) return val;
  if (val === '') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val.trimEnd() === '') return ' ';
  return val.includes('.') ? rubyToF(val) : rubyToI(val);
}

function kind(v) {
  if (v === null) return 'nil';
  if (typeof v === 'number') return 'number';
  return typeof v; // 'string' | 'boolean'
}

// Ruby comparison semantics: == / != never raise (values of different
// classes are simply unequal); ordering operators require both operands
// to be numbers or both strings.
function compare(lhs, op, rhs) {
  if (op === '==') return lhs === rhs;
  if (op === '!=') return lhs !== rhs;
  const k = kind(lhs);
  if (k !== kind(rhs) || (k !== 'number' && k !== 'string')) throw new IncomparableError();
  switch (op) {
    case '<':
      return lhs < rhs;
    case '<=':
      return lhs <= rhs;
    case '>':
      return lhs > rhs;
    case '>=':
      return lhs >= rhs;
  }
  throw new IncomparableError();
}

// Returns whether the condition holds. Throws IfevalSyntaxError if the
// text is not a comparison expression (Asciidoctor: "malformed
// preprocessor directive - invalid expression").
export function evaluateIfeval(text, attrState) {
  const m = EXPR.exec(text.trim());
  if (!m) throw new IfevalSyntaxError(`malformed preprocessor directive - invalid expression: ifeval::[${text}]`);
  const [, rawLeft, op, rawRight] = m;
  try {
    return compare(resolveOperand(rawLeft, attrState), op, resolveOperand(rawRight, attrState));
  } catch (err) {
    if (err instanceof IncomparableError) return false;
    throw err;
  }
}

export function isIfevalExpression(text) {
  return EXPR.test(text.trim());
}
