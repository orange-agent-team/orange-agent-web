import { expect, it } from 'vitest';
import { CloudClient } from '../src/api/cloud-runs';
import { readIntent } from '../src/api/cloud-intent';
import type {UserSession} from '../src/api/contracts';

const session:UserSession={user_id:'user',personal_owner_id:'owner',session_id:'session',csrf_token:'csrf',expires_at:'2099-01-01T00:00:00Z'};
const pin='1'.repeat(64);
const definition={name:'list_projects',description:'List granted projects',parameters:{type:'object',properties:{}}};
const tool={name:'list_projects',connector:'gitlab',execution_digest:pin,tool_version:'gitlab.list_projects.v1',execution_environment:'platform_connector',
  approval_required:true,model_definition:definition};

it('negotiates registered tools and rejects a definition attributed to another provider',async()=>{
  const client=(family:string)=>new CloudClient(async(input)=>{
    expect(String(input)).toBe('/api/v1/agent/connector-tools?repository_listing=true');
    return new Response(JSON.stringify({user_id:'user',owner_id:'owner',tools:[{...tool,connector:family}]}));
  });
  expect(await client('gitlab').connectorTools(session)).toEqual([tool]);
  await expect(client('github').connectorTools(session)).rejects.toThrow();
});

it('requires explicit repository access in a recovered reservation',()=>{
  const draft={v:1,owner:'owner',user:'user',session:'session',key:'one',budget:'budget',ttl:600,
    model:{model_version:'model',price_version:'price',invocation_id:'invocation',output_limit:128,tool:{name:'list_projects',execution_digest:pin}},
    definition,upload:{upload_id:'upload',media_type:'application/json',sha256:pin,size_bytes:'4'}};
  const read=(value:unknown)=>readIntent({getItem:()=>JSON.stringify(value)},session);
  expect(()=>read(draft)).toThrow('REPOSITORY_OPT_IN_REQUIRED');
  expect(read({...draft,allow_external_connectors:true})?.model?.tool?.name).toBe('list_projects');
});
