export type MarkdownParserErrorCode =
  | 'ERR_MARKDOWN_CONFIGURATION'
  | 'ERR_MARKDOWN_BUDGET_EXCEEDED';

export class MarkdownParserError extends Error {
  readonly code: MarkdownParserErrorCode;

  constructor(message: string, code: MarkdownParserErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MarkdownParserError';
    this.code = code;
  }
}

export class MarkdownConfigurationError extends MarkdownParserError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'ERR_MARKDOWN_CONFIGURATION', options);
    this.name = 'MarkdownConfigurationError';
  }
}

export type MarkdownBudgetName =
  | 'maxInputCodeUnits'
  | 'maxLines'
  | 'maxNodes'
  | 'maxDepth';

export class MarkdownBudgetExceededError extends MarkdownParserError {
  readonly budget: MarkdownBudgetName;
  readonly limit: number;
  readonly observed: number;

  constructor(budget: MarkdownBudgetName, limit: number, observed: number) {
    super(
      `Markdown parsing exceeded ${budget}: observed ${observed}, limit ${limit}.`,
      'ERR_MARKDOWN_BUDGET_EXCEEDED'
    );
    this.name = 'MarkdownBudgetExceededError';
    this.budget = budget;
    this.limit = limit;
    this.observed = observed;
  }
}
