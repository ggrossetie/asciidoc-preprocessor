# asciidoc-preprocessor

A JavaScript implementation of the **stream-clocked line transducer** model
proposed for the AsciiDoc preprocessor, in response to
[asciidoc-lang#26](https://gitlab.eclipse.org/eclipse/asciidoc-lang/asciidoc-lang/-/work_items/26)
("Proposal to clarify the behavior of the preprocessor").

This is a proof of concept, not a production preprocessor: it exists to show
the model works, to make its conformance rules testable, and to make its
claimed divergence from the reference implementation (Asciidoctor)
falsifiable rather than asserted.

## The model, in one paragraph

The preprocessor is specified as an independent stage. It consumes the
source line stream and emits a new line stream plus a provenance map (output
line → source file and line). The block grammar consumes that output as
ordinary input. The stage maintains its own attribute state and never
consults the parser — no information flows from block processing back into
it. Because it is a pure function of the source files and the initial
attributes, an implementation may still run it lazily, fused with parsing;
the result is observationally identical. Just-in-time is an implementation
strategy, not the semantics — unlike the reference implementation, where
directive evaluation timing is a function of the parser's look-ahead
distance (see "Findings" below).


## Layout

```
src/
  attribute-state.js        the attribute state (§2): name -> {value, locked}
  intrinsic-attributes.js   seed state a processor supplies (backend-*, doctype-*, safe-mode-*, ...)
  transducer.js             the orchestrator: single left-to-right pass, provenance, diagnostics
  grammar/
    attr-entry.js           attr-entry line grammar + value-continuation folding (§3)
    header.js               doctitle / author / revision mini-grammar (§2)
    delimiters.js           open-delimiter stack, opaque regions (§4)
    conditionals.js         ifdef / ifndef / ifeval / endif, the conditional stack
    ifeval.js               the ifeval comparison grammar (as in Asciidoctor)
    include.js              include::target[attrlist], lines= / tag(s)= / indent=
compare/
  cases.js                  the comparison corpus (one observable behavior per case)
  harness.js                runs a case through Asciidoctor and through transducer + Asciidoctor
  report.js                 generates compare/REPORT.md
  REPORT.md                 generated: every case, side by side
test/
  unit/                     one file per grammar rule / module
  comparison/               the Appendix A examples + the whole corpus against real Asciidoctor.js
COMPARISON.md               analysis of every difference with Asciidoctor
```

## Output contract

`transduce(input, options)` returns `{ lines, text, provenance, attributes,
diagnostics }`. Attribute entry lines (and their continuation lines) stay in
the output: the parser consumes them too and keeps its own document
attribute state (§5). Directive lines never reach the output; the
single-line form `ifdef::x[text]` is *replaced* by `text`, which is then
processed like any other line (it may be an include or an attribute entry,
as in Asciidoctor). Escaped directives (`\ifdef::…`, `\include::…`) are
emitted without their backslash.

Options: `attributes` (seed state; a plain value is locked, `{ value, soft:
true }` is soft, `null` is a locked unset — see `intrinsicAttributes()` for
the attributes Asciidoctor seeds), `safe` (`unsafe` by default, `safe`,
`server`, `secure`), `baseDir`, and `readInclude(target, fromFile, attrs)`
to resolve include targets (the include-processor extension point).

## The attribute-entry grammar

```abnf
attr-entry = ":" ( name / "!" name / name "!" ) ":" [ sp value ]
name       = word-char *( word-char / "-" )
word-char  = ALPHA / DIGIT / "_"
sp         = 1*( SP / HTAB )
value      = <rest of line; may wrap>
```

Values may wrap across lines with the soft (`SP \`), hard (`SP + SP \`),
and legacy (`SP +`) markers, with Asciidoctor's folding rules: each
continuation line must repeat the first line's marker to keep the value
open, a hard wrap joins with a newline and keeps the `+`, and an empty line
ends the value. `pass:[…]` values are unwrapped.

Attribute references (`{name}`) in the value resolve eagerly, at
recognition time, against the state as it exists at that point in the
stream — snapshot semantics. Escaped references (`\{name}`) and the
character-replacement references (`{sp}`, `{nbsp}`, …) behave as in
Asciidoctor; `{set:…}` and `{counter:…}` are parser-side and left alone.

## Opaque regions

`DelimiterStack` tracks verbatim (`----`, `....`, and fenced ```` ``` ````),
passthrough (`++++`), comment (`////`), and table (`|===`, `,===`, `:===`,
`!===`, any number of `=` ≥ 3) delimiter lines. Inside an open region,
lines are not scanned for attribute entries — but directives
(`ifdef`/`ifndef`/`ifeval`/`include`) remain recognized and still resolve
against the state from before the region. **Opacity is a write barrier, not
a read barrier.** Comment regions are the exception: they are **inert**
(a read barrier too). No directive is evaluated inside `////` and its lines
are emitted verbatim, as Asciidoctor does, and so that a parser keeping
comments in its ASG sees the text as written (case D9).

Passthrough opacity, left open by the proposal (Appendix C), is settled
here by observation: Asciidoctor never treats an entry-shaped line inside
`++++` as an entry (corpus case B3).

Table opacity is not an approximation: an attribute entry inside an
AsciiDoc table cell (`a|`) is scoped to the cell's own nested document and
never reaches the document-level attribute state (case A9).

## Conditionals

The conditional stack reproduces Asciidoctor's `PreprocessorReader`
exactly — block and single-line forms, `,` (OR) / `+` (AND) combinators
(the first delimiter decides), `endif::target[]` matched against the full
target, a mismatched `endif` reported without popping, malformed directives
reported and dropped. What differs is only *when* the stack runs:
stream-clocked here, parser-clocked there.

`ifeval::[expr]` implements Asciidoctor's comparison grammar, not a subset
of it: Asciidoctor does **not** evaluate Ruby (an earlier version of this
README said so; that was wrong). Operands are typed exactly as
`resolve_expr_val` does — quoted strings, `true`/`false`, empty as nil,
integers and floats with Ruby's `to_i`/`to_f` — and incompatible
comparisons are false (see [`ifeval.js`](src/grammar/ifeval.js)). On two
corner cases Asciidoctor.js itself departs from Ruby Asciidoctor; the
transducer follows Ruby (cases E2, E3).

## Includes

`lines=`, `tag=`/`tags=` (with `*`, `**`, `!`), `indent=`, `leveloffset=`,
`opts=optional`, attribute references in the target and attribute list,
`attribute-missing` handling, `max-include-depth`, safe modes (path jail in
`safe`, links in `secure`), URI gating by `allow-uri-read`, and
non-AsciiDoc content (not preprocessed, by file extension) all follow
Asciidoctor. Provenance is exact per line, including inside a `lines=` or
`tags=` selection.

## Document conformance (§6)

| Rule | What it requires                                                  | Status here                                                                                                                      |
|------|-------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| D1   | Entry-shaped lines outside opaque regions sit at a block boundary | out of scope — requires the block model, which this project deliberately does not have                                           |
| D2   | Conditionals balanced & nested within each include unit           | **diagnosed**, lexically, at end of unit (`ConditionalStack.checkUnitEnd`)                                                       |
| D3   | Each include unit leaves the delimiter stack as it found it       | **diagnosed**, lexically, at end of unit, in both directions (left open / closed what it did not open)                          |
| D4   | Directives rely only on transducer-reachable attributes           | satisfied by construction (directives only ever consult `AttributeState`) — no parser-set attributes exist for them to leak from |
| D5   | Includes outside opaque regions sit at a block boundary           | out of scope — requires the block model                                                                                          |

For a document violating none of these, the guarantee is: deterministic,
portable output; agreement between the transducer's state and any
(hypothetical) document-level state at every directive line; and per-file
compositionality. For a violating document, the transducer still produces
output (it is total) — the guarantee is simply void, matching §6.

## Remaining scope reductions

- **Setext doctitle** (`Title` underlined with `=`): needs one line of
  look-ahead, which §1 excludes (case F5).
- **Attribute value substitutions**: Asciidoctor applies the header
  substitutions (special characters + attributes) to every entry value;
  the transducer, per §3, only resolves attribute references (cases C2,
  C3, F6).
- **Lenient attribute names**: Asciidoctor accepts `:First Name:` and
  sanitizes it to `firstname`; the spec grammar does not (case C1).
- **Include `depth=` and `encoding=`**, URI fetching (delegated to
  `readInclude`), and `max-attribute-value-size` are not implemented.

## Findings

[COMPARISON.md](COMPARISON.md) lists every difference with Asciidoctor,
with examples, and weighs the advantages and drawbacks of each.
[compare/REPORT.md](compare/REPORT.md) is the raw, generated evidence: 81
cases run through Asciidoctor.js 4.0.7 and Asciidoctor (Ruby) 2.0.20 and
through the transducer + the same parser. The rendered output is identical
in 60 cases against Ruby Asciidoctor (58 against Asciidoctor.js, which
departs from Ruby in two `ifeval` corner cases); every case that differs
is one of the departures analyzed in COMPARISON.md.

The point is not that Asciidoctor is "buggy" — the proposal argues
(Appendix A.2) that the parser is behaving consistently on the stream it
received; the defect is *when* the conditional was evaluated, which is
exactly what the stream-clocked model pins down.

## Running the tests

```console
npm install
npm test                # everything
npm run test:unit       # grammar/module-level tests only, no Asciidoctor dependency
npm run test:comparison # the Appendix A examples + the corpus against real Asciidoctor.js
npm run compare         # regenerate compare/REPORT.md (adds a Ruby column if the gem is installed)
```
