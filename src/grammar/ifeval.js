// A minimal, safe evaluator for ifeval::[] expressions.
//
// Asciidoctor's ifeval evaluates the bracket content as a Ruby expression
// (arbitrary code execution by design). That is incompatible with a
// lexical, independently-specifiable stage, so this transducer instead
// implements a small closed comparison grammar:
//
//   ifeval-expr = operand ws op ws operand
//   operand     = quoted-string / bare-token
//   op          = "==" / "!=" / "<=" / ">=" / "<" / ">"
//
// Operands that both parse as numbers compare numerically; otherwise they
// compare as strings. This is a deliberate scope reduction, not an
// oversight — see README "Differences from Asciidoctor".

const EXPR = /^\s*(".*?"|'.*?'|\S+)\s*(==|!=|<=|>=|<|>)\s*(".*?"|'.*?'|\S+)\s*$/;

function unquote(token) {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

export class IfevalSyntaxError extends Error {}

// expr should already have attribute references resolved (D4: operands
// resolve against the preprocessor attribute state).
export function evaluateIfeval(expr) {
  const m = EXPR.exec(expr);
  if (!m) throw new IfevalSyntaxError(`unsupported ifeval expression: ${JSON.stringify(expr)}`);
  const [, rawLeft, op, rawRight] = m;
  const left = unquote(rawLeft);
  const right = unquote(rawRight);

  const leftNum = Number(left);
  const rightNum = Number(right);
  const numeric = left.trim() !== '' && right.trim() !== '' && !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
  const a = numeric ? leftNum : left;
  const b = numeric ? rightNum : right;

  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      throw new IfevalSyntaxError(`unsupported operator: ${op}`);
  }
}
