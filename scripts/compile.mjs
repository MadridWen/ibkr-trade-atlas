import {readFile,writeFile,mkdir} from 'node:fs/promises';
const core=await readFile('src/core.mjs','utf8'),app=await readFile('src/app.js','utf8');
const page=(await readFile('src/page.html','utf8')).replace('/*CORE*/',core.replaceAll('export ','')).replace('/*APP*/',app);
const server=(await readFile('src/market-sources.mjs','utf8'))+'\n'+(await readFile('src/persistence.mjs','utf8'))+'\n'+(await readFile('src/server.mjs','utf8'));
await mkdir('worker',{recursive:true});
await writeFile('worker/index.js',core+'\nconst page = '+JSON.stringify(page)+';\n'+server);
console.log('Compiled self-contained Worker and browser app');
