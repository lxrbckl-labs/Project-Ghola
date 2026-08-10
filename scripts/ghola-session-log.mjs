#!/usr/bin/env node
// ghola-session-log.mjs — Session log housekeeping.
// Nothing in the codebase calls this script anymore (the launcher spawn that
// used to invoke it has been removed). It is retained rather than deleted
// because Ghola never deletes files on operator instruction; the operator may
// repurpose or delete it later. It performs no writes: log cleanup was
// removed on operator instruction, and logs are kept indefinitely.

function main() {
  try {
    // Parse --dir <path> from argv (kept for interface compatibility with
    // the launcher's invocation; no longer used to gate or perform deletion).
    const dirIdx = process.argv.indexOf('--dir');
    if (dirIdx === -1 || dirIdx + 1 >= process.argv.length) {
      process.exit(0);
    }
    // No cleanup is performed. Logs accumulate until the operator removes
    // them manually.
  } catch (err) {
    process.stderr.write(
      `ghola-session-log: ${err.message}\n`,
    );
  }
}

main();
