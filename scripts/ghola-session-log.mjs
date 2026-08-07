#!/usr/bin/env node
// ghola-session-log.mjs — Clean up old session log files.
// Called at session start by the launcher. Deletes .txt files in the
// session-logs directory that are older than 7 days, but ONLY on Monday
// (so logs accumulate during the week and get cleaned at the start of
// the next).

import * as fs from 'fs';
import * as path from 'path';

/** Maximum age in milliseconds: 7 days. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function main() {
  try {
    // Parse --dir <path> from argv.
    const dirIdx = process.argv.indexOf('--dir');
    if (dirIdx === -1 || dirIdx + 1 >= process.argv.length) {
      process.exit(0);
    }
    const dir = process.argv[dirIdx + 1];

    // Only run cleanup on Monday (day 1).
    if (new Date().getDay() !== 1) {
      process.exit(0);
    }

    if (!fs.existsSync(dir)) {
      process.exit(0);
    }

    const now = Date.now();
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.txt')) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        process.stderr.write(
          `ghola-session-log: failed to process ${entry}: ${err.message}\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `ghola-session-log: ${err.message}\n`,
    );
  }
}

main();
