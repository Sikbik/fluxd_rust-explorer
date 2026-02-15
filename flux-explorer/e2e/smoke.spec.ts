import { test, expect } from '@playwright/test';
import { preparePage } from './helpers/e2e-utils';

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test('home loads and shows core sections', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Flux Explorer', level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder('Search by block, transaction, or address...')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Feed Stream + Reward Dispatch', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chain Stats + Network Cadence', level: 3 })).toBeVisible();
});

test('search route resolves numeric height to block page', async ({ page }) => {
  await page.goto('/search/1');

  await page.waitForURL(/\/block\/1/, { timeout: 20_000 });

  const blockHashLabel = page.getByText('Block Hash');
  const errorLabel = page.getByText('Error Loading Block');
  await expect(blockHashLabel.or(errorLabel)).toBeVisible();
});

test('block detail renders transactions or error state', async ({ page }) => {
  await page.goto('/block/1');

  const transactionsHeading = page.getByRole('heading', { name: 'Transactions' }).first();
  const errorLabel = page.getByText('Error Loading Block');

  await expect(transactionsHeading.or(errorLabel)).toBeVisible();
});

test('transaction detail renders core fields or error state', async ({ page }) => {
  const fakeTxid = '0'.repeat(64);
  await page.goto(`/tx/${fakeTxid}`);

  const txHeading = page.getByRole('heading', { name: /^Transaction$/ });
  const errorLabel = page.getByText('Error Loading Transaction');

  await expect(txHeading.or(errorLabel)).toBeVisible();

  if (await txHeading.isVisible()) {
    await expect(page.getByText('Transaction ID').first()).toBeVisible();
  }
});

test('address page renders core fields or error state', async ({ page }) => {
  const fakeAddress = 't1' + 'a'.repeat(33);
  await page.goto(`/address/${fakeAddress}`);

  const addressHeading = page.getByRole('heading', { name: /^Address/, level: 1 });
  const errorLabel = page.getByText('Error Loading Address');

  await expect(addressHeading.or(errorLabel)).toBeVisible();

  if (await addressHeading.isVisible()) {
    await expect(page.getByText('Address').first()).toBeVisible();
  }
});

test('rich list page loads or shows degraded state', async ({ page }) => {
  await page.goto('/rich-list');

  await expect(page.getByRole('heading', { name: 'Flux Rich List', level: 1 })).toBeVisible();

  const loading = page.getByText('Loading rich list...');
  const error = page.getByText('fetch failed');
  const table = page.getByRole('table');

  await expect(loading.or(error).or(table)).toBeVisible({ timeout: 30_000 });
});
