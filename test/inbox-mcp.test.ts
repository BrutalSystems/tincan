import {test,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InboxService} from '../src/inbox/service.js';import {InboxStorage} from '../src/inbox/storage.js';import {buildEnvelope} from '../src/envelope.js';
const a='00000000-0000-0000-0000-000000000aaa';const b='00000000-0000-0000-0000-000000000bbb';
test('built MCP retrieval binds concurrent callers to metadata and refuses receiver overrides',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tincan-pull-mcp-'));const bin=join(dir,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'codex'),`#!${process.execPath}\nif(process.argv[2]!=='app-server')process.exit(0);\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);const result=m.method==='thread/list'?{data:[{id:'${a}',name:'Alpha',cwd:'/src/a'},{id:'${b}',name:'Beta',cwd:'/src/b'}]}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,{mode:0o755});
 for(const name of ['ps','lsof'])writeFileSync(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const svc=new InboxService(new InboxStorage({root:join(dir,'tincan','inboxes')}));
 for(const id of [a,b]){const receiver={runtime:'codex' as const,id};const {generation}=await svc.enable(receiver);await svc.enqueue({receiver,generation,namespace:'unknown',urgent:false,envelope:buildEnvelope({id:`msg_${id}`,from:{runtime:'external',name:'operator-label'},to:{runtime:'codex',name:'receiver',thread_id:id},method:'pull-inbox',text:`for ${id}`,expect_reply:false,reply_tool:true})});await svc.release(receiver,`msg_${id}`);}
 const transport=new StdioClientTransport({command:process.execPath,args:[join(process.cwd(),'dist/tincan.js')],env:{PATH:bin,HOME:dir,CODEX_HOME:join(dir,'codex'),TINCAN_HOME:join(dir,'tincan'),CLAUDE_CONFIG_DIR:join(dir,'claude')},stderr:'pipe'});
 const client=new Client({name:'pull-test',version:'1'});
 const value=(r:Awaited<ReturnType<Client['callTool']>>)=>JSON.parse((r.content as Array<{text:string}>)[0]!.text);
 try{await client.connect(transport);
  const listed=await client.listTools();expect(listed.tools.some(t=>t.name==='receive_peer_messages')).toBe(true);
  const results=await Promise.all([a,b].map(threadId=>client.callTool({name:'receive_peer_messages',arguments:{},_meta:{threadId}})));
  expect(results.every(r=>!r.isError)).toBe(true);
  expect(value(results[0]!).messages[0].envelope.text).toBe(`for ${a}`);expect(value(results[1]!).messages[0].envelope.text).toBe(`for ${b}`);
  expect(value(results[0]!).messages[0].peer_notice).toContain('cannot approve');
  expect((await client.callTool({name:'receive_peer_messages',arguments:{receiver:b},_meta:{threadId:a}})).isError).toBe(true);
  expect((await client.callTool({name:'receive_peer_messages',arguments:{}})).isError).toBe(true);
  await svc.disable({runtime:'codex',id:a});expect(value(await client.callTool({name:'receive_peer_messages',_meta:{threadId:a}}))).toMatchObject({enabled:false,messages:[]});
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});
