const cloudReply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
async function accountHash(owner,ref){const bytes=new TextEncoder().encode(owner+'|'+ref);const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function readWorkspace(db,owner){
 for(let attempt=0;attempt<2;attempt++){const head=await db.prepare('SELECT revision, snapshot_id, metadata_json, updated_at FROM user_workspaces WHERE owner_id = ?').bind(owner).first();if(!head)return{revision:0,state:{trades:[],snapshot:null,period:'',importNotes:[],symbolAliases:[],importCount:0},updatedAt:null};
 const chunks=head.snapshot_id?(await db.prepare('SELECT rows_json FROM workspace_chunks WHERE owner_id = ? AND snapshot_id = ? ORDER BY chunk_no').bind(owner,head.snapshot_id).all()).results:[];
 const meta=JSON.parse(head.metadata_json);if(chunks.length||!meta.tradeCount)return{revision:head.revision,state:{...meta,trades:chunks.flatMap(c=>JSON.parse(c.rows_json))},updatedAt:head.updated_at};}
 throw Error('读取云端记录失败，请刷新重试');
}
export async function writeWorkspace(db,owner,expected,state,requestId){
 const now=new Date().toISOString(),snapshotId=crypto.randomUUID(),chunks=[];
 for(let i=0;i<state.trades.length;i+=200)chunks.push(state.trades.slice(i,i+200));
 const metadata={...state,tradeCount:state.trades.length,lastRequestId:requestId};delete metadata.trades;
 if(new TextEncoder().encode(JSON.stringify(metadata)).length>150000)throw Error('账单元数据过大，请拆分文件');
 try{for(let i=0;i<chunks.length;i+=30){await db.batch(chunks.slice(i,i+30).map((chunk,j)=>db.prepare('INSERT INTO workspace_chunks (owner_id, snapshot_id, chunk_no, rows_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(owner,snapshotId,i+j,JSON.stringify(chunk),now)));}
 await db.prepare('INSERT OR IGNORE INTO user_workspaces (owner_id) VALUES (?)').bind(owner).run();
 const result=await db.prepare('UPDATE user_workspaces SET revision = revision + 1, snapshot_id = ?, metadata_json = ?, updated_at = ? WHERE owner_id = ? AND revision = ?').bind(snapshotId,JSON.stringify(metadata),now,owner,expected).run();
 if(result.meta.changes!==1){await db.prepare('DELETE FROM workspace_chunks WHERE owner_id = ? AND snapshot_id = ?').bind(owner,snapshotId).run();return null;}
 // Old snapshots remain briefly so an in-flight reader cannot observe a partially deleted version.
 await db.prepare('DELETE FROM workspace_chunks WHERE owner_id = ? AND snapshot_id <> ? AND created_at < ?').bind(owner,snapshotId,new Date(Date.now()-86400000).toISOString()).run();
 return{revision:expected+1,state:{...metadata,trades:state.trades},updatedAt:now};
 }catch(e){try{await db.prepare('DELETE FROM workspace_chunks WHERE owner_id = ? AND snapshot_id = ? AND snapshot_id NOT IN (SELECT snapshot_id FROM user_workspaces WHERE owner_id = ?)').bind(owner,snapshotId,owner).run();}catch{}throw e;}
}
function validateLegacy(trades){if(!Array.isArray(trades)||trades.length>20000)throw Error('本地迁移记录数量无效');return trades.map((t,i)=>{const normalized={id:'legacy'+i,symbol:String(t.symbol||'').toUpperCase(),originalSymbol:String(t.originalSymbol||t.symbol||'').toUpperCase(),currency:String(t.currency||'').toUpperCase(),date:day(t.date),time:String(t.time||'00:00:00'),side:t.side,qty:number(t.qty),price:number(t.price),fee:number(t.fee),feeMissing:!!t.feeMissing,account:String(t.account||'账户 1').slice(0,50),accountKey:String(t.accountKey||'legacy:'+(t.account||'账户 1')).slice(0,150),order:i};
 if(!/^[A-Z]{3}$/.test(normalized.currency)||!/^[A-Z0-9^][A-Z0-9. /\-^]{0,24}$/.test(normalized.symbol)||!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(normalized.time)||!['BUY','SELL'].includes(normalized.side)||normalized.qty<=0||normalized.price<=0)throw Error('本地迁移记录字段无效');if(t.tradeId)normalized.tradeId=String(t.tradeId).slice(0,150);return normalized;});}
export async function persistenceApi(request,env){
 const url=new URL(request.url),owner=request.headers.get('oai-authenticated-user-id');if(!owner)return cloudReply({error:'请先使用 ChatGPT 登录此私有站点'},401);if(!env.DB)return cloudReply({error:'云端存储尚未就绪，请稍后刷新。当前本地记录已保留。'},503);
 if(request.method==='GET'&&url.pathname==='/api/workspace'){try{return cloudReply(await readWorkspace(env.DB,owner));}catch{return cloudReply({error:'云端记录读取失败，请稍后重试。'},503);}}
 if(request.method!=='POST'||!['/api/imports/preview','/api/imports','/api/migrate'].includes(url.pathname))return cloudReply({error:'Method not allowed'},405);
 const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return cloudReply({error:'跨站写入被拒绝'},403);if(!request.headers.get('content-type')?.startsWith('application/json'))return cloudReply({error:'需要 JSON 数据'},415);
 try{if(Number(request.headers.get('content-length')||0)>11*1024*1024)return cloudReply({error:'多个文件合计不能超过 10 MB'},413);const raw=await request.text();if(new TextEncoder().encode(raw).length>11*1024*1024)return cloudReply({error:'多个文件合计不能超过 10 MB'},413);const body=JSON.parse(raw),current=await readWorkspace(env.DB,owner),migrate=url.pathname==='/api/migrate',preview=url.pathname.endsWith('/preview');
 if(!preview&&body.requestId&&current.state.lastRequestId===body.requestId)return cloudReply({...current,stats:current.state.lastImport,retried:true});
 if(!Number.isInteger(body.expectedRevision)||body.expectedRevision!==current.revision)return cloudReply({error:'云端记录已更新，请刷新预览后重试，不会覆盖其他设备的数据',revision:current.revision},409);
 let files=[];if(migrate){files=[{trades:validateLegacy(body.trades),snapshot:body.snapshot?{...body.snapshot,asOf:body.snapshot.asOf||statementEndDate(body.snapshot.period||body.period||'')}:null,period:String(body.period||'').slice(0,200),notes:[],symbolAliases:[]}];}
 else{if(!Array.isArray(body.files)||!body.files.length||body.files.length>20)throw Error('请选择 1–20 份 CSV / plain 文件');let size=0;const accountKeys=new Map();for(const file of body.files){if(typeof file.text!=='string')throw Error('文件内容无效');size+=new TextEncoder().encode(file.text).length;if(size>10*1024*1024)throw Error('多个文件合计不能超过 10 MB');const p=parseTrades(file.text,{includeAccountRefs:true});if(p.errors.length)throw Error('文件含 '+p.errors.length+' 行无效成交，首个错误在第 '+p.errors[0].line+' 行：'+p.errors[0].message+'。请修正后导入，避免漏记。');for(const t of [...p.trades,...p.funding]){if(!accountKeys.has(t.accountRef))accountKeys.set(t.accountRef,await accountHash(owner,t.accountRef));t.accountKey=accountKeys.get(t.accountRef);delete t.accountRef;}files.push(p);}}
 const existingAliases=current.state.symbolAliases||[],merged=mergeTradeFiles(current.state.trades,[{trades:[],symbolAliases:existingAliases},...files]);if(merged.conflicts.length)return cloudReply({error:'发现相同成交 ID 的内容冲突，未写入任何数据',stats:merged.stats,conflicts:merged.conflicts.slice(0,20)},409);
 let snapshot=current.state.snapshot,period=current.state.period||'';for(const f of files)if(f.snapshot&&(!snapshot||(f.snapshot.asOf&&(!snapshot.asOf||f.snapshot.asOf>=snapshot.asOf)))){snapshot=f.snapshot;period=f.period||period;}
 const aliases=new Map(existingAliases.map(a=>[a.alias,a]));for(const f of files)for(const a of f.symbolAliases||[])aliases.set(a.alias,a);
 const funding=mergeFunding(current.state.funding||[],files.map(f=>f.funding||[]));
 const notes=[...new Set([...(current.state.importNotes||[]),...files.flatMap(f=>f.notes||[])])].slice(-30),next={trades:merged.trades,funding,snapshot,period,importNotes:notes,symbolAliases:[...aliases.values()],importedAt:new Date().toISOString(),importCount:(current.state.importCount||0)+(migrate?0:files.length),lastImport:{...merged.stats,files:files.length,migration:migrate}};
 const portfolio=portfolioEntries(next.trades,{},snapshot),summary={stocks:portfolio.length,holding:portfolio.filter(x=>x.status==='OPEN').length,closed:portfolio.filter(x=>x.status==='CLOSED').length};
 if(preview)return cloudReply({revision:current.revision,stats:merged.stats,summary,total:next.trades.length,fundingCount:funding.filter(f=>f.kind==='fx').length,openingCount:funding.filter(f=>f.kind==='opening').length,hasIncomingFunding:files.some(f=>f.funding?.length),notes,conflicts:[]});
 if(typeof body.requestId!=='string'||body.requestId.length>100)throw Error('缺少导入请求编号');const written=await writeWorkspace(env.DB,owner,current.revision,next,body.requestId);if(!written)return cloudReply({error:'另一设备刚更新了记录，请重新预览后重试。'},409);return cloudReply({...written,stats:merged.stats,summary});
 }catch(e){const msg=e instanceof SyntaxError?'请求内容无效':e.message;if(/D1|SQLITE|database/i.test(msg))return cloudReply({error:'云端保存暂时失败，尚未确认写入，请保留文件并重试。'},503);return cloudReply({error:msg||'导入失败，原有记录保留'},400);}
}
