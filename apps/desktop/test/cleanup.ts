import { rmSync } from 'node:fs';

/**
 * Removes a test's temporary folder. On Windows a child process that is still exiting (an agent, Git) can hold a
 * file open for a moment, so `rmSync` fails with EPERM or EBUSY; retry, and never fail a test over a leftover
 * folder in the temp directory.
 */
export function removeTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // left for the OS to clean
  }
}
