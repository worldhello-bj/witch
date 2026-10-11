import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const dest=path.join(root,'.harness/typecheck');
for (const directory of ['src/brain','src/personality','src/runtime','src/memory']) await fs.mkdir(path.join(dest,directory),{recursive:true});
for (const [from,to] of [['config.ts','config.ts'],['http-json.ts','brain/http-json.ts'],['glm.ts','brain/glm.ts'],['web-search.ts','brain/web-search.ts'],['types.ts','types.ts']])
 await fs.copyFile(path.join(root,'current-source',from),path.join(dest,'src',to));
// The handoff lacks these app modules. Type-only declarations describe only the
// imported boundary used by the supplied search code. This is not an app build.
await fs.writeFile(path.join(dest,'src/optional-dependencies.d.ts'),'declare module "dotenv/config";\n');
await fs.writeFile(path.join(dest,'src/personality.d.ts'),'export interface Personality { id: string; version: string; sourcePath: string; instructions: string; }\n');
await fs.writeFile(path.join(dest,'src/personality/prompt.d.ts'),`import type {Personality} from '../personality.js';
import type {BrainRequest} from '../types.js';
export declare function buildBrainPrompt(personality: Personality, request: BrainRequest, context: {provider:string;model:string;capabilities:string[]}): string;\n`);
await fs.writeFile(path.join(dest,'src/memory/types.d.ts'),'export interface MemoryContext { readonly __omittedApplicationBoundary?: never; }\n');
await fs.writeFile(path.join(dest,'src/runtime/types.d.ts'),`import type {BrainRequest,BrainResponse} from '../types.js';
export interface TurnContext {request: BrainRequest;}
export interface TurnExtension {readonly id:string; apply(context:TurnContext):Promise<BrainResponse|undefined>;}\n`);
await fs.writeFile(path.join(dest,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noUncheckedIndexedAccess:true,noEmit:true,skipLibCheck:true,types:['node'],typeRoots:[path.join(root,'node_modules/@types')]},include:['src/**/*.ts']},null,2));
console.log('ISOLATED TYPE CHECK: glm.ts, web-search.ts, http-json.ts, config.ts, types.ts; omitted app imports are declaration-only test boundaries.');
const result=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'--project',path.join(dest,'tsconfig.json')],{stdio:'inherit'});
process.exitCode=result.status??1;
