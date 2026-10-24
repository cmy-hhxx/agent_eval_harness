import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createScoreNetwork, scoreProxyFor } from './score-network.js';

test('Score proxy routing checks the original hostname, protocol and NO_PROXY port',()=>{
  const env={HTTP_PROXY:'http://proxy:80',HTTPS_PROXY:'http://secure:80',NO_PROXY:'localhost,.example.com:443'};
  assert.equal(scoreProxyFor(new URL('https://issuer.example.com/report'),env),undefined);
  assert.equal(scoreProxyFor(new URL('http://issuer.example.com/report'),env),env.HTTP_PROXY);
  assert.equal(scoreProxyFor(new URL('https://other.com/report'),env),env.HTTPS_PROXY);
  assert.equal(scoreProxyFor(new URL('https://other.com/report'),{...env,no_proxy:'*'}),undefined);
});

test('Score source transport tunnels to the validated IP and retains the original Host',async()=>{
  const proxy=createServer(),requests:string[]=[];
  proxy.on('connect',(request,socket)=>{
    requests.push(request.url!);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data',bytes=>{
      const text=bytes.toString();assert.match(text,/host: issuer\.example\.com/i);
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 8\r\nConnection: close\r\n\r\nevidence');
    });
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const keys=['http_proxy','HTTP_PROXY','no_proxy','NO_PROXY'],previous=keys.map(key=>process.env[key]);
  process.env.http_proxy=`http://127.0.0.1:${(proxy.address() as {port:number}).port}`;delete process.env.no_proxy;delete process.env.NO_PROXY;
  const transport=await createScoreNetwork();
  try{
    const response=await transport.download(new URL('http://issuer.example.com/report'),{address:'93.184.216.34',family:4},AbortSignal.timeout(3000));
    const chunks:Uint8Array[]=[];for await(const chunk of response.body)chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(),'evidence');assert.deepEqual(requests,['93.184.216.34:80']);
  }finally{
    await transport.close();keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
    proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));
  }
});
