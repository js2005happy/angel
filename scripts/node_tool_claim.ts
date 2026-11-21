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
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, statfsSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export class ClaimUnavailable extends Error {
  constructor() { super("Operation already claimed or claim storage is unsafe; manual reconciliation required"); }
}

export interface OperationClaim {
  operationId: string;
  claimId: string;
  state: "unknown";
}

/** Preflight only: does not bind a stable directory handle against races. */
function checkPrivateDirectory(directory: string): void {
  // Windows junctions and other reparse points cannot be reliably rejected
  // by this path-based lstat preflight. Disable claims rather than accept a
  // potentially redirected storage location until handle-based checks exist.
  if (process.platform === "win32") throw new ClaimUnavailable();
  if (!isAbsolute(directory)) throw new ClaimUnavailable();
  let current = resolve(directory);
  const leaf = current;
  for (;;) {
    let info;
    try { info = lstatSync(current); } catch { throw new ClaimUnavailable(); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ClaimUnavailable();
    // A writable ancestor can redirect the claim path after preflight.
    // Reject it even when sticky (e.g. /tmp); only root or this user
    // may own ancestors. The leaf must remain private to this user.
    const uid = process.getuid?.();
    if (uid === undefined || (info.uid !== uid && info.uid !== 0) ||
        (info.mode & 0o022) !== 0 ||
        (current === leaf && (info.uid !== uid || (info.mode & 0o077) !== 0))) {
      throw new ClaimUnavailable();
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Fail closed. No automatic stale-claim recovery or re-execution. */
export function claimOperation(directory: string, operationId: string): OperationClaim {
  // Validate the runtime type before RegExp.test: JavaScript coerces numbers,
  // arrays and objects to strings, which could alias another operation ID.
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) throw new ClaimUnavailable();
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new ClaimUnavailable();
  // Caller must provision a private, stable parent. Do not create ancestors.
  checkPrivateDirectory(directory);
  const filename = createHash("sha256").update(operationId).digest("hex") + ".claim";
  const claimId = randomUUID();
  // Bind the directory identity before creation, not only after writing.
  // This detects some replacements but is NOT an openat-style guarantee.
  // Linux procfs exposes a stable descriptor-relative path. Keep the directory
  // fd open through O_EXCL creation so a renamed ancestor cannot redirect it.
  // This is Linux-only; do not silently fall back to a racy pathname on other OSes.
  if (process.platform !== "linux") throw new ClaimUnavailable();
  // /proc/self/fd must be backed by the kernel procfs, not a bind-mounted or
  // user-controlled lookalike. Linux PROC_SUPER_MAGIC is 0x9fa0.
  // A mount-namespace adversary can still alter mounts after this preflight;
  // callers must not treat this as a sandbox or hostile-namespace defense.
  try {
    if (statfsSync("/proc/self/fd").type !== 0x9fa0) throw new ClaimUnavailable();
  } catch { throw new ClaimUnavailable(); }
  let before;
  let fd: number;
  let directoryFd: number;
  let claimNameAtFd: string;
  try {
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      before = fstatSync(directoryFd);
      const named = lstatSync(directory);
      if (!before.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
          before.dev !== named.dev || before.ino !== named.ino ||
          before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) throw new ClaimUnavailable();
      // /proc/self/fd/N is resolved by the kernel against the open directory,
      // not by traversing the original directory pathname again.
      claimNameAtFd = `/proc/self/fd/${directoryFd}/${filename}`;
      fd = openSync(claimNameAtFd,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) { closeSync(directoryFd); throw error; }
  } catch { throw new ClaimUnavailable(); }
  let claimFileIdentity: { dev: number; ino: number; size: number } | undefined;
  let writeFailed = false;
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
    // Resolve the claim name against the still-open directory fd, not a pathname
    // that could have been replaced after creation.
    // Verify the reserved name still identifies the exact regular file we wrote.
    // This detects some local replacement/tampering, not an atomic openat binding.
    const opened = fstatSync(fd);
    const named = lstatSync(claimNameAtFd);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
        opened.dev !== named.dev || opened.ino !== named.ino ||
        opened.nlink !== 1 || named.nlink !== 1 ||
        opened.uid !== process.getuid?.() || named.uid !== opened.uid ||
        (opened.mode & 0o077) !== 0 || (named.mode & 0o077) !== 0 ||
        opened.size !== data.length || named.size !== data.length) {
      throw new ClaimUnavailable();
    }
    claimFileIdentity = { dev: opened.dev, ino: opened.ino, size: opened.size };
  } catch {
    // Never unlink: a partial claim is also a reason to block replay.
    writeFailed = true;
  } finally {
    // Always attempt to close the claim file, even when writing/fsync failed.
    // A close failure makes durability unknown; never report a successful claim.
    try { closeSync(fd); } catch { writeFailed = true; }
    if (writeFailed) {
      // Release the directory exactly once on this error path. Do not let
      // cleanup failures hide the original unknown outcome.
      try { closeSync(directoryFd); } catch { /* unavailable */ }
    }
    // On success keep directoryFd open for directory fsync and name checks.
  }
  if (writeFailed) throw new ClaimUnavailable();
  if (!claimFileIdentity) { closeSync(directoryFd); throw new ClaimUnavailable(); }
  // Sync the SAME directory descriptor used for exclusive creation. A path
  // reopen could sync a replacement directory instead of the reserved inode.
  // Directory durability still depends on the underlying filesystem.
  try {
    const dirfd = directoryFd;
    {
      const opened = fstatSync(dirfd);
      const named = lstatSync(directory);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new ClaimUnavailable();
      if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
          opened.dev !== named.dev || opened.ino !== named.ino ||
          opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0) {
        throw new ClaimUnavailable();
      }
      fsyncSync(dirfd);
      const after = lstatSync(directory);
      if (after.dev !== opened.dev || after.ino !== opened.ino ||
          !after.isDirectory() || after.isSymbolicLink()) throw new ClaimUnavailable();
      // Recheck through the same directory fd after syncing. This only detects
      // replacement at this instant; it is not an openat-style atomic binding.
      const claimNamed = lstatSync(claimNameAtFd);
      if (!claimNamed.isFile() || claimNamed.isSymbolicLink() ||
          claimNamed.dev !== claimFileIdentity.dev || claimNamed.ino !== claimFileIdentity.ino ||
          claimNamed.nlink !== 1 || claimNamed.uid !== process.getuid?.() ||
          (claimNamed.mode & 0o077) !== 0 || claimNamed.size !== claimFileIdentity.size) {
        throw new ClaimUnavailable();
      }
    }
  } catch { throw new ClaimUnavailable(); }
  finally { closeSync(directoryFd); }
  return { operationId, claimId, state: "unknown" };
}
