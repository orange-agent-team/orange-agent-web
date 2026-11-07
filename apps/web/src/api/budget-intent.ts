import { decodeAccount, type CreateBudget } from './accounts';
import type { UserSession } from './contracts';
export interface BudgetIntent { version: 1; user: string; owner: string; key: string; body: CreateBudget }
export const intentKey = (session: UserSession) => `orange-budget-v1:${JSON.stringify([session.user_id, session.personal_owner_id])}`;
export function loadIntent(storage: Pick<Storage, 'getItem'>, session: UserSession): BudgetIntent | null {
  const raw = storage.getItem(intentKey(session)); if (raw === null) return null;
  if (raw.length > 2048) throw new Error('INVALID_SAVED_INTENT');
  const value = JSON.parse(raw) as BudgetIntent;
  if (value === null || typeof value !== 'object' || value.version !== 1 || value.user !== session.user_id || value.owner !== session.personal_owner_id || typeof value.key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.key) || Object.keys(value).sort().join(',') !== 'body,key,owner,user,version') throw new Error('INVALID_SAVED_INTENT');
  decodeAccount('CreateBudget', value.body); return value;
}
export function saveIntent(storage: Pick<Storage, 'setItem'>, session: UserSession, intent: BudgetIntent): void {
  storage.setItem(intentKey(session), JSON.stringify(intent));
}
