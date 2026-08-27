import type {
  MarkdownDiagnostic,
  MarkdownDocumentNode,
  MarkdownFootnoteDefinition,
  MarkdownReferenceDefinition
} from './model.js';
import type {
  MarkdownDialect,
  MarkdownParseOptions,
  MarkdownResourceUsage,
  MarkdownSourceRetention,
  MarkdownSyntaxExtension
} from './options.js';
import { MarkdownConfigurationError } from './errors.js';
import { createMarkdownSourceIndex, type MarkdownSourceIndex } from './source.js';
import { BudgetController, resolveBudgets } from './internal/budget.js';
import { convertMarkdown } from './internal/parser-engine.js';
import type { BlockParseSeed } from './internal/block-parser.js';
import { normalizeMarkdownIdentifier } from './internal/identifier.js';

export interface MarkdownParseMetadata {
  readonly dialect: MarkdownDialect;
  readonly commonMarkVersion: '0.31.2';
  readonly gfmVersion: '0.29.0.gfm.13' | null;
  readonly extensions: readonly MarkdownSyntaxExtension[];
  readonly sourceCodeUnits: number;
  readonly lineCount: number;
  readonly nodeCount: number;
  readonly maximumDepth: number;
  readonly resourceUsage: MarkdownResourceUsage;
}

export interface ParsedMarkdownDocument {
  readonly tree: MarkdownDocumentNode;
  readonly sourceText: string | null;
  readonly sourceIndex: MarkdownSourceIndex;
  readonly definitions: readonly MarkdownReferenceDefinition[];
  readonly footnotes: readonly MarkdownFootnoteDefinition[];
  readonly diagnostics: readonly MarkdownDiagnostic[];
  readonly metadata: MarkdownParseMetadata;
  definitionFor(label: string): MarkdownReferenceDefinition | null;
  footnoteFor(label: string): MarkdownFootnoteDefinition | null;
}

export function markdownLineCount(source: string): number {
  let count = 1;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) index += 1;
      count += 1;
    } else if (code === 0x0a) count += 1;
  }
  return count;
}

function optionDialect(value: MarkdownDialect | undefined): MarkdownDialect {
  if (value === undefined) return 'commonmark';
  if (value !== 'commonmark' && value !== 'gfm') {
    throw new MarkdownConfigurationError('dialect must be either "commonmark" or "gfm".');
  }
  return value;
}

function optionRetention(value: MarkdownSourceRetention | undefined): MarkdownSourceRetention {
  if (value === undefined) return 'text';
  if (value !== 'none' && value !== 'text') {
    throw new MarkdownConfigurationError('sourceRetention must be either "none" or "text".');
  }
  return value;
}

const syntaxExtensions = new Set<MarkdownSyntaxExtension>(['frontMatter', 'callouts', 'math']);

function optionExtensions(value: readonly MarkdownSyntaxExtension[] | undefined): readonly MarkdownSyntaxExtension[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new MarkdownConfigurationError('extensions must be an array.');
  const resolved: MarkdownSyntaxExtension[] = [];
  for (const extension of value) {
    if (!syntaxExtensions.has(extension)) {
      throw new MarkdownConfigurationError(`Unknown Markdown syntax extension: ${String(extension)}.`);
    }
    if (resolved.includes(extension)) {
      throw new MarkdownConfigurationError(`Markdown syntax extension is duplicated: ${extension}.`);
    }
    resolved.push(extension);
  }
  return Object.freeze(resolved);
}

export interface MarkdownParseInternals {
  readonly sourceOffset?: number;
  readonly documentLength?: number;
  readonly seed?: BlockParseSeed;
  nextId(): number;
}

/** Internal entry point used by editor sessions to parse a block-aligned suffix. */
export function parseMarkdownInternal(
  source: string,
  options: MarkdownParseOptions,
  internals: MarkdownParseInternals
): ParsedMarkdownDocument {
  const dialect = optionDialect(options.dialect);
  const sourceRetention = optionRetention(options.sourceRetention);
  const extensions = optionExtensions(options.extensions);
  const limits = resolveBudgets(options.budgets);
  const totalLines = markdownLineCount(source);
  const budget = new BudgetController(source.length, totalLines, limits);
  const converted = convertMarkdown(source, {
    dialect,
    extensions: new Set(extensions),
    seed: internals.seed ?? {},
    sourceOffset: internals.sourceOffset ?? 0,
    documentLength: internals.documentLength ?? source.length,
    budget,
    nextId: internals.nextId
  });
  const usage = budget.usage();
  const definitionLookup = new Map(converted.definitions.map((definition) => [definition.normalizedLabel, definition]));
  const footnoteLookup = new Map(converted.footnotes.map((footnote) => [footnote.normalizedLabel, footnote]));
  const metadata: MarkdownParseMetadata = Object.freeze({
    dialect,
    commonMarkVersion: '0.31.2',
    gfmVersion: dialect === 'gfm' ? '0.29.0.gfm.13' : null,
    extensions,
    sourceCodeUnits: source.length,
    lineCount: totalLines,
    nodeCount: usage.nodes,
    maximumDepth: usage.maximumDepth,
    resourceUsage: usage
  });
  return Object.freeze({
    tree: converted.tree,
    sourceText: sourceRetention === 'text' ? source : null,
    sourceIndex: createMarkdownSourceIndex(source),
    definitions: converted.definitions,
    footnotes: converted.footnotes,
    diagnostics: converted.diagnostics,
    metadata,
    definitionFor(label: string): MarkdownReferenceDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return definitionLookup.get(normalizeMarkdownIdentifier(label)) ?? null;
    },
    footnoteFor(label: string): MarkdownFootnoteDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return footnoteLookup.get(normalizeMarkdownIdentifier(label)) ?? null;
    }
  });
}

/** Parse an exact Markdown source string into an immutable source-aware tree. */
export function parseMarkdown(source: string, options: MarkdownParseOptions = {}): ParsedMarkdownDocument {
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object.');
  let nextNodeId = 1;
  return parseMarkdownInternal(source, options, { nextId: () => nextNodeId++ });
}
