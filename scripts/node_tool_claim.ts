/**
 * Experimental Node/Bun execution claim primitive; NOT wired into the runtime.
 * A successful claim reserves a unique operation ID in one trusted local directory.
 * Claims are intentionally never deleted or auto-expired: a crash leaves UNKNOWN,
 * not permission to repeat a potentially side-effecting tool call.
 *
 * Security boundary: the directory and its ancestors MUST be controlled by the
 * same trusted OS user. This is not a distributed lock, a sandbox, or a receipt
 * proving an external side effect. Never use on an untrusted/shared filesystem.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export class ClaimUnavailable extends Error {
  constructor() { super("Operation already claimed or claim storage is unsafe; manual reconciliation required"); }
}

export interface OperationClaim {
  operationId: string;
  claimId: string;
  state: "unknown";
}

/** Fail closed. No automatic stale-claim recovery or re-execution. */
export function claimOperation(directory: string, operationId: string): OperationClaim {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new ClaimUnavailable();
  // Caller must provision a private, stable parent. Do not create ancestors.
  let dir;
  try {
    dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new ClaimUnavailable();
  } catch { throw new ClaimUnavailable(); }
  const filename = createHash("sha256").update(operationId).digest("hex") + ".claim";
  const claimId = randomUUID();
  const path = join(directory, filename);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch { throw new ClaimUnavailable(); }
  try {
    const body = JSON.stringify({ version: 1, operationId, claimId, state: "unknown" }) + "\n";
    const data = Buffer.from(body, "utf8");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new ClaimUnavailable();
      offset += written;
    }
    fsyncSync(fd);
  } catch {
    // Never unlink: a partial claim is also a reason to block replay.
    throw new ClaimUnavailable();
  } finally {
    closeSync(fd);
  }
  // Directory durability varies by OS/filesystem; failure must not be treated
  // as a successful durable reservation.
  try {
    const dirfd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  } catch { throw new ClaimUnavailable(); }
  return { operationId, claimId, state: "unknown" };
}
