#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// SDK 0.166.0 does not expose --strict-config. Keep this tiny launcher at the adapter boundary.
const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
const triple = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
const packageRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
const platformPackage = packageRequire.resolve(
  `@openai/codex-${process.platform}-${process.arch}/package.json`,
);
const binary = path.join(path.dirname(platformPackage), 'vendor', triple, 'bin', 'codex');
const args = process.argv.slice(2);
const child = spawn(
  binary,
  [
    args[0],
    '--strict-config',
    ...(args[0] === 'exec' ? ['--ignore-user-config'] : []),
    ...args.slice(1),
  ],
  {
    env: process.env,
    stdio: 'inherit',
  },
);
const pidFile = process.env.INCIDENT_CODEX_PID_FILE;
if (pidFile)
  writeFileSync(pidFile, JSON.stringify({ launcher: process.pid, child: child.pid }), {
    mode: 0o600,
  });
let timer;
let forcedKill = false;
// SIGINT lets the native CLI cancel its sandboxed commands before exiting.
function terminate() {
  child.kill('SIGINT');
  timer ??= setTimeout(() => {
    forcedKill = true;
    child.kill('SIGKILL');
  }, 2000);
}
// Unified command execution can create its own session and be reparented to PID 1.
// A run-specific marker survives ordinary forks/execs, unlike the parent PID tree.
const marker = pidFile ? 'INCIDENT_CODEX_PID_FILE=' + pidFile : undefined;
function ps(args) {
  return execFileSync('/bin/ps', args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 1000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
async function tagged(pid) {
  if (!marker || pid === process.pid) return false;
  try {
    if (process.platform === 'linux') {
      const environment = await readFile('/proc/' + pid + '/environ');
      return environment.toString().split('\0').includes(marker);
    }
    return ps(['eww', '-p', String(pid), '-o', 'command=']).includes(marker);
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code) || error.status === 1)
      return false;
    throw error;
  }
}
async function taggedProcesses() {
  if (!marker) return [];
  if (process.platform === 'linux') {
    const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
    const matches = await Promise.all(
      entries.map(async (entry) => {
        const pid = Number(entry);
        return (await tagged(pid)) ? pid : undefined;
      }),
    );
    return matches.filter((pid) => pid !== undefined);
  }
  return ps(['eww', '-axo', 'pid=,command='])
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}
async function signalTagged(signal) {
  for (const pid of await taggedProcesses()) {
    // Recheck the unique marker before each signal; never reuse a stale captured PID.
    if (!(await tagged(pid))) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
async function drainProcesses(signal, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const remaining = await taggedProcesses();
    if (!remaining.length) return true;
    await signalTagged(signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  return !(await taggedProcesses()).length;
}
let finishing;
function cleanup(code) {
  if (finishing) return;
  clearTimeout(timer);
  finishing = (async () => {
    try {
      if (!(await drainProcesses('SIGTERM', 1500)) && !(await drainProcesses('SIGKILL', 1000)))
        throw new Error('Native command cleanup unconfirmed');
      // macOS may hide sandboxed process environments. A forced CLI exit cannot
      // prove its commands stopped, even if the marker scan finds nothing.
      if (forcedKill) throw new Error('Native command cleanup unconfirmed');
      if (pidFile) unlinkSync(pidFile);
      process.exit(code ?? 1);
    } catch {
      // Keep the PID file: the adapter must not report successful cleanup.
      process.exit(1);
    }
  })();
}
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
child.on('error', () => {
  cleanup(1);
});
child.on('exit', (code, signal) => {
  if (signal) forcedKill = true;
  cleanup(code);
});
