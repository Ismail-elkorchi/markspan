# Conformance scope

The parser targets CommonMark 0.31.2 and the cmark-gfm 0.29.0.gfm.13 extension
suite: tables, task-list items, strikethrough, literal autolinks, tag filtering
syntax, and footnotes.

The exact upstream fixture artifacts are committed under `fixtures/` with
versions, source URLs, SHA-256 hashes, example counts, and licenses in
`fixtures/MANIFEST.json`. `npm run test:conformance` rejects changed fixture
bytes or a stale result matrix.

All 652 CommonMark and 30 GFM examples parse successfully through the public
source-AST API and pass immutability, unique-ID, position, containment, and node
accounting invariants. A fixture-only renderer consumes that same tree—without
reparsing—and matches all 652 CommonMark outputs and all 29 executable GFM
outputs byte for byte.

The package does not expose HTML rendering. The matrix nevertheless records it
as an independent semantic check of the public tree. One upstream crash-only
GFM fixture is declared as `<IGNORE>` and is still parsed and checked against
all source-tree invariants.

See [CONFORMANCE_MATRIX.md](CONFORMANCE_MATRIX.md) for section totals and
`fixtures/conformance-matrix.json` for every individual pass/fail result.
