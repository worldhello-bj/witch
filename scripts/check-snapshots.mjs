import fs from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
for (const name of await fs.readdir(new URL('../current-source/', import.meta.url))) {
  if (!name.endsWith('.ts')) continue;
  const source = await fs.readFile(new URL(`../current-source/${name}`, import.meta.url), 'utf8');
  stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: name });
  console.log(`TypeScript syntax/transformation passed: ${name}`);
}
console.log('This is a syntax check, not a whole-application type check.');
