import { test, expect, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectRounded, getFixtureAddress, preparePage, FIXTURE_TXID } from "./helpers/e2e-utils";

const CENTER_ADDRESS = getFixtureAddress("A");

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
] as const;

type RouteCase = {
  name: string;
  path: string;
  ready: (page: Page) => Locator;
};

const routes: RouteCase[] = [
  {
    name: "home",
    path: "/",
    ready: (page) => page.getByRole("heading", { name: "Flux Explorer", level: 1 }),
  },
  {
    name: "blocks",
    path: "/blocks",
    ready: (page) => page.getByRole("heading", { name: "Blocks", level: 1 }),
  },
  {
    name: "block",
    path: "/block/1",
    ready: (page) => page.getByRole("heading", { name: /Block/, level: 1 }),
  },
  {
    name: "transaction",
    path: `/tx/${FIXTURE_TXID}`,
    ready: (page) => page.getByRole("heading", { name: /Transaction/, level: 1 }),
  },
  {
    name: "address",
    path: `/address/${CENTER_ADDRESS}`,
    ready: (page) => page.getByRole("heading", { name: /Address/, level: 1 }),
  },
  {
    name: "rich-list",
    path: "/rich-list",
    ready: (page) => page.getByRole("heading", { name: "Flux Rich List", level: 1 }),
  },
];

for (const viewport of viewports) {
  test.describe(`${viewport.name} viewport`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await preparePage(page);
    });

    for (const route of routes) {
      test(`${route.name} renders without horizontal overflow`, async ({ page }) => {
        await page.goto(route.path);
        await expect(route.ready(page)).toBeVisible({ timeout: 30_000 });
        await expectNoHorizontalOverflow(page);
      });
    }

    test("home hero stays rounded", async ({ page }) => {
      await page.goto("/");
      const heading = page.getByRole("heading", { name: "Flux Explorer", level: 1 });
      await expect(heading).toBeVisible();

      const hero = page.locator("section", { has: heading }).first();
      await expect(hero).toBeVisible();
      await expectRounded(hero, 32);

      const overlays = hero.locator("> div.pointer-events-none.absolute.inset-0");
      const overlayCount = await overlays.count();
      expect(overlayCount).toBeGreaterThanOrEqual(2);

      for (let index = 0; index < overlayCount; index += 1) {
        await expectRounded(overlays.nth(index), 32);
      }
    });

    test("page shell banner stays rounded", async ({ page }) => {
      await page.goto("/blocks");
      await expect(page.getByRole("heading", { name: "Blocks", level: 1 })).toBeVisible({
        timeout: 30_000,
      });

      const shellBanner = page.locator("section > div.relative.overflow-hidden").first();
      await expect(shellBanner).toBeVisible();
      await expectRounded(shellBanner, 20);
    });
  });
}
