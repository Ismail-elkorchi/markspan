import {
  MarkdownBudgetExceededError,
  MarkdownConfigurationError,
  type MarkdownBudgetName
} from '../errors.js';
import {
  defaultMarkdownParseBudgets,
  type MarkdownParseBudgets,
  type MarkdownResourceUsage,
  type ResolvedMarkdownParseBudgets
} from '../options.js';

function resolveLimit(
  value: number | undefined,
  fallback: number,
  name: MarkdownBudgetName
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new MarkdownConfigurationError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

export function resolveBudgets(value: MarkdownParseBudgets | undefined): ResolvedMarkdownParseBudgets {
  return Object.freeze({
    maxInputCodeUnits: resolveLimit(
      value?.maxInputCodeUnits,
      defaultMarkdownParseBudgets.maxInputCodeUnits,
      'maxInputCodeUnits'
    ),
    maxLines: resolveLimit(value?.maxLines, defaultMarkdownParseBudgets.maxLines, 'maxLines'),
    maxNodes: resolveLimit(value?.maxNodes, defaultMarkdownParseBudgets.maxNodes, 'maxNodes'),
    maxDepth: resolveLimit(value?.maxDepth, defaultMarkdownParseBudgets.maxDepth, 'maxDepth')
  });
}

export class BudgetController {
  readonly limits: ResolvedMarkdownParseBudgets;
  private nodeCount = 0;
  private depthMaximum = 0;
  private readonly lines: number;
  private readonly inputLength: number;

  constructor(
    inputLength: number,
    lineCount: number,
    limits: ResolvedMarkdownParseBudgets
  ) {
    this.inputLength = inputLength;
    this.lines = lineCount;
    this.limits = limits;
    if (inputLength > limits.maxInputCodeUnits) {
      throw new MarkdownBudgetExceededError('maxInputCodeUnits', limits.maxInputCodeUnits, inputLength);
    }
    if (lineCount > limits.maxLines) {
      throw new MarkdownBudgetExceededError('maxLines', limits.maxLines, lineCount);
    }
  }

  depth(depth: number): void {
    if (depth > this.depthMaximum) this.depthMaximum = depth;
    if (depth > this.limits.maxDepth) {
      throw new MarkdownBudgetExceededError('maxDepth', this.limits.maxDepth, depth);
    }
  }

  node(depth: number): void {
    this.nodeCount += 1;
    if (this.nodeCount > this.limits.maxNodes) {
      throw new MarkdownBudgetExceededError('maxNodes', this.limits.maxNodes, this.nodeCount);
    }
    this.depth(depth);
  }

  usage(): MarkdownResourceUsage {
    return Object.freeze({
      inputCodeUnits: this.inputLength,
      lines: this.lines,
      nodes: this.nodeCount,
      maximumDepth: this.depthMaximum
    });
  }
}
