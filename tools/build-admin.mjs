import { cp, mkdir } from 'node:fs/promises';
const target = new URL('../dist/plugins/rest/admin/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL('../src/plugins/rest/admin/', import.meta.url), target, { recursive: true });
