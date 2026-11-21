import {Ajv2020} from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/team-governance.schema.json' with {type:'json'};
import {UserClient} from './client';
import {decode,type UserSession,type TeamRole} from './contracts';
import {pathId} from './compute-contracts';

export type Member={user_id:string;role:TeamRole};
type Membership={organization_id:string;policy_version:string;data:Member[]};
export type Invite={invitation_id:string;organization_id:string;organization_name:string;issuer_id:string;recipient_id:string;role:TeamRole;state:'pending'|'accepted'|'revoked'|'declined'|'expired';expires_at_unix:string;accepted_policy_version:string|null};
type Invites={organization_id:string|null;user_id:string;data:Invite[];next_cursor:string|null};
export type Policy={organization_id:string;owner_ceiling:string|null;hard_limit:string|null;allocated:string;version:string};
export type Budget={organization_id:string;root_budget_id:string;member_id:string|null;limit:string;spent:string;reserved:string;state:'active'|'closing'|'closed';allow_submit:boolean;version:string|null};
type Budgets={organization_id:string;data:Budget[];next_cursor:string|null};
type Change={organization_id:string;user_id:string;role:TeamRole|null;policy_version:string};
const ajv=new Ajv2020({strict:false});ajv.addSchema(schema);
const validate=<T,>(name:string)=>ajv.compile<T>({$ref:schema.$id+'#/$defs/'+name});
const validateMembers=validate<Membership>('TeamMembers'),validateInvite=validate<Invite>('Invitation'),validateInvites=validate<Invites>('Invitations'),validatePolicy=validate<Policy>('BudgetPolicy'),validateBudget=validate<Budget>('MemberBudget'),validateBudgets=validate<Budgets>('MemberBudgets'),validateChange=validate<Change>('MembershipReceipt');
export type Operation='invite'|'revoke'|'accept'|'decline'|'change'|'policy'|'allocate'|'adjust';
export type Intent={op:Operation;org:string;key:string;target?:string;body:Record<string,unknown>};
const requests={invite:validate('IssueInvitation'),revoke:validate('Empty'),accept:validate('ExplicitAcceptance'),decline:validate('Empty'),change:validate('MembershipChange'),policy:validate('SetBudgetPolicy'),allocate:validate('CreateAllocation'),adjust:validate('AdjustAllocation')};
const root=(org:string)=>'/api/v1/organizations/'+pathId(org);
const page=(after?:string)=>'?limit=30'+(after?'&after='+pathId(after):'');
export function checkIntent(v:Intent,org:string){
  if(!v||v.org!==org||!Object.hasOwn(requests,v.op)||!requests[v.op](v.body))throw Error('INVALID_TEAM_INTENT');
  pathId(v.key);pathId(org);
  if(['revoke','accept','decline','adjust'].includes(v.op))pathId(v.target??'');
  if(v.op==='invite'&&v.body.invitation_id!==v.key||v.op==='allocate'&&v.body.budget_id!==v.key||['revoke','accept','decline'].includes(v.op)&&v.target!==v.key)throw Error('TEAM_KEY_MISMATCH');
}
function safeBudget(v:Budget){return BigInt(v.spent)+BigInt(v.reserved)<=BigInt(v.limit)&&BigInt(v.limit)<=9223372036854775807n;}
export class TeamClient extends UserClient{
  async organization(s:UserSession,org:string,signal:AbortSignal){
    const v=decode('UserOrganization',await this.call(root(org),{signal}));
    if(v.member_user_id!==s.user_id||v.organization_id!==org)throw Error('ORGANIZATION_MISMATCH');return v;
  }
  async members(org:string,signal:AbortSignal){
    const v=await this.call(root(org)+'/members',{signal});
    if(!validateMembers(v)||v.organization_id!==org)throw Error('UNCONFIRMED_MEMBERS');return v;
  }
  async invitations(s:UserSession,org:string|null,after:string|undefined,signal:AbortSignal){
    const v=await this.call((org?root(org)+'/invitations':'/api/v1/me/team-invitations')+page(after),{signal});
    if(!validateInvites(v)||v.user_id!==s.user_id||v.organization_id!==org||v.data.some(i=>org?i.organization_id!==org:i.recipient_id!==s.user_id||i.state!=='pending'))throw Error('UNCONFIRMED_INVITES');return v;
  }
  async policy(org:string,signal:AbortSignal){
    const v=await this.call(root(org)+'/budget-policy',{signal});if(!validatePolicy(v)||v.organization_id!==org||(v.hard_limit===null)!==(v.owner_ceiling===null)||v.hard_limit!==null&&(BigInt(v.hard_limit)>BigInt(v.owner_ceiling!)||BigInt(v.allocated)>BigInt(v.hard_limit)))throw Error('UNCONFIRMED_TEAM_LIMIT');return v;
  }
  async budget(org:string,id:string,signal:AbortSignal){
    const v=await this.call(root(org)+'/budgets/'+pathId(id),{signal});
    if(!validateBudget(v)||v.organization_id!==org||v.root_budget_id!==id||!safeBudget(v))throw Error('UNCONFIRMED_ALLOCATION');
    return v;
  }
  async memberBudgets(org:string,after:string|undefined,signal:AbortSignal){
    const v=await this.call(root(org)+'/budgets'+page(after),{signal});
    if(!validateBudgets(v)||v.organization_id!==org||v.data.some(r=>r.organization_id!==org||!safeBudget(r)))throw Error('UNCONFIRMED_TEAM_BUDGETS');return v;
  }
  async act(s:UserSession,m:Intent,signal:AbortSignal){
    checkIntent(m,m.org);const base=root(m.org);const target=m.target?pathId(m.target):'';
    const urls={invite:base+'/invitations',revoke:base+'/invitations/'+target,accept:'/api/v1/team-invitations/'+target+'/accept',decline:'/api/v1/team-invitations/'+target+'/decline',
      change:base+'/members',policy:base+'/budget-policy',allocate:base+'/budgets',adjust:base+'/budgets/'+target};
    const v=await this.call(urls[m.op],{method:m.op==='revoke'?'DELETE':'POST',signal,headers:{'Content-Type':'application/json','Idempotency-Key':m.key,'X-CSRF-Token':s.csrf_token},
      ...(m.op==='revoke'?{}:{body:JSON.stringify(m.body)})});
    if(['invite','accept','decline','revoke'].includes(m.op)){
      if(!validateInvite(v)||v.organization_id!==m.org||v.invitation_id!==m.key||m.op==='invite'&&(v.issuer_id!==s.user_id||v.recipient_id!==m.body.recipient_id||v.role!==m.body.role)||
        m.op==='accept'&&(v.recipient_id!==s.user_id||v.state!=='accepted')||m.op==='decline'&&(v.recipient_id!==s.user_id||v.state!=='declined')||m.op==='revoke'&&v.state!=='revoked')throw Error('UNCONFIRMED_INVITE_ACTION');
    }else if(m.op==='change'){
      if(!validateChange(v)||v.organization_id!==m.org||v.user_id!==m.body.user_id||v.role!==m.body.role)throw Error('UNCONFIRMED_ROLE_CHANGE');
    }else if(m.op==='policy'){
      if(!validatePolicy(v)||v.organization_id!==m.org)throw Error('UNCONFIRMED_TEAM_LIMIT');
    }else if(!validateBudget(v)||!safeBudget(v)||v.organization_id!==m.org||v.root_budget_id!==(m.op==='allocate'?m.key:m.target))throw Error('UNCONFIRMED_ALLOCATION');
    return v;
  }
}
