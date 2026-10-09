# AsciiDoc Preprocessor: Lexical Attribute Tracking and Document Conformance

**Status:** working draft / discussion notes for the AsciiDoc specification working group
**Date:** 2026-07-10

## Background and motivation (non-normative)

The AsciiDoc preprocessor (`include::`, `ifdef::`, `ifndef::`, `ifeval::`, `endif::`) is the hardest part of the language to specify.
The parser never sees directives, only their output.
Yet directive evaluation in the reference implementation (Asciidoctor) is *interleaved* with parsing: directives are resolved lazily in `PreprocessorReader#process_line` as the parser peeks and reads lines.
Conditionals are therefore evaluated against parser-dependent attribute state.
This creates a feedback loop between the two layers that defeats any clean two-layer grammar.

This interleaving produces **emergent, unspecifiable semantics**.
The following was verified against Asciidoctor `main` (see Appendix A).
When the parser buffers lines ahead (lists, tables), conditionals in the buffered region are evaluated *before* attribute entries in that same region are parsed.
In a single document, `ifdef::flag[]` directives referencing an attribute textually defined above them are silently dropped, while an `{flag}` reference at the end of the same document substitutes correctly.
The attribute is simultaneously defined (parser substitution phase) and undefined (preprocessor conditionals within the look-ahead window).
The result depends on the parser's look-ahead distance, which is unobservable, undocumented, and varies with surrounding structure.
No independent implementation would reproduce it.
A specification can state neither "conditionals see attributes textually defined above" (false inside lists today) nor "conditionals see document state when the parser consumes the line" (that would require norming parser internals).

The proposal below replaces the interleaved model with a **preprocessor specified as an autonomous line-stream transducer**.
The transducer holds its own attribute state, updated by *lexical* recognition of attribute entry lines in stream order.
This reproduces exactly the sequential behavior that works today.
It makes the buffered cases predictable (arguably fixing them).
And it makes the preprocessor specifiable, testable, and implementable independently of any parser.

---

## Normative text

### 1. Definition: lexical recognition

A recognition rule is **lexical** if, for any line *L* in the preprocessor's line stream, its applicability to *L* can be decided from:

1. the character content of *L* alone, and
2. a **bounded preprocessor context**: a fixed, finite set of state variables (the conditional stack, the open-delimiter stack, and the value-continuation flag) that are themselves computed exclusively by lexical rules applied to the lines that precede *L* in the stream.

Lexical recognition MUST NOT depend on: the parser's block model or parsing state, the substitutions in effect for any enclosing block, block metadata (styles, roles, attribute lists, `subs`), the semantic outcome of parsing any line, or any line that follows *L* in the stream.

*Non-normative note.*
Equivalently: the preprocessor is a deterministic transducer that consumes the line stream in a single left-to-right pass, deciding each line in isolation given O(1) carried state.
No look-ahead, no backtracking, no feedback from the parser.
This property makes the preprocessor specifiable and implementable independently of any parser, and makes its output identical across implementations.
It deliberately excludes the interleaved semantics of the reference implementation, in which directive evaluation timing depends on the parser's look-ahead distance and is therefore unobservable and unportable.

### 2. Preprocessor attribute state

The preprocessor maintains an **attribute state**: a mapping from attribute names to values, together with a per-attribute *locked* flag.

- The state is initialized from the attributes supplied by the processor interface (API/CLI).
  Attributes assigned by the interface without the soft-set modifier are *locked*.
- The state is also updated by the **document header mini-grammar**.
  At the start of the stream (after any front matter, and spanning lines contributed by header includes), the preprocessor recognizes the doctitle line, the author line, and the revision line per the header grammar.
  It assigns the implicit attributes they define (`doctitle`, `author`, `firstname`, `authorinitials`, `email`, `revnumber`, `revdate`, …), subject to the locked rule.
  Header recognition is lexical in the sense of §1: it is decided by line shape and position, with a header-mode flag in the bounded context.
  The header grammar itself is line-oriented and unnested, so this adds vocabulary without adding parsing power.
- The state is updated, in stream order, by every line recognized as an **attribute entry line** (§3) in the preprocessor's *output* stream, that is, after include expansion and after conditional resolution.
  Lines suppressed by a false conditional, lines within non-AsciiDoc include content, and lines within an opaque region (§4) MUST NOT update the state.
- An entry naming a *locked* attribute MUST NOT modify the state.
- This state, and no other, is the attribute state consulted by the preprocessor itself: for evaluating `ifdef`/`ifndef`/`ifeval` expressions, and for resolving attribute references appearing in a directive line (the include target and the directive's attribute list, e.g. `tags`, `lines`, `leveloffset`).

*Non-normative note.*
Tracking the *output* stream (rather than the raw input) is the only choice consistent with self-reference.
A conditional guarding a region that itself defines attributes behaves as authors expect.
Entries from included files take effect in expansion order.

*Non-normative note.*
"In the output stream" does not imply a second pass.
The output stream and the attribute state are produced together, in the same left-to-right pass.
A directive line is evaluated against the state accumulated so far.
That evaluation determines whether the following lines are emitted or skipped.
An emitted entry line updates the state before the next line is considered.
Formally, the transducer is a left fold over the input: each step consumes one line, reads only the carried state, and decides emission and update locally.
A worked trace:

```
:a: 1                <1> emitted; state: a=1
ifdef::a[]           <2> evaluated against the current state (a is set): true; push conditional; keep emitting
:b: 2                <3> emitted; state: b=2, before the next line is read
endif::[]            <4> pop conditional
include::{b}.adoc[]  <5> target resolved with the current state: 2.adoc; its lines are pushed and processed next
```

And the false branch:

```
ifndef::a[]          <1> evaluated against the current state: false; start skipping
:c: 3                <2> consumed, not emitted; state unchanged
endif::[]            <3> stop skipping
```

Every decision reads only the carried state, established by preceding lines.
Skipping the body of a false conditional requires no look-ahead either: the decision to skip each line comes from the conditional stack, and the matching `endif` is simply encountered along the way.
"In the output stream" characterizes *which* lines count, not an evaluation order.

### 3. Attribute entry lines

A line is recognized as an **attribute entry line** if and only if it matches the following grammar (anchored to the full line):

```abnf
attr-entry   = ":" ( name / "!" name / name "!" ) ":" [ sp value ]
name         = word-char *( word-char / "-" )
word-char    = ALPHA / DIGIT / "_"
sp           = 1*( SP / HTAB )
value        = <rest of line; may wrap, see below>
```

The `name` rule matches the documented constraints on [attribute names](https://docs.asciidoctor.org/asciidoc/latest/attributes/names-and-values/): at least one character, beginning with a word character, containing only word characters and hyphens, no dots or spaces.
The name is normalized to lowercase.
The `!` forms unset the attribute.
A value present on an unset form is ignored; implementations SHOULD warn.

Values may [wrap across lines](https://docs.asciidoctor.org/asciidoc/latest/attributes/wrap-values/).
A value line ending with the soft-wrap marker (SP `\`) continues on the next line.
On folding, the marker, the newline, and any leading indentation of the continuation line are replaced by a single space.
A value line ending with SP `+` SP `\` (hard wrap) also continues; the SP `+` is retained in the value as a hard line break replacement.
Continuation lines are consumed as part of the entry and are not scanned as independent lines.
Continuation is itself a lexical rule: the value-continuation flag in the bounded context (§1).

Attribute references (`{name}`) occurring in the value are resolved **eagerly**, at recognition time, against the attribute state as it exists at that point in the stream (snapshot semantics).
Unresolvable references follow the `attribute-missing` policy.
No other substitution is applied by the preprocessor.

### 4. Opaque regions (delimiter tracking)

The bounded context includes an **open-delimiter stack**, maintained lexically.
A line consisting solely of a delimiter run that opens or closes a verbatim delimited block (listing `----`, literal `....`, comment `////`) or a table block (`|===`, `,===`, `:===`, `!===`) pushes or pops the stack per the delimited-block pairing rules.
While a verbatim, comment, or table delimiter is open, lines are **opaque**: they are not scanned for attribute entry lines.
Preprocessor directive lines remain recognized inside verbatim and table regions.
They are evaluated against the attribute state as accumulated up to that point.
Opacity is a **write barrier** (no state updates from within the region), not a read barrier (directives inside the region still consult the full state from before and outside it).

Comment regions are the exception: they are **inert**, a read barrier as well as a write barrier.
While a comment delimiter is open, no line is recognized as a directive, an escaped directive, or an attribute entry.
Every line up to and including the matching closing delimiter is emitted unchanged.
Only the closing delimiter is recognized.
A conditional that encloses a comment region still applies to the region as a whole.

*Non-normative note.*
Opacity prevents displayed text that merely resembles an attribute entry (e.g. inside a code listing) from polluting the preprocessor state.
Directive lines stay active inside verbatim blocks and tables, because including tagged code snippets into listings and CSV data into tables are primary use cases.
Table opacity is not an approximation but the *exact* document-level semantics.
An attribute entry inside an AsciiDoc table cell is scoped to the cell's nested document and never reaches the document attribute state.
Entry-shaped text in a plain cell is display text (verified, Appendix A.3).
The preprocessor therefore needs no notion of cells or of blocks within cells.
Comment regions are inert because evaluating directives there has no use and real risk.
Commenting out a passage that contains an unbalanced `ifdef` would otherwise remove the rest of the document.
An `include` inside a comment would read, and possibly fail on, a file whose content is never displayed.
Inertness also matches the reference implementation, which reads comment block content without preprocessing.
And it keeps the source text intact for parsers that preserve comments in the ASG: the comment node then holds exactly what the author wrote, not a preprocessed variant of it.
Open question: whether passthrough delimiters (`++++`) should also be opaque.
Non-verbatim delimited blocks (example, sidebar, open) are deliberately *not* opaque: an attribute entry is legal for the parser there, so tracking it lexically is correct.

### 5. Consistency with the document attribute state

The parser maintains its own document attribute state, updated when attribute entries are parsed as blocks.
Consider a document in which every attribute entry line (i) occurs at a block boundary outside opaque regions and (ii) names no locked attribute.
For such a document, the preprocessor attribute state at any directive line and the document attribute state at the corresponding parse position agree.
Where they diverge (an entry-shaped line inside a context the parser does not treat as an attribute entry, or an attribute assigned by a parser-level extension during parsing), **the preprocessor state governs directive processing**.
Such divergence is *implementation-defined* territory for documents.
Extensions that need to influence directive processing MUST do so through the preprocessor-level extension interface.

### 6. Document conformance

The scope of conformance is the **document**: the main file together with every transitively included AsciiDoc file.
Each such file is an **include unit**.
A document is **preprocessing-conforming** if it satisfies rules D1–D5.

**D1: Entries at entry positions.**
Every line outside opaque regions that matches the attribute entry grammar (§3) MUST occur at a position where the parser recognizes it as an attribute entry.
That means a block boundary, not within the line range of a paragraph or other multi-line block.
Text intended for display that matches the entry grammar MUST be escaped or placed within an opaque region.

**D2: Per-unit conditional balance.**
Within each include unit, conditional directives MUST be properly nested and balanced.
Every `ifdef`/`ifndef`/`ifeval` directive has its matching `endif` in the same unit.
Each `endif::target[]` matches the innermost open conditional.
The conditional stack is empty at the end of the unit.
A conditional MUST NOT be opened in one unit and closed in another.

**D3: Per-unit delimiter balance.**
Each include unit MUST leave the open-delimiter stack as it found it.
It closes every delimited block it opens, and it does not close a delimited block it did not open.
This requirement applies to the delimiters tracked by §4.
It is RECOMMENDED for all delimited block forms, so that every unit is structurally self-contained.

**D4: Directive self-sufficiency.**
Every attribute consulted by a directive line MUST resolve against the preprocessor attribute state (§2) at that point in the stream.
This covers the target of a conditional, the operands of an `ifeval` expression, and attribute references in an include target or directive attribute list.
A document MUST NOT rely, in directive lines, on attributes established only by parser-side mechanisms: parser-level extensions, counters, or entry lines the parser would recognize but the preprocessor does not (see D1).

**D5: Includes at block boundaries.**
Outside opaque regions, an `include::` directive SHOULD occur at a block boundary: separated from adjacent content lines by an empty line, a delimiter line, or the start or end of its unit.
Inside opaque regions, an include is textual and this rule does not apply.
*(v1: SHOULD, with a deprecation-style warning; candidate MUST for v2, where it becomes the structural include.)*

**Guarantee.**
For a preprocessing-conforming document, an implementation conforming to §§1–4 provides:

1. **Determinism and portability.**
   The preprocessor output is a pure function of the source files and the initial attribute state.
   It is identical across conforming implementations and independent of any parser's internals.
2. **State agreement.**
   The consistency property of §5 holds at every directive line.
3. **Compositionality.**
   Every include unit is balanced with respect to conditionals and tracked delimiters.
   Units can therefore be analyzed, cached, and parsed per file (a prerequisite for incremental parsing and language tooling).

For documents that violate these rules, preprocessing still proceeds per §§1–4 (the transducer is total).
But the guarantee is void, and the parser-visible result is implementation-defined to the extent noted in §5.

### 7. Diagnostics

The preprocessor MUST emit, alongside its output line stream, a **provenance mapping** from each output line to the source file and line it originates from.
Diagnostics, from any layer, MUST report source locations through this mapping.

Detectability differs per rule.
The layer that can detect a violation SHOULD be the one to report it:

| Rule | Detectable by | Requirement |
| ---- | ------------- | ----------- |
| D2 (conditional balance) | Preprocessor, lexically, at end of unit | MUST diagnose |
| D3 (delimiter balance) | Preprocessor, lexically, at end of unit | MUST diagnose |
| D1 (entry positions) | Parser only (requires block model) | SHOULD diagnose |
| D5 (include placement) | Parser only | SHOULD diagnose (deprecation warning in v1) |
| D4 (directive self-sufficiency) | Partially: unresolvable references surface via the `attribute-missing` policy; reliance on parser-set attributes that happens to work is undetectable | SHOULD diagnose where detectable |

Whether D2/D3 violations are errors or warnings in v1 is pending corpus measurement (see Appendix C).

---

## Appendix A: Demonstration of the emergent semantics of the interleaved model (non-normative)

All results verified 2026-07-09/10 against Asciidoctor `main` with `ruby -Ilib bin/asciidoctor -s`.

### A.1 Conditional vs. substitution divergence

```asciidoc
* first item
+
:flag: yes
+
ifdef::flag[LIST-VISIBLE]

intervening paragraph

ifdef::flag[LATER-VISIBLE]

value: {flag}
```

Observed output: `LIST-VISIBLE` and `LATER-VISIBLE` are both silently dropped.
The list's look-ahead buffering evaluates both conditionals before the `:flag:` entry is parsed as a block.
Even the conditional past a blank line and an intervening paragraph is caught.
Yet the final paragraph renders `value: yes`: the attribute *is* set by the time parser-phase substitution runs.
The same attribute is simultaneously defined and undefined within one document, depending on which layer consults it.
The same `:flag:` + `ifdef::flag[]` sequence works correctly outside a list.

Under §§1–4 of this proposal, all three `flag` sites are consistent.
The entry precedes the directives in the stream, so both conditionals are kept.

### A.2 Downstream consequence is not a parser bug

```asciidoc
* first item
+

== Heading after empty continuation
```

Observed output: the heading is swallowed into the list item as a paragraph, with no preprocessor directive involved.
A dangling `+` continuation followed by a blank line attaches the next block.
This is standard (if surprising) continuation semantics.
When a dropped conditional leaves such a dangling `+` (as in A.1's original variant), the resulting structure mangling is the parser behaving consistently on the stream it received.
The defect is upstream: *when* the conditional was evaluated.
That is precisely what §§1–4 pin down.

### A.3 Attribute entries in AsciiDoc table cells are cell-scoped

```asciidoc
|===
a|
:tflag: yes

in the cell: {tflag}
|===

after the table: {tflag}

ifdef::tflag[TFLAG-DEFINED]
```

Observed output: `in the cell: yes`, but `after the table: {tflag}` (unresolved) and `TFLAG-DEFINED` dropped.
An attribute entry inside an AsciiDoc (`a|`) cell applies only to the cell's nested document.
The document-level attribute state, and hence directive processing, is never affected, even in the current implementation.
This licenses §4's rule that table regions are opaque for attribute entry tracking.
The lexical model matches the document-level semantics exactly, without identifying cells or blocks within cells.

The write-barrier/read-barrier distinction is likewise the current behavior.
Directives inside a cell commonly and legitimately reference attributes (a conditional block in a cell, `include::{examplesdir}/…[]` in a cell).
These must resolve, and they do.
Verified:

```asciidoc
:docattr: DOC

|===
a|
:cellattr: CELL

ifdef::docattr[IFDEF-DOCATTR-VISIBLE]

ifdef::cellattr[IFDEF-CELLATTR-VISIBLE]

cell ref: {cellattr}
|===
```

Observed output: `IFDEF-DOCATTR-VISIBLE` is rendered.
A directive inside the table reads the document-level state from before the table.
`IFDEF-CELLATTR-VISIBLE` is dropped.
An entry inside the cell is invisible to directives, even in the same cell, because directives in the table are resolved during the outer, buffered read of the table's lines, before the cell's nested document parses the entry.
And `{cellattr}` renders `CELL` (nested-document substitution, parser phase).
§4's rule (reads pass through, writes are blocked) reproduces all three outcomes.

## Appendix B: Response to work item #26, "Proposal to clarify the behavior of the preprocessor" (non-normative)

Dan Allen's analysis ([asciidoc-lang#26](https://gitlab.eclipse.org/eclipse/asciidoc-lang/asciidoc-lang/-/work_items/26)) frames the core problem as a contradiction: "the preprocessor has access to document attributes as soon as they are defined" yet "does not otherwise recognize or honor the document's block structure."
It surveys four models, recommends the *priority line processor* (model 4, closest to current behavior), and concludes that the preprocessor cannot be made less complicated than it currently is.
This proposal is best understood as a fifth model missing from that taxonomy.
It answers each objection as follows.

**The taxonomy conflates "lexical" with "no attribute tracking."**
Model 1 (*lexical preprocessor*) is rejected because it drops attribute entry processing entirely, breaking the many documents whose directives reference document-defined attributes.
Model 2 (*lexical in body*) is rejected because it limits tracking to the header, and "it's not uncommon for documents to change the value of an attribute to modify the target of a subsequent include."
Both rejections target the *absence or restriction of tracking*, not lexicality itself.
The model specified here is a **lexical preprocessor with stream-ordered lexical attribute tracking (§§1–4)**.
It keeps what makes models 1–2 tractable: single pass, bounded context, no parser feedback.
And it supports exactly the patterns that made Dan reject them: a body entry that retargets a subsequent include works, because the entry line lexically precedes the include line in the stream.
The taxonomy's missing option dissolves its dilemma.

**The "contradiction" dissolves once "defined" is read lexically.**
The hybrid-nature problem only exists if the preprocessor must consult the *parser's* attribute state, which requires the block model.
§§2–3 give the preprocessor its own notion of "defined": an entry-shaped line at a tracked position earlier in the output stream.
§5 states when the two notions provably agree (for documents satisfying D1).
No block-structure awareness is required, only the bounded lexical context of §1.

**Model 4 preserves an unspecifiable target.**
The priority line processor is credited with "full compatibility."
The cost is a parser that can "modify the input ahead of the cursor" and "backtrack to the location of the preprocessor directive", capabilities Dan acknowledges are incompatible with standard grammar formalisms.
But the compatibility it buys is with behavior that is not well-defined even in the reference implementation.
As Appendix A shows, directive evaluation timing depends on the parser's look-ahead distance.
So "the attribute state when the line is consumed" varies with surrounding structure (lists, tables) and across hypothetical implementations.
Specifying model 4 would require norming the parser's line-consumption order, i.e., writing Asciidoctor's internals into the spec.
The choice is therefore not "model 4 = compatible vs. lexical = breaking."
It is "model 4 = implementation trace as spec" vs. "lexical tracking = the *intended* semantics ('what is textually above is visible'), made true in all cases, including those where the current behavior silently diverges from it."

**The restrictions that sank model 3 are not incurred.**
Unlike the priority block processor, this model imposes no structural placement rules.
Directives remain line-oriented tokens recognized anywhere, including inside verbatim blocks (§4).
Adjacent includes still stitch textually.
The only balance requirements are per include unit (D2/D3): document conformance rules with lexically detectable violations and defined fallback behavior (§6), not grammar-level prohibitions.

**Line offset tracking becomes tractable.**
Model 4 entangles source mapping with parser backtracking over mutated input.
A standalone transducer instead emits a provenance mapping (output line to source file and line) as an ordinary part of its output contract, specified once, independent of the parser.

**The three follow-up objections to a separate phase.**
A later remark in the discussion argues that a separate preprocessor phase is "too much effort" because it (a) must process the header and assign the attributes extracted from it (doctitle, author, …), (b) must honor attributes locked via the API, and (c) must correctly identify blocks in an AsciiDoc table cell.
Each dissolves under this model.
(b) is not a parsing problem at all.
It is one rule on the state map (§2, locked flag): a sentence, not an effort.
(a) is real but bounded.
The header is itself a line-oriented, unnested mini-grammar (doctitle line, author line, revision line, entries, no blocks).
Recognizing it is lexical per §1, with a header-mode flag (§2).
The spec must write that grammar precisely anyway for the parser, so the preprocessor reuses it rather than adding to the spec's burden.
(c) rests on a false premise.
No phase, including the current interleaved one, identifies blocks inside table cells for directive purposes.
And it does not need to, because an attribute entry in an AsciiDoc cell is scoped to the cell's nested document and never reaches document-level state (verified, Appendix A.3).
The correct rule is the opposite of block identification: tables are opaque for entry tracking (§4), which reproduces the document-level semantics exactly.
Conversely, the one-phase alternative does not make these three questions disappear.
It makes their answers emergent.
In one phase, *when* header attributes become visible, *what* a directive inside a heavily buffered table sees, and *how* locking interacts with in-flight parsing are all answered by the parser's line-consumption order, which is precisely what cannot be specified (Appendix A.1).
The honest cost of the separate phase is different and worth stating.
Its lexical vocabulary grows: directives, entries, delimiters, header, tables.
The discipline that keeps it from re-becoming a parser is §1: every addition must remain decidable per line with O(1) carried state.
The header grammar and table delimiters pass that test.
Block metadata, `subs`, and cell structure do not, and stay out.
The natural stopping point exists: the preprocessor needs exactly the lexical shadow of "where do document-level attribute entries take effect," and nothing more.

**"Line filter" vs. independent stage: naming, and the clocking distinction.**
A follow-up reply reads this proposal as "similar in spirit" to the priority line processor ("the preprocessor has to process each line just in time as the block processing is happening") and suggests it is "more of a line filter than a line preprocessor."
The *filter* intuition captures the line orientation: lines in, lines out, no block model.
But it concedes too much.
A filter connotes a consumer-driven per-line check running while block processing happens, which is precisely the just-in-time reading this proposal rejects.
It also understates what the stage does: include expansion, conditional resolution, its own state, provenance emission.
The accurate name is the one used throughout this document: an **independent stage**, a *line-stream transducer*.
The similarity in spirit hides the one difference that carries all the value: **what clocks the stage**.
In the priority line processor, directive processing consults document state *at the moment the parser consumes the line*.
It is parser-clocked.
Because the parser buffers (lists, tables), that moment is a function of parser internals (Appendix A.1).
In this model the transducer is **stream-clocked**: it consults its own state at the line's position in the stream, and no information ever flows from the parser back into it.
That absence of a feedback edge has a decisive consequence: just-in-time processing remains available as an *implementation strategy*.
The transducer is a pure function of (source files, seed attributes), so lazy line-at-a-time evaluation fused with parsing is observationally identical to a separate pass.
But just-in-time stops being the *semantics*.
Implementations keep the single-phase efficiency.
The spec gets a definition in which the transducer is an independent stage: specified, tested, and conformance-checked on its own, with the parser as an ordinary grammar over its output.
The two models are genuinely distinct: there exist documents (A.1) on which they produce different output.
The delta is precisely the look-ahead-dependent behavior that cannot be normed.

**Stateless tooling.**
The same reply identifies the remaining structural cost: "the tool actually has to run the file to determine how to parse it," which no model avoids without fundamentally changing the language.
Correct: full statelessness is unattainable in v1.
It is unattainable in C too, where tooling must run the preprocessor and is given include paths by convention.
But statelessness is a gradient, and the models sit at measurably different points on it.
Under the current, parser-clocked model, "running the file" means running *the parser*: an unspecified computation.
Under the stream-clocked transducer, it means a **single linear lexical scan with O(1) carried state**: cheap, incremental (an editor can damage-and-repair it per edit), and exactly specified.
Moreover, parts of the problem become stateless outright.
Directive, entry, and delimiter recognition are regular (highlighters need no state).
Under D2/D3, a conforming include unit's *block structure* is well-formed standalone.
Conditional regions are balanced, structured, optional groups that a tool can parse and display without evaluating them, as C IDEs do for `#ifdef`.
What remains irreducibly stateful is *evaluation*: branch selection and include-target resolution need the seed attributes.
That is a configuration convention (the analog of `-I` paths), not a parse.
The v2 trajectory then shrinks statefulness further: a structural `subdoc` macro for composition ([asciidoctor#3603](https://github.com/asciidoctor/asciidoctor/issues/3603)), with `include` remaining the textual construct, and eventually a declared attribute interface per unit, approach per-file statelessness.
On this reading, the conformance rules of §6 are not merely compatibility management.
They are the stepping stones that make the v2 constructs reachable.
The transducer model does not cement statefulness; it bounds it and gives it a migration path.

**Where the conclusion still holds, and where it doesn't.**
Dan is right that no model reproduces current behavior bit-for-bit while being simpler.
This proposal knowingly diverges in the cases enumerated in §5/D1–D5: entry-shaped lines the parser would not honor, attributes set by parser-level extensions, conditionals or delimiters spanning include units, and directives whose evaluation timing currently depends on parser look-ahead inside lists and tables.
The claim is that this delta consists disproportionately of behavior that is accidental, look-ahead-dependent, or already non-portable.
And the delta is measurable on a corpus before the working group commits (Appendix C).
What *can* be made less complicated is the specification: two composable stages, each with an ordinary grammar, instead of one coupled system requiring a custom parsing discipline.

## Appendix C: Open questions and follow-up work (non-normative)

- **Corpus measurement** before fixing severities and restrictions.
  Count real-world occurrences of: (a) conditionals spanning include units, (b) includes leaving delimiters unbalanced (header/footer wrapper pattern), (c) entry-shaped lines inside verbatim blocks colliding with names used in directives, (d) directive lines relying on attributes defined mid-body (expected common, e.g. per-chapter `:sourcedir:`, and supported by lexical tracking) vs. relying on parser-extension-set attributes (expected rare), (e) entry-shaped lines mid-paragraph or in other positions the parser does not honor (D1 divergences).
  Items (a)–(e) jointly quantify the compatibility delta claimed in Appendix B.
- **Passthrough opacity** (`++++`): include in §4's opaque set or not.
- **Extension taxonomy.**
  API/CLI attributes are seed state.
  Preprocessor-level extensions (Preprocessor, IncludeProcessor) may mutate preprocessor state in stream order (supported path).
  Parser-level extensions influencing directives are implementation-defined (§5).
- **Spec v2 direction** (out of scope here).
  Add a structural composition macro, `subdoc`, interpreted at the parse phase where there is a tree to write into, as proposed by Dan Allen in [asciidoctor#3603](https://github.com/asciidoctor/asciidoctor/issues/3603): block boundaries only, the unit parsed as a sequence of blocks, parsing context carried per unit (relative paths, automatic relative `leveloffset`), imported nodes addressable (IDs).
  Keep `include` as the textual construct, with the transducer semantics and conformance rules of v1: its historical meaning is preserved under its historical name, and no existing textual use (snippets in listings, CSV in tables) needs to change.
  For attribute scoping of subdoc units, the language already has a precedent: AsciiDoc table cells (reads inherited at the instantiation point, entries scoped to the nested document, no write-back; Appendix A.3).
  A declared attribute interface per unit is the further step that approaches per-file statelessness.
  Conditionals can move to the model level (block metadata evaluated on the AST).
  Migration is gradual and mechanizable: an include at a block boundary outside opaque regions is a candidate `subdoc`; an include inside an opaque region stays an include; conformance on the remaining structural uses of `include` can be tightened over time.
  D2/D3/D5 are exactly what make an include unit subdoc-able, so v1 conformance is the stepping stone toward #3603.