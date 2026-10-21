import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { identityKey } from './identity.js';
import { InboxError, INBOX_MAX_BYTES, type InboxIdentity, type InboxSnapshot, type PolicyView } from './types.js';
const identity = z.object({runtime:z.enum(['codex','claude-code','opencode']),id:z.string()}).strict();
const party=z.object({runtime:z.enum(['codex','claude-code','opencode','external']),name:z.string(),cwd:z.string().optional(),thread_id:z.string().optional(),session_id:z.string().optional(),machine:z.string().optional()});
const envelope=z.object({id:z.string(),at:z.string(),from:party,to:party,method:z.literal('pull-inbox'),expect_reply:z.boolean(),reply_tool:z.boolean(),in_reply_to:z.string().optional(),answers:z.boolean().optional(),also_sent_to:z.array(z.string()).optional(),broadcast_id:z.string().optional(),reply_via:z.string().optional(),text:z.string()});
const snapshot=z.object({version:z.literal(1),enabled:z.boolean(),generation:z.string().min(1),receiver:identity,grants:z.array(identity),nextSequence:z.number().int().nonnegative().safe(),items:z.array(z.object({envelope,state:z.enum(['quarantined','eligible','released']),expiresAt:z.number().finite(),sequence:z.number().int().positive().safe().optional(),urgent:z.boolean(),sender:identity.optional()})),keys:z.array(z.object({namespace:z.string(),keyHash:z.string(),fingerprint:z.string(),messageId:z.string(),expiresAt:z.number().finite()}))}).strict();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export interface StorageOptions {root:string; now?:()=>number; lockTimeoutMs?:number; probeOwner?:(owner:{pid:number;token:string})=>'alive'|'dead'|'unknown'}
/** Private local state, not a boundary against arbitrary processes with this UID. */
export class InboxStorage {
 readonly root:string;
 constructor(private readonly options:StorageOptions){this.root=options.root;}
 private dir(who:InboxIdentity):string {identityKey(who);return join(this.root,hash(who.id.toLowerCase()),who.runtime);}
 private async checked(path:string, directory:boolean):Promise<boolean>{
  try {const s=await fs.lstat(path);if(s.isSymbolicLink() || (directory?!s.isDirectory():!s.isFile()) || (process.getuid && s.uid!==process.getuid()) || (s.mode & 0o077)!==0) throw new InboxError('storage_failed'); return true;}catch(e){if(absent(e))return false;throw e;}
 }
 private async read(who:InboxIdentity):Promise<InboxSnapshot|undefined>{
  if(!await this.checked(this.root,true))return undefined;
  const parent=join(this.root,hash(who.id.toLowerCase()));
  if(!await this.checked(parent,true))return undefined;
  const dir=this.dir(who);if(!await this.checked(dir,true))return undefined;
  const path=join(dir,'state.json');if(!await this.checked(path,false))throw new InboxError('policy_corrupt');
  const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await handle.stat();if(stat.size>INBOX_MAX_BYTES)throw new InboxError('policy_corrupt');
   const parsed=snapshot.safeParse(JSON.parse(await handle.readFile('utf8')));
   if(!parsed.success)throw new InboxError('policy_corrupt');
   const s=parsed.data as InboxSnapshot;
   if(identityKey(s.receiver)!==identityKey(who))throw new InboxError('policy_corrupt');
   for(const grant of s.grants)identityKey(grant);
   if(s.items.some(i=>i.sequence!==undefined && i.sequence>s.nextSequence))throw new InboxError('policy_corrupt');
   return s;
  }catch(e){if(e instanceof InboxError)throw e;throw new InboxError('policy_corrupt');}finally{await handle.close();}
 }
 async inspect(who:InboxIdentity):Promise<PolicyView>{
  identityKey(who);try {const s=await this.read(who);return s?.enabled?{enabled:true,generation:s.generation,receiver:s.receiver}:{enabled:false};}catch(e){if(e instanceof InboxError)throw e;throw new InboxError('storage_failed');}
 }
 async inspectId(id:string):Promise<PolicyView[]>{
  const results:PolicyView[]=[];
  for(const runtime of ['codex','claude-code','opencode'] as const){
   const who={runtime,id};
   // A bare ID may belong to only one runtime's syntax. Do not guess which.
   try{identityKey(who);}catch{continue;}
   const view=await this.inspect(who);if(view.enabled)results.push(view);
  }return results;
 }
 private async mkdir(path:string):Promise<void>{await fs.mkdir(path,{recursive:true,mode:0o700});await this.checked(path,true);}
 async transaction<T>(who:InboxIdentity, fn:(state:InboxSnapshot|undefined)=>{state:InboxSnapshot;result:T}):Promise<T>{
  identityKey(who);
  let lock:string|undefined;let token:string|undefined;let committed=false;
  try {
   await this.mkdir(this.root);const locks=join(this.root,'.locks');await this.mkdir(locks);
   const path=join(locks,hash(identityKey(who)));const deadline=Date.now()+(this.options.lockTimeoutMs??2000);
   for(;;){try{await fs.mkdir(path,{mode:0o700});lock=path;token=randomUUID();await fs.writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600,flag:'wx'});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(Date.now()>=deadline)throw new InboxError('locked');await new Promise(r=>setTimeout(r,10));}}
   const old=await this.read(who);const {state,result}=fn(old);
   const encoded=JSON.stringify(state);if(Buffer.byteLength(encoded)>INBOX_MAX_BYTES)throw new InboxError('queue_full');
   if(!snapshot.safeParse(state).success || identityKey(state.receiver)!==identityKey(who))throw new InboxError('policy_corrupt');
   const parent=join(this.root,hash(who.id.toLowerCase()));await this.mkdir(parent);const dir=this.dir(who);await this.mkdir(dir);
   const temp=join(dir,`.${token}.tmp`);const handle=await fs.open(temp,'wx',0o600);
   try{await handle.writeFile(encoded);await handle.sync();}finally{await handle.close();}
   try{await fs.rename(temp,join(dir,'state.json'));committed=true;const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}}finally{await fs.unlink(temp).catch(()=>{});}
   return result;
  }catch(e){if(committed)throw new InboxError('commit_unknown');if(e instanceof InboxError)throw e;if((e as NodeJS.ErrnoException).code)throw new InboxError('storage_failed');throw e;}
  finally {if(lock && token){try{const owner=JSON.parse(await fs.readFile(join(lock,'owner.json'),'utf8'));if(owner.token===token){await fs.unlink(join(lock,'owner.json'));await fs.rmdir(lock);}}catch{/* Uncertain ownership leaves a recoverable lock, never deletes another writer's. */}}}
 }
}
