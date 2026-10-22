import { AuthService } from '../dist-desktop/core/auth.js';
import { GoogleDrive } from '../dist-desktop/core/drive.js';
import { MemoryStore } from '../dist-desktop/core/store.js';
import { mkdir, writeFile } from 'node:fs/promises';
const saved = globalThis.fetch, results = [];
function pool(accounts) {
  const repo = new MemoryStore();
  accounts.forEach((accountId, i) => repo.saveConnection({ id: `c${i}`, accountId, clientId: `client${i}`, projectId: 'synthetic-project', clientSecret: 'synthetic', accessToken: `synthetic${i}`, expiresAt: Date.now()+3600000 }));
  const auth = new AuthService(repo, async()=>{});
  return { auth, drive: new GoogleDrive(auth) };
}
try {
  for (const accounts of [['a'],['a','a','a'],['a','a','a','b','b','b']]) {
    const { auth, drive } = pool(accounts); let active=0,peak=0;
    globalThis.fetch = async()=>{ peak=Math.max(peak,++active); await new Promise(r=>setTimeout(r,5));active--;return Response.json({id:'f',parents:[]}); };
    await Promise.all([...new Set(accounts)].flatMap(account=>Array.from({length:24},(_,i)=>drive.get(account,`f${i}`))));
    const expected = accounts.length === 1 ? 6 : accounts.length === 3 ? 18 : 36;
    if (peak!==expected) throw Error(`Unexpected initial peak ${peak} != ${expected}`);
    results.push({scenario:'immediate-full-concurrency',accounts:new Set(accounts).size,connections:accounts.length,peak,limits:auth.snapshot()});
  }
  {
    const { auth, drive } = pool(['a','a']); const times=[];
    globalThis.fetch=async()=>{times.push(Date.now());return times.length===1?new Response(JSON.stringify({error:{errors:[{reason:'userRateLimitExceeded'}]}}),{status:403,headers:{'Retry-After':'2'}}):Response.json({id:'f',parents:[]});};
    await drive.get('a','f');
    const gap=times[1]-times[0],limit=auth.snapshot().accounts[0].limit;
    if(gap<2000 || limit!==6) throw Error('Cross-connection cooling or halving failed');
    results.push({scenario:'account-limit-across-two-connections',retryAfterMs:2000,observedGapMs:gap,initialCapacity:12,reducedCapacity:limit,requests:times.length});
  }
  await mkdir('test-results/concurrency-1.3.0',{recursive:true});
  await writeFile('test-results/concurrency-1.3.0/results.json',JSON.stringify({passed:true,scope:'synthetic HTTP responses and credentials only; real wall-clock backoff; no remote requests',results},null,2));
  console.log('Concurrency/backoff checks passed:',JSON.stringify(results.map(({limits,...result})=>result)));
} finally {globalThis.fetch=saved;}
