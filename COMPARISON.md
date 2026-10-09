# Stream-clocked transducer vs. Asciidoctor's preprocessor: an exhaustive comparison

This document lists **every** observable difference between this project's preprocessor (an autonomous line transducer, see [SPEC.md](SPEC.md)) and Asciidoctor's (`PreprocessorReader`, interleaved with the parser). For each one, it gives a runnable example, the result on both sides, the cause, and the advantages and drawbacks.

Every claim below is **measured, not assumed**. Each example is a case of the corpus in [`compare/cases.js`](compare/cases.js), identified by a code (A2, D9…). It was run against **Asciidoctor (Ruby) 2.0.20** and **Asciidoctor.js 4.0.7**. The raw details are in [`compare/REPORT.md`](compare/REPORT.md) (`npm run compare`). The verdict of each case is locked by `test/comparison/corpus.test.js`: if either side changes behavior, a test fails.

---

## 1. Summary

| | Number of cases |
|---|---|
| Cases in the corpus | **81** |
| Rendered output identical to Ruby Asciidoctor | **60** |
| Rendered output different from Ruby Asciidoctor | **21**, in 7 families (§4) |
| Cases where Asciidoctor.js differs from Ruby Asciidoctor | **2** (`ifeval`, §4.9) |

The 21 differences break down as follows:

| Family | Cases | Nature | Who is "right"? |
|---|---|---|---|
| 4.1 Clocking: a directive is evaluated before the entry above it | A2 A3 A4 A6 A7 A8 G18 | **intended fix** of the model | the transducer (consistent with text order) |
| 4.2 Entry-shaped line where the parser sees none | B1 B7 B5 B10 | limit of the lexical approach (rule D1) | Asciidoctor (the parser has block information) |
| 4.3 Attribute name grammar | C1 | stricter spec | debatable (compatibility vs. rigor) |
| 4.4 Substitutions applied to values | C2 C3 F6 | simpler spec | the transducer (Asciidoctor HTML-escapes file paths) |
| 4.5 Directive in a value continuation line | C12 | simpler spec | debatable, marginal |
| 4.7 Included non-AsciiDoc content | G5 | spec rule (§2) | the transducer |
| 4.8 Asciidoctor bugs not reproduced | D6 G4 G7 | fixes | the transducer |
| 4.10 Setext title | F5 | scope reduction (§1) | Asciidoctor |

One former difference has been **resolved**: directives in `////` comment blocks (D9, G13). The spec now makes comment regions inert, as Asciidoctor does (§4.6).

The transducer also brings differences outside the rendered output (§5): exact provenance, D2/D3 diagnostics, a preprocessor usable on its own, linear cost.

**Overall reading.** On a document that is "conforming" in the sense of the spec (§6), both models produce the same result. The differences concentrate where Asciidoctor's behavior depends on the parser's look-ahead, which is unpredictable and cannot be specified. The only difference that argued **against the spec as written**, directives evaluated in comment blocks, has been fixed by a simple lexical rule: comment regions are inert (§4.6).

---

## 2. Method

To isolate the effect of the **preprocessor model**, and only that, each case is rendered in two ways with **the same parser**:

1. **Asciidoctor alone**: its interleaved preprocessor, then its parser.
2. **Transducer, then Asciidoctor**: the transducer produces a line stream with no directive left. That stream is passed to the same Asciidoctor, which therefore has no directive to evaluate. Directive-shaped output lines are content; they are re-escaped so the parser leaves them intact.

The comparison is done on the **rendered text** (HTML with tags removed, whitespace normalized), against Ruby 2.0.20, the historical reference implementation, and against Asciidoctor.js 4.0.7. Intrinsic attributes (`backend-html5`, `safe-mode-unsafe`…) are supplied to the transducer by `intrinsicAttributes()`, just as Asciidoctor injects them into its `Document`.

### What was completed in the implementation to make the comparison fair

Before this work, several differences came from **gaps in the implementation**, not from the model. They would have polluted the comparison. Here is what was fixed, step by step (188 tests in total):

1. **Output contract conforming to the spec (§2, §5)**: attribute entry lines stay in the output stream. Before, they were removed, and the downstream parser lost the document attribute state (`{flag}` no longer substituted).
2. **Line normalization** as in Asciidoctor: CRLF, BOM, trailing whitespace stripped. Before, `----␠` was not recognized as a delimiter.
3. **Escaped directives** `\ifdef::…`, `\include::…`.
4. **Conditional stack aligned** with `PreprocessorReader`: a mismatched `endif` is reported **without** popping; `endif::a[]` is compared to the full target (`a,b`); the first `,`/`+` delimiter decides the combinator; malformed directives are reported and dropped.
5. **Single-line form `ifdef::x[text]`**: the text replaces the line and is **reprocessed** (it may be an `include::` or an entry, cases D3/D4), without attribute substitution. Before, it was emitted raw and substituted.
6. **`ifeval` with Asciidoctor's actual grammar.** The README claimed that Asciidoctor evaluates arbitrary Ruby. **That is false**: it applies a closed binary-comparison grammar with operand typing (quoted strings, `to_i`-style integers, floats, booleans, nil). It is now reproduced exactly (E1 to E6).
7. **Attribute values**: legacy ` +` continuation (accepted by Asciidoctor), the "every line must repeat the marker" rule, stop on an empty line, `pass:[…]` unwrapping, escaped references `\{x}`, character references `{sp}`/`{nbsp}`, `{set:…}`/`{counter:…}` left to the parser.
8. **Intrinsic and derived attributes**: `backend-*`, `basebackend-*`, `doctype-*`, `filetype-*`, `safe-mode-*`, `asciidoctor-version`, dates… Derived attributes are recomputed when `:doctype:`/`:backend:` appear **in the header**, and only there, as in Asciidoctor (F2/F3). An attribute unset through the API (`name!`) is now locked.
9. **Complete header**: entries and comments before the title, several authors separated by `;` (`author_2`…), the exact revision-line regex, `:author:` split into its components at the end of the header, implicit attributes that do not override an already-defined attribute, `skip-front-matter`.
10. **Delimiters**: `|====` tables (any number of `=` ≥ 3), fenced ```` ``` ```` blocks, `++++` passthrough. The latter was left open in Appendix C; it is settled by observation (case B3).
11. **Complete `include`**: `lines=`, `tag=`/`tags=` (with `*`, `**`, `!`), `indent=`, `leveloffset=`, `opts=optional`, attribute references in the target and the attribute list, the `attribute-missing` policy, `max-include-depth`, `safe`/`secure` modes, URIs gated by `allow-uri-read`, non-AsciiDoc content not preprocessed, cycle detection by resolved path.
12. **D3 in both directions**: a unit that leaves a block open, or that closes a block it did not open, is reported.
13. **Inert comment regions** (recommendation 1 of §7, now applied to the spec §4): inside `////`, no directive is evaluated and lines are emitted verbatim.

---

## 3. What is identical (60 cases)

These behaviors are **reproduced identically**. They are the compatibility baseline of the model.

- **Simple sequence**: an entry then a directive outside any buffered structure (A1, A10, G1, G17).
- **AsciiDoc table cells** (A9, Appendix A.3): the entry stays local to the cell, a directive in the table reads the pre-table state, and `{cellattr}` is substituted in the cell. The transducer gets this result without any notion of cells, through the write barrier of the opaque region.
- **Opaque regions**: listing, passthrough, fenced, plain table cell (B2, B3, B4, B6). A delimiter inside a paragraph also gives the same result (B9).
- **Value grammar**: soft, hard and legacy continuations, `pass:[]`, snapshot resolution, API locking and soft-set, `{set:…}` invisible to directives in both models, `{sp}` (C4 to C11).
- **Conditionals**: `,`/`+` combinators, mismatched `endif`, single-line form containing an include or an entry, escaping, unterminated conditional, conditional spanning an include, directive inside a comment block, trailing whitespace (D1 to D5, D7 to D10).
- **`ifeval`**: integers vs. strings (`5 < 10` is true, `"5" < "10"` is false), intrinsic version, missing attribute, malformed expression (E1, E4 to E6).
- **Intrinsic attributes and header**: backend, safe-mode, doctype in the header then in the body, multiple authors, revision (F1 to F4).
- **Include**: `lines=`, `tag=`, `leveloffset=`, `indent=`, references in the attribute list, missing file, `optional`, `drop-line`, `secure` mode, URI without `allow-uri-read`, include in a comment, "header/footer" includes that open and close a block (G1 to G3, G6, G8 to G17, G19).
- **Single-line comments** (I1 to I6): a line starting with `//` can never be a directive or an entry, since both are only recognized at column 0. It is passed through verbatim and the parser treats it as a comment, so no special rule is needed: it is inert by construction. `// endif::[]` does not close a conditional, and inside a false branch the comment line is dropped with the rest of the branch. A line comment may sit between the doctitle and the author line. `///` (three slashes) is neither a comment nor an entry: it is text. As with `////` blocks, the parser receives the comment text as written, which is what an ASG preserving comments needs. The only `//` lines with a preprocessing role are `// tag::name[]` / `// end::name[]` markers, and only in a file included with `tag=`/`tags=` (G2).
- **Lines**: CRLF, front matter (H1, H2).

---

## 4. The differences, one by one

### 4.1 Clocking: the directive is evaluated before the entry above it (A2 A3 A4 A6 A7 A8 G18)

This is **the** difference the model intends to introduce. When Asciidoctor's parser reads a compound block (list item with a continuation, example block, open block, admonition, description list), it **first reads all the lines of the block** into a buffer. The preprocessor evaluates the directives of those lines at that point. The entries are only applied **afterwards**, when the parser analyzes the buffered content. A directive placed *after* an entry in the text is therefore evaluated *before* it.

**Example A4: example block.** This is the most telling case, because the pattern is mundane:

```asciidoc
====
:flag: yes

ifdef::flag[IN-EXAMPLE]
====
```

| Asciidoctor (Ruby and JS) | Transducer |
|---|---|
| empty block: `IN-EXAMPLE` is **silently dropped** | `IN-EXAMPLE` |

An admonition (A6) behaves the same way:

```asciidoc
[NOTE]
====
:edition: pro

ifeval::["{edition}" == "pro"]
PRO-ONLY
endif::[]
====
```

Asciidoctor renders an empty note. The transducer renders `PRO-ONLY`.

**Example A2 (Appendix A.1 of the proposal)**: with a list, the effect reaches **beyond the list**:

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

| Asciidoctor | Transducer |
|---|---|
| `first item` / `intervening paragraph` / `value: yes` | `first item` / `LIST-VISIBLE` / `intervening paragraph` / `LATER-VISIBLE` / `value: yes` |

In the same document, `flag` is both **undefined** for the two `ifdef`s and **defined** for `{flag}`.

**Example A3**: the same cause applied to an `include` produces a self-contradictory error message:

```asciidoc
* item
+
:part: chapters
+
include::{part}/intro.adoc[]
```

Asciidoctor logs `include file not found: …/{part}/intro.adoc`, then **renders** `Unresolved directive in <stdin> - include::chapters/intro.adoc[]`. The preprocessor did not see `part`, but the parser substituted it in the replacement line. The transducer includes the file.

Cases A7 (open block `--`), A8 (description list) and G18 (a file included in a list continuation that defines an attribute tested right after) are identical in principle. Conversely, **A5 and A10 do not differ**: a sidebar followed by a directive *after* the block, or a list followed by an entry separated by an empty line. Everything depends on what the parser had buffered when it looked at the line. That is precisely what a specification cannot standardize.

- **Advantages (transducer).** The rule "what is written above is visible" becomes true everywhere. The result no longer depends on the surrounding structure. The behavior can be specified in one sentence and tested without a parser.
- **Drawbacks.** Strictly speaking, this breaks compatibility. However, it only breaks documents that *silently lose content today*: it is hard to imagine an author relying on `IN-EXAMPLE` disappearing. The final attribute state is the same in both models, since the entry applies to the document in both cases. Only the evaluation of the directive changes.
- **Actual regression risk**: low. The corpus measurement of Appendix C has yet to be done.

### 4.2 Entry-shaped line where the parser sees none (B1 B7 B5 B10)

The transducer recognizes an entry **by the shape of the line**. The parser recognizes it only **at a block boundary**. Outside an opaque region, the two can therefore diverge. This is exactly conformance rule **D1**.

**B1: in the middle of a paragraph**

```asciidoc
Some paragraph text
:flag: yes

ifdef::flag[FLAG-SET]
```

| Asciidoctor | Transducer |
|---|---|
| `Some paragraph text :flag: yes` (text), `FLAG-SET` dropped | same paragraph, then `FLAG-SET` |

Case **B7** is identical, with the line placed directly under a list item without `+`.

**B5 and B10: the block style comes from metadata**

```asciidoc
[source]
--
:flag: yes
--

ifdef::flag[FLAG-SET]
```

```asciidoc
[comment]
--
ifdef::nope[]
--

AFTER-COMMENT-BLOCK
```

With `[source]`, the open block becomes a listing; with `[comment]`, it becomes a comment. Asciidoctor therefore sees neither an entry (B5) nor a directive (B10, where `AFTER-COMMENT-BLOCK` is rendered). By definition (§1), the transducer does not read block metadata. For it, `--` is not opaque: it defines `flag` (B5), and it opens a conditional that **swallows the rest of the document** (B10, empty output, with the D2 and `unterminated conditional` diagnostics).

- **Advantages.** Recognition stays decidable line by line, with bounded state. That is what makes the preprocessor specifiable and usable on its own.
- **Drawbacks.** This is the intrinsic limit of the lexical model: it does not know about blocks. B10 is the most troublesome, because `[comment]` on an open block is a real idiom. A document violating D1 loses the guarantee that the preprocessor state and the document state agree. Only the parser can diagnose D1 (spec §7: SHOULD).
- **Mitigation.** Displayed text that looks like an entry should be escaped or placed in an opaque region anyway, which is what D1 requires. B10 is the styled-block counterpart of §4.6: inert `////` regions are lexical, a `[comment]` style on `--` is not.

### 4.3 Attribute name grammar (C1)

```asciidoc
:First Name: Dan

ifdef::firstname[SANITIZED-NAME-SET: {firstname}]
```

| Asciidoctor | Transducer |
|---|---|
| `SANITIZED-NAME-SET: Dan` | nothing |

Asciidoctor accepts `^:(!?\w[^:]*):` and then **sanitizes** the name by removing invalid characters and lowercasing it. `First Name` thus becomes `firstname`. The spec (§3) enforces the documented constraint: word characters and hyphens only.

- **Advantages (spec).** A closed, documented grammar: no "ghost" attribute whose name differs from what is written.
- **Drawbacks.** Incompatible with older documents; the line becomes displayed text.
- **Option**: adopt the lenient grammar with sanitization. It stays lexical, but it enshrines a surprising behavior.

### 4.4 Substitutions applied to values (C2 C3 F6)

Asciidoctor applies the **header substitutions** (special characters, then attributes) to the value of every entry, and to the document title. The spec (§3) limits itself to attribute references.

**C2**

```asciidoc
:op: <

ifeval::["{op}" == "<"]
RAW-LESS-THAN
endif::[]
```

Asciidoctor stores `&lt;`: the comparison is false and the text is dropped. The transducer stores `<`: `RAW-LESS-THAN` is rendered.

**C3**, the clearest consequence:

```asciidoc
:dir: a&b

include::{dir}/x.adoc[]
```

Asciidoctor looks for the file **`a&amp;b/x.adoc`** (`include file not found`). The transducer includes `a&b/x.adoc`.

**F6**: with `= Tom & Jerry`, Asciidoctor sets `doctitle` to `Tom &amp; Jerry`, so `ifeval::["{doctitle}" == "Tom & Jerry"]` is false.

- **Advantages (spec).** The values seen by directives are the ones the author wrote. HTML-escaping a file path is a defect, not a feature.
- **Drawbacks.** Asciidoctor's parser will keep storing the escaped value: the transducer state and the document state diverge on these characters (§5 of the spec). Substitution in the body is unaffected, since the parser performs it.

### 4.5 Directive in a value continuation line (C12)

```asciidoc
:v: start \
ifdef::nope[middle]

ifeval::["{v}" == "start"]
DIRECTIVE-PROCESSED-IN-VALUE
endif::[]
```

Asciidoctor reads continuation lines **through the preprocessor**: the `ifdef` is evaluated and disappears, and `v` is `start`. Under §3, continuation lines are part of the entry and are not scanned: `v` is `start ifdef::nope[middle]`.

- Marginal. The spec rule is simpler and respects "bounded state". It would only need to be written explicitly in the spec.

### 4.6 Directives in a `////` comment block (D9, G13): **resolved, comments are inert**

```asciidoc
////
ifdef::nope[]
////

AFTER-COMMENT
```

| Asciidoctor | Transducer, original spec §4 | Transducer, amended spec §4 |
|---|---|---|
| `AFTER-COMMENT` | **empty document**, with the D2, D3 and `unterminated conditional` diagnostics | `AFTER-COMMENT`, no diagnostic |

Asciidoctor reads the content of a comment block with `skip_processing`, that is, **without evaluating directives**. The original spec §4 made every opaque region a write-only barrier and kept directives active, including inside `////`. In listings and tables this is essential (snippets, CSV). In comments it served no purpose and was dangerous: commenting out a passage that contains an unbalanced `ifdef` made the rest of the document disappear. For an `include::` in a comment (G13), Asciidoctor does not read the file, while the transducer tried to read it and produced a spurious error.

Spec §4 now makes comment regions **inert**: a barrier for reads *and* writes. Inside `////`, no directive, escaped directive or attribute entry is recognized; every line is emitted unchanged until the closing delimiter. A conditional that encloses the whole comment block still applies to it. The rule stays purely lexical and reproduces Asciidoctor; D9 and G13 are now identical.

- **ASG.** Whether comment blocks should be kept in the ASG is under discussion. Inertness is the precondition that makes it useful: the comment node holds exactly what the author wrote (directive lines included, unevaluated), not a preprocessed variant in which an `include` would have been expanded into the comment or part of it suppressed by a conditional.

### 4.7 Included non-AsciiDoc content that looks like an entry (G5)

```asciidoc
include::settings.conf[]

ifdef::port[PORT-DEFINED]
```

with `settings.conf` containing `:port: 8080`.

Asciidoctor does not preprocess the file (`.conf` is not an AsciiDoc extension), but its **parser** then reads `:port: 8080` as an entry: `PORT-DEFINED` is rendered. The transducer applies §2 ("lines of a non-AsciiDoc include do not update the state"), so nothing is rendered.

- **Advantage.** Consistent: a non-AsciiDoc file is content, not document configuration.
- **Drawback.** An author who includes an attribute file named `.properties` (a rare but real pattern) has to rename it to `.adoc`.

### 4.8 Asciidoctor bugs the transducer does not reproduce (D6 G4 G7)

**D6: an escaped directive inside a false branch is rendered anyway**

```asciidoc
ifdef::nope[]
\ifdef::shown[]
endif::[]

END
```

Asciidoctor (Ruby and JS) renders `ifdef::shown[]` then `END`: the escape check runs *before* the "we are in a false branch" check. The transducer renders only `END`.

**G4: `leveloffset=` on an include inside a listing**

```asciidoc
----
include::snippet.adoc[leveloffset=+1]
----
```

Asciidoctor injects its synthetic entries **into the listing**, which therefore displays `:leveloffset: +1`, then `SNIPPET`, then `:leveloffset!:`. The transducer only injects these lines outside opaque regions and renders `SNIPPET`.

**G7: circular include**

```asciidoc
include::loop.adoc[]
```

with `loop.adoc` containing `LOOP` then `include::loop.adoc[]`.

Asciidoctor has no cycle detection. It renders `LOOP` **64 times**, then the raw line `include::loop.adoc[]`, with the error `maximum include depth of 64 exceeded`. The transducer renders `LOOP` once, with the error `circular include: loop.adoc (loop.adoc:2)`.

- These three differences are fixes. A spec describing the preprocessor does not have to standardize these bugs.

### 4.9 `ifeval`: Asciidoctor.js disagrees with Ruby Asciidoctor (E2 E3)

The two reference implementations disagree with each other:

```asciidoc
:level: high

ifeval::[{level} == 0]
WORD-IS-ZERO
endif::[]
```

In Ruby, `"high".to_i` is `0`: the condition is true. In JS, `parseInt("high")` is `NaN`: it is false.

```asciidoc
ifeval::[true != "true"]
BOOL-NE-STRING
endif::[]
```

In Ruby, `true != "true"` is true. Asciidoctor.js raises an error on the boolean/string mix and treats the condition as false.

The transducer follows **Ruby**. These two cases show that even the reference is not portable in unspecified areas. That is a direct argument for a **normative** `ifeval` grammar, including operand typing: the grammar already exists (§2, item 6); it only needs to be written into the spec.

### 4.10 Setext title (F5)

```asciidoc
The Title
=========

ifdef::doctitle[DOCTITLE-SET]
```

Asciidoctor recognizes the underlined title (compatibility syntax) and renders `DOCTITLE-SET`. The transducer does not recognize it, because deciding that a line is a setext title requires **looking at the next line**, which §1 forbids.

- **Option 1**: explicitly allow a one-line bounded look-ahead for this single case; recognition stays regular.
- **Option 2**: treat setext as outside the model (compatibility syntax) and diagnose it.

---

## 5. Differences not visible in the rendered output

### 5.1 Exact provenance (G19)

```asciidoc
include::doc.adoc[lines=1;6..8]
```

`doc.adoc` contains an unterminated listing at line 7.

- **Asciidoctor (Ruby and JS)**: `WARN: unterminated listing block (doc.adoc: line 3)`. **The line number is wrong**: Asciidoctor only keeps the offset of the first selected line, then counts continuously.
- **Transducer**: the provenance maps each output line to its actual position (`doc.adoc:1`, `:6`, `:7`, `:8`). Any diagnostic, from any layer, can therefore point to the right place (spec §7).

### 5.2 D2/D3 conformance diagnostics (D8, G14, D7)

Asciidoctor silently accepts a conditional opened in an included file and closed in the including one (D8), as well as the "header/footer" pattern where `open.adoc` opens a `----` that `close.adoc` closes (G14). The rendered output is identical in both models, but the transducer reports `D2` and `D3` (as `warning`).

- **Advantage.** Include units become analyzable on their own, which is the prerequisite for incremental parsing and the future `subdoc` (Appendix C).
- **Drawback.** These warnings are new on existing documents that work. The severity (warning or error) remains to be decided after a corpus measurement.

### 5.3 Asciidoctor's preprocessor cannot be used on its own

If Asciidoctor's `PreprocessorReader` is drained **without the parser**:

```asciidoc
:flag: yes

ifdef::flag[FLAG-VISIBLE]
```

| `PreprocessorReader` alone | Transducer alone |
|---|---|
| `[":flag: yes", ""]`: the `FLAG-VISIBLE` line is lost | `[":flag: yes", "", "FLAG-VISIBLE"]` |

In Asciidoctor, it is the entries applied by the **parser** that feed the preprocessor. A tool (IDE, linter, indexer, syntax highlighter) that wants to know the effective text of a document must therefore **run the whole parser**. With the transducer, a single linear pass with bounded state is enough.

### 5.4 Cost

Indicative measurement on a 60,000-line synthetic document (sections, entries, conditionals, listings): **24 ms** for the transducer alone, versus **109 ms** for `Asciidoctor.load` (parsing included). The two measurements do not cover the same work. The order of magnitude only shows that "running the file to know how to read it" costs one lexical pass, not a full parse.

### 5.5 Integration: who supplies the intrinsic attributes?

Asciidoctor itself injects `backend-html5`, `doctype-article`, `safe-mode-*`, etc. In line with §2, the transducer receives them **from the interface** (`intrinsicAttributes()`). If they are not supplied, `ifdef::backend-html5[]` is false. This is one more responsibility for the integrator, and a point to write into the spec: the list of attributes every processor MUST inject.

### 5.6 Messages

The transducer's messages reuse Asciidoctor's (malformed directive, mismatched, unmatched, include not found, optional include dropped, cannot include URI…). They add a **rule** (`D2`, `D3`, `include-cycle`…) and a source position derived from the provenance.

---

## 6. Overall advantages and drawbacks of the model

| | Stream-clocked transducer | Parser-clocked Asciidoctor |
|---|---|---|
| **Predictability** | A directive sees what is written above it, everywhere (§4.1) | Depends on the parser's look-ahead: lists, compound blocks, admonitions |
| **Specifiability** | Regular grammars plus bounded state; testable without a parser | Would require standardizing the parser's line-consumption order |
| **Portability** | Result is a pure function of the sources and the initial attributes | Ruby and JS already disagree (§4.9) |
| **Tooling** | Usable on its own, linear cost, exact provenance (§5.1, §5.3) | Requires the full parser; wrong line numbers with `lines=` |
| **Robustness** | Cycle detection, no escaped directive in a false branch, no synthetic entry in a listing (§4.8) | Bugs D6, G4, G7 |
| **Composition** | D2/D3 diagnosed: each unit can be analyzed on its own | Conditionals and blocks can span files without any warning |
| **Block awareness** | None: wrong when a block style changes its content model (`[source]--`, `[comment]--`) or on an entry outside a block boundary (D1) | Exact, since it is the parser |
| **Strict compatibility** | 21 of 81 cases differ; they are edge cases, but some occur in practice (§4.2, §4.3) | The reference, by definition |
| **Integration** | The interface must supply the intrinsic attributes (§5.5) | Built in |
| **Values** | As written | HTML-escaped, even in paths (§4.4) |
| **New warnings** | D2/D3 on patterns that work today (§5.2) | None |

---

## 7. Recommendations for the specification

In order of importance:

1. **Make comments inert (§4).** *Applied.* A region opened by `////` is a barrier **for reads and writes**: no directive is evaluated inside it and its lines are emitted verbatim. The rule is lexical, reproduces Asciidoctor, removes the most dangerous defect of the original text (D9, G13), and keeps comment content intact should comments be preserved in the ASG. The `[comment]--` case (B10) remains out of reach and falls under D1.
2. **Standardize `ifeval`**: the `operand op operand` grammar, operand typing (string, nil, boolean, integer and float with "numeric prefix, otherwise 0" semantics), and the rule "incompatible comparison = false". This ends the Ruby/JS divergence (E2, E3). The misconception that `ifeval` evaluates Ruby should also be corrected.
3. **Settle Appendix C for passthrough**: `++++` is opaque. This is Asciidoctor's observed behavior (B3). Also add fenced ```` ``` ```` blocks to the verbatim set, and allow any number of `=` (≥ 3) in table delimiters.
4. **Write down the list of intrinsic attributes** the processor must supply as initial state (`backend-*`, `basebackend-*`, `doctype-*`, `safe-mode-*`, `asciidoctor-version`…), together with the rule that derived attributes are only updated **within the header** (F2, F3).
5. **Decide on values** (§4.4): either "no substitution besides references" (current text, saner) or "header substitutions". If the first option is kept, it should be listed among the acknowledged divergences of §5.
6. **Decide on attribute names** (§4.3): strict grammar or Asciidoctor-style sanitization.
7. **Specify the single-line form**: the text *replaces* the line and is reprocessed (includes and entries possible), without substitution.
8. **Specify escaping**: an escaped directive inside a false branch is dropped like the rest of the branch (D6).
9. **`leveloffset=`**: synthetic entries are only injected outside opaque regions (G4).
10. **Include cycles**: mandatory detection by resolved path, rather than a mere depth limit (G7).
11. **Setext**: allow a one-line look-ahead, or explicitly exclude setext from the model (F5).
12. **Continuation lines**: state explicitly that they are not scanned as directives (C12).

---

## 8. Reproducing

```console
npm install
npm test             # 188 tests, including one per corpus case (verdicts locked against Asciidoctor.js)
npm run compare      # regenerates compare/REPORT.md; adds a Ruby column if the asciidoctor gem is installed
```

To add a case, add an entry to [`compare/cases.js`](compare/cases.js) (source, included files, API attributes, safe mode, expected verdict).
