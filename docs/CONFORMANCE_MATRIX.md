# Conformance matrix

Generated from pinned CommonMark 0.31.2 and cmark-gfm 0.29.0.gfm.13 fixtures. The complete per-example results are in `fixtures/conformance-matrix.json`.

| Suite | Section | Examples | Fixture outcome | Source AST |
| --- | --- | ---: | ---: | ---: |
| commonmark | Tabs | 11 | 11 pass, 0 fail | 11/11 |
| commonmark | Backslash escapes | 13 | 13 pass, 0 fail | 13/13 |
| commonmark | Entity and numeric character references | 17 | 17 pass, 0 fail | 17/17 |
| commonmark | Precedence | 1 | 1 pass, 0 fail | 1/1 |
| commonmark | Thematic breaks | 19 | 19 pass, 0 fail | 19/19 |
| commonmark | ATX headings | 18 | 18 pass, 0 fail | 18/18 |
| commonmark | Setext headings | 27 | 27 pass, 0 fail | 27/27 |
| commonmark | Indented code blocks | 12 | 12 pass, 0 fail | 12/12 |
| commonmark | Fenced code blocks | 29 | 29 pass, 0 fail | 29/29 |
| commonmark | HTML blocks | 44 | 44 pass, 0 fail | 44/44 |
| commonmark | Link reference definitions | 27 | 27 pass, 0 fail | 27/27 |
| commonmark | Paragraphs | 8 | 8 pass, 0 fail | 8/8 |
| commonmark | Blank lines | 1 | 1 pass, 0 fail | 1/1 |
| commonmark | Block quotes | 25 | 25 pass, 0 fail | 25/25 |
| commonmark | List items | 48 | 48 pass, 0 fail | 48/48 |
| commonmark | Lists | 26 | 26 pass, 0 fail | 26/26 |
| commonmark | Inlines | 1 | 1 pass, 0 fail | 1/1 |
| commonmark | Code spans | 22 | 22 pass, 0 fail | 22/22 |
| commonmark | Emphasis and strong emphasis | 132 | 132 pass, 0 fail | 132/132 |
| commonmark | Links | 90 | 90 pass, 0 fail | 90/90 |
| commonmark | Images | 22 | 22 pass, 0 fail | 22/22 |
| commonmark | Autolinks | 19 | 19 pass, 0 fail | 19/19 |
| commonmark | Raw HTML | 20 | 20 pass, 0 fail | 20/20 |
| commonmark | Hard line breaks | 15 | 15 pass, 0 fail | 15/15 |
| commonmark | Soft line breaks | 2 | 2 pass, 0 fail | 2/2 |
| commonmark | Textual content | 3 | 3 pass, 0 fail | 3/3 |
| gfm | Tables | 6 | 6 pass, 0 fail | 6/6 |
| gfm | Table cell count mismatches | 2 | 2 pass, 0 fail | 2/2 |
| gfm | Embedded pipes | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Oddly-formatted markers | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Escaping | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Embedded HTML | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Reference-style links | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Sequential cells | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Interaction with emphasis | 1 | 1 pass, 0 fail | 1/1 |
| gfm | a table can be recognised when separated from a paragraph of text without an empty line | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Strikethroughs | 2 | 2 pass, 0 fail | 2/2 |
| gfm | Autolinks | 3 | 3 pass, 0 fail | 3/3 |
| gfm | HTML tag filter | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Footnotes | 1 | 1 pass, 0 fail | 1/1 |
| gfm | When a footnote is used multiple times, we insert multiple backrefs. | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Footnote reference labels are href escaped | 1 | 1 pass, 0 fail | 1/1 |
| gfm | Interop | 2 | 2 pass, 0 fail | 2/2 |
| gfm | Task lists | 3 | 3 pass, 0 fail | 3/3 |

Total: **682 fixture passes, 0 render failures**, and **682/682 AST/invariant passes**.

“Fixture outcome” compares the fixture-only reference renderer byte-for-byte when the upstream fixture supplies HTML. The single upstream `<IGNORE>` case passes only after parsing and AST invariants succeed. “Source AST” validates complete traversal, unique IDs, immutable nodes, bounded spans, containment, and exact node accounting from the same parse.
