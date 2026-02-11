import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

const HEAVY_ADDRESS = "t1erTe9pzQRnT1J7irwdoMb6kQqPQDvkktA";

test("export guard blocks large export request without token", async ({ request }) => {
  const response = await request.get(
    `/api/indexer/api/v1/addresses/${HEAVY_ADDRESS}/transactions?limit=250&fromTimestamp=1527811200&toTimestamp=1893456000`
  );

  expect(response.status()).toBe(401);
  const payload = await response.json();
  expect(payload.error).toBe("missing_export_token");
});

test("address CSV export succeeds for large range", async ({ page }, testInfo) => {
  test.setTimeout(12 * 60_000);

  await page.goto(`/address/${HEAVY_ADDRESS}`);
  await expect(page.getByRole("heading", { name: "Address" })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Export CSV" }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "All time" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8 * 60_000 }),
    dialog.getByRole("button", { name: "Export CSV" }).click(),
  ]);

  const filePath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(filePath);

  const stat = await fs.stat(filePath);
  expect(stat.size).toBeGreaterThan(1024);

  const csv = await fs.readFile(filePath, "utf8");
  expect(csv.startsWith("Date (UTC),Type,Amount,Currency")).toBeTruthy();

  const lineCount = csv.split("\n").length;
  expect(lineCount).toBeGreaterThan(1000);
});
