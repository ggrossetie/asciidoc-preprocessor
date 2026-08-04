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
  attribute-state.js       the attribute state (§2): name -> {value, locked}
  transducer.js             the orchestrator: single left-to-right pass, provenance, diagnostics
  grammar/
    attr-entry.js            attr-entry line grammar + value-continuation folding (§3)
    header.js                 doctitle / author / revision mini-grammar (§2)
    delimiters.js             open-delimiter stack, opaque regions (§4)
    conditionals.js           ifdef / ifndef / ifeval / endif, the conditional stack
    ifeval.js                 minimal safe comparison-expression evaluator
    include.js                include::target[attrlist] recognition
test/
  unit/                      one file per grammar rule / module
  comparison/                the same reproducible examples run against real Asciidoctor.js
```

## The attribute-entry grammar

```abnf
attr-entry = ":" ( name / "!" name / name "!" ) ":" [ sp value ]
name       = word-char *( word-char / "-" )
word-char  = ALPHA / DIGIT / "_"
sp         = 1*( SP / HTAB )
value      = <rest of line; may wrap>
```

Values may wrap across lines with the soft (`SP \`) and hard (`SP + SP \`)
wrap markers. Soft-wrap folding joins with a single space; hard-wrap folding
retains the `+` in the value and joins with a newline (so that, once
substituted into body text, it reproduces AsciiDoc's own hard-line-break
syntax). Both are decided by a bounded value-continuation flag, so folding
stays lexical (§1).

Attribute references (`{name}`) in the value resolve eagerly, at
recognition time, against the state as it exists at that point in the
stream — snapshot semantics, verified in
[`attribute-state.test.js`](test/unit/attribute-state.test.js).

## Opaque regions

`DelimiterStack` tracks verbatim (`----`, `....`), comment (`////`), and
table (`|===`, `,===`, `:===`, `!===`) delimiter lines. Inside an open
region, lines are not scanned for attribute entries — but directives
(`ifdef`/`ifndef`/`ifeval`/`include`) remain recognized and still resolve
against the state from before the region. **Opacity is a write barrier, not
a read barrier.** This is why an `include::` inside a listing block (a
common pattern for pulling tagged snippets into example code) keeps
working, while a `:name: value`-shaped line of *displayed* code inside that
same listing does not pollute the document's attributes.

Table opacity is not an approximation: an attribute entry inside an
AsciiDoc table cell (`a|`) is scoped to the cell's own nested document and
never reaches the document-level attribute state — true in Asciidoctor
today (see `test/comparison`), and reproduced here by construction. The
transducer needs no notion of cells, or of blocks within cells, to get this
right.

## Conditionals

`ifdef`/`ifndef` support both the block form (`ifdef::name[]` … `endif::[]`)
and the single-line form (`ifdef::name[Text]`, no `endif` needed — text is
emitted verbatim if the condition holds, the whole line vanishes
otherwise). Names may be combined with `,` (OR — any defined/undefined) or
`+` (AND — all defined/undefined).

`ifeval::[expr]` is always block form. **Scope reduction:** Asciidoctor
evaluates the bracket content as an arbitrary Ruby expression; this
transducer instead implements a small closed comparison grammar
(`operand ("==")|("!=")|("<")|("<=")|(">")|(">=") operand`, numeric if both
operands parse as numbers, string otherwise — see
[`ifeval.js`](src/grammar/ifeval.js)). This is a deliberate scope reduction
in service of the model's core claim (lexical, specifiable, no arbitrary
code execution as part of a language grammar), not an oversight.

## Document conformance (§6)

| Rule | What it requires                                                  | Status here                                                                                                                      |
|------|-------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| D1   | Entry-shaped lines outside opaque regions sit at a block boundary | out of scope — requires the block model, which this project deliberately does not have                                           |
| D2   | Conditionals balanced & nested within each include unit           | **diagnosed**, lexically, at end of unit (`ConditionalStack.checkUnitEnd`)                                                       |
| D3   | Each include unit leaves the delimiter stack as it found it       | **diagnosed**, lexically, at end of unit (`DelimiterStack.checkUnitEnd`)                                                         |
| D4   | Directives rely only on transducer-reachable attributes           | satisfied by construction (directives only ever consult `AttributeState`) — no parser-set attributes exist for them to leak from |
| D5   | Includes outside opaque regions sit at a block boundary           | out of scope — requires the block model                                                                                          |

For a document violating none of these, the guarantee is: deterministic,
portable output; agreement between the transducer's state and any
(hypothetical) document-level state at every directive line; and per-file
compositionality. For a violating document, the transducer still produces
output (it is total) — the guarantee is simply void, matching §6.

## Other deliberate scope reductions

- **Include filtering** (`lines=`, `tag(s)=`) is not implemented — an
  `include::` always contributes the full referenced unit. This is
  parser-orthogonal content selection, not part of what the model is
  arguing for.
- **The header mini-grammar** (doctitle/author/revision) is a reduced
  subset: single author, no `;`-separated author list, a simplified
  revision-line pattern. It exists to demonstrate that header recognition
  is lexical (decidable by line shape + position), not to claim full
  compatibility with Asciidoctor's author/revision parsing.
- **Passthrough (`++++`) opacity** is left open, as it is in the proposal
  itself (Appendix C).

## Findings: running the same examples against real Asciidoctor.js

`test/comparison/asciidoctor-divergence.test.js` runs the proposal's own
reproducible examples (Appendix A) through both this transducer and the
`asciidoctor` npm package (Asciidoctor.js, core 2.0.26 as of this writing),
and asserts on the actual observed behavior of each — not a description of
it. Summary:

| Example                                                             | Asciidoctor (parser-clocked)                                                                                                                                                          | This transducer (stream-clocked)                                                                    |
|---------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `:flag: yes` + `ifdef::flag[...]` inside a list's look-ahead buffer | both conditionals **silently dropped**; `{flag}` still substitutes to `yes` elsewhere — the same attribute is simultaneously defined and undefined, depending which layer consults it | both conditionals **kept**, consistently, because the entry precedes them in the stream             |
| the identical `:flag:`/`ifdef` pair outside a list                  | works                                                                                                                                                                                 | works (no special case needed — there was never a list to begin with)                               |
| attribute entry inside an AsciiDoc table cell (`a\|`)               | never reaches document-level state; a directive in the table still reads pre-table state; the cell's own `{ref}` resolves via nested-document parsing                                 | identical outcome, reproduced by the opaque-region write barrier (§4) — no notion of cells required |
| a conforming document with no list/table involved                   | agrees                                                                                                                                                                                | agrees                                                                                              |

Run it yourself:

```console
npm run test:comparison
```

The point of these tests is not that Asciidoctor is "buggy" — the proposal
argues (Appendix A.2) that the parser is behaving consistently on the
stream it received; the defect is *when* the conditional was evaluated,
which is exactly what the stream-clocked model pins down.

## Running the tests

```console
npm install
npm test              # everything
npm run test:unit       # grammar/module-level tests only, no Asciidoctor dependency
npm run test:comparison # the Appendix A examples against real Asciidoctor.js
```
