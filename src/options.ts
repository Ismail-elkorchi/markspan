export type MarkdownDialect = 'commonmark' | 'gfm';
export type MarkdownSourceRetention = 'none' | 'text';

export interface MarkdownParseBudgets {
  /** Maximum JavaScript UTF-16 code units accepted as input. */
  readonly maxInputCodeUnits?: number;
  readonly maxLines?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

export interface ResolvedMarkdownParseBudgets {
  readonly maxInputCodeUnits: number;
  readonly maxLines: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}

export interface MarkdownParseOptions {
  /** CommonMark is the conservative default. */
  readonly dialect?: MarkdownDialect;
  /** Retain the exact source string on the result. */
  readonly sourceRetention?: MarkdownSourceRetention;
  readonly budgets?: MarkdownParseBudgets;
}

export interface MarkdownResourceUsage {
  readonly inputCodeUnits: number;
  readonly lines: number;
  readonly nodes: number;
  readonly maximumDepth: number;
}

export const defaultMarkdownParseBudgets: ResolvedMarkdownParseBudgets = Object.freeze({
  maxInputCodeUnits: 10_000_000,
  maxLines: 1_000_000,
  maxNodes: 1_000_000,
  maxDepth: 256
});
