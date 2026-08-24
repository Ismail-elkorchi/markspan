# Markspan

Source-exact Markdown syntax trees for TypeScript editors and analysis tools.

Markspan is a zero-dependency CommonMark and GFM parser built around immutable
syntax nodes, exact UTF-16 source spans, and incremental document updates. It is
designed for software that needs to understand and edit Markdown rather than
immediately convert it to HTML.

It parses CommonMark 0.31.2 or GFM into a typed syntax tree whose nodes retain
exact UTF-16 ranges in the original JavaScript string. The parser engine has
zero runtime dependencies and emits runtime-neutral ESM. Rendering, terminal
layout, HTML sanitation, URL policy, and syntax highlighting remain consumer
responsibilities.

## Purpose

Renderer-oriented token streams discard information needed by editors and
structural analysis tools. This package preserves block markers, list and task
syntax, fences, definitions, inline delimiters, and original source ranges in a
renderer-independent tree.

## Install

From npm:

```sh
npm install markspan
```

From JSR:

```sh
deno add jsr:@ismail-elkorchi/markspan
```

The examples below use the npm specifier `markspan`. Native JSR consumers can
use `jsr:@ismail-elkorchi/markspan` instead.

Node.js 22 or newer is supported. The emitted JavaScript is standard ESM and
uses no Node-specific runtime API, so the package can also run in Deno, Bun,
and browsers.

## Parse

```ts
import { parseMarkdown } from 'markspan';

const parsed = parseMarkdown(source, {
  dialect: 'gfm',
  sourceRetention: 'text'
});

console.log(parsed.tree.children);
console.log(parsed.metadata.resourceUsage);
```

`commonmark` is the default dialect. `gfm` adds tables, task-list markers,
strikethrough, literal URL/email autolinks, and footnotes.

All offsets are zero-based UTF-16 code-unit offsets. They can be passed directly
to `String.prototype.slice` and common JavaScript editor APIs.

```ts
import {
  collectMarkdownNodes,
  sliceMarkdownSource
} from 'markspan';

const heading = collectMarkdownNodes(parsed.tree, 'heading')[0];
if (heading && parsed.sourceText) {
  console.log(sliceMarkdownSource(parsed.sourceText, heading.span));
}
```

## Syntax tree

The tree is a discriminated union. Important block kinds include:

- `heading`, `paragraph`, and `blockQuote`
- `list` and `listItem`
- `codeBlock`, `thematicBreak`, and `htmlBlock`
- `linkDefinition` and GFM `footnoteDefinition`
- GFM `table`, `tableRow`, and `tableCell`

Important inline kinds include:

- `text`, `escape`, and `characterReference`
- `emphasis`, `strong`, and GFM `strikethrough`
- `codeSpan`, `link`, and `image`
- `softBreak`, `hardBreak`, `htmlInline`, and GFM `footnoteReference`

Every public node and child array is frozen. Trees have no parent pointers or
process-global cache. Use traversal helpers when parent/depth information is
needed.

```ts
import { walkMarkdown } from 'markspan';

for (const { node, parent, depth } of walkMarkdown(parsed.tree)) {
  console.log(depth, parent?.kind, node.kind, node.span);
}
```

See [`docs/AST.md`](docs/AST.md) for the complete source-identity contract.

## Analysis

```ts
import {
  collectMarkdownLinks,
  countMarkdownDocumentWords,
  extractMarkdownOutline,
  extractMarkdownText
} from 'markspan';

const outline = extractMarkdownOutline(parsed.tree);
const links = collectMarkdownLinks(parsed.tree, {
  links: true,
  images: true,
  definitions: true
});
const text = extractMarkdownText(parsed.tree, {
  code: 'omit',
  image: 'alt',
  html: 'omit'
});
const words = countMarkdownDocumentWords(parsed.tree);
```

Text extraction is policy-driven. Word counts are derived from an extraction
policy rather than embedded in the document node.

For editor hit-testing:

```ts
import {
  markdownNodeAt,
  markdownPathAt
} from 'markspan';

const deepest = markdownNodeAt(parsed.tree, cursorOffset);
const path = markdownPathAt(parsed.tree, cursorOffset);
```

## Reference definitions

Definitions remain source nodes even though renderers normally omit them.
Reference links resolve to the first definition for a normalized label.
Duplicates produce diagnostics and remain in the tree with `active: false`.

```ts
const guide = parsed.definitionFor('Guide');
console.log(guide?.destination);
console.log(parsed.diagnostics);
```

## Resource limits

Markdown accepts arbitrary character sequences, so parser failures are
operational rather than ordinary syntax errors. Deterministic limits protect
applications that process untrusted or generated input.

```ts
const parsed = parseMarkdown(source, {
  budgets: {
    maxInputCodeUnits: 5_000_000,
    maxLines: 500_000,
    maxNodes: 300_000,
    maxDepth: 192
  }
});
```

The parser may throw `MarkdownConfigurationError` or
`MarkdownBudgetExceededError`. Depth is checked at inline-container boundaries
and during tree construction. Emphasis and bracket resolution use bounded
single-pass indexes rather than a separate delimiter-work limit. Successful
resource usage is reported in `metadata.resourceUsage`.

## Editor updates

The package includes deterministic non-overlapping text edits and offset
mapping:

```ts
import {
  applyMarkdownTextEdits,
  mapMarkdownOffsetThroughEdits
} from 'markspan';

const edits = [
  { span: { start: 2, end: 7 }, text: 'New title' }
];
const updated = applyMarkdownTextEdits(source, edits);
const nextCursor = mapMarkdownOffsetThroughEdits(
  source.length,
  cursorOffset,
  edits,
  'forward'
);
```

`createMarkdownDocumentSession` is a buffer-oriented incremental parser. It
reparses from the nearest safe blank-line boundary, reuses unchanged node
objects, and preserves node IDs when unchanged syntax shifts. Documents with
reference or footnote definitions use a full parse because those definitions
can change earlier inline interpretation; stable nodes are still reconciled.

```ts
import { createMarkdownDocumentSession } from 'markspan';

const session = createMarkdownDocumentSession(source, { dialect: 'gfm' });
const update = session.applyEdits(edits);
console.log(update.snapshot.revision);
console.log(update.changedOldSpan, update.changedNewSpan);
console.log(update.strategy, update.parsedSpan, update.reusedNodes);
```

## Security boundary

The parser does not execute raw HTML, fetch images, open links, or transform
Markdown into HTML. `htmlBlock` and `htmlInline` retain raw values. Link and
image destinations are parsed data, not approved URLs. A renderer must escape
output and apply its own HTML and URL policies.

## Build and verify

```sh
npm install
npm run check
```

The repository contains strict TypeScript checks, all 682 pinned CommonMark/GFM
fixtures, differential fuzzing, pathological-input benchmarks, reproducible
package checks, and Node/browser/Deno/Bun runtime lanes. See the
[conformance matrix](docs/CONFORMANCE_MATRIX.md).

## Package boundaries

This package owns parsing, source identity, traversal, analysis, and text-edit
mapping. It contains no rendering, layout, sanitation, navigation, storage, or
user-interface policy.

There is intentionally no mdast adapter and no plugin API. The public tree is a
closed source-aware contract; grammar behavior is selected only by `dialect`.

Consumers decide how syntax nodes become HTML, terminal output, editor
decorations, search indexes, or another representation.
