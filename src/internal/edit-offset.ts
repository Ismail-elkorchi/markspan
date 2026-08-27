import type { SourceSpan } from '../model.js';

export interface OrderedSourceEdit {
  readonly span: SourceSpan;
  readonly text: string;
}

export type SourceOffsetAffinity = 'backward' | 'forward';

/** Map an offset through edits sorted by source position and input order. */
export function mapOrderedSourceOffset(
  offset: number,
  edits: readonly OrderedSourceEdit[],
  affinity: SourceOffsetAffinity
): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.span.start) break;
    if (edit.span.start === edit.span.end && offset === edit.span.start) {
      if (affinity === 'backward') return offset + delta;
      delta += edit.text.length;
      continue;
    }
    if (offset >= edit.span.end) {
      delta += edit.text.length - (edit.span.end - edit.span.start);
      continue;
    }
    return edit.span.start + delta + (affinity === 'forward' ? edit.text.length : 0);
  }
  return offset + delta;
}
