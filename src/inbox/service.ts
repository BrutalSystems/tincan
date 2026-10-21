import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { InboxStorage } from './storage.js';
import { identityKey } from './identity.js';
import { InboxError, INBOX_TTL_MS, INBOX_MAX_ITEMS, INBOX_MAX_BYTES, QUARANTINE_MAX_ITEMS, QUARANTINE_MAX_BYTES, READ_MAX_BYTES, READ_DEFAULT_LIMIT, READ_MAX_LIMIT, type InboxIdentity, type InboxSnapshot, type InboxItem, type ReadArgs, type ReadResult, type EnqueueArgs, type EnqueueResult } from './types.js';
const bytes=(x:unknown)=>Buffer.byteLength(JSON.stringify(x));
const digest=(x:string)=>createHash('sha256').update(x).digest('hex');
export type InboxEvent = 'queued'|'quarantined'|'released'|'revoked'|'expired'|'dropped';
export interface InboxOptions { now?:()=>number; newGeneration?:()=>string; audit?:(id:string,state:InboxEvent,at:string)=>void }
export function inboxFromEnv(env:NodeJS.ProcessEnv=process.env, options:InboxOptions={}):InboxService {
 return new InboxService(new InboxStorage({root:join(env.TINCAN_HOME??join(homedir(),'.tincan'),'inboxes')}), options);
}
export class InboxService {
 constructor(readonly storage:InboxStorage, private readonly options:InboxOptions={}){}
 private now(){return (this.options.now??Date.now)();}
 inspect(receiver:InboxIdentity){return this.storage.inspect(receiver);}
 inspectId(id:string){return this.storage.inspectId(id);}
 private expire(s:InboxSnapshot){const now=this.now();s.items=s.items.filter(i=>i.expiresAt>now);s.keys=s.keys.filter(k=>k.expiresAt>now);}
 private async change<T>(receiver:InboxIdentity, action:(s:InboxSnapshot, events:Array<[string,InboxEvent]>)=>T):Promise<T>{
  const events:Array<[string,InboxEvent]>=[];
  const result=await this.storage.transaction(receiver,s=>{
   if(!s?.enabled)throw new InboxError('policy_changed');
   for(const item of s.items)if(item.expiresAt<=this.now())events.push([item.envelope.id,'expired']);
   this.expire(s);return {state:s,result:action(s,events)};
  });
  for(const [id,state]of events){try{this.options.audit?.(id,state,new Date(this.now()).toISOString());}catch{/* Audit failure cannot undo a committed queue operation. */}}
  return result;
 }
 async enable(receiver:InboxIdentity):Promise<{generation:string}>{
  return this.storage.transaction(receiver,old=>{
   const state:InboxSnapshot=old?.enabled?old:{version:1,enabled:true,generation:(this.options.newGeneration??randomUUID)(),receiver,grants:[],nextSequence:0,items:[],keys:[]};
   return {state,result:{generation:state.generation}};
  });
 }
 async disable(receiver:InboxIdentity){return this.change(receiver,(s,events)=>{const discarded=s.items.length;for(const i of s.items)events.push([i.envelope.id,'dropped']);s.enabled=false;s.items=[];s.keys=[];s.grants=[];return {discarded};});}
 async grant(receiver:InboxIdentity,sender:InboxIdentity){identityKey(sender);return this.change(receiver,(s,events)=>{
  if(!s.grants.some(g=>identityKey(g)===identityKey(sender)))s.grants.push(sender);
  for(const i of s.items)if(i.state==='quarantined'&&i.sender&&identityKey(i.sender)===identityKey(sender)){i.state='eligible';i.sequence=++s.nextSequence;events.push([i.envelope.id,'queued']);}
  return {granted:true};
 });}
 async revoke(receiver:InboxIdentity,sender:InboxIdentity){identityKey(sender);return this.change(receiver,(s,events)=>{
  s.grants=s.grants.filter(g=>identityKey(g)!==identityKey(sender));
  for(const i of s.items)if(i.state==='eligible'&&i.sender&&identityKey(i.sender)===identityKey(sender)){i.state='quarantined';i.sequence=++s.nextSequence;events.push([i.envelope.id,'revoked']);}return {revoked:true};
 });}
 async release(receiver:InboxIdentity,id:string){return this.change(receiver,(s,events)=>{const i=s.items.find(i=>i.envelope.id===id);if(!i)throw new InboxError('item_unknown');if(i.state!=='released'){i.state='released';i.sequence=++s.nextSequence;events.push([id,'released']);}return {released:true};});}
 async drop(receiver:InboxIdentity,id:string){return this.change(receiver,(s,events)=>{if(!s.items.some(i=>i.envelope.id===id))throw new InboxError('item_unknown');s.items=s.items.filter(i=>i.envelope.id!==id);events.push([id,'dropped']);return {dropped:true};});}
 async status(receiver:InboxIdentity){
  const view=await this.inspect(receiver);if(!view.enabled)return {enabled:false as const,grants:[],items:0,bytes:0,eligible:0,quarantined:0,released:0,next_expiry:null};
  return this.change(receiver,s=>({enabled:true as const,generation:s.generation,grants:s.grants,items:s.items.length,bytes:bytes(s),eligible:s.items.filter(i=>i.state==='eligible').length,quarantined:s.items.filter(i=>i.state==='quarantined').length,released:s.items.filter(i=>i.state==='released').length,next_expiry:s.items.length?Math.min(...s.items.map(i=>i.expiresAt)):null}));
 }
 private page(s:InboxSnapshot,args:ReadArgs,held:boolean):ReadResult {
  const limit=args.limit??READ_DEFAULT_LIMIT;
  if(!Number.isInteger(limit)||limit<1||limit>READ_MAX_LIMIT)throw new InboxError('cursor_invalid');
  const kind=held?'quarantine':'read';let seq=0;
  if(args.cursor!==undefined){try{const c=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));
   if(c.receiver!==identityKey(s.receiver)||c.generation!==s.generation||c.kind!==kind||!Number.isSafeInteger(c.sequence)||c.sequence<0||c.sequence>s.nextSequence)throw Error();seq=c.sequence;
  }catch{throw new InboxError('cursor_invalid');}}
  const available=s.items.filter(i=>(held?i.state==='quarantined':i.state!=='quarantined')&&(i.sequence??0)>seq).sort((a,b)=>a.sequence!-b.sequence!);
  const messages:InboxItem[]=[];
  for(const item of available){if(messages.length===limit||bytes([...messages,item])>READ_MAX_BYTES)break;messages.push(item);seq=item.sequence!;}
  return {enabled:true,messages,next_cursor:Buffer.from(JSON.stringify({receiver:identityKey(s.receiver),generation:s.generation,kind,sequence:seq})).toString('base64url'),has_more:messages.length<available.length};
 }
 async read(receiver:InboxIdentity,args:ReadArgs):Promise<ReadResult>{
  if(!(await this.inspect(receiver)).enabled)return {enabled:false,messages:[],notice:'Strict inbox is not enabled.'};
  return this.change(receiver,s=>this.page(s,args,false));
 }
 async quarantine(receiver:InboxIdentity,args:ReadArgs={}){return this.change(receiver,s=>this.page(s,args,true));}
 private insert(s:InboxSnapshot,args:EnqueueArgs):EnqueueResult {
  if(!s.enabled||s.generation!==args.generation)throw new InboxError('policy_changed');
  this.expire(s);
  const {envelope:e}=args;
  const fingerprint=digest(JSON.stringify({receiver:identityKey(args.receiver),text:e.text,from:e.from.runtime,reply:e.in_reply_to,answers:e.answers,expect:e.expect_reply,reply_via:e.reply_via,urgent:args.urgent}));
  const keyHash=args.key===undefined?undefined:digest(args.key);
  const previous=keyHash===undefined?undefined:s.keys.find(k=>k.namespace===args.namespace&&k.keyHash===keyHash);
  if(previous){if(previous.fingerprint!==fingerprint)throw new InboxError('key_reused');const item=s.items.find(i=>i.envelope.id===previous.messageId);return {message_id:previous.messageId,inbox_state:item?.state==='quarantined'?'quarantined':'queued',duplicate:true};}
  const existing=s.items.find(i=>i.envelope.id===e.id);if(existing)return {message_id:e.id,inbox_state:existing.state==='quarantined'?'quarantined':'queued',duplicate:true};
  const eligible=!!args.sender&&s.grants.some(g=>identityKey(g)===identityKey(args.sender!));
  const item:InboxItem={envelope:e,state:eligible?'eligible':'quarantined',expiresAt:this.now()+INBOX_TTL_MS,urgent:args.urgent,sequence:s.nextSequence+1,...(args.sender&&{sender:args.sender})};
  if(bytes([item])>READ_MAX_BYTES||s.items.length>=INBOX_MAX_ITEMS)throw new InboxError('queue_full');
  const held=s.items.filter(i=>i.state==='quarantined');
  if(!eligible&&(held.length>=QUARANTINE_MAX_ITEMS||bytes([...held,item])>QUARANTINE_MAX_BYTES))throw new InboxError('queue_full');
  s.items.push(item);s.nextSequence++;
  if(keyHash!==undefined)s.keys.push({namespace:args.namespace,keyHash,fingerprint,messageId:e.id,expiresAt:item.expiresAt});
  if(bytes(s)>INBOX_MAX_BYTES)throw new InboxError('queue_full');
  return {message_id:e.id,inbox_state:eligible?'queued':'quarantined',duplicate:false};
 }
 async enqueue(args:EnqueueArgs){return this.change(args.receiver,(s,events)=>{const result=this.insert(s,args);if(!result.duplicate)events.push([result.message_id,result.inbox_state]);return result;});}
 async preflight(args:EnqueueArgs):Promise<void>{await this.change(args.receiver,s=>{this.insert(structuredClone(s),args);});}
}
