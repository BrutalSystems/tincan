import {beforeEach,afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MessageLog} from '../src/log.js';import {buildEnvelope} from '../src/envelope.js';
import {strictAuditEnvelope, requestFingerprint} from '../src/inbox/audit.js';
import {FileIdempotencyStore} from '../src/cli-idempotency.js';
let dir:string;let log:MessageLog;
const envelope=(id:string,strict=true)=>buildEnvelope({id,from:{runtime:'codex',name:'sender',thread_id:'sender'},to:{runtime:'claude-code',name:'receiver',session_id:'receiver'},method:strict?'pull-inbox':'inbox',text:'PRIVATE_BODY_SENTINEL',expect_reply:false,reply_tool:true});
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'tincan-audit-'));log=new MessageLog(join(dir,'messages.jsonl'));});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test('audit sink never persists a pull message body even without explicit projection',()=>{
 const e=envelope('msg_1');log.appendMessage(e,false);log.appendIncoming(e);
 expect(readFileSync(join(dir,'messages.jsonl'),'utf8')).not.toContain('PRIVATE_BODY_SENTINEL');
 expect(log.findMessage('msg_1')).toMatchObject({text:'[body omitted: strict inbox]',body_omitted:true,from:e.from,to:e.to});
 expect(strictAuditEnvelope(e)).toMatchObject({text:'[body omitted: strict inbox]',body_omitted:true});
 expect(log.readWithIntegrity({last_n:20}).integrity.ok).toBe(true);
});
test('quarantined answers cannot close questions; later availability is historical',()=>{
 const q={...envelope('question',false),expect_reply:true};log.appendMessage(q,true);
 const a={...envelope('answer'),in_reply_to:'question',answers:true};log.appendMessage(a,false);log.appendOutcome('answer',true);log.appendInboxEvent('answer','quarantined','2026-01-01');
 expect(log.read({last_n:20}).find(r=>r.id==='question')).toMatchObject({answered:false});
 log.appendInboxEvent('answer','released','2026-01-02');expect(log.read({last_n:20}).find(r=>r.id==='question')).toMatchObject({answered:true});
 log.appendInboxEvent('answer','revoked','2026-01-03');expect(log.read({last_n:20}).find(r=>r.id==='question')).toMatchObject({answered:true});
});
test('failed answers and non-answer releases do not close questions',()=>{
 log.appendMessage({...envelope('q',false),expect_reply:true},true);
 log.appendMessage({...envelope('a'),in_reply_to:'q',answers:true},false);log.appendOutcome('a',false);log.appendInboxEvent('a','queued','now');
 log.appendMessage({...envelope('b'),in_reply_to:'q'},false);log.appendOutcome('b',true);log.appendInboxEvent('b','released','now');
 expect(log.read({last_n:20}).find(r=>r.id==='q')).toMatchObject({answered:false});
});
test('fingerprint retry records keep content out of persistent key files',()=>{
 const keys=new FileIdempotencyStore(join(dir,'keys'));
 keys.record('agent:one:key',{messageId:'msg_1',peer:'receiver',peerArg:'receiver',text:'[body omitted: strict inbox]',fingerprint:requestFingerprint({message:'PRIVATE_BODY_SENTINEL'}),strict:true});
 expect(keys.lookup('agent:two:key')).toBeUndefined();
 expect(keys.lookup('agent:one:key')).toMatchObject({strict:true});
 const data=readdirSync(join(dir,'keys')).map(n=>readFileSync(join(dir,'keys',n),'utf8')).join('');expect(data).not.toContain('PRIVATE_BODY_SENTINEL');
 expect(requestFingerprint({message:'x',answers:true})).not.toBe(requestFingerprint({message:'x',answers:false}));
});
