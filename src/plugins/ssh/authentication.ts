import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import type { PluginContext } from '../../plugin-api/index.js';
import { objectSchema } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { credentialSchema, privateRedactor, text } from '../shared.js';
import { validatePrivatePaths } from '../private-paths.js';

export interface Authentication {
  type: 'password' | 'private-key' | 'private-key+password';
  privateKeyFile?: string;
  password?: string;
  passwordFile?: string;
  passphrase?: string;
  passphraseFile?: string;
}
const passwordFields = { password: text, passwordFile: text };
const keyFields = { privateKeyFile: text, passphrase: text, passphraseFile: text };
const noDoublePassphrase = {
  not: {
    properties: { passphrase: {}, passphraseFile: {} },
    required: ['passphrase', 'passphraseFile'],
  },
};
export const authenticationSchema = {
  oneOf: [
    credentialSchema(
      { type: { const: 'password' }, ...passwordFields },
      ['type'],
      'password',
      'passwordFile',
    ),
    {
      ...objectSchema({ type: { const: 'private-key' }, ...keyFields }),
      required: ['type', 'privateKeyFile'],
      ...noDoublePassphrase,
    },
    {
      ...credentialSchema(
        { type: { const: 'private-key+password' }, ...keyFields, ...passwordFields },
        ['type', 'privateKeyFile'],
        'password',
        'passwordFile',
      ),
      ...noDoublePassphrase,
    },
  ],
};
export function configuredPath(file: string, context: PluginContext): string {
  return file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : context.resolvePath(file);
}
async function boundedFile(file: string, context: PluginContext): Promise<Buffer> {
  try {
    const actual = configuredPath(file, context);
    const info = await stat(actual);
    if (!info.isFile() || info.size > 1048576) throw new Error();
    const data = await readFile(actual);
    if (data.length > 1048576) throw new Error();
    return data;
  } catch {
    throw new HostError('SSH_CREDENTIAL_FILE_INVALID');
  }
}
export async function authentication(config: Authentication, context: PluginContext) {
  const app = fileURLToPath(new URL('../../../', import.meta.url));
  await validatePrivatePaths(
    [
      context.configFile,
      ...[config.privateKeyFile, config.passwordFile, config.passphraseFile]
        .filter((p): p is string => p !== undefined)
        .map((p) => configuredPath(p, context)),
    ],
    ['src', 'dist', 'tools', 'node_modules'].map((p) => path.join(app, p)),
  );
  const secret = async (value: string | undefined, file: string | undefined) => {
    if ((value !== undefined) === (file !== undefined))
      throw new HostError('SSH_AUTH_SECRET_INVALID');
    if (value !== undefined) return value;
    try {
      // Text files may end in one LF/CRLF. Spaces are part of the credential.
      const result = new TextDecoder('utf-8', { fatal: true })
        .decode(await boundedFile(file!, context))
        .replace(/\r?\n$/, '');
      if (!result.length) throw new Error();
      return result;
    } catch {
      throw new HostError('SSH_AUTH_SECRET_INVALID');
    }
  };
  const password =
    config.type !== 'private-key' ? await secret(config.password, config.passwordFile) : undefined;
  const passphrase =
    config.passphrase !== undefined || config.passphraseFile !== undefined
      ? await secret(config.passphrase, config.passphraseFile)
      : undefined;
  const privateKey =
    config.type !== 'password' ? await boundedFile(config.privateKeyFile!, context) : undefined;
  if (privateKey) {
    const parsed = utils.parseKey(privateKey, passphrase);
    if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey())
      throw new HostError('SSH_PRIVATE_KEY_INVALID');
  }
  const keyText = privateKey?.toString('utf8').trim();
  const redactor = privateRedactor(
    [
      ...(password ? [password] : []),
      ...(passphrase ? [passphrase] : []),
      ...(keyText
        ? [keyText, ...keyText.split(/\r?\n/).filter((line) => line && !line.startsWith('---'))]
        : []),
    ],
    context,
  );
  return { password, passphrase, privateKey, redactor };
}

/** Parse the existing OpenSSH trust file; never fetch or accept unknown host keys. */
export async function hostKeys(host: string, port: number, file: string, context: PluginContext) {
  try {
    await boundedFile(file, context);
    const { stdout } = await promisify(execFile)(
      '/usr/bin/ssh-keygen',
      ['-F', port === 22 ? host : `[${host}]:${port}`, '-f', configuredPath(file, context)],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 5000, maxBuffer: 65536 },
    );
    const allowed = new Set<string>(),
      revoked = new Set<string>();
    for (const line of stdout.split('\n').filter((line) => line && !line.startsWith('#'))) {
      const fields = line.trim().split(/\s+/);
      const marker = fields[0]!.startsWith('@') ? fields.shift() : undefined;
      if (marker && marker !== '@revoked') continue;
      const key = Buffer.from(fields[2] ?? '', 'base64');
      const parsed = utils.parseKey(`${fields[1]} ${fields[2]}`);
      if (parsed instanceof Error || !key.length) throw new Error();
      (marker === '@revoked' ? revoked : allowed).add(
        createHash('sha256').update(key).digest('hex'),
      );
    }
    for (const key of revoked) allowed.delete(key);
    if (!allowed.size) throw new Error();
    return {
      fingerprints: [...allowed].sort(),
      verify: (key: string) => allowed.has(key) && !revoked.has(key),
    };
  } catch {
    throw new HostError('SSH_HOST_KEYS_INVALID');
  }
}
