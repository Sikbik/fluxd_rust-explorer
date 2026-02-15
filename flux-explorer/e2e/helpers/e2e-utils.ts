import { expect, type Page } from "@playwright/test";

const FIXED_EPOCH_MS = 1_700_000_000_000;

export async function preparePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fixedEpochMs = 1_700_000_000_000;

    Date.now = () => fixedEpochMs + Math.floor(performance.now());

    let seed = 0x1234abcd;
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };

    const style = document.createElement("style");
    style.setAttribute("data-e2e", "disable-animations");
    style.textContent = `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    `;
    document.head.appendChild(style);
  });

  await stubExternalFluxStats(page);
}

async function stubExternalFluxStats(page: Page): Promise<void> {
  await page.route("https://api.runonflux.io/**", async (route) => {
    const url = route.request().url();

    if (url.includes("/daemon/getzelnodecount")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          data: {
            total: 1234,
            stable: 1200,
            "cumulus-enabled": 600,
            "nimbus-enabled": 450,
            "stratus-enabled": 150,
            "basic-enabled": 0,
            "super-enabled": 0,
            "bamf-enabled": 0,
            ipv4: 1234,
            ipv6: 0,
            onion: 0,
          },
        }),
      });
      return;
    }

    if (url.includes("/apps/globalappsspecifications")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          data: [
            {
              version: 8,
              name: "explore",
              description: "Fixture app spec",
              owner: "t1" + "Z".repeat(33),
              instances: 3,
            },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "success", data: [] }),
    });
  });

  await page.route("https://stats.runonflux.com/**", async (route) => {
    const url = route.request().url();

    if (url.includes("/fluxinfo?projection=flux")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          data: [
            { flux: { arcaneVersion: "1.0.0" } },
            { flux: { arcaneVersion: "1.0.0" } },
            { flux: {} },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "success", data: [] }),
    });
  });
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflowPx = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });

  expect(overflowPx, `Horizontal overflow detected (${overflowPx}px)`).toBeLessThanOrEqual(2);
}

export async function expectRounded(locator: ReturnType<Page["locator"]>, minPx = 8): Promise<void> {
  const radii = await locator.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      tl: style.borderTopLeftRadius,
      tr: style.borderTopRightRadius,
      br: style.borderBottomRightRadius,
      bl: style.borderBottomLeftRadius,
    };
  });

  const parse = (value: string) => Number.parseFloat(value.replace("px", "")) || 0;
  const tl = parse(radii.tl);
  const tr = parse(radii.tr);
  const br = parse(radii.br);
  const bl = parse(radii.bl);

  expect(Math.min(tl, tr, br, bl)).toBeGreaterThanOrEqual(minPx);
}

export async function expectTooltipInViewport(
  page: Page,
  tooltip: ReturnType<Page["locator"]>
): Promise<void> {
  const box = await tooltip.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) return;

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

export function getFixtureAddress(letter: string): string {
  return `t1${letter.repeat(33)}`;
}

export const FIXTURE_TXID = "2".repeat(64);
export const FIXTURE_BLOCK_HEIGHT = 1;
export const FIXTURE_EPOCH_MS = FIXED_EPOCH_MS;
