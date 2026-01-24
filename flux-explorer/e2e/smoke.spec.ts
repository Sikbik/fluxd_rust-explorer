import { test, expect } from '@playwright/test';

test('home loads and shows core sections', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Flux Explorer', level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder('Search by block, transaction, or address...')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Network Statistics', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest Blocks', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Block Rewards', level: 3 })).toBeVisible();
});

test('search route resolves numeric height to block page', async ({ page }) => {
  await page.goto('/search/1');

  await page.waitForURL(/\/block\/1/, { timeout: 20_000 });

  const blockHashLabel = page.getByText('Block Hash');
  const errorLabel = page.getByText('Error Loading Block');
  await expect(blockHashLabel.or(errorLabel)).toBeVisible();
});
