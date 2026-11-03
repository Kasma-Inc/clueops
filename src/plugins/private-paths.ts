import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HostError } from '../core/errors.js';

export const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};
export async function canonicalPath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  try {
    return await realpath(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === absolute) throw error;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}
export function systemRuntimeRoots(): readonly string[] {
  return process.platform === 'darwin'
    ? [
        '/bin',
        '/sbin',
        '/usr',
        '/etc',
        '/System',
        '/Library',
        '/Applications',
        '/private/var/db',
        '/opt/homebrew/lib',
        '/dev',
      ]
    : [
        '/bin',
        '/sbin',
        '/usr',
        '/etc',
        '/lib',
        '/lib64',
        '/nix/store',
        '/run/current-system/sw',
        '/dev',
      ];
}

/** Private configuration must stay outside the OS/runtime files tools may read. */
export async function validatePrivatePaths(
  paths: readonly string[],
  runtime: readonly string[] = [],
): Promise<string[]> {
  const protectedRoots = await Promise.all(paths.map(canonicalPath));
  const automaticReads = await Promise.all(
    [...systemRuntimeRoots(), ...runtime].map(canonicalPath),
  );
  if (
    protectedRoots.some((file) =>
      automaticReads.some((root) => contains(root, file) || contains(file, root)),
    )
  )
    throw new HostError('FILESYSTEM_PRIVATE_RUNTIME');
  return protectedRoots;
}
