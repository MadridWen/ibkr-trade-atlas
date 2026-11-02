import {DatabaseSync} from 'node:sqlite';import {readFileSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';
export function openLocalD1(filename=':memory:'){
 if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});const sqlite=new DatabaseSync(filename);sqlite.exec('PRAGMA journal_mode = WAL');
 sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
 const name='0000_trade_workspace';if(!sqlite.prepare('SELECT name FROM local_migrations WHERE name=?').get(name)){sqlite.exec(readFileSync(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));sqlite.prepare('INSERT INTO local_migrations(name) VALUES(?)').run(name);}
 const wrap=(sql,bindings=[])=>({sql,bindings,bind(...args){return wrap(sql,args);},async first(){return sqlite.prepare(sql).get(...bindings)||null;},async all(){return{results:sqlite.prepare(sql).all(...bindings)};},async run(){const r=sqlite.prepare(sql).run(...bindings);return{success:true,meta:{changes:Number(r.changes)}};}});
 return{prepare:sql=>wrap(sql),async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push({success:true,meta:{changes:Number(sqlite.prepare(s.sql).run(...s.bindings).changes)}});sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}},close:()=>sqlite.close()};
}
