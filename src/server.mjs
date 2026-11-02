const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
async function currentFx(){try{const r=await fetch('https://api.frankfurter.dev/v2/rate/USD/CNY',{signal:AbortSignal.timeout(7000),headers:{Accept:'application/json'}});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();if(d.base!=='USD'||d.quote!=='CNY'||!Number.isFinite(d.rate)||d.rate<=0)throw Error('汇率响应无效');const date=day(d.date),age=(Date.now()-Date.parse(date))/86400000;if(age>7||age< -1)throw Error('汇率日期过旧或异常');return json({rate:d.rate,date,base:'USD',quote:'CNY',source:'Frankfurter',asOf:new Date().toISOString(),label:'最新可用日参考汇率，非实时成交汇率'});}catch{return json({error:'当前 USD/CNY 汇率获取失败；可重试，或在页面手动输入并注明日期。未使用默认或模拟汇率。'},502);}}
export default {async fetch(request,env,ctx){void ctx;const url=new URL(request.url);if(url.pathname==='/api/workspace'||url.pathname.startsWith('/api/imports')||url.pathname==='/api/migrate')return persistenceApi(request,env);if(request.method!=='GET')return json({error:'Method not allowed'},405);
if(url.pathname==='/api/fx')return currentFx();
if(url.pathname==='/api/history'){
const symbol=url.searchParams.get('symbol')||'',start=url.searchParams.get('start')||'';if(!/^[A-Z0-9^][A-Z0-9.\-^]{0,29}$/.test(symbol)||!/^\d{4}-\d{2}-\d{2}$/.test(start))return json({error:'股票代码或日期无效'},400);
let date;try{date=day(start);}catch{return json({error:'日期无效'},400);}const period1=Math.floor(new Date(date+'T00:00:00Z').getTime()/1000),period2=Math.floor(Date.now()/1000)+86400;
if(period1<0||period1>=period2)return json({error:'日期超出免费行情范围'},400);
const choice=url.searchParams.get('source')||'auto';if(!['auto','yahoo','nasdaq','stooq','twelve'].includes(choice))return json({error:'不支持的数据源'},400);const data=await loadMarketHistory(symbol,start,env,choice);return json(data,data.error?502:200);}

if(url.pathname!=='/')return new Response('Not found',{status:404});
return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'"}});
}};
