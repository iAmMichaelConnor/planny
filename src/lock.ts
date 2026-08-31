import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Advisory cross-process write lock for a store. Every mutation runs its
 * whole load-mutate-save span inside withLock, so two planny processes (two
 * CLIs, or the CLI and the serve UI) cannot interleave and drop updates.
 *
 * The lock is a file created with O_EXCL. A crashed process leaves it
 * behind; anything older than the stale threshold is broken and replaced.
 * In-process concurrency needs no handling: operations are synchronous.
 */

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_MS = 25;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(root: string, fn: () => T): T {
  const lockPath = join(root, '.planny', 'lock');
  const timeout = Number(process.env.PLANNY_LOCK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const staleAfter = Number(process.env.PLANNY_LOCK_STALE_MS ?? DEFAULT_STALE_MS);
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleAfter) {
          unlinkSync(lockPath); // stale: holder is gone
          continue;
        }
      } catch {
        continue; // the holder released between our check and stat: retry now
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the store is locked by another planny process — retry, or delete ${lockPath} if none is running`,
        );
      }
      sleep(RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone (broken as stale by a waiter) — nothing to release
    }
  }
}
