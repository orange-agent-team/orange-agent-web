import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../../docs/contracts/account.schema.json' with { type: 'json' };
export interface Budget { root_budget_id: string; scope_id: string; limit: string; spent: string; reserved: string; status: 'active' | 'closing' | 'closed' }
export interface CreateBudget { scope_id: string; limit: string }
export interface Wallet { user_id: string; owner_id: string; gift: string; earned: string; purchased: string; reserved_gift: string; reserved_earned: string; reserved_purchased: string; pending_earned: string }
export interface ProviderIncome {job_id:string;units:string;eligible_unix:string;state:'pending'|'review'|'available'}
export interface IncomePage {user_id:string;owner_id:string;data:ProviderIncome[];next_cursor:string|null}
export interface BudgetPage { user_id: string; owner_id: string; data: Budget[]; next_cursor: string | null }
export type ReadScope='wallet:read'|'budgets:read';
export interface KeyDetails {
  key_id:string; user_id:string; owner_id:string; audience:'orange-personal-automation-v1'; scope:ReadScope;
  label:string; status:'active'|'revoked'|'expired'; created_at:string; expires_at:string;
}
export interface KeyPage {data:KeyDetails[];next_cursor:string|null}
const ajv = new Ajv2020({ strict: false }); ajv.addSchema(schema);
const validators = {
  PersonalKey: ajv.compile<KeyDetails>({$ref:schema.$id+'#/$defs/PersonalKeyView'}),
  PersonalKeys: ajv.compile<KeyPage>({$ref:schema.$id+'#/$defs/PersonalKeyPage'}),
  Wallet: ajv.compile<Wallet>({ $ref: `${schema.$id}#/$defs/WalletView` }),
  Budget: ajv.compile<Budget>({ $ref: `${schema.$id}#/$defs/BudgetView` }),
  CreateBudget: ajv.compile<CreateBudget>({ $ref: `${schema.$id}#/$defs/CreateBudget` }),
  IncomePage: ajv.compile<IncomePage>({$ref:`${schema.$id}#/$defs/ProviderIncomeList`}),
  BudgetPage: ajv.compile<BudgetPage>({ $ref: `${schema.$id}#/$defs/PersonalBudgetList` }),
};
type Values = { PersonalKey:KeyDetails; PersonalKeys:KeyPage; IncomePage:IncomePage; Wallet: Wallet; Budget: Budget; CreateBudget: CreateBudget; BudgetPage: BudgetPage };
const maximum = 9223372036854775807n;
const amounts = new Set(['units','gift', 'earned', 'purchased', 'reserved_gift', 'reserved_earned', 'reserved_purchased', 'pending_earned', 'limit', 'spent', 'reserved']);
export function decodeAccount<K extends keyof Values>(kind: K, value: unknown): Values[K] {
  if (!validators[kind](value)) throw new Error('INVALID_ACCOUNT_RESPONSE');
  const check = (object: unknown): void => {
    if (object !== null && typeof object === 'object') for (const [key, field] of Object.entries(object)) {
      if (amounts.has(key) && (typeof field !== 'string' || !/^(0|[1-9][0-9]*)$/.test(field) || BigInt(field) > maximum)) throw new Error('INVALID_ACCOUNT_MONEY');
      if (typeof field === 'object') check(field);
    }
    if (object !== null && typeof object === 'object' && 'root_budget_id' in object) {
      const budget = object as Budget;
      if (BigInt(budget.spent) + BigInt(budget.reserved) > BigInt(budget.limit)) throw new Error('INVALID_BUDGET_TOTAL');
    }
  };
  check(value); return value as Values[K];
}
export function parseCredits(text: string): string | undefined {
  if (text.length > 32) return undefined;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(text.trim());
  if (!match) return undefined;
  const units = BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return units <= maximum ? units.toString() : undefined;
}
export function formatCredits(units: string | bigint): string {
  const amount = BigInt(units); if (amount < 0n) throw new Error('INVALID_ACCOUNT_MONEY');
  const whole = amount / 1000000n, fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole.toLocaleString('zh-CN') + (fraction ? `.${fraction}` : '');
}
