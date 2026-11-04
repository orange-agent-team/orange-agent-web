import { decode, type UserSession, type CreateOrganization } from './contracts';
export class ApiFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly requestId?: string) { super(code); }
}
export class UserClient {
  constructor(private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  private async call(path: string, init: RequestInit = {}, expectedStatus = 200): Promise<unknown> {
    if (!path.startsWith('/api/v1/') || path.includes('://') || path.includes('\\')) throw new Error('INVALID_PATH');
    let response: Response;
    const headers = new Headers(init.headers); headers.set('Accept', 'application/json');
    try { response = await this.fetcher(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
    catch (error) { if (init.signal?.aborted) throw error; throw new ApiFailure(0, 'CONNECTION_UNAVAILABLE'); }
    if (response.ok && response.status !== expectedStatus) throw new ApiFailure(response.status, 'UNCONFIRMED_RESPONSE');
    if (response.status === 204) return undefined;
    let body: unknown;
    try { body = await response.json(); } catch { throw new ApiFailure(response.status, 'INVALID_RESPONSE'); }
    if (!response.ok) {
      try { const error = decode('Error', body); throw new ApiFailure(response.status, error.code, error.request_id); }
      catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure(response.status, 'REQUEST_REJECTED'); }
    }
    return body;
  }
  async session(signal?: AbortSignal) {
    const session = decode('UserSession', await this.call('/api/v1/session', { signal }));
    if (Date.parse(session.expires_at) <= Date.now()) throw new ApiFailure(401, 'SESSION_EXPIRED');
    return session;
  }
  async organizations(session: UserSession, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '50' }); if (cursor) query.set('after', cursor);
    const value = decode('UserOrganizationList', await this.call(`/api/v1/organizations?${query}`, { signal }));
    if (value.user_id !== session.user_id || value.data.some(row => row.member_user_id !== session.user_id)) throw new ApiFailure(403, 'ACTOR_MISMATCH');
    return value;
  }
  async createOrganization(session: UserSession, key: string, request: CreateOrganization) {
    decode('CreateOrganization', request);
    const value = decode('UserOrganization', await this.call('/api/v1/organizations', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': key }, body: JSON.stringify(request) }));
    if (value.member_user_id !== session.user_id) throw new ApiFailure(403, 'ACTOR_MISMATCH');
    return value;
  }
  async logout(session: UserSession) {
    try { await this.call('/api/v1/session', { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID() } }, 204); }
    catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) throw error; }
  }
  async logoutCurrent() {
    try {
      const context = decode('SessionRevocationContext', await this.call('/api/v1/session/revocation'));
      await this.call('/api/v1/session', { method: 'DELETE', headers: { 'X-CSRF-Token': context.csrf_token, 'Idempotency-Key': crypto.randomUUID() } }, 204);
    } catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) throw error; }
  }
}
