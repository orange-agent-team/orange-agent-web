import { describe, expect, it, vi } from 'vitest';
import { UserClient } from '../src/api/client';
import { authorityKey, decode, type UserSession } from '../src/api/contracts';
const session = (user = 'user-fixture'): UserSession => ({ session_id: 'session-fixture', user_id: user, personal_owner_id: user, csrf_token: 'c'.repeat(43), expires_at: '2099-01-01T00:00:00Z' });
const organization = (user = 'user-fixture') => ({ member_user_id: user, organization_id: 'org-fixture', name: 'Contract fixture', role: 'owner', member_limit: 20, policy_version: '1' });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
describe('user identity and request boundaries', () => {
  it('rejects expired sessions and administrator session shapes', async () => {
    for (const value of [{ ...session(), expires_at: '2020-01-01T00:00:00Z' }, { principal_id: 'admin', roles: ['platform_admin'] }, { ...session(), roles: ['platform_admin'] }]) {
      await expect(new UserClient(vi.fn<typeof fetch>().mockResolvedValue(json(value))).session()).rejects.toThrow();
    }
  });
  it('binds cached identity to both user and session', () => {
    expect(authorityKey(session())).not.toBe(authorityKey(session('another')));
    expect(authorityKey(session())).not.toBe(authorityKey({ ...session(), session_id: 'new-session' }));
  });
  it('rejects a projection for another user even if its shape is valid', async () => {
    for (const data of [{ user_id: 'another', data: [] }, { user_id: 'user-fixture', data: [organization('another')] }]) {
      await expect(new UserClient(vi.fn<typeof fetch>().mockResolvedValue(json(data))).organizations(session())).rejects.toMatchObject({ code: 'ACTOR_MISMATCH' });
    }
  });
  it('does not call a pending response successful or automatically repeat a mutation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(organization(), 202));
    await expect(new UserClient(fetcher).createOrganization(session(), 'intent-1', { name: 'Test', member_limit: 20 })).rejects.toMatchObject({ code: 'UNCONFIRMED_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reuses the caller intent only on explicit retry, with session-bound CSRF and no bearer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(json(organization()));
    const api = new UserClient(fetcher); const body = { name: 'Test', member_limit: 20 };
    await expect(api.createOrganization(session(), 'same-intent', body)).rejects.toMatchObject({ status: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await api.createOrganization(session(), 'same-intent', body);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('Idempotency-Key')).toBe('same-intent'); expect(headers.get('X-CSRF-Token')).toBe(session().csrf_token);
      expect(headers.has('Authorization')).toBe(false); expect(init?.body).toBe(JSON.stringify(body)); expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store'); expect(init?.redirect).toBe('error');
    }
  });
  it('rejects actor spoofing, excess capacity and noncanonical policy versions', () => {
    expect(() => decode('CreateOrganization', { name: 'Test', member_limit: 20, actor_id: 'someone-else' })).toThrow();
    expect(() => decode('CreateOrganization', { name: 'Test', member_limit: 100 })).toThrow();
    expect(() => decode('UserOrganization', { ...organization(), policy_version: 1 })).toThrow();
    expect(() => decode('UserOrganization', { ...organization(), policy_version: '01' })).toThrow();
  });
});
