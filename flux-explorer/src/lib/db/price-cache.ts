/**
 * SQLite Price Cache Database
 *
 * Persistent cache for historical cryptocurrency prices
 * Eliminates redundant API calls to CoinGecko
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database file location (stored in project root, excluded from git)
const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'price-cache.db');

let db: Database.Database | null = null;

/**
 * Initialize the SQLite database and create tables if needed
 */
export function initPriceCache(): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Create/open database
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Configure automatic checkpointing (every 1000 pages / ~4MB)
  db.pragma('wal_autocheckpoint = 1000');

  // Set checkpoint on close
  db.pragma('journal_size_limit = 4194304'); // 4MB limit

  // Create price_history table with hourly precision
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      timestamp INTEGER PRIMARY KEY,
      price_usd REAL NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fetched_at ON price_history(fetched_at);

    -- Migration: Keep old date-based table for compatibility
    CREATE TABLE IF NOT EXISTS price_history_daily (
      date TEXT PRIMARY KEY,
      price_usd REAL NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);

  return db;
}

/**
 * Get cached price for a specific date
 *
 * @param date - Date string in YYYY-MM-DD format
 * @returns USD price or null if not cached
 */
export function getCachedPrice(date: string): number | null {
  const database = initPriceCache();

  const row = database.prepare(
    'SELECT price_usd FROM price_history_daily WHERE date = ?'
  ).get(date) as { price_usd: number } | undefined;

  return row?.price_usd ?? null;
}

/**
 * Store price in cache
 *
 * @param date - Date string in YYYY-MM-DD format
 * @param priceUsd - USD price
 */
export function setCachedPrice(date: string, priceUsd: number): void {
  const database = initPriceCache();

  database.prepare(
    'INSERT OR REPLACE INTO price_history_daily (date, price_usd, fetched_at) VALUES (?, ?, ?)'
  ).run(date, priceUsd, Date.now());
}

/**
 * Get multiple cached prices at once
 *
 * @param dates - Array of date strings in YYYY-MM-DD format
 * @returns Map of date -> price (only includes cached dates)
 */
export function getCachedPrices(dates: string[]): Map<string, number> {
  const database = initPriceCache();
  const results = new Map<string, number>();

  if (dates.length === 0) return results;

  // Build placeholders for IN clause
  const placeholders = dates.map(() => '?').join(',');

  const rows = database.prepare(
    `SELECT date, price_usd FROM price_history_daily WHERE date IN (${placeholders})`
  ).all(...dates) as Array<{ date: string; price_usd: number }>;

  for (const row of rows) {
    results.set(row.date, row.price_usd);
  }

  return results;
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  const database = initPriceCache();

  const stats = database.prepare(`
    SELECT
      COUNT(*) as total_entries,
      MIN(date) as oldest_date,
      MAX(date) as newest_date,
      MIN(fetched_at) as first_fetch,
      MAX(fetched_at) as last_fetch
    FROM price_history_daily
  `).get() as {
    total_entries: number;
    oldest_date: string | null;
    newest_date: string | null;
    first_fetch: number | null;
    last_fetch: number | null;
  };

  return stats;
}

/**
 * Clear old cache entries (optional maintenance)
 *
 * @param olderThanDays - Remove entries older than this many days
 */
export function cleanupOldCache(olderThanDays: number = 365): number {
  const database = initPriceCache();
  const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

  const result = database.prepare(
    'DELETE FROM price_history_daily WHERE fetched_at < ?'
  ).run(cutoffTime);

  return result.changes;
}

/**
 * Store hourly price in cache
 *
 * @param timestamp - Unix timestamp in seconds
 * @param priceUsd - USD price
 */
export function setCachedPriceHourly(timestamp: number, priceUsd: number): void {
  const database = initPriceCache();

  database.prepare(
    'INSERT OR REPLACE INTO price_history (timestamp, price_usd, fetched_at) VALUES (?, ?, ?)'
  ).run(timestamp, priceUsd, Date.now());
}

/**
 * Get closest cached price to a timestamp (within 2 hours)
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns USD price or null if no nearby price found
 */
export function getCachedPriceByTimestamp(timestamp: number): number | null {
  const database = initPriceCache();

  // Find closest price within 2 hours (7200 seconds)
  const row = database.prepare(`
    SELECT price_usd, ABS(timestamp - ?) as diff
    FROM price_history
    WHERE ABS(timestamp - ?) <= 7200
    ORDER BY diff ASC
    LIMIT 1
  `).get(timestamp, timestamp) as { price_usd: number } | undefined;

  return row?.price_usd ?? null;
}

/**
 * Get cached prices for multiple timestamps with a single range query.
 * Finds the closest cached hour within 2 hours (7200s) for each timestamp.
 */
export function getCachedPricesByTimestamps(timestamps: number[]): Map<number, number | null> {
  const results = new Map<number, number | null>();
  if (timestamps.length === 0) return results;

  const normalized = Array.from(
    new Set(
      timestamps
        .filter((ts) => Number.isFinite(ts) && ts > 0)
        .map((ts) => Math.trunc(ts))
    )
  );

  if (normalized.length === 0) return results;

  const database = initPriceCache();

  let minTimestamp = normalized[0];
  let maxTimestamp = normalized[0];
  for (let i = 1; i < normalized.length; i += 1) {
    const ts = normalized[i];
    if (ts < minTimestamp) minTimestamp = ts;
    if (ts > maxTimestamp) maxTimestamp = ts;
  }

  const rows = database.prepare(`
    SELECT timestamp, price_usd
    FROM price_history
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(minTimestamp - 7200, maxTimestamp + 7200) as Array<{ timestamp: number; price_usd: number }>;

  if (rows.length === 0) {
    for (const ts of normalized) {
      results.set(ts, null);
    }
    return results;
  }

  const rowTimestamps = rows.map((row) => row.timestamp);

  const lowerBound = (target: number): number => {
    let left = 0;
    let right = rowTimestamps.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (rowTimestamps[mid] < target) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return left;
  };

  for (const ts of normalized) {
    const idx = lowerBound(ts);
    let bestDiff = Number.POSITIVE_INFINITY;
    let bestPrice: number | null = null;

    if (idx < rows.length) {
      const diff = Math.abs(rows[idx].timestamp - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPrice = rows[idx].price_usd;
      }
    }

    if (idx > 0) {
      const diff = Math.abs(rows[idx - 1].timestamp - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPrice = rows[idx - 1].price_usd;
      }
    }

    results.set(ts, bestDiff <= 7200 ? bestPrice : null);
  }

  return results;
}

/**
 * Batch store hourly prices
 *
 * @param prices - Array of [timestamp, price] tuples
 */
export function batchSetPrices(prices: [number, number][]): void {
  const database = initPriceCache();

  const insert = database.prepare(
    'INSERT OR REPLACE INTO price_history (timestamp, price_usd, fetched_at) VALUES (?, ?, ?)'
  );

  const insertMany = database.transaction((priceData: [number, number][]) => {
    const now = Date.now();
    for (const [timestamp, price] of priceData) {
      insert.run(timestamp, price, now);
    }
  });

  insertMany(prices);
}

/**
 * Get prices for a timestamp range
 *
 * @param startTimestamp - Start Unix timestamp (seconds)
 * @param endTimestamp - End Unix timestamp (seconds)
 * @returns Array of { timestamp, price_usd }
 */
export function getPricesByRange(startTimestamp: number, endTimestamp: number): Array<{ timestamp: number; price_usd: number }> {
  const database = initPriceCache();

  const rows = database.prepare(`
    SELECT timestamp, price_usd
    FROM price_history
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startTimestamp, endTimestamp) as Array<{ timestamp: number; price_usd: number }>;

  return rows;
}

/**
 * Get date range that needs to be populated
 *
 * @returns { oldestTimestamp, newestTimestamp, count }
 */
export function getPriceDataRange() {
  const database = initPriceCache();

  const stats = database.prepare(`
    SELECT
      COUNT(*) as count,
      MIN(timestamp) as oldest_timestamp,
      MAX(timestamp) as newest_timestamp
    FROM price_history
  `).get() as {
    count: number;
    oldest_timestamp: number | null;
    newest_timestamp: number | null;
  };

  return stats;
}

/**
 * Close database connection (for graceful shutdown)
 */
export function closePriceCache(): void {
  if (db) {
    db.close();
    db = null;
  }
}
