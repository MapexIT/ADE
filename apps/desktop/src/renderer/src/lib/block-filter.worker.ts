/** SM-20: runs a user's regular expression away from the window; the page terminates it after the budget. */
import { tryFilterLines, type WorkerRequest } from './block-filter.ts';

const scope = self as unknown as { onmessage: ((e: { data: WorkerRequest }) => void) | null; postMessage(message: unknown): void };

scope.onmessage = (e) => {
  scope.postMessage(tryFilterLines(e.data.lines, e.data.opts));
};
