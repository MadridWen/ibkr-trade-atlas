export function csv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows=[];let row=[],cell='',quote=false;
  for(let i=0;i<text.length;i++) { const c=text[i];
    if(c==='"') { if(quote&&text[i+1]==='"'){cell+='"';i++;} else if(!quote&&cell!=='') throw Error('CSV 引号格式不正确'); else quote=!quote; }
    else if(!quote&&(c===','||c==='\n'||c==='\r')) {row.push(cell);cell='';if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(x=>x.trim())) rows.push(row);row=[];}}
    else cell+=c;
  }
  if(quote)throw Error('CSV 引号未闭合');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
const norm=s=>String(s??'').toLowerCase().replace(/[\s._/()\-]/g,'');
export function day(s) {
  let m=String(s??'').trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:$|[;, T])/);
  if(!m)throw Error('日期需为 YYYY-MM-DD 或 YYYYMMDD');
  let d=m.slice(1,4).join('-');if(new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('无效日期');return d;
}
export function number(s) { let v=String(s??'').trim().replace(/,/g,'');if(!v||!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v))throw Error('数值无效或缺失');let n=Number(v);if(!Number.isFinite(n))throw Error('数值溢出');return n; }
const fieldAliases={
  '资产分类':'assetcategory','资产类别':'assetcategory','货币':'currency','币种':'currency',
  '代码':'symbol','股票代码':'symbol','日期时间':'datetime','交易日期':'tradedate','日期':'date','时间':'time',
  '数量':'quantity','交易数量':'quantity','交易价格':'tradeprice','成交价格':'tradeprice','价格':'price',
  '佣金税':'commtax','佣金费用':'commfee','佣金':'commission','费用':'fee','手续费':'fee',
  '合约编号':'conid','底层':'underlying','账户':'account','账户id':'accountid','买卖':'side','方向':'side','买入卖出':'buysell'
};
const fieldName=s=>fieldAliases[norm(s)]||norm(s);
// IBKR repeats “代码” / “Code”: ticker first, transaction flags last.
// Preserve the first column so flags never overwrite the ticker.
function object(h,r) {const o={};h.forEach((x,i)=>{const k=fieldName(x);if(k&&!Object.hasOwn(o,k))o[k]=r[i]?.trim()??'';});return o;}
const tradeSection=s=>['Trades','交易','成交'].includes(String(s).trim());
function get(o,...ks){for(const k of ks){if(o[norm(k)]!==undefined&&o[norm(k)]!=='')return o[norm(k)];}return '';}
function statementContext(rows) {
  const aliases=new Map(),names=new Map();let h=[],positionHeader=[],hasPositions=false,period='',primaryAccount='';const positions=[];
  for(const row of rows){
    if(['账户信息','Account Information'].includes(row[0])&&row[1]==='Data'&&['账户','Account'].includes(row[2]))primaryAccount=row[3]||'';
    if(row[0]==='Statement'&&row[1]==='Data'&&row[2]==='Period')period=row[3]||'';
    if(['金融产品信息','Financial Instrument Information'].includes(row[0])){
      if(row[1]==='Header'){h=row.slice(2);continue;}if(row[1]!=='Data'||!h.length)continue;
      const o=object(h,row.slice(2));if(!['股票','stocks','stock','stk','etf'].includes(get(o,'Asset Category','AssetClass').toLowerCase()))continue;
      const list=get(o,'Symbol').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean),conid=get(o,'Conid','ContractID');
      if(!conid||list.length<2)continue;const underlying=get(o,'Underlying').toUpperCase(),canonical=list.includes(underlying)?underlying:list.at(-1);
      for(const name of list){const prev=names.get(name);if(prev&&prev!==conid){aliases.delete(name);names.set(name,'CONFLICT');continue;}names.set(name,conid);if(prev!=='CONFLICT')aliases.set(name,{symbol:canonical,conid});}
    }
    if(['未平仓持仓','Open Positions'].includes(row[0])){
      if(row[1]==='Header'){positionHeader=row.slice(2);hasPositions=true;continue;}if(row[1]!=='Data'||!positionHeader.length)continue;
      const o=object(positionHeader,row.slice(2));if(!['股票','stocks','stock','stk','etf'].includes(get(o,'Asset Category','AssetClass').toLowerCase()))continue;
      const detail=get(o,'DataDiscriminator');if(detail&&detail!=='Summary')continue;
      try{positions.push({symbol:get(o,'Symbol').toUpperCase(),currency:get(o,'Currency','CurrencyPrimary').toUpperCase(),qty:number(get(o,'Quantity'))});}catch{hasPositions=false;}
    }
  }
  const normalized=positions.map(p=>({...p,symbol:aliases.get(p.symbol)?.symbol||p.symbol}));
  const asOf=statementEndDate(period);return{aliases,primaryAccount,snapshot:hasPositions?{positions:normalized,period,asOf,complete:true}:null,period};
}
export function parseTrades(text,options={}) {
  const rows=csv(text),context=statementContext(rows),trades=[],errors=[],notes=[];let header=null,sectioned=rows.some(r=>tradeSection(r[0])&&r[1]==='Header'),ignored=0,ids=new Map(),accounts=new Map();
  for(let i=0;i<rows.length;i++) {let r=rows[i],h=header;
    if(sectioned){if(!tradeSection(r[0])){continue;}if(r[1]==='Header'){header=r.slice(2);continue;}if(r[1]!=='Data'){ignored++;continue;}r=r.slice(2);h=header;}
    else if(!header){if(r.some(x=>fieldName(x)==='symbol')&&r.some(x=>['tradeprice','tprice','price'].includes(fieldName(x)))){header=r;continue;}continue;}
    if(!h)continue;const o=object(h,r);const asset=get(o,'Asset Category','AssetClass');const detail=get(o,'DataDiscriminator','LevelOfDetail');
    if((asset&&!['stocks','stock','stk','etf','股票'].includes(asset.toLowerCase()))||(detail&&!['order','exec','execution','trade','fill'].includes(detail.toLowerCase()))){ignored++;continue;}
    try {
      const originalSymbol=(get(o,'OriginalSymbol')||get(o,'Symbol')).toUpperCase(),rawSymbol=get(o,'Symbol').toUpperCase(),symbol=context.aliases.get(rawSymbol)?.symbol||rawSymbol;if(!symbol||/^(total|subtotal)/i.test(symbol)){ignored++;continue;}if(!/^[A-Z0-9^][A-Z0-9. /\-^]{0,24}$/.test(symbol))throw Error('不支持的股票代码');
      const rawDate=get(o,'Date/Time','DateTime','TradeDate','Date');let date=day(rawDate);let time=rawDate.match(/(?:[;, T])\s*(\d{2}:?\d{2}:?\d{2})/)?.[1]||get(o,'Time','TradeTime')||'00:00:00';if(/^\d{6}$/.test(time))time=time.replace(/(..)(..)(..)/,'$1:$2:$3');if(!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time))throw Error('时间无效');
      const q=number(get(o,'Quantity','Qty'));if(Math.abs(q)<1e-10)throw Error('数量为零');const p=number(get(o,'T. Price','TradePrice','Price'));if(p<=0)throw Error('成交价必须大于零');
      const sideValue=get(o,'Buy/Sell','Side').toUpperCase();const rawSide=({'买入':'BUY','买':'BUY','卖出':'SELL','卖':'SELL'})[sideValue]||sideValue;if(rawSide&&!['BUY','SELL','BOT','SLD','B','S'].includes(rawSide))throw Error('买卖方向无效');
      const side=rawSide?(['BUY','BOT','B'].includes(rawSide)?'BUY':'SELL'):(q>0?'BUY':'SELL');
      let currency=get(o,'Currency','CurrencyPrimary').toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw Error('缺少有效 Currency 币种');
      const comm=get(o,'IBCommission','Comm/Fee','Comm/Tax','Commission');const fee=comm!==''?-number(comm):number(get(o,'Fee','Fees')||'0');
      const feeCcy=get(o,'IBCommissionCurrency','CommissionCurrency');if(feeCcy&&feeCcy!==currency)throw Error('佣金币种与成交币种不同，需先换算');
      const acct=get(o,'Account','AccountId','ClientAccountID')||context.primaryAccount||'default';if(!accounts.has(acct))accounts.set(acct,'账户 '+(accounts.size+1));
      const account=accounts.get(acct),tradeId=get(o,'IBExecID','ExecutionID','TradeID');
      const t={id:'t'+i,date,time,symbol,originalSymbol,currency,side,qty:Math.abs(q),price:p,fee,feeMissing:comm===''&&get(o,'Fee','Fees')==='',account,order:i};if(tradeId)t.tradeId=tradeId;if(options.includeAccountRefs)t.accountRef=acct;
      if(tradeId){const k=account+'|'+tradeId;if(ids.has(k)){const old=ids.get(k);if(JSON.stringify({...old,id:0,order:0})!==JSON.stringify({...t,id:0,order:0}))throw Error('相同成交 ID 的内容冲突');ignored++;continue;}ids.set(k,t);}
      trades.push(t);
    } catch(e){errors.push({line:i+1,message:e.message});}
  }
  if(!header)throw Error('未找到成交表头。支持中英文 IBKR 活动账单 CSV（含 .plain / .txt 扩展名），或使用标准成交模板。');
  if(trades.length>20000)throw Error('最小版本每次最多导入 20,000 笔成交');
  if(accounts.size>1)notes.push('检测到多个账户，FIFO 按匿名账户分别匹配。');
  if(trades.some(t=>t.feeMissing))notes.push(trades.filter(t=>t.feeMissing).length+' 笔未提供佣金 / 费用，暂按 0 计算。');
  if(trades.some(t=>t.time==='00:00:00'))notes.push('部分成交没有时间，同日按文件顺序匹配。');
  const renamed=[...new Set(trades.filter(t=>t.originalSymbol!==t.symbol).map(t=>t.originalSymbol+' → '+t.symbol))];if(renamed.length)notes.push('根据账单同一合约信息合并历史代码：'+renamed.join('、')+'。');
  const fundingResult=parseFundingRows(rows,context,options);errors.push(...fundingResult.errors);if(fundingResult.funding.some(f=>f.kind==='opening'))notes.push('已读取期初美元现金余额；账单没有给出其人民币成本时，仅补齐美元数量，不猜测历史汇率。');if(fundingResult.funding.length)notes.push('已读取 '+fundingResult.funding.filter(f=>f.kind==='fx').length+' 笔美元 / 人民币换汇；人民币成本使用资金 FIFO 归属估算，需完整资金记录。');
  return {funding:fundingResult.funding,symbolAliases:[...context.aliases].map(([alias,a])=>({alias,...a})),snapshot:context.snapshot,period:context.period,trades:trades.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)||a.order-b.order),errors,ignored,notes};
}
export function parsePrices(text,expectedSymbol='') {
  const rows=csv(text);const header=rows.shift();if(!header)throw Error('行情文件为空');const bars=[],seen=new Set();
  for(let i=0;i<rows.length;i++){const o=object(header,rows[i]);const symbol=get(o,'Symbol').toUpperCase();if(expectedSymbol&&symbol&&symbol!==expectedSymbol.toUpperCase())throw Error('行情文件股票 '+symbol+' 与当前股票 '+expectedSymbol+' 不符');const date=day(get(o,'Date'));const b={date,open:number(get(o,'Open')),high:number(get(o,'High')),low:number(get(o,'Low')),close:number(get(o,'Close')),volume:number(get(o,'Volume')||'0')};
    if(seen.has(date))throw Error('行情日期重复：'+date);seen.add(date);
    if(b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.volume<0)throw Error('第 '+(i+2)+' 行 OHLC 关系不正确');bars.push(b);
  }if(!bars.length)throw Error('没有行情记录');return bars.sort((a,b)=>a.date.localeCompare(b.date));
}
export function fifo(trades,splits=[],asOf='9999-12-31') {
  const groups=new Map(),out=new Map(),events=[...trades.filter(t=>t.date<=asOf).map(t=>({...t,type:'trade'})),...splits.filter(s=>s.date<=asOf).map(s=>({...s,type:'split',time:''}))].sort((a,b)=>a.date.localeCompare(b.date)||(a.type==='split'?-1:b.type==='split'?1:a.time.localeCompare(b.time)||a.order-b.order));
  let realized=0,unmatched=0;
  for(const e of events){if(e.type==='split'){if(!Number.isFinite(e.ratio)||e.ratio<=0)throw Error('拆股比例无效');for(const lots of groups.values())for(const l of lots){l.qty*=e.ratio;l.unitCost/=e.ratio;}continue;}
    const k=e.account+'|'+e.symbol+'|'+e.currency;if(!groups.has(k))groups.set(k,[]);const lots=groups.get(k);
    if(e.side==='BUY'){lots.push({qty:e.qty,unitCost:e.price+e.fee/e.qty,date:e.date});out.set(e.id,{pnl:null,matched:0,unmatched:0,matches:[]});}
    else {let remaining=e.qty,cost=0,matches=[];while(remaining>1e-9&&lots.length){const l=lots[0],q=Math.min(l.qty,remaining);cost+=q*l.unitCost;matches.push({date:l.date,qty:q,cost:q*l.unitCost});remaining-=q;l.qty-=q;if(l.qty<1e-9)lots.shift();}
      const matched=e.qty-remaining,pnl=matched>1e-9?matched*e.price-e.fee*(matched/e.qty)-cost:null;if(pnl!==null)realized+=pnl;unmatched+=remaining;out.set(e.id,{pnl,matched,unmatched:remaining,matches});}
  }
  let qty=0,cost=0;for(const lots of groups.values())for(const l of lots){qty+=l.qty;cost+=l.qty*l.unitCost;}return{realized,qty,cost,unmatched,rows:out};
}
export function rawYahoo(result) {
  const splits=Object.values(result.events?.splits??{}).map(e=>({date:new Intl.DateTimeFormat('en-CA',{timeZone:result.meta.exchangeTimezoneName||'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.date*1000)),ratio:Number(e.numerator)/Number(e.denominator)})).sort((a,b)=>a.date.localeCompare(b.date));
  if(splits.some(s=>!Number.isFinite(s.ratio)||s.ratio<=0))throw Error('行情拆股比例无效');
  const q=result.indicators?.quote?.[0];if(!q||!Array.isArray(result.timestamp))throw Error('行情响应没有日线');const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:result.meta.exchangeTimezoneName||'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});const bars=[];
  result.timestamp.forEach((ts,i)=>{const date=fmt.format(new Date(ts*1000));let factor=splits.filter(s=>s.date>date).reduce((a,s)=>a*s.ratio,1);const b={date,open:q.open[i]*factor,high:q.high[i]*factor,low:q.low[i]*factor,close:q.close[i]*factor,volume:q.volume?.[i]??0};if([q.open[i],q.high[i],q.low[i],q.close[i]].every(x=>x!==null&&Number.isFinite(x))&&b.low>0)bars.push(b);});return{bars,splits};
}

export function emptyWorkspace(){return{schema:2,trades:[],funding:[],markets:{},selected:'',range:'ALL',from:'',to:'',side:'ALL',universe:'ALL',importedAt:null,snapshot:null,period:'',importNotes:[]};}
export function restoreWorkspace(saved){
  const clean=emptyWorkspace();if(!saved||!Array.isArray(saved.trades))return{state:clean,message:''};
  const removed=saved.demo===true||saved.trades.some(t=>String(t.id).startsWith('demo'));
  const trades=saved.demo===true?[]:saved.trades.filter(t=>!String(t.id).startsWith('demo'));
  const markets={};for(const [k,m] of Object.entries(saved.markets||{}))if(['csv','yahoo','nasdaq','stooq','twelve'].includes(m?.source)&&m.tradeKey===k)markets[k]=m;
  return{state:{...clean,...saved,schema:2,demo:false,trades,markets,universe:saved.universe||'ALL'},message:removed?'旧版虚构示例已移除。请导入你的 IBKR 账单。':saved.schema!==2&&trades.length?'已保留本地成交。请重新导入原账单，以核对历史改名及账单期末持仓。':''};
}
export function boundMarket(markets,k){const m=markets?.[k];if(!m||m.tradeKey!==k||!['csv','yahoo','nasdaq','stooq','twelve'].includes(m.source)||m.currency!==k.split('|').at(-1))return null;return m;}
export function tradeSummary(trades,splits=[],from='0000',to='9999'){
  const calc=fifo(trades,splits,to),visible=trades.filter(t=>t.date>=from&&t.date<=to),sells=visible.filter(t=>t.side==='SELL');
  const realized=sells.reduce((a,t)=>a+(calc.rows.get(t.id)?.pnl??0),0),missing=sells.reduce((a,t)=>a+(calc.rows.get(t.id)?.unmatched??0),0);
  return{calc,visible,sellCount:sells.length,buyCount:visible.filter(t=>t.side==='BUY').length,realized,missing,complete:missing<1e-8};
}
export function portfolioEntries(trades,markets={},snapshot=null){
  const groups=new Map();for(const t of trades){const k=t.symbol+'|'+t.currency;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(t);}
  return[...groups].map(([k,ts])=>{const m=boundMarket(markets,k),calc=fifo(ts,m?.splits||[]),reported=snapshot?.complete?snapshot.positions.filter(p=>p.symbol===ts[0].symbol&&p.currency===ts[0].currency).reduce((a,p)=>a+p.qty,0):null;
    const qty=reported??calc.qty,status=reported!==null?(Math.abs(qty)<1e-8?'CLOSED':qty>0?'OPEN':'REVIEW'):calc.unmatched>1e-8?'REVIEW':Math.abs(qty)<1e-8?'CLOSED':'OPEN';
    return{key:k,symbol:ts[0].symbol,currency:ts[0].currency,trades:ts,qty,status,reported:reported!==null,missing:calc.unmatched,realized:calc.realized,buyCount:ts.filter(t=>t.side==='BUY').length,sellCount:ts.filter(t=>t.side==='SELL').length};});
}

export function statementEndDate(period,first=false){
 const iso=String(period).match(/\d{4}-\d{2}-\d{2}/g);if(iso?.length)return first?iso[0]:iso.at(-1);
 const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const zh={'一月':1,'二月':2,'三月':3,'四月':4,'五月':5,'六月':6,'七月':7,'八月':8,'九月':9,'十月':10,'十一月':11,'十二月':12};
 const matches=[...String(period).matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December|十一月|十二月|十月|一月|二月|三月|四月|五月|六月|七月|八月|九月)\s+(\d{1,2}),?\s+(\d{4})/gi)];
 const m=first?matches[0]:matches.at(-1);if(!m)return'';const month=zh[m[1]]||months.findIndex(x=>x.toLowerCase()===m[1].toLowerCase())+1;return m[3]+'-'+String(month).padStart(2,'0')+'-'+m[2].padStart(2,'0');
}
const numericKey=n=>Number(n).toString();
export function fillFingerprint(t,withAccount=true){return JSON.stringify([withAccount?(t.accountKey||t.account):'',t.symbol,t.currency,t.date,t.time,t.side,numericKey(t.qty),numericKey(t.price),numericKey(t.fee),!!t.feeMissing]);}
export function mergeTradeFiles(existing,files){
 const baseline=existing.map(t=>({...t})),incoming=files.map(f=>({...f,trades:f.trades.map(t=>({...t}))}));
 const aliases=new Map();for(const f of incoming)for(const a of f.symbolAliases||[]){const old=aliases.get(a.alias);if(old&&old.conid!==a.conid)throw Error('股票历史代码的合约信息冲突，请检查文件');aliases.set(a.alias,a);}
 for(const ts of [baseline,...incoming.map(f=>f.trades)])for(const t of ts){const alias=aliases.get(t.originalSymbol||t.symbol)||aliases.get(t.symbol);if(alias){t.originalSymbol=t.originalSymbol||t.symbol;t.symbol=alias.symbol;}}
 // Upgrade a legacy anonymous account only when overlapping identical fills identify one account unambiguously.
 const candidateAccounts=new Map(),allBatches=[baseline,...incoming.map(f=>f.trades)];for(const ts of allBatches)for(const t of ts)if(t.accountKey&&!t.accountKey.startsWith('legacy:')){const k=fillFingerprint(t,false);if(!candidateAccounts.has(k))candidateAccounts.set(k,new Set());candidateAccounts.get(k).add(t.accountKey);}
 const legacyGroups=new Map();for(const ts of allBatches)for(const t of ts)if(!t.accountKey||t.accountKey.startsWith('legacy:')){const k=t.accountKey||t.account;if(!legacyGroups.has(k))legacyGroups.set(k,[]);legacyGroups.get(k).push(t);}
 for(const ts of legacyGroups.values()){let possible=null;for(const t of ts){const set=candidateAccounts.get(fillFingerprint(t,false));if(set)possible=possible===null?new Set(set):new Set([...possible].filter(x=>set.has(x)));}if(possible?.size===1){const accountKey=[...possible][0];for(const t of ts)t.accountKey=accountKey;}}
 const groups=new Map(),idMap=new Map(),conflicts=[];let incomingCount=0;
 const batches=[{trades:baseline,existing:true},...incoming];
 for(let batch=0;batch<batches.length;batch++){
  const counts=new Map();for(const t of batches[batch].trades){if(batch)incomingCount++;const fp=fillFingerprint(t),identity=t.tradeId?(t.accountKey||t.account)+'|'+t.tradeId:null;
   if(identity&&idMap.has(identity)&&idMap.get(identity)!==fp){conflicts.push({symbol:t.symbol,date:t.date,time:t.time,tradeId:t.tradeId,reason:'同一成交 ID 的股票、时间、数量、价格或费用不一致'});continue;}if(identity)idMap.set(identity,fp);
   if(!groups.has(fp))groups.set(fp,{sample:t,ids:new Map(),anonymous:[],peak:0});const g=groups.get(fp);if(identity){g.ids.set(identity,t);const duplicateKey=fp+'|'+identity;if(counts.has(duplicateKey))continue;counts.set(duplicateKey,1);}else g.anonymous.push(t);
   counts.set(fp,(counts.get(fp)||0)+1);
  }
  for(const [fp,n] of counts)if(groups.has(fp))groups.get(fp).peak=Math.max(groups.get(fp).peak,n);
 }
 const trades=[];let id=0;const accountLabels=new Map();for(const g of groups.values()){const total=Math.max(g.peak,g.ids.size),known=[...g.ids.values()];for(let i=0;i<total;i++){const t={...(known[i]||g.anonymous[i-known.length]||g.sample)};delete t.accountRef;const accountKey=t.accountKey||'legacy:'+t.account;if(!accountLabels.has(accountKey))accountLabels.set(accountKey,'账户 '+(accountLabels.size+1));t.accountKey=accountKey;t.account=accountLabels.get(accountKey);t.id='m'+id++;trades.push(t);}}
 trades.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)||(a.order||0)-(b.order||0));trades.forEach((t,i)=>t.order=i);
 if(trades.length>50000)throw Error('当前版本最多合并保存 50,000 笔成交');
 return{trades,stats:{incoming:incomingCount,added:Math.max(0,trades.length-existing.length),duplicates:Math.max(0,incomingCount-(trades.length-existing.length)),conflicts:conflicts.length},conflicts};
}
export function portfolioTotals(trades,markets={},from='0001-01-01',to='9999-12-31',snapshot=null){
 const previous=new Date(new Date(from+'T12:00:00Z').getTime()-86400000).toISOString().slice(0,10),groups=new Map();
 for(const t of trades){const k=t.symbol+'|'+t.currency;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(t);}
 for(const p of snapshot?.positions||[])if(p.qty&& !groups.has(p.symbol+'|'+p.currency))groups.set(p.symbol+'|'+p.currency,[]);
 const currencies=new Map();
 for(const [k,ts] of groups){const currency=k.split('|').at(-1),symbol=k.split('|')[0],m=boundMarket(markets,k);
  function at(date){const c=fifo(ts,m?.splits||[],date),price=(m?.bars||[]).filter(b=>b.date<=date).at(-1),reasons=[];let r=c.realized,u=0;
   if(!ts.length){reasons.push('缺少该持仓的成交历史');r=null;u=null;}
   if(c.unmatched>1e-8){reasons.push('卖出缺少买入成本');r=null;u=null;}
   if(ts.some(t=>t.date<=date&&t.feeMissing)){reasons.push('成交费用缺失');r=null;u=null;}
   if(snapshot?.complete&&snapshot.asOf&&date>=snapshot.asOf){const reported=snapshot.positions.filter(p=>p.symbol===symbol&&p.currency===currency).reduce((n,p)=>n+p.qty,0);if(Math.abs(reported-c.qty)>1e-8){reasons.push('账单持仓与成交历史不一致');r=null;u=null;}}
   if(c.qty>1e-8&&u!==null){if(!price||!m?.verified){reasons.push('缺少可用行情');u=null;}else if((Date.parse(date)-Date.parse(price.date))/86400000>7){reasons.push('行情距估值日超过 7 天');u=null;}else u=c.qty*price.close-c.cost;}
   return{realized:r,unrealized:u,total:r===null||u===null?null:r+u,qty:c.qty,priceDate:price?.date||null,reasons};
  }
  const end=at(to),start=ts.length&&previous<ts[0].date?{realized:0,unrealized:0,total:0,reasons:[]}:at(previous),sub=(a,b)=>a===null||b===null?null:a-b;
  const row={key:k,symbol,currency,...end,periodRealized:sub(end.realized,start.realized),periodUnrealized:sub(end.unrealized,start.unrealized),periodTotal:sub(end.total,start.total),startPriceDate:start.priceDate||null,reasons:[...new Set([...end.reasons,...start.reasons])]};
  if(!currencies.has(currency))currencies.set(currency,{currency,rows:[]});currencies.get(currency).rows.push(row);
 }
 const fields=['realized','unrealized','total','periodRealized','periodUnrealized','periodTotal'];return [...currencies.values()].map(g=>({...g,...Object.fromEntries(fields.map(f=>[f,g.rows.some(r=>r[f]===null)?null:g.rows.reduce((s,r)=>s+r[f],0)])),missing:g.rows.filter(r=>r.reasons.length).length}));
}
// Funding records retain only monetary fields; never retain raw descriptions or account numbers.
function parseFundingRows(rows,context,options={}){
 const funding=[],errors=[];let header=[];const cashSections=['存款和取款','Deposits & Withdrawals','股息','Dividends','代扣税','Withholding Tax','佣金调整','Commission Adjustments'];
 const periodStart=statementEndDate(context.period,true);
 for(let i=0;i<rows.length;i++){const r=rows[i];if(!['现金报告','Cash Report'].includes(r[0])||r[1]!=='Data'||!['期初现金','Starting Cash','Opening Cash'].includes(r[2])||r[3]!=='USD'||!periodStart)continue;
  try{const usd=number(r[4]),f={kind:'opening',date:day(periodStart),time:'00:00:00',usd,cny:null,quote:'USD',feeUsd:0,category:'opening',order:-1};if(options.includeAccountRefs)f.accountRef=context.primaryAccount||'default';else f.account='账户 1';funding.push(f);}catch(e){errors.push({line:i+1,message:'期初现金：'+e.message});}
 }
 for(let i=0;i<rows.length;i++){const row=rows[i];if(row[1]==='Header'){header=row.slice(2);continue;}if(row[1]!=='Data')continue;
  if(!tradeSection(row[0])&&!cashSections.includes(row[0]))continue;const o=object(header,row.slice(2)),symbol=get(o,'Symbol').toUpperCase(),asset=get(o,'Asset Category','AssetClass').toLowerCase();
  const isFx=tradeSection(row[0])&&['forex','fx','cash','外汇'].includes(asset)&&['USD.CNH','USD.CNY','CNH.USD','CNY.USD'].includes(symbol);const isCash=cashSections.includes(row[0])&&get(o,'Currency').toUpperCase()==='USD',isOther=tradeSection(row[0])&&get(o,'Currency').toUpperCase()==='USD'&&['options','option','期权','event contracts by kalshi'].includes(asset);if(!isFx&&!isCash&&!isOther)continue;
  const detail=get(o,'DataDiscriminator','LevelOfDetail');if((isFx||isOther)&&detail&&!['order','exec','execution','trade','fill'].includes(detail.toLowerCase()))continue;
  try{const raw=get(o,'Date/Time','DateTime','Date','Settle Date','SettleDate','结算日期'),date=day(raw),time=raw.match(/(?:[;, T])\s*(\d{2}:\d{2}:\d{2})/)?.[1]||'00:00:00';let usd,cny=null,quote='',feeUsd=0;
   if(isFx){const q=number(get(o,'Quantity','Qty')),price=number(get(o,'T. Price','TradePrice','Price'));const proceedsRaw=get(o,'Proceeds','收益');const proceeds=proceedsRaw!==''?number(proceedsRaw):-q*price;if(price<=0||!q||q*proceeds>=0)throw Error('换汇数量、价格或收支方向无效');
    if(symbol.startsWith('USD.')){usd=q;cny=-proceeds;quote=symbol.split('.')[1];}else{usd=proceeds;cny=-q;quote=symbol.split('.')[0];}
    const commission=get(o,'Comm in USD','Commission in USD','佣金 USD');if(commission!=='')feeUsd=-number(commission);else if(get(o,'Comm/Fee','Comm/Tax','Commission')!==''&&number(get(o,'Comm/Fee','Comm/Tax','Commission'))!==0)throw Error('换汇佣金币种不明确');
   }else if(isOther)usd=number(get(o,'Proceeds','收益'))+number(get(o,'Comm/Fee','Comm/Tax','Commission')||'0');else usd=number(get(o,'Amount','金额'));if(!Number.isFinite(usd)||Math.abs(usd)<1e-12)continue;
   const f={kind:isFx?'fx':'cash',date,time,usd,cny,quote,feeUsd,category:isFx?'conversion':cashSections.slice(0,2).includes(row[0])?'external':'income',order:i};if(options.includeAccountRefs)f.accountRef=get(o,'Account','AccountId','ClientAccountID')||context.primaryAccount||'default';else f.account='账户 1';funding.push(f);
  }catch(e){errors.push({line:i+1,message:'换汇 / 资金记录：'+e.message});}
 }
 return{funding,errors};
}
export function mergeFunding(existing=[],files=[]){
 const groups=new Map();for(const batch of [existing,...files]){const counts=new Map();for(const f of batch||[]){const k=JSON.stringify([f.accountKey||f.account,f.kind,f.date,f.time,f.usd,f.cny,f.quote,f.feeUsd,f.category]);counts.set(k,(counts.get(k)||0)+1);if(!groups.has(k))groups.set(k,{sample:f,count:0});}for(const[k,n]of counts)groups.get(k).count=Math.max(groups.get(k).count,n);}
 const out=[];for(const g of groups.values())for(let n=0;n<g.count;n++){const f={...g.sample};delete f.accountRef;out.push(f);}if(out.length>30000)throw Error('换汇和资金记录超过 30,000 笔');return out.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)||(a.order||0)-(b.order||0));
}
// Display method: actual yuan funding cost, with all USD sale proceeds revalued at one current rate.
// Sale cash re-enters at that same rate, preventing FX gains/losses being counted again on reinvestment.
export function cnyLedger(trades,funding,markets,asOf,rate){
 const validRate=Number.isFinite(rate)&&rate>0,cash=new Map(),stocks=new Map(),sellPnl=new Map(),buyCosts=new Map(),cashShortfalls=[];
 const acct=x=>x.accountKey||x.account||'default',stockKey=x=>acct(x)+'|'+x.symbol+'|'+x.currency,earliest=new Map(),openings=new Map();
 for(const e of [...trades.filter(t=>t.currency==='USD'),...funding.filter(f=>f.kind!=='opening')]){const a=acct(e);if(!earliest.has(a)||e.date<earliest.get(a))earliest.set(a,e.date);}
 for(const f of funding.filter(f=>f.kind==='opening'&&f.date<=asOf).sort((a,b)=>a.date.localeCompare(b.date))){const a=acct(f);if(!openings.has(a)&&(!earliest.has(a)||f.date<=earliest.get(a)))openings.set(a,f);}
 function wallet(a){if(!cash.has(a))cash.set(a,{lots:[],debt:0});return cash.get(a);}
 // A basis is fixed yuan + floating USD * the current rate. Keep missing rates separate from missing historical cost.
 const basis=(fixed=0,floating=0,known=true)=>({fixed,floating,known});
 const value=b=>!b.known?null:Math.abs(b.floating)<1e-10?b.fixed:validRate?b.fixed+b.floating*rate:null;
 function debit(a,q,e){const w=wallet(a),cost=basis();let remaining=q;while(remaining>1e-7&&w.lots.length){const l=w.lots[0],n=Math.min(l.qty,remaining);cost.fixed+=n*l.fixed;cost.floating+=n*l.floating;cost.known&&=l.known;remaining-=n;l.qty-=n;if(l.qty<1e-7)w.lots.shift();}
  if(remaining>1e-7){w.debt+=remaining;cost.known=false;cashShortfalls.push({date:e.date,symbol:e.symbol||'',usd:remaining});}return cost;
 }
 function credit(a,q,cost){if(q<=1e-7)return;const w=wallet(a),unit={fixed:cost.fixed/q,floating:cost.floating/q,known:cost.known},settle=Math.min(w.debt,q);w.debt-=settle;q-=settle;if(q>1e-7)w.lots.push({qty:q,...unit});}
 const events=[...funding.filter(f=>f.kind!=='opening'&&f.date<=asOf).map(f=>({...f,type:'funding',priority:f.kind==='fx'&&f.usd>0?0:2})),...[...openings.values()].map(f=>({...f,type:'funding',priority:-1})),...trades.filter(t=>t.currency==='USD'&&t.date<=asOf).map(t=>({...t,type:'trade',priority:2}))];
 for(const[k,m]of Object.entries(markets||{}))if(boundMarket(markets,k))for(const s of m.splits||[])if(s.date<=asOf)events.push({...s,type:'split',key:k,time:'',priority:1});
 events.sort((a,b)=>a.date.localeCompare(b.date)||a.priority-b.priority||(a.time||'').localeCompare(b.time||'')||(a.order||0)-(b.order||0));
 for(const e of events){if(e.type==='split'){for(const[k,s]of stocks)if(k.endsWith('|'+e.key))for(const l of s.lots){l.qty*=e.ratio;l.fixed/=e.ratio;l.floating/=e.ratio;}continue;}
  const a=acct(e);if(e.type==='funding'){if(e.kind==='fx'){const net=e.usd-(e.feeUsd||0);if(net>0)credit(a,net,basis(e.cny,0,Number.isFinite(e.cny)));else debit(a,-net,e);}else if(e.usd>0)credit(a,e.usd,e.category==='income'?basis(0,e.usd):basis(e.cny||0,0,Number.isFinite(e.cny)));else if(e.usd<0)debit(a,-e.usd,e);continue;}
  const k=stockKey(e);if(!stocks.has(k))stocks.set(k,{symbol:e.symbol,lots:[],realized:basis()});const s=stocks.get(k);
  if(e.side==='BUY'){const cost=debit(a,e.qty*e.price+e.fee,e);cost.known&&=!e.feeMissing;s.lots.push({qty:e.qty,fixed:cost.fixed/e.qty,floating:cost.floating/e.qty,known:cost.known,date:e.date});buyCosts.set(e.id,value(cost));}
  else{let remaining=e.qty;const cost=basis();while(remaining>1e-9&&s.lots.length){const l=s.lots[0],q=Math.min(remaining,l.qty);cost.fixed+=q*l.fixed;cost.floating+=q*l.floating;cost.known&&=l.known;remaining-=q;l.qty-=q;if(l.qty<1e-9)s.lots.shift();}if(remaining>1e-9||e.feeMissing)cost.known=false;const usd=e.qty*e.price-e.fee,pnl=basis(-cost.fixed,usd-cost.floating,cost.known);sellPnl.set(e.id,value(pnl));s.realized.fixed+=pnl.fixed;s.realized.floating+=pnl.floating;s.realized.known&&=pnl.known;if(usd>=0)credit(a,usd,basis(0,usd));else debit(a,-usd,e);}
 }
 const rows=new Map();for(const s of stocks.values()){const k=s.symbol+'|USD';if(!rows.has(k))rows.set(k,{realizedBasis:basis(),qty:0,costBasis:basis()});const r=rows.get(k);r.realizedBasis.fixed+=s.realized.fixed;r.realizedBasis.floating+=s.realized.floating;r.realizedBasis.known&&=s.realized.known;for(const l of s.lots){r.qty+=l.qty;r.costBasis.fixed+=l.qty*l.fixed;r.costBasis.floating+=l.qty*l.floating;r.costBasis.known&&=l.known;}}
 for(const r of rows.values()){r.realized=value(r.realizedBasis);r.cost=value(r.costBasis);r.realizedKnown=r.realized!==null;r.realizedCostKnown=r.realizedBasis.known;r.costKnown=r.costBasis.known;}
 return{rows,sellPnl,buyCosts,cashShortfalls,openings:[...openings.values()].map(f=>({date:f.date,usd:f.usd,costKnown:Number.isFinite(f.cny)}))};
}
export function cnyPortfolioTotals(trades,funding,markets,from,to,snapshot,rate){
 const base=portfolioTotals(trades,markets,from,to,snapshot).find(g=>g.currency==='USD');if(!base)return{currency:'CNY',rows:[],realized:0,unrealized:0,total:0,periodRealized:0,periodUnrealized:0,periodTotal:0,missing:0};
 const previous=new Date(Date.parse(from+'T12:00:00Z')-86400000).toISOString().slice(0,10),usdStarts=new Map((portfolioTotals(trades,markets,'0001-01-02',previous,snapshot).find(g=>g.currency==='USD')?.rows||[]).map(r=>[r.key,r])),ends=cnyLedger(trades,funding,markets,to,rate),starts=cnyLedger(trades,funding,markets,previous,rate),valid=Number.isFinite(rate)&&rate>0;
 function at(k,led,date,baseR,baseU){const r=led.rows.get(k)||{realized:0,qty:0,cost:0,realizedKnown:true,costKnown:true,realizedCostKnown:true},m=boundMarket(markets,k),price=m?.bars.filter(b=>b.date<=date).at(-1);return{realized:baseR===null||!r.realizedKnown?null:r.realized,unrealized:baseU===null||!r.costKnown?null:r.qty<1e-8?0:valid&&price?r.qty*price.close*rate-r.cost:null,cost:r.costKnown?r.cost:null};}
 const rows=base.rows.map(b=>{const end=at(b.key,ends,to,b.realized,b.unrealized),usdStart=usdStarts.get(b.key);const start=at(b.key,starts,previous,usdStart?usdStart.realized:0,usdStart?usdStart.unrealized:0);const total=x=>x.realized===null||x.unrealized===null?null:x.realized+x.unrealized,sub=(a,b)=>a===null||b===null?null:a-b;const reasons=[...b.reasons];if(!valid&&(b.qty>0||trades.some(t=>t.symbol===b.symbol&&t.side==='SELL'&&t.date<=to)))reasons.push('缺少当前 USD/CNY 汇率');if((!ends.rows.get(b.key)?.costKnown&&b.qty>0)||(ends.rows.get(b.key)?.realizedCostKnown===false&&!b.reasons.includes('卖出缺少买入成本')))reasons.push('人民币资金成本不完整（期初余额 / 现金缺口）');return{...b,...end,currency:'CNY',total:total(end),periodRealized:sub(end.realized,start.realized),periodUnrealized:sub(end.unrealized,start.unrealized),periodTotal:sub(total(end),total(start)),reasons:[...new Set(reasons)]};});
 const fields=['realized','unrealized','total','periodRealized','periodUnrealized','periodTotal'];return{currency:'CNY',rows,...Object.fromEntries(fields.map(f=>[f,rows.some(r=>r[f]===null)?null:rows.reduce((s,r)=>s+r[f],0)])),missing:rows.filter(r=>r.reasons.length).length};
}
