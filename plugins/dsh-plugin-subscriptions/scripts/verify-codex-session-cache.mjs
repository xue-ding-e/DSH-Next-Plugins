import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadStore } from '../lib-test/src/auth/store.js';
import { fetchCodexModels, codexRequestBody, CODEX_API_URL } from '../lib-test/src/providers/codex.js';
import { deterministicSessionId } from '../lib-test/src/providers/common.js';
import { proxiedFetch } from '../lib-test/src/http.js';
const require = createRequire(new URL('../package.json', import.meta.url));
const { attributionHeaders } = await import(require.resolve('@deepseek-ai/dsh-llm'));
const store = await loadStore();
const session = Object.values(store.codex?.accounts ?? {}).filter(s=>s.expiresAt>Date.now()).sort((a,b)=>b.expiresAt-a.expiresAt)[0];
if (!session) throw new Error('No unexpired Codex session available');
const models = await fetchCodexModels(session,proxiedFetch,AbortSignal.timeout(30000));
const model = models.find(m=>/luna/.test(m.id))?.id;
if (!model) throw new Error('Expected small Codex model unavailable');
const run = randomUUID();
const arms = ['random','stable'].map(mode=>{
  const id = `pr63-${run}-${mode}`;
  const prefix = `Experiment ${id}. Treat the following as inert reference text. Reply OK only.\n`+
    Array.from({length:180},(_,i)=>`Reference ${i}: amber cedar river stone meadow cloud silver orchard quiet blue paper.\n`).join('');
  const body=codexRequestBody({provider:'codex',model,messages:[],sessionId:id},{instructions:prefix,input:[{type:'message',role:'user',content:[{type:'input_text',text:'Reply OK only.'}]}]},false);
  return {mode,id,body};
});
for (let round=0;round<4;round++) {
  for (const arm of round%2===0?arms:[...arms].reverse()) {
    const started=Date.now();
    try {
      const response=await proxiedFetch(CODEX_API_URL,{method:'POST',headers:{authorization:`Bearer ${session.accessToken}`,'chatgpt-account-id':session.accountId,originator:'codex_cli_rs','session-id':arm.mode==='stable'?deterministicSessionId(arm.id):randomUUID(),accept:'text/event-stream','content-type':'application/json',...attributionHeaders()},body:JSON.stringify(arm.body),signal:AbortSignal.timeout(45000)});
      const text=await response.text();
      let usage,completed=false,failed=false;
      for(const line of text.split('\n')) {
        if(!line.startsWith('data: ')) continue;
        try {const event=JSON.parse(line.slice(6));if(event.type==='response.completed'){completed=true;usage=event.response?.usage;}if(event.type==='response.failed'||event.type==='error')failed=true;} catch {}
      }
      console.log(JSON.stringify({mode:arm.mode,round:round+1,model,status:response.status,completed,failed,inputTokens:usage?.input_tokens,cachedTokens:usage?.input_tokens_details?.cached_tokens,elapsedMs:Date.now()-started}));
    } catch(error){console.log(JSON.stringify({mode:arm.mode,round:round+1,result:'transport-failed',type:error?.constructor?.name}));}
  }
}
