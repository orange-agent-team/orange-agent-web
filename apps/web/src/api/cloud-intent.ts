import type {UserSession} from './contracts';
import {connectorNames} from './cloud-runs';
import type {ModelSelection,ToolDefinition} from './cloud-runs';
import type {Upload} from './compute-contracts';
export interface CloudIntent {
  v:1;owner:string;user:string;session:string;key:string;budget:string;ttl:number;
  allow_document_connectors?:true;allow_external_connectors?:true;model?:ModelSelection;definition?:ToolDefinition;upload:Upload;prepared?:{artifact:string;version:string};
}
const id=/^[A-Za-z0-9_.:-]{1,128}$/;
export function cloudKey(s:UserSession){return 'orange.cloud-reservation:'+encodeURIComponent(s.session_id);}
export function readIntent(storage:Pick<Storage,'getItem'>,s:UserSession):CloudIntent|undefined {
  const text=storage.getItem(cloudKey(s));if(text===null)return;
  const v:CloudIntent=JSON.parse(text);
  if(!v||v.v!==1||v.owner!==s.personal_owner_id||v.user!==s.user_id||v.session!==s.session_id||
      ![v.key,v.budget,v.upload?.upload_id].every(x=>typeof x==='string'&&id.test(x))||!Number.isInteger(v.ttl)||v.ttl<60||v.ttl>3600||
      (v.model===undefined ? v.upload.media_type!=='text/plain' : v.upload.media_type!=='application/json' ||
        ![v.model.price_version,v.model.model_version,v.model.invocation_id].every(x=>typeof x==='string'&&id.test(x)) ||
        !Number.isInteger(v.model.output_limit)||v.model.output_limit<1||v.model.output_limit>4096)||!/^[0-9a-f]{64}$/.test(v.upload.sha256)||!/^[1-9][0-9]{0,5}$/.test(v.upload.size_bytes)||Number(v.upload.size_bytes)>262144||
      (v.prepared&&(![v.prepared.artifact,v.prepared.version].every(x=>typeof x==='string'&&id.test(x)))))throw Error('INVALID_CLOUD_INTENT');
  if(v.allow_document_connectors!==undefined&&v.allow_document_connectors!==true)throw Error('INVALID_DOCUMENT_INTENT');
  if(v.allow_external_connectors!==undefined&&v.allow_external_connectors!==true)throw Error('INVALID_EGRESS_INTENT');
  if(v.model?.continue_after_tool!==undefined&&(typeof v.model.continue_after_tool!=='boolean'||(v.model.continue_after_tool&&v.model.tool?.name!=='list_directory')))throw Error('INVALID_CLOUD_INTENT');
  if(v.model?.tool && ((v.model.tool.name!=='list_directory'&&!connectorNames.includes(v.model.tool.name))||!/^[0-9a-f]{64}$/.test(v.model.tool.execution_digest)||
      v.definition?.name!==v.model.tool.name||typeof v.definition.description!=='string'||typeof v.definition.parameters!=='object'))throw Error('INVALID_CLOUD_TOOL_INTENT');
  if((v.model?.tool?.name==='list_repositories'||v.model?.tool?.name==='list_projects') && !v.allow_external_connectors)throw Error('REPOSITORY_OPT_IN_REQUIRED');
  if(v.definition&&!v.model?.tool)throw Error('INVALID_CLOUD_TOOL_INTENT');
  return v;
}
