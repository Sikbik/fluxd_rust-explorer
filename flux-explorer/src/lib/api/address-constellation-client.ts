import type { AddressConstellationData } from "@/types/address-constellation";

const CONSTELLATION_REQUEST_TIMEOUT_MS = 30_000;

export async function getAddressConstellation(
  address: string,
  options?: { mode?: "fast" | "deep" }
): Promise<AddressConstellationData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONSTELLATION_REQUEST_TIMEOUT_MS);
  let response: Response;
  const mode = options?.mode ?? "fast";
  const url =
    mode === "deep"
      ? `/api/address-constellation/${address}?mode=deep`
      : `/api/address-constellation/${address}`;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Constellation request timed out. Please retry.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to fetch address constellation (${response.status})`);
  }

  return response.json() as Promise<AddressConstellationData>;
}
