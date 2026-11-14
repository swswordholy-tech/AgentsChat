/**
 * Host half of agentschat-identity (generation 2).
 *
 * The Client module owns everything the user sees; this half exists so the row
 * mounts in the Loader (which is also how `dsh.client` is discovered). It also
 * writes a one-line liveness marker, because "the chip is not on screen" has two
 * very different causes — the row never loaded, or the browser module never ran
 * — and without a marker from each half there is no way to tell them apart.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_LOG_BYTES = 256 * 1024;
const DARWIN_ROOT_LINKS = new Set(['/var', '/tmp', '/etc']);

function checkDirectories(directory) {
  let path = resolve(directory);
  for (;;) {
    const stat = lstatSync(path);
    const systemLink = process.platform === 'darwin' && DARWIN_ROOT_LINKS.has(path) && stat.isSymbolicLink();
    if (!systemLink && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error('Refusing symlinked or non-directory log ancestor');
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
}

export function apply(_ctx, { homeDir = homedir() } = {}) {
  let fd;
  try {
    const directory = resolve(homeDir, '.dsh');
    checkDirectories(directory);
    // Check the physical path too, including ancestors behind Darwin system links.
    checkDirectories(realpathSync(directory));
    const path = join(directory, 'agentschat-identity-host.log');
    let target;
    try { target = lstatSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (target && (!target.isFile() || target.isSymbolicLink() || target.size >= MAX_LOG_BYTES)) return;
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (target ? 0 : constants.O_CREAT | constants.O_EXCL);
    fd = openSync(path, flags, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || (target && (opened.dev !== target.dev || opened.ino !== target.ino))) return;
    checkDirectories(directory);
    checkDirectories(realpathSync(directory));
    const line = `${new Date().toISOString()} host half applied\n`;
    if (opened.size + Buffer.byteLength(line) > MAX_LOG_BYTES) return;
    writeSync(fd, line);
  } catch {} finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}
