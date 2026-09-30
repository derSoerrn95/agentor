import { test, expect, type Page } from '@playwright/test';
import { createTestUser, deleteTestUser, signInBrowserAsUser, type CreatedUser, signedInContext } from '../helpers/test-users';
import { BASE_URL, REDIRECT_URI, authorizationRequest, obtainTokens, registerPublicClient } from '../helpers/mcp';
import { ApiClient } from '../helpers/api-client';

/** Serves the OAuth client's redirect URI inside the browser so the final
 * redirect (with `code` / `error`) can be observed. */
async function captureRedirect(page: Page): Promise<() => Promise<URL>> {
  let resolve!: (url: URL) => void;
  const redirected = new Promise<URL>((r) => (resolve = r));
  await page.route(`${REDIRECT_URI}**`, async (route) => {
    resolve(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>client callback</p>' });
  });
  return () => redirected;
}

// Every test signs in its own user so consents never leak between tests.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('MCP OAuth in the browser', () => {
  let user: CreatedUser;

  test.beforeEach(async () => {
    user = await createTestUser('OAuth UI');
  });

  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id);
  });

  test('a signed-in user approves an application on the consent page', async ({ page, context, request }) => {
    await signInBrowserAsUser(context, user.email, user.password);
    const clientId = await registerPublicClient(request, 'Consent UI Client');
    const { url, state } = authorizationRequest(clientId);
    const redirect = await captureRedirect(page);

    await page.goto(url.toString());
    await expect(page).toHaveURL(/\/oauth\/consent\?/);
    await expect(page.getByTestId('oauth-client-name')).toHaveText('Consent UI Client');
    await expect(page.getByTestId('oauth-scopes')).toContainText('agentor');
    await expect(page.getByTestId('oauth-scopes')).toContainText('Full control of your Agentor account');
    await expect(page.getByText(user.email)).toBeVisible();
    await expect(page.getByTestId('oauth-redirect-origin')).toHaveText(new URL(REDIRECT_URI).origin);

    await page.getByTestId('oauth-approve').click();
    const callback = await redirect();
    expect(callback.searchParams.get('code')).toBeTruthy();
    expect(callback.searchParams.get('state')).toBe(state);
  });

  test('denying sends the user back to the application with access_denied', async ({ page, context, request }) => {
    await signInBrowserAsUser(context, user.email, user.password);
    const { url } = authorizationRequest(await registerPublicClient(request, 'Denied UI Client'));
    const redirect = await captureRedirect(page);

    await page.goto(url.toString());
    await page.getByTestId('oauth-deny').click();
    const callback = await redirect();
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('code')).toBeNull();
  });

  test('a signed-out user signs in and the authorization continues', async ({ page, request }) => {
    const { url } = authorizationRequest(await registerPublicClient(request, 'Login UI Client'));
    const redirect = await captureRedirect(page);

    await page.goto(url.toString());
    await expect(page).toHaveURL(/\/login\?.*sig=/);
    await expect(page.getByTestId('oauth-login-notice')).toBeVisible();
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', user.password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/oauth\/consent\?/, { timeout: 15_000 });
    await page.getByTestId('oauth-approve').click();
    expect((await redirect()).searchParams.get('code')).toBeTruthy();
  });

  test('a consent page opened after the session ended resumes through the login page', async ({ page }) => {
    // Reach the consent step with an API session, then open it in a browser that is signed out.
    const session = await signedInContext(user.email, user.password);
    let consentUrl: URL;
    try {
      const { url } = authorizationRequest(await registerPublicClient(session, 'Expired Session Client'));
      const res = await session.get(url.toString(), { maxRedirects: 0 });
      consentUrl = new URL(res.headers()['location'], BASE_URL);
    } finally {
      await session.dispose();
    }
    expect(consentUrl.pathname).toBe('/oauth/consent');
    const redirect = await captureRedirect(page);

    await page.goto(consentUrl.pathname + consentUrl.search);
    await expect(page).toHaveURL(/\/login\?.*sig=/);
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', user.password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/oauth\/consent\?/, { timeout: 15_000 });
    await page.getByTestId('oauth-approve').click();
    expect((await redirect()).searchParams.get('code')).toBeTruthy();
  });

  test('the consent page links only web homepages, never script URIs', async ({ page, context, request }) => {
    await signInBrowserAsUser(context, user.email, user.password);
    const safe = authorizationRequest(await registerPublicClient(request, 'Homepage Client', { client_uri: 'https://client.example/about' }));
    await page.goto(safe.url.toString());
    await expect(page.getByRole('link', { name: 'https://client.example/about' })).toHaveAttribute('href', 'https://client.example/about');

    // Registration is open, so a hostile client can claim any client_uri.
    const hostile = authorizationRequest(await registerPublicClient(request, 'Script Client', { client_uri: 'javascript:alert(document.cookie)' }));
    await page.goto(hostile.url.toString());
    await expect(page.getByTestId('oauth-client-name')).toHaveText('Script Client');
    await expect(page.locator('[data-testid="oauth-consent"] a')).toHaveCount(0);
  });

  test('the consent page refuses direct visits', async ({ page, context }) => {
    await signInBrowserAsUser(context, user.email, user.password);
    await page.goto('/oauth/consent');
    await expect(page.getByTestId('oauth-consent-error')).toContainText('only reachable from an application authorization request');
    await expect(page.getByTestId('oauth-approve')).toBeDisabled();
  });

  test('the account modal shows the MCP URL and revokes authorized applications', async ({ page, context }) => {
    const session = await signedInContext(user.email, user.password);
    try {
      const tokens = await obtainTokens(session);
      await signInBrowserAsUser(context, user.email, user.password);
      await page.goto('/');
      await page.waitForSelector('h1:has-text("Agentor")', { timeout: 15_000 });
      await page.getByRole('button', { name: 'Account settings' }).click();

      const section = page.getByTestId('account-mcp');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('mcp-url')).toHaveText(/\/mcp$/);
      const app = section.getByTestId('mcp-app');
      await expect(app).toHaveCount(1);
      await expect(app).toContainText('Agentor test client');

      await app.getByTestId('mcp-app-revoke').click();
      await expect(app.getByTestId('mcp-app-revoke')).toHaveText('Confirm revoke');
      await app.getByTestId('mcp-app-revoke').click();
      await expect(section.getByTestId('mcp-apps-empty')).toBeVisible();

      const { body } = await new ApiClient(session).listAuthorizedApps();
      expect(body.map((a: { clientId: string }) => a.clientId)).not.toContain(tokens.clientId);
    } finally {
      await session.dispose();
    }
  });
});
