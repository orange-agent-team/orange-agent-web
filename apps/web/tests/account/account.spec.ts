// Explicit browser/API substitutes. Real identity and database acceptance are separate suites.
import { expect, test, type Page } from '@playwright/test';
const identity = { session_id: 'browser-session', user_id: 'browser-user', personal_owner_id: 'browser-owner', csrf_token: 'c'.repeat(43), expires_at: '2099-01-01T00:00:00Z' };
const wallet = { user_id: identity.user_id, owner_id: identity.personal_owner_id, gift: '9007199254740993', earned: '0', purchased: '0', reserved_gift: '0', reserved_earned: '0', reserved_purchased: '0', pending_earned: '0' };
async function fixture(page: Page) {
 const state = { lost: true, effects: 0, revoked: false, keys: [] as string[], bodies: [] as string[], budgets: [] as { root_budget_id: string; scope_id: string; limit: string; spent: string; reserved: string; status: string }[] };
 await page.route('**/api/v1/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/api/v1/session') return state.revoked ? respond({ code: 'UNAUTHENTICATED', message: 'test fixture', request_id: 'error', retry_class: 'after_reauth' },401) : respond(identity);
  if (url.pathname === '/api/v1/account/wallet') return respond(state.revoked ? { ...wallet, user_id: 'different' } : wallet);
  if (url.pathname === '/api/v1/account/budgets' && request.method() === 'GET') return respond({ user_id: identity.user_id, owner_id: identity.personal_owner_id, data: state.budgets, next_cursor: null });
  if (url.pathname === '/api/v1/account/budgets' && request.method() === 'POST') {
   expect(request.headers()['x-csrf-token']).toBe(identity.csrf_token); expect(request.headers()['authorization']).toBeUndefined();
   state.keys.push(request.headers()['idempotency-key']); state.bodies.push(request.postData()!); const body = request.postDataJSON() as { scope_id: string; limit: string };
   if (!state.budgets.length) { state.effects++; state.budgets.push({ root_budget_id: 'created-budget', scope_id: body.scope_id, limit: body.limit, spent: '0', reserved: '0', status: 'active' }); }
   if (state.lost) { state.lost = false; return route.abort('failed'); }
   return respond(state.budgets[0]);
  }
  return respond({ code: 'UNIMPLEMENTED_FIXTURE', message: 'unexpected fixture call', request_id: 'error', retry_class: 'never' },500);
 });
 return state;
}
test('exact balance and reload preserve the original unknown creation', async ({ page }) => {
 const state = await fixture(page); await page.goto('/account');
 await expect(page.getByTestId('available-credits')).toHaveText('9,007,199,254.740993');
 await page.getByRole('textbox', { name: '预算上限（积分）' }).fill('0.000001'); await page.getByRole('button', { name: '创建预算', exact: true }).click();
 await expect(page.getByText('本次创建尚未确认')).toBeVisible(); await expect(page.getByRole('textbox', { name: '预算上限（积分）' })).toBeDisabled();
 await page.reload(); await expect(page.getByText('有一项创建请求待核对')).toBeVisible(); await page.getByRole('button', { name: '继续本次创建' }).click();
 await expect(page.getByTestId('budget-created')).toBeVisible(); expect(state.effects).toBe(1); expect(state.keys).toHaveLength(2); expect(state.keys[0]).toBe(state.keys[1]); expect(state.bodies[0]).toBe(state.bodies[1]); expect(JSON.parse(state.bodies[0]).limit).toBe('1');
 await expect(page.getByTestId('available-credits')).toHaveText('9,007,199,254.740993');
 await page.screenshot({ path: 'test-results-account/account-preview.png', fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 const navigationBottom = await page.getByRole('navigation', { name: '用户导航' }).evaluate(element => element.getBoundingClientRect().bottom);
 const mainTop = await page.locator('main.portal-main').evaluate(element => element.getBoundingClientRect().top); expect(navigationBottom).toBeLessThanOrEqual(mainTop);
 const fits = await page.getByTestId('available-credits').evaluate(element => element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right - parseFloat(getComputedStyle(element.parentElement!).paddingRight)); expect(fits).toBe(true);
 await page.screenshot({ path: 'test-results-account/account-mobile.png', fullPage: true });
});
test('corrupt saved intent blocks a fresh mutation', async ({ page }) => {
 const state = await fixture(page);
 await page.addInitScript(({ user, owner }) => { sessionStorage.setItem(`orange-budget-v1:${JSON.stringify([user,owner])}`, JSON.stringify({ version: 1, user, owner: 'different', key: 'unknown', body: { scope_id: 'scope', limit: '1' } })); }, { user: identity.user_id, owner: identity.personal_owner_id });
 await page.goto('/account'); await expect(page.getByText('无法保存或核对本次请求')).toBeVisible(); await expect(page.getByRole('button', { name: '创建预算', exact: true })).toBeDisabled(); expect(state.effects).toBe(0);
});
test('actor mismatch clears account content and reauthenticates', async ({ page }) => {
 const state = await fixture(page); await page.goto('/account'); await expect(page.getByTestId('available-credits')).toBeVisible(); state.revoked = true;
 await page.getByRole('button', { name: '刷新账户' }).click(); await expect(page.getByRole('heading', { name: '登录你的账户' })).toBeVisible(); await expect(page.getByTestId('available-credits')).toHaveCount(0); expect(state.effects).toBe(0);
});
