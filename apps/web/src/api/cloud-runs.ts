import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/cloud-agent.schema.json' with {type:'json'};
import { ComputeClient } from './compute-client';
import { ApiFailure } from './client';
import type {UserSession} from './contracts';
export const profile='dev-gvisor-linux-arm64-v1';
export interface RunCreate {root_budget_id:string;input_artifact_id:string;input_version_id:string;resource_profile_id:typeof profile;workspace_ttl_seconds:number}
export interface CloudRun {
  run_id:string;owner_id:string;user_id:string;version:string;root_budget_id:string;input_artifact_id:string;input_version_id:string;created_at:string;
  status:'queued'|'running'|'cancelled'|'recovery_required'|'failed'|'completed'|'waiting_approval'|'paused';
  workspace:{workspace_id:string;version:string;resource_profile_id:typeof profile;expires_at:string;
    status:'requested'|'preparing'|'ready'|'running'|'draining'|'deleted'|'quarantined'};
}
interface Page {user_id:string;owner_id:string;data:CloudRun[];next_before?:string}
interface Capacity {user_id:string;owner_id:string;resource_profile_id:typeof profile;max_active:number;occupied:number;can_reserve:boolean;pool_available:boolean}
const ajv=new Ajv2020({strict:false});
ajv.addFormat('date-time',v=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v)&&Number.isFinite(Date.parse(v)));
ajv.addSchema(schema);
const validate=<T,>(name:string)=>ajv.compile<T>({$ref:`${schema.$id}#/$defs/${name}`});
const run=validate<CloudRun>('CloudRun'),page=validate<Page>('CloudRunList'),capacity=validate<Capacity>('CloudCapacity'),create=validate<RunCreate>('CloudRunCreate');
interface Withdrawal {owner_id:string;user_id:string;request_key:string;receipt_id:string;run?:CloudRun}
const withdrawal=validate<Withdrawal>('CloudRunWithdrawal');
const idPattern=/^[A-Za-z0-9_.:-]{1,128}$/;
function component(id:string){if(!idPattern.test(id))throw Error('INVALID_IDENTIFIER');return encodeURIComponent(id);}
function owned(row:{owner_id:string;user_id:string},s:UserSession){if(row.owner_id!==s.personal_owner_id||row.user_id!==s.user_id)throw new ApiFailure(403,'ACTOR_MISMATCH');}
function checked(raw:unknown,s:UserSession){if(!run(raw))throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');owned(raw,s);return raw;}
const base='/api/v1/agent';
export class CloudClient extends ComputeClient {
  async cloudCapacity(s:UserSession,signal?:AbortSignal){
    const raw=await this.call(base+'/workspace-capacity',{signal});
    if(!capacity(raw)||raw.can_reserve!==(raw.pool_available&&raw.occupied<raw.max_active))throw new ApiFailure(200,'INVALID_RESPONSE');
    owned(raw,s);return raw;
  }
  async cloudRuns(s:UserSession,before?:string,signal?:AbortSignal){
    const q=new URLSearchParams({limit:'30'});if(before)q.set('before',before);
    const raw=await this.call(base+'/runs?'+q,{signal});if(!page(raw))throw new ApiFailure(200,'INVALID_RESPONSE');
    owned(raw,s);raw.data.forEach(item=>owned(item,s));return raw;
  }
  async createRun(s:UserSession,key:string,body:RunCreate){
    if(!create(body)||!idPattern.test(key))throw Error('INVALID_REQUEST');
    const row=checked(await this.call(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'Idempotency-Key':key},body:JSON.stringify(body)},201),s);
    if(row.root_budget_id!==body.root_budget_id||row.input_artifact_id!==body.input_artifact_id||row.input_version_id!==body.input_version_id||row.workspace.resource_profile_id!==body.resource_profile_id)throw new ApiFailure(201,'UNCONFIRMED_RESPONSE');
    return row;
  }
  async originalRun(s:UserSession,key:string){return checked(await this.call(base+'/invocations/'+component(key)),s);}
  async withdrawOriginal(s:UserSession,key:string){
    const row=await this.call(base+'/invocations/'+component(key),{method:'DELETE',headers:{'Idempotency-Key':key,'X-CSRF-Token':s.csrf_token}});
    if(!withdrawal(row)||row.request_key!==key)throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
    owned(row,s);if(row.run)checked(row.run,s);return row;
  }
  async cancelCloudRun(s:UserSession,runId:string,key:string){
    const row=checked(await this.call(base+'/runs/'+component(runId),{method:'DELETE',headers:{'Idempotency-Key':key,'X-CSRF-Token':s.csrf_token}}),s);
    if(row.run_id!==runId||row.status!=='cancelled')throw new ApiFailure(200,'UNCONFIRMED_RESPONSE');
    return row;
  }
}
