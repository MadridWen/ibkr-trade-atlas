import {mkdir,rm,copyFile,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=process.cwd(),dist=resolve(root,'dist');
await rm(dist,{recursive:true,force:true});
await mkdir(resolve(dist,'server'),{recursive:true});
await mkdir(resolve(dist,'.openai'),{recursive:true});
await copyFile(resolve(root,'worker/index.js'),resolve(dist,'server/index.js'));
let manifest;
try {manifest=JSON.parse(await readFile(resolve(root,'.openai/hosting.json'),'utf8'));}
catch(e) {if(e.code!=='ENOENT')throw e;manifest=JSON.parse(await readFile(resolve(root,'.openai/hosting.example.json'),'utf8'));}
await writeFile(resolve(dist,'.openai/hosting.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Built dist/server/index.js; configure a private Site project before deployment.');
