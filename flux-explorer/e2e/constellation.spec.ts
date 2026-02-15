import { test, expect } from "@playwright/test";
import { expectTooltipInViewport, getFixtureAddress, preparePage } from "./helpers/e2e-utils";

const CENTER_ADDRESS = getFixtureAddress("A");

test.describe("Address constellation interactions", () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page);
  });

  test("desktop hover tooltip stays near cursor and inside viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/address/${CENTER_ADDRESS}`);

    await expect(page.getByRole("heading", { name: /Address/, level: 1 })).toBeVisible({
      timeout: 30_000,
    });

    const nodes = page.locator("svg .constellation-node");
    await expect.poll(async () => await nodes.count(), { timeout: 30_000 }).toBeGreaterThan(1);

    const centerNode = nodes.first();
    await centerNode.scrollIntoViewIfNeeded();
    await centerNode.hover();

    const box = await centerNode.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const mouseX = box.x + box.width / 2;
    const mouseY = box.y + box.height / 2;

    const tooltip = page.locator("div.pointer-events-none.fixed", { hasText: "Tx Count" });
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    await expectTooltipInViewport(page, tooltip);
    await expect(tooltip).toContainText("Center Address");
    await expect(tooltip).toContainText(CENTER_ADDRESS);

    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox).not.toBeNull();
    if (!tooltipBox) return;

    expect(Math.abs(tooltipBox.x - mouseX)).toBeLessThan(450);
    expect(Math.abs(tooltipBox.y - mouseY)).toBeLessThan(450);
  });

  test("mobile tap opens bottom sheet and hop/reset works", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/address/${CENTER_ADDRESS}`);

    await expect(page.getByRole("heading", { name: /Address/, level: 1 })).toBeVisible({
      timeout: 30_000,
    });

    const nodes = page.locator("svg .constellation-node");
    await expect.poll(async () => await nodes.count(), { timeout: 30_000 }).toBeGreaterThan(1);

    await nodes.nth(1).scrollIntoViewIfNeeded();
    await nodes.nth(1).click();

    const hopButton = page.getByRole("button", { name: "Hop To Address" });
    await expect(hopButton).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Open Page" })).toBeVisible();

    await hopButton.click();

    const resetButton = page.getByRole("button", { name: "Reset to page address" });
    await expect(resetButton).toBeVisible({ timeout: 10_000 });

    await resetButton.click();
    await expect(resetButton).toBeHidden({ timeout: 10_000 });
  });
});
