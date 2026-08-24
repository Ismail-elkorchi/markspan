# Syntax tree and source identity

## Offsets

`SourceSpan` is half-open: `start` is inclusive and `end` is exclusive. Both are
UTF-16 code-unit offsets into the exact input string. The parser does not
normalize CRLF before assigning ranges.

A semantic value may be normalized while its span still points to the original
spelling. Examples include decoded character references, escaped punctuation,
code-span whitespace normalization, and code-block line-ending normalization.

Tabs advance to four-column stops only in the block parser's virtual indentation
model. Semantic values are produced from the original token content: removing
an indentation tab never expands later tabs into spaces. Because a tab occupies
one source code unit but several virtual columns, no range invents an offset
inside a source character, and slicing a span always returns original text.

## Ownership

Node spans cover the syntax construct owned by the node. Child spans generally
fall inside the parent span. Reference-link metadata is an intentional
exception: `definitionSpan` points to the definition elsewhere in the document,
while the link node's own `span` covers the use site.

Marker-specific ranges are available where editors need them:

- heading marker ranges
- list and task markers
- opening and closing emphasis markers
- code fences and code-span markers
- hard-break markers
- definition labels, destinations, and titles

Lists expose both levels of CommonMark looseness. `list.tight` describes how a
renderer treats the list as a whole, while each `listItem.spread` records
whether that item itself contains the separating blank-line structure.

## IDs

Node IDs are unique within a parse or document session. Independent parses do
not coordinate IDs. Within `createMarkdownDocumentSession`, unchanged syntax
keeps its ID across updates; unchanged nodes at identical positions also retain
object identity. Shifted unchanged nodes receive frozen copies with mapped spans
and the same ID. Changed syntax receives new IDs. Update results report the
parsed range and reuse count explicitly.

## Immutability

Public nodes, marker objects, spans, arrays, parse metadata, diagnostics, and
parse results are frozen. No node contains a parent pointer. This avoids cycles,
keeps snapshots shareable, and allows consumers to cache derived layout by
node object or parse result.

Use `walkMarkdown`, `markdownNodeChildren`, or `markdownPathAt` when context is
needed.
