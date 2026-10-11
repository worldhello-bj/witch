import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const baseline='da37de9dba2b460000e822a1613465f55671626a';
const manifest=execFileSync('git',['show',`${baseline}:MANIFEST.csv`],{encoding:'utf8'}).trim().split(/\r?\n/).slice(1);
const sha=buffer=>createHash('sha256').update(buffer).digest('hex').toUpperCase();
const files=manifest.map(row=>{
 const [,raw,expectedSha,expectedBytes]=row.match(/^"([^"]+)","([^"]+)","(\d+)"$/);
 const path=raw.replaceAll('\\','/');const bytes=execFileSync('git',['show',`${baseline}:${path}`]);
 return {path,expectedBytes:Number(expectedBytes),actualBytes:bytes.length,expectedSha256:expectedSha,actualSha256:sha(bytes),matches:sha(bytes)===expectedSha,matchesAfterCRLFRestoration:sha(Buffer.from(bytes.toString().replaceAll('\n','\r\n')))===expectedSha};
});
const result={baseline,scope:'Original committed handoff bytes, before this repair',files,exactMatches:files.filter(x=>x.matches).length,total:files.length,missingApplicationFiles:['package.json (original application)','tsconfig.json (original application)','src/personality.ts','src/personality/prompt.ts','src/runtime/turn-runtime.ts','scripts/web-search-stage-artifacts.mjs','scripts/web-search-live-budget.mjs','runtime saved answer/source reports'],originalApplicationBaseline:'33bc2c64fc256b7ba6aea683ce6a9cce2378f078 is not present in the supplied repository remote'};
await fs.writeFile(new URL('../evidence/input-integrity.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(`Original manifest exact matches: ${result.exactMatches}/${result.total}; mismatches are disclosed, not silently rewritten.`);
