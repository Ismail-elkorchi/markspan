import type { MarkdownSourceIndex } from '../source.js';

const scanLengths = new WeakMap<object, number>();

export function recordMarkdownSourceIndexScanLength(index: MarkdownSourceIndex, length: number): void {
  scanLengths.set(index, length);
}

export function markdownSourceIndexScanLength(index: MarkdownSourceIndex): number {
  return scanLengths.get(index) ?? 0;
}
