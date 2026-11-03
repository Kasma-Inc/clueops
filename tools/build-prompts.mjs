import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Embed authored Markdown into generated TS before tsc; no runtime asset paths.
const source = fileURLToPath(new URL('../prompts/', import.meta.url));
const output = fileURLToPath(new URL('../src/generated/prompts/', import.meta.url));
async function compile(directory = '') {
  for (const entry of await readdir(path.join(source, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await compile(relative);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const text = await readFile(path.join(source, relative), 'utf8');
      const file = path.join(output, relative.replace(/\.md$/, '.ts'));
      const code =
        '// Generated from prompts/' +
        relative +
        '; do not edit.\nexport default ' +
        JSON.stringify(text) +
        ';\n';
      await mkdir(path.dirname(file), { recursive: true });
      let previous;
      try {
        previous = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (previous !== code) await writeFile(file, code);
    }
  }
}
await compile();
