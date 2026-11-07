import { describe, expect, it, vi } from 'vitest';
import { UserClient } from '../src/api/client';
import { decodeAccount, formatCredits, parseCredits } from '../src/api/accounts';
import { intentKey, loadIntent, saveIntent, type BudgetIntent } from '../src/api/budget-intent';
import type { UserSession } from '../src/api/contracts';
const session: UserSession = { session_id: 'session', user_id: 'user', personal_owner_id: 'owner', csrf_token: 'c'.repeat(43), expires_at: '2099-01-01T00:00:00Z' };
const budget = { root_budget_id: 'budget', scope_id: 'scope', limit: '9007199254740993', spent: '0', reserved: '0', status: 'active' };
const wallet = { user_id: 'user', owner_id: 'owner', gift: '9007199254740993', earned: '0', purchased: '0', reserved_gift: '0', reserved_earned: '0', reserved_purchased: '0', pending_earned: '0' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
describe('exact personal account boundary', () => {
 it('never rounds through JS numbers or silently truncates input', () => {
  expect(parseCredits('9007199254.740993')).toBe('9007199254740993');
  expect(formatCredits('9007199254740993')).toBe('9,007,199,254.740993');
  expect(parseCredits('0.000001')).toBe('1'); expect(parseCredits('9223372036854.775807')).toBe('9223372036854775807');
  for (const bad of ['1e3','1.0000001','-1','01','9223372036854.775808','9'.repeat(100)]) expect(parseCredits(bad)).toBeUndefined();
 });
 it('rejects numeric/overflow balances, impossible totals and actor substitution', async () => {
  for (const value of [{ ...wallet, gift: 2 }, { ...wallet, gift: '9223372036854775808' }]) expect(() => decodeAccount('Wallet', value)).toThrow();
  expect(() => decodeAccount('Budget', { ...budget, reserved: budget.limit, spent: '1' })).toThrow();
  await expect(new UserClient(vi.fn<typeof fetch>().mockResolvedValue(json({ ...wallet, owner_id: 'another' }))).wallet(session)).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
  await expect(new UserClient(vi.fn<typeof fetch>().mockResolvedValue(json({ user_id: 'another', owner_id: 'owner', data: [], next_cursor: null }))).budgets(session)).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
 });
 it('keeps original mutation identity on retry and rejects a different scope or pending success', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(json(budget)); const client = new UserClient(fetcher); const body = { scope_id: budget.scope_id, limit: budget.limit };
  await expect(client.createBudget(session,'same-key',body)).rejects.toMatchObject({ status: 0 }); expect(fetcher).toHaveBeenCalledTimes(1);
  await client.createBudget(session,'same-key',body);
  for (const [, init] of fetcher.mock.calls) { const h = new Headers(init?.headers); expect(h.get('Idempotency-Key')).toBe('same-key'); expect(h.get('X-CSRF-Token')).toBe(session.csrf_token); expect(h.has('Authorization')).toBe(false); expect(init?.body).toBe(JSON.stringify(body)); }
  for (const response of [json({ ...budget, scope_id: 'different' }), json(budget,202)]) await expect(new UserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).createBudget(session,'same-key',body)).rejects.toMatchObject({ code: 'UNCONFIRMED_RESPONSE' });
 });
 it('bounds a stalled mutation without automatic retry or claiming no effect', async () => {
  vi.useFakeTimers();
  try {
   const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted','AbortError')), { once: true }); }));
   const pending = new UserClient(fetcher).createBudget(session,'original-key',{ scope_id: 'scope', limit: '1' });
   const result = expect(pending).rejects.toMatchObject({ status: 0, code: 'REQUEST_TIMEOUT' });
   await vi.advanceTimersByTimeAsync(15000); await result; expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
 });
 it('persists only account-bound original intent and fails closed on corrupt recovery', () => {
  const data = new Map<string,string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string,value: string) => { data.set(key,value); } };
  const intent: BudgetIntent = { version: 1, user: session.user_id, owner: session.personal_owner_id, key: 'intent', body: { scope_id: 'scope', limit: '5' } };
  saveIntent(storage,session,intent); expect(loadIntent(storage,session)).toEqual(intent); expect(data.get(intentKey(session))).not.toContain('csrf');
  expect(loadIntent(storage,{ ...session, user_id: 'another' })).toBeNull();
  for (const bad of [{ ...intent, owner: 'another' }, { ...intent, body: { scope_id: 'scope', limit: 5 } }, { ...intent, csrf_token: 'secret' }]) { data.set(intentKey(session),JSON.stringify(bad)); expect(() => loadIntent(storage,session)).toThrow(); }
 });
});
