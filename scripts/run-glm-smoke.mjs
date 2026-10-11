import fs from 'node:fs/promises';
import { loadSnapshot } from '../tests/support/load-snapshot.mjs';
// Execute the supplied smoke against the real GLM snapshot. The only missing
// runtime import, buildBrainPrompt, is the explicit test double in loadSnapshot.
globalThis.__witchGlmSnapshot = await loadSnapshot('glm');
let smoke = await fs.readFile(new URL('../current-source/glm-smoke.mjs', import.meta.url), 'utf8');
smoke = smoke.replace(/import \{([^}]+)\} from "\.\.\/dist\/brain\/glm\.js";/,
  'const {$1} = globalThis.__witchGlmSnapshot;');
console.log('ISOLATED GLM SMOKE: personality prompt is a test double; no QQ/runtime/full-app claim.');
await import('data:text/javascript;base64,' + Buffer.from(smoke+'\n//# sourceURL=witch-isolated-glm-smoke.mjs').toString('base64'));
