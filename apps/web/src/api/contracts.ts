import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/user.schema.json' with { type: 'json' };
export interface UserSession { session_id: string; user_id: string; personal_owner_id: string; csrf_token: string; expires_at: string }
export type TeamRole = 'owner' | 'admin' | 'member' | 'billing' | 'viewer';
export interface Organization { member_user_id: string; organization_id: string; name: string; role: TeamRole; member_limit: number; policy_version: string }
export interface OrganizationList { user_id: string; data: Organization[]; next_cursor?: string }
export interface CreateOrganization { name: string; member_limit: number }
export interface ApiError { code: string; message: string; request_id: string; retry_class: string }
const ajv = new Ajv2020({ strict: false });
ajv.addFormat('date-time', (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s)));
ajv.addSchema(schema);
const validators = {
  SessionRevocationContext: ajv.compile<{ csrf_token: string }>({ $ref: `${schema.$id}#/$defs/SessionRevocationContext` }),
  UserSession: ajv.compile<UserSession>({ $ref: `${schema.$id}#/$defs/UserSession` }),
  UserOrganization: ajv.compile<Organization>({ $ref: `${schema.$id}#/$defs/UserOrganization` }),
  UserOrganizationList: ajv.compile<OrganizationList>({ $ref: `${schema.$id}#/$defs/UserOrganizationList` }),
  CreateOrganization: ajv.compile<CreateOrganization>({ $ref: `${schema.$id}#/$defs/CreateOrganization` }),
  Error: ajv.compile<ApiError>({ $ref: `${schema.$id}#/$defs/Error` }),
};
type Values = { SessionRevocationContext: { csrf_token: string }; UserSession: UserSession; UserOrganization: Organization; UserOrganizationList: OrganizationList; CreateOrganization: CreateOrganization; Error: ApiError };
export function decode<K extends keyof Values>(kind: K, value: unknown): Values[K] {
  if (!validators[kind](value)) throw new Error('INVALID_RESPONSE');
  return value as Values[K];
}
export const authorityKey = (session: UserSession) => JSON.stringify([session.user_id, session.session_id]);
