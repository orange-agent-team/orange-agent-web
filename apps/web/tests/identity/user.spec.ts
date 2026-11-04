import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decode } from '../../src/api/contracts';
const path = process.env.ORANGE_IDENTITY_FIXTURE;
const database = process.env.ORANGE_TEST_DATABASE_URL_FILE;
if (!path || !database) throw new Error('Actual local identity and database required; no mock fallback');
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { users: { username: string; password: string }[] };
const origin = 'https://127.0.0.1:43122';
async function login(page: Page, index = 0) {
  await page.goto(origin+'/');
  await page.getByRole('link', { name: '登录用户空间', exact: true }).click();
  await page.locator('#username').fill(fixture.users[index].username);
  await page.locator('#password').fill(fixture.users[index].password);
  await page.locator('#kc-login').click();
  await page.waitForURL(origin+'/organizations');
  await expect(page.getByRole('heading', { name: '你的组织', exact: true })).toBeVisible();
  const response = await page.request.get('/api/v1/session'); expect(response.status()).toBe(200);
  return decode('UserSession', await response.json());
}
function active(user: string, enabled: boolean) {
  if (!/^[a-f0-9-]{36}$/.test(user)) throw new Error('Expected locally generated user UUID');
  const url = new URL(readFileSync(database!, 'utf8').trim());
  if (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/orange_dev') throw new Error('Dedicated development DB required');
  execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: `UPDATE users SET active=${enabled} WHERE user_id='${user}';`,
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
test('real user login creates an authorized organization once and never becomes an admin session', async ({ page, browser }, info) => {
  const session = await login(page);
  const cookie = (await page.context().cookies()).find(c => c.name === '__Host-orange-user');
  expect(Boolean(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax')).toBe(true);
  const admin = await page.request.get('http://127.0.0.1:43102/admin/v1/session', { headers: { Cookie: `__Host-orange-admin=${cookie!.value}` } });
  expect(admin.status()).toBe(401);
  expect((await page.request.get('/admin/v1/session')).status()).toBe(404);
  const name = '用户联调-'+crypto.randomUUID().slice(0, 8);
  await page.getByRole('textbox', { name: '组织名称', exact: true }).fill(name);
  const mutation = page.waitForRequest(r => new URL(r.url()).pathname === '/api/v1/organizations' && r.method() === 'POST');
  await page.getByRole('button', { name: '创建组织', exact: true }).click();
  const request = await mutation; const response = await request.response(); expect(response?.status()).toBe(200);
  const created = decode('UserOrganization', await response!.json()); expect(created.member_user_id).toBe(session.user_id); expect(created.role).toBe('owner');
  await expect(page.getByTestId('created-result')).toContainText(name);
  const repeated = await page.request.post('/api/v1/organizations', { data: request.postDataJSON(), headers: { Origin: origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': request.headers()['idempotency-key'] } });
  expect(repeated.status()).toBe(200); expect((await repeated.json()).organization_id).toBe(created.organization_id);
  expect((await page.request.post('/api/v1/organizations', { data: { name: 'CSRF rejection', member_limit: 20 } })).status()).toBe(403);
  const other = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const otherPage = await other.newPage(); const otherSession = await login(otherPage, 1);
    expect(otherSession.user_id).not.toBe(session.user_id);
    expect((await otherPage.request.get('/api/v1/organizations/'+created.organization_id)).status()).toBe(404);
    const list = decode('UserOrganizationList', await (await otherPage.request.get('/api/v1/organizations')).json());
    expect(list.user_id).toBe(otherSession.user_id); expect(list.data.some(row => row.organization_id === created.organization_id)).toBe(false);
  } finally { await other.close(); }
  // Authenticated fixture screen only; never capture passwords, OTP pages, traces or cookies.
  await page.screenshot({ path: info.outputPath('organizations-local-identity.png'), fullPage: true });
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByText('已退出当前会话。', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
});
test('user OAuth state is browser bound, PKCE protected and consumed once', async ({ page, browser }) => {
  const response = await page.request.get('/api/v1/auth/start', { maxRedirects: 0 }); expect(response.status()).toBe(303);
  const url = new URL(response.headers().location); expect(url.searchParams.get('client_id')).toBe('orange-user');
  expect(url.searchParams.get('redirect_uri')).toBe(origin+'/api/v1/auth/callback'); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(Boolean(url.searchParams.get('nonce'))).toBe(true);
  const callback = '/api/v1/auth/callback?code=invalid&state='+encodeURIComponent(url.searchParams.get('state')!);
  const other = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    expect((await other.request.get(callback)).status()).toBe(401);
    expect((await page.request.get(callback)).status()).toBe(401);
    expect((await page.request.get(callback)).status()).toBe(401);
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  } finally { await other.close(); }
});
test('an inactive account can terminate its own browser session without restoring data access', async ({ page }) => {
  const session = await login(page);
  active(session.user_id, false);
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: '退出当前会话', exact: true })).toBeVisible();
    expect((await page.request.get('/api/v1/organizations')).status()).toBe(401);
    await page.getByRole('button', { name: '退出当前会话', exact: true }).click();
    await expect(page.getByText('已退出当前会话。', { exact: true })).toBeVisible();
    active(session.user_id, true);
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  } finally { active(session.user_id, true); }
});
