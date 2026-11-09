import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { admin, baseURL } from '../playwright.config';

const unique = (name: string): string => `${name} ${Date.now()}-${test.info().parallelIndex}-${randomUUID().slice(0, 4)}`;

/** Calls the API as the signed-in page, from the app's own origin, as the app does. */
async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, {
    data,
    headers: { origin: baseURL, 'idempotency-key': randomUUID() },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** Signs in as the server admin and makes a new team, so every test starts empty. */
async function freshTeam(page: Page): Promise<string> {
  await post(page, '/api/session', admin);
  const team = await post<{ slug: string }>(page, '/api/admin/teams', { name: unique('Team') });
  return team.slug;
}

const tab = (team: string, id: string): string => `/t/${team}/settings/${id}`;

/** Records whether a skeleton ever appeared, from before the app starts. */
async function watchForSkeleton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = (): void => {
      if (document.querySelector('os-skeleton')) (window as unknown as { sawSkeleton: boolean }).sawSkeleton = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  });
}

const sawSkeleton = (page: Page): Promise<boolean> =>
  page.evaluate(() => Boolean((window as unknown as { sawSkeleton?: boolean }).sawSkeleton));

test.describe('Every Settings tab says what it is for', () => {
  test('UC-4/S1 each tab explains itself', async ({ page }) => {
    const team = await freshTeam(page);
    await page.goto(tab(team, 'account'));
    const links = page.getByRole('navigation', { name: 'Settings' }).getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((all) => all.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThanOrEqual(8);
    for (const href of hrefs) {
      await page.goto(href);
      const explainer = page.locator('header[os-section-header] p').first();
      await expect(explainer, href).toBeVisible();
      expect((await explainer.innerText()).split(' ').length, href).toBeGreaterThan(5);
    }
  });

  test('UC-4/S2 no projects yet asks for the repository, with an example', async ({ page }) => {
    const team = await freshTeam(page);
    await page.goto(tab(team, 'projects'));
    const empty = page.locator('os-empty-state', { hasText: 'No projects yet' });
    await expect(empty).toContainText('Add the repository your agents work in');
    await expect(empty).toContainText('git@github.com:acme/shop.git');
    await empty.getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByLabel('Project name')).toBeFocused();
  });

  test('UC-4/S3 no agents yet offers to add one and to connect one', async ({ page }) => {
    const team = await freshTeam(page);
    await page.goto(tab(team, 'agents'));
    const empty = page.locator('os-empty-state', { hasText: 'No agents yet' });
    await expect(empty).toContainText('one agent per developer and tool');
    await empty.getByRole('button', { name: 'Add agent' }).click();
    await expect(page.getByLabel('Name')).toBeFocused();
    await empty.getByRole('link', { name: 'Connect an agent' }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${team}/settings/connect-agent$`));
  });

  test('UC-4/S4 the approval modes are explained in one place', async ({ page }) => {
    const team = await freshTeam(page);
    await post(page, `/api/t/${team}/actors`, { name: 'Claude', kind: 'agent' });
    await post(page, `/api/t/${team}/actors`, { name: 'Codex', kind: 'agent' });
    await page.goto(tab(team, 'agents'));
    const card = page.locator('[os-setting-card]', { hasText: 'How proposals get approved' });
    await expect(card.locator('dt')).toHaveText(['A person approves', 'A reviewer agent approves', 'Approved on arrival']);
    await expect(page.getByText('A member reviews each proposal in the Inbox')).toHaveCount(1);
  });

  test('UC-4/S5 an agent with no working tokens says what that means', async ({ page }) => {
    const team = await freshTeam(page);
    // A new agent comes with a token; revoking it leaves the agent with none.
    const { id } = await post<{ id: string }>(page, `/api/t/${team}/actors`, { name: 'Claude', kind: 'agent' });
    const revoked = await page.request.delete(`/api/t/${team}/tokens/${id}`, { headers: { origin: baseURL } });
    expect(revoked.ok()).toBe(true);
    await page.goto(tab(team, 'agents'));
    const card = page.locator('[os-setting-card]', { hasText: 'Claude' });
    await expect(card).toContainText('No working tokens, so this agent can’t connect.');
    await expect(card.getByRole('button', { name: 'New token' })).toBeVisible();
  });

  test('UC-4/S6 a slow tab shows a placeholder, and a failed one says what failed', async ({ page }) => {
    const team = await freshTeam(page);
    await watchForSkeleton(page);

    await page.goto(tab(team, 'projects'));
    await expect(page.locator('os-empty-state')).toBeVisible();
    expect(await sawSkeleton(page)).toBe(false);

    await page.route('**/api/t/*/settings', async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.reload();
    await expect(page.locator('os-skeleton')).toBeVisible();
    await expect(page.locator('os-empty-state')).toBeVisible();
    await expect(page.locator('os-skeleton')).toBeHidden();

    await page.unroute('**/api/t/*/settings');
    await page.route('**/api/t/*/settings', (route) =>
      route.fulfill({ status: 503, json: { error: 'The server is down for a moment.' } }),
    );
    await page.goto(tab(team, 'members'));
    await expect(page.locator('os-callout[tone=danger]')).toContainText('The members didn’t load');
    await page.goto(tab(team, 'agents'));
    await expect(page.locator('os-callout[tone=danger]')).toContainText('The agents didn’t load');
  });

  test('UC-4/S7 removing a member or revoking a token says what stops and what stays', async ({ page }) => {
    const team = await freshTeam(page);
    await post(page, `/api/t/${team}/members`, {
      email: `${randomUUID()}@e2e.test`,
      name: 'Riley Reviewer',
      role: 'member',
    });
    await post(page, `/api/t/${team}/actors`, { name: 'Claude', kind: 'agent' });
    const dialog = page.locator('os-confirm-dialog dialog');

    await page.goto(tab(team, 'members'));
    await page.getByRole('button', { name: 'Remove Riley Reviewer' }).click();
    await expect(dialog).toContainText('can’t see this team any more');
    await expect(dialog).toContainText('What they reviewed stays on record');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.goto(tab(team, 'agents'));
    await page.getByRole('button', { name: /^Revoke/ }).click();
    await expect(dialog).toContainText('stops working straight away');
    await expect(dialog).toContainText('Claude stays, with its history');
  });
});
