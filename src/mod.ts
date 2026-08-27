export {
  parseMarkdown,
  type MarkdownParseMetadata,
  type ParsedMarkdownDocument
} from './parse.js';

export {
  defaultMarkdownParseBudgets,
  type MarkdownDialect,
  type MarkdownParseBudgets,
  type MarkdownParseOptions,
  type MarkdownSyntaxExtension,
  type MarkdownResourceUsage,
  type MarkdownSourceRetention,
  type ResolvedMarkdownParseBudgets
} from './options.js';

export {
  MarkdownBudgetExceededError,
  MarkdownConfigurationError,
  MarkdownParserError,
  type MarkdownBudgetName,
  type MarkdownParserErrorCode
} from './errors.js';

export * from './model.js';

export { markdownCodeValueSourceSpan } from './code-value-source-map.js';

export {
  assertSourceSpan,
  createMarkdownSourceIndex,
  updateMarkdownSourceIndex,
  isSourceSpan,
  mergeSourceSpans,
  sliceMarkdownSource,
  sourceSpanContains,
  sourceSpanIntersects,
  type MarkdownSourceIndex,
  type MarkdownSourceIndexEdit,
  type SourcePosition
} from './source.js';

export {
  collectMarkdownLinks,
  collectMarkdownNodes,
  countMarkdownDocumentWords,
  countMarkdownWords,
  definitionText,
  extractMarkdownOutline,
  extractMarkdownText,
  extractMarkdownTextTokens,
  headingText,
  linkText,
  markdownNodeAt,
  markdownNodeChildren,
  markdownNodesIntersecting,
  markdownPathAt,
  visitMarkdown,
  walkMarkdown,
  type CollectMarkdownLinksOptions,
  type MarkdownLinkInfo,
  type MarkdownOutlineEntry,
  type MarkdownTextExtractionOptions,
  type MarkdownTextToken,
  type MarkdownTextTokenKind,
  type MarkdownVisitControl,
  type MarkdownWalkEntry
} from './analysis.js';

export {
  applyMarkdownTextEdits,
  createMarkdownDocumentSession,
  mapMarkdownOffsetThroughEdits,
  type AppliedMarkdownEdits,
  type MarkdownDocumentSession,
  type MarkdownOffsetAffinity,
  type MarkdownParseInstrumentation,
  type MarkdownSessionSnapshot,
  type MarkdownSessionUpdate,
  type MarkdownTextEdit
} from './edit.js';


export {
  collectMarkdownSyntaxTokens,
  type MarkdownSyntaxToken,
  type MarkdownSyntaxTokenKind
} from './syntax.js';

export {
  createMarkdownTreeIndex,
  type MarkdownTreeIndex
} from './tree-index.js';
