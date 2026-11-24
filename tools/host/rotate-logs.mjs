// Usage: node tools/host/rotate-logs.mjs --dir <log-dir>
//        [--max-bytes <n, default 10485760>] [--keep <n, default 7>]
// launchd opens stdout and stderr logs for append, so writers continue at the
// new end after an in-place truncate. Writes between the copy and truncate can
// be lost, which is acceptable for operational logs. This is unverified on
// macOS launchd specifically; the runbook drill checks it.
// Run one rotator at a time in a log directory controlled by the service owner.

import {
  closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync,
  openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const safeOpen = constants.O_NOFOLLOW | constants.O_NONBLOCK;

function options() {
  const { values } = parseArgs({ options: {
    dir: { type: 'string' },
    'max-bytes': { type: 'string', default: '10485760' },
    keep: { type: 'string', default: '7' },
  } });
  const number = (text, minimum) => {
    const n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < minimum) {
      throw new Error('invalid number');
    }
    return n;
  };
  if (!values.dir) throw new Error('missing directory');
  return { dir: resolve(values.dir), maxBytes: number(values['max-bytes'], 0), keep: number(values.keep, 1) };
}

function rotateArchives(path, archives, keep, mode) {
  // Check all matching archive slots before modifying any of them.
  const entries = archives.map((suffix) => {
    const file = `${path}.${suffix}`;
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error(`not a regular archive: ${file}`);
    return { file, n: Number(suffix), mode: stat.mode & 0o7777 };
  });
  entries.sort((a, b) => b.n - a.n);
  for (const entry of entries) {
    if (entry.n >= keep) {
      unlinkSync(entry.file);
    } else {
      const restricted = entry.mode & mode;
      if (restricted !== entry.mode) {
        const fd = openSync(entry.file, constants.O_RDONLY | safeOpen);
        try {
          fchmodSync(fd, restricted);
        } finally {
          closeSync(fd);
        }
      }
      renameSync(entry.file, `${path}.${entry.n + 1}`);
    }
  }
}

function copyLog(source, archive, size, mode) {
  const dest = openSync(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | safeOpen, mode);
  let complete = false;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (let copied = 0; copied < size;) {
      const read = readSync(source, buffer, 0, Math.min(buffer.length, size - copied), null);
      if (read === 0) throw new Error('log shrank during copy');
      for (let written = 0; written < read;) {
        written += writeSync(dest, buffer, written, read - written);
      }
      copied += read;
    }
    fchmodSync(dest, mode);
    complete = true;
  } finally {
    closeSync(dest);
    if (!complete) unlinkSync(archive);
  }
}

function rotate(dir, names, name, maxBytes, keep) {
  const path = join(dir, name);
  const info = lstatSync(path);
  if (!info.isFile() || info.size <= maxBytes) return;

  const source = openSync(path, constants.O_RDWR | safeOpen);
  try {
    const { size, mode } = fstatSync(source);
    if (size <= maxBytes) return;
    const restricted = mode & 0o600;
    if ((mode & 0o7777) !== restricted) fchmodSync(source, restricted);
    const prefix = `${name}.`;
    const archives = names.filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length)).filter((suffix) => /^[1-9]\d*$/.test(suffix));
    rotateArchives(path, archives, keep, restricted);
    copyLog(source, `${path}.1`, size, restricted);
    ftruncateSync(source, 0);
    console.log(`rotated  ${name}  ${size}`);
  } finally {
    closeSync(source);
  }
}

let config;
try {
  config = options();
} catch {
  console.error('usage: rotate-logs.mjs --dir <log-dir> [--max-bytes <n>] [--keep <n>]');
  process.exit(2);
}

try {
  const { dir, maxBytes, keep } = config;
  if (!lstatSync(dir).isDirectory()) throw new Error(`not a log directory: ${dir}`);
  const names = readdirSync(dir);
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      rotate(dir, names, name, maxBytes, keep);
    } catch (error) {
      console.error(`${name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
