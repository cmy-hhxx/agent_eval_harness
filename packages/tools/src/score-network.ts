import type { EnvHttpProxyAgent } from 'undici';
import { isIP } from 'node:net';
import { defaultDownload, type WebReaderOptions } from './web-reader.js';

/** Match the original hostname before replacing it with the validated public IP. */
export function scoreProxyFor(url:URL,env:NodeJS.ProcessEnv=process.env):string|undefined {
  const exclusions=env.no_proxy??env.NO_PROXY??'',port=Number(url.port)||(url.protocol==='https:'?443:80),host=url.hostname.toLowerCase();
  if(exclusions.trim()==='*')return;
  for(const item of exclusions.split(/[,\s]+/).filter(Boolean)){
    const parts=/^(.+):(\d+)$/.exec(item),name=(parts?parts[1]:item).replace(/^\*?\./,'').toLowerCase();
    if(parts&&Number(parts[2])!==port)continue;
    if(host===name||host.endsWith('.'+name))return;
  }
  const http=env.http_proxy??env.HTTP_PROXY;
  return (url.protocol==='https:'?env.https_proxy??env.HTTPS_PROXY??http:http)||undefined;
}

/** Score owns this explicit transport; SDK global dispatcher changes cannot replace it. */
interface ScoreNetwork {fetch:typeof fetch;download:NonNullable<WebReaderOptions['download']>;close():Promise<void>}
export async function createScoreNetwork():Promise<ScoreNetwork>{
  const {EnvHttpProxyAgent,ProxyAgent,fetch:proxyFetch,request}=await import('undici');
  let searchAgent:EnvHttpProxyAgent|undefined;
  const fetcher:typeof fetch=(input,init)=>{
    searchAgent??=new EnvHttpProxyAgent();
    return proxyFetch(input as Parameters<typeof proxyFetch>[0],{...init,dispatcher:searchAgent} as Parameters<typeof proxyFetch>[1]) as unknown as ReturnType<typeof fetch>;
  };
  const download:NonNullable<WebReaderOptions['download']>=async(url,address,signal,accept)=>{
    const proxy=scoreProxyFor(url);
    if(!proxy)return defaultDownload(url,address,signal,accept);
    const hostname=url.hostname.replace(/^\[|\]$/g,''),pinned=new URL(url);
    pinned.hostname=address.family===6?`[${address.address}]`:address.address;
    const dispatcher=new ProxyAgent({uri:proxy,requestTls:{...(isIP(hostname)?{}:{servername:hostname})}});
    try{
      const response=await request(pinned,{dispatcher,signal,headers:{host:url.host,'user-agent':'ErisEvidenceReader',
        accept:accept??'text/html,application/pdf,text/plain,application/xhtml+xml;q=0.9','accept-encoding':'gzip, deflate, br'}});
      response.body.once('close',()=>{void dispatcher.close().catch(()=>{});});
      return {statusCode:response.statusCode,headers:response.headers,body:response.body,
        destroy:()=>{response.body.destroy();void dispatcher.destroy().catch(()=>{});}};
    }catch(error){
      await dispatcher.destroy().catch(()=>{});
      const status=error instanceof Error?/Proxy response \((\d{3})\)/.exec(error.message)?.[1]:undefined;
      if(status)throw Object.assign(new Error(`来源代理返回HTTP ${status}`),{code:`PROXY_HTTP_${status}`});
      throw error;
    }
  };
  return {fetch:fetcher,download,close:async()=>{await searchAgent?.close();}};
}
