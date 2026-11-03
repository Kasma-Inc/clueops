import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SkillDescriptor } from '../../plugin-api/index.js';
import { installSkills, assertSkillSourcesSeparate } from '../../core/skills.js';
import { HostError } from '../../core/errors.js';

const exec = promisify(execFile);

export async function prepareSkillWorkspace(
  home: string,
  work: string,
  skills: readonly SkillDescriptor[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await assertSkillSourcesSeparate(skills, [home, work]);
  for (const directory of [
    home,
    path.join(home, '.codex'),
    path.join(home, '.agents'),
    work,
    path.join(work, '.agents'),
    path.join(work, '.codex'),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HostError('WORKSPACE_BOUNDARY_INVALID');
  }
  const roots = await Promise.all(
    [
      path.join(home, '.agents'),
      path.join(home, '.codex'),
      path.join(work, '.agents'),
      path.join(work, '.codex'),
    ].map(async (parent) => path.join(await realpath(parent), 'skills')),
  );
  await assertSkillSourcesSeparate(skills, roots);
  // A state directory inside the service repository must not inherit its parent skills/config.
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  try {
    const git = path.join(work, '.git');
    const info = await lstat(git).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info)
      await exec('git', ['init', '--quiet', '--initial-branch=main', '--template=', work], {
        env: environment,
        signal,
        timeout: 5000,
      });
    else if (!info.isDirectory() || info.isSymbolicLink())
      throw new HostError('WORKSPACE_BOUNDARY_INVALID');
    const result = await exec('git', ['-C', work, 'rev-parse', '--show-toplevel'], {
      env: environment,
      signal,
      timeout: 5000,
    });
    if ((await realpath(result.stdout.trim())) !== (await realpath(work)))
      throw new HostError('WORKSPACE_BOUNDARY_INVALID');
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HostError) throw error;
    throw new HostError('WORKSPACE_GIT_SETUP_FAILED');
  }
  await installSkills(skills, roots[0]!, signal);
  // This legacy discovery path is also session-owned, never the operator's home.
  for (const root of roots.slice(1)) await rm(root, { recursive: true, force: true });
  signal.throwIfAborted();
}
