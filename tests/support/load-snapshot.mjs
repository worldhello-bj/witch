import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The handoff omits personality/prompt.ts. This explicit test double supplies
// only that import; it is never distributed as production implementation.
const promptDouble = 'data:text/javascript,' + encodeURIComponent(`
export function buildBrainPrompt(personality, request, context) {
  return [personality.instructions, '当前大脑提供商：' + context.provider,
    '当前模型：' + context.model, request.text, JSON.stringify(request.history ?? [])].join('\\n');
}`);
async function snapshotUrl(name, internalExports = []) {
  const ref = process.env.WITCH_BASELINE_REF;
  const file = `current-source/${name}.ts`;
  let source = ref
    ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' })
    : await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  if (name === "config") source = source.replace('import "dotenv/config";', "// Explicit test boundary: environment values are supplied by the test, not .env.");
  source = source.replace('"../personality/prompt.js"', JSON.stringify(promptDouble));
  for (const dependency of ['http-json']) {
    if (source.includes(`"./${dependency}.js"`))
      source = source.replaceAll(`"./${dependency}.js"`, JSON.stringify(await snapshotUrl(dependency)));
  }
  const code = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: file })
    + (internalExports.length ? `\nexport { ${internalExports.join(', ')} };` : '')
    + `\n//# sourceURL=witch-snapshot-${name}.js`;
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}

export async function loadSnapshot(name, internalExports = []) {
  return import(await snapshotUrl(name, internalExports));
}
