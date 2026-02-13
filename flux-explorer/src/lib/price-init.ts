/**
 * Automatic Price Data Initialization
 *
 * Runs on app startup to ensure price database is populated
 * - Checks if database exists and has recent data
 * - Automatically populates if needed (background process)
 * - Non-blocking: app starts immediately
 */

import { batchSetPrices, getPriceDataRange, initPriceCache, setCachedPriceHourly } from './db/price-cache';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import ky from 'ky';

let initializationStarted = false;
let hourlyUpdateInterval: NodeJS.Timeout | null = null;
let hourlyLockHeld = false;
let backfillInterval: NodeJS.Timeout | null = null;

const DATA_DIR = path.join(process.cwd(), 'data');
const POPULATION_LOCK_PATH = path.join(DATA_DIR, 'price-population.lock');
const HOURLY_LOCK_PATH = path.join(DATA_DIR, 'price-hourly.lock');
const POPULATION_LOG_PATH = path.join(DATA_DIR, 'price-population.log');
const RECENT_BACKFILL_HOURS = 24 * 30;

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

function isPriceCacheEnabled(): boolean {
  const autoInitEnv = process.env.AUTO_INIT_PRICES;
  if (autoInitEnv === 'false' || process.env.DISABLE_PRICE_CACHE === 'true') {
    return false;
  }

  const autoInitDefault = process.env.NODE_ENV === 'production';
  const autoInit = autoInitEnv === 'true' ? true : autoInitDefault;
  if (!autoInit) return false;

  return envFlag('PRICE_CACHE_ENABLED', true);
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function tryAcquireLock(lockPath: string, staleAfterMs: number): boolean {
  ensureDataDir();
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (error: unknown) {
    const errnoCode = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (errnoCode !== 'EEXIST') return false;

    try {
      const stat = fs.statSync(lockPath);
      if ((Date.now() - stat.mtimeMs) > staleAfterMs) {
        fs.unlinkSync(lockPath);
        return tryAcquireLock(lockPath, staleAfterMs);
      }
    } catch {
      // Ignore and treat lock as held
    }

    return false;
  }
}

function touchLock(lockPath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  } catch {
    // Ignore
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore
  }
}

function shouldSkipBackfill(): boolean {
  if (!fs.existsSync(POPULATION_LOCK_PATH)) return false;
  try {
    const stat = fs.statSync(POPULATION_LOCK_PATH);
    return (Date.now() - stat.mtimeMs) <= (12 * 60 * 60 * 1000);
  } catch {
    return false;
  }
}

/**
 * Check if price data needs initialization
 */
export function checkPriceDataStatus(): { needsInit: boolean; reason: string } {
  try {
    initPriceCache();
    const range = getPriceDataRange();

    // No data at all
    if (range.count === 0) {
      return { needsInit: true, reason: 'Database is empty' };
    }

    // Check if data is recent (within last 7 days)
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    if (range.newest_timestamp && range.newest_timestamp < sevenDaysAgo) {
      return { needsInit: true, reason: `Data is outdated (newest: ${new Date(range.newest_timestamp * 1000).toISOString()})` };
    }

    // Check if we have reasonable amount of data (at least 6 months = ~4300 hours)
    if (range.count < 4000) {
      return { needsInit: true, reason: `Insufficient data (${range.count} entries, need ~4000+)` };
    }

    return { needsInit: false, reason: 'Database is populated and up-to-date' };
  } catch (error) {
    return { needsInit: true, reason: `Error checking database: ${error}` };
  }
}

/**
 * Initialize price data in background process
 */
export function initializePriceData(): void {
  if (initializationStarted) {
    console.log('💰 Price data initialization already in progress');
    return;
  }

  if (!isPriceCacheEnabled() || !envFlag('PRICE_CACHE_POPULATE', true)) {
    return;
  }

  const status = checkPriceDataStatus();

  if (!status.needsInit) {
    console.log('✅ Price data is ready:', status.reason);
    return;
  }

  // Avoid spawning multiple population jobs across multi-instance deployments.
  // The population script also enforces this lock and releases it when done.
  const POPULATION_LOCK_STALE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 hours
  if (fs.existsSync(POPULATION_LOCK_PATH)) {
    try {
      const stat = fs.statSync(POPULATION_LOCK_PATH);
      if ((Date.now() - stat.mtimeMs) <= POPULATION_LOCK_STALE_AFTER_MS) {
        console.log('💰 Price data population already running (lock present)');
        return;
      }
      fs.unlinkSync(POPULATION_LOCK_PATH);
      console.warn('⚠️  Price population lock was stale and was cleared');
    } catch {
      console.log('💰 Price data population already running (lock present)');
      return;
    }
  }

  console.log('🚀 Initializing price data:', status.reason);
  console.log('   This will run in the background and may take 30-45 minutes');
  console.log('   The app will remain fully functional during this time');
  console.log('   Price data will be available once complete\n');

  initializationStarted = true;

  // Determine script path
  const scriptPath = path.join(process.cwd(), 'scripts', 'populate-price-history.ts');

  // Check if we have tsx available
  const tsxPath = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const useTsx = fs.existsSync(tsxPath);

  if (!useTsx) {
    console.warn('⚠️  tsx not found - price data population requires: npm install tsx');
    console.warn('   Run manually: npm run populate-prices');
    return;
  }

  ensureDataDir();
  const logFd = fs.openSync(POPULATION_LOG_PATH, 'a');

  // Spawn background process
  const child = spawn(tsxPath, [scriptPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
  });

  fs.closeSync(logFd);

  // Detach from parent process
  child.unref();

  console.log(`📊 Price data population started (PID: ${child.pid})`);
  console.log('   Logs: tail -f data/price-population.log\n');
}

/**
 * Fetch and store the latest hourly price from CryptoCompare (free, no auth)
 */
async function updateLatestHourlyPrice(): Promise<void> {
  try {
    // Fetch latest hourly data from CryptoCompare
    const response = await ky.get('https://min-api.cryptocompare.com/data/v2/histohour', {
      searchParams: {
        fsym: 'FLUX',
        tsym: 'USD',
        limit: '1', // Just get the latest hour
      },
      timeout: 30000,
    }).json<{
      Response: string;
      Data: {
        Data: Array<{
          time: number;
          close: number;
        }>;
      };
    }>();

    if (response.Response === 'Success' && response.Data && response.Data.Data && response.Data.Data.length > 0) {
      // Get the most recent price
      const latest = response.Data.Data[response.Data.Data.length - 1];
      const timestamp = latest.time;
      const price = latest.close;

      setCachedPriceHourly(timestamp, price);
      console.log(`💰 Updated hourly price: $${price.toFixed(4)} at ${new Date(timestamp * 1000).toISOString()}`);
    }
  } catch (error) {
    console.error('❌ Failed to fetch hourly price update:', error);
  }
}

/**
 * Backfill recent hourly prices to cover downtime gaps.
 */
async function backfillRecentHourlyPrices(hours: number = RECENT_BACKFILL_HOURS): Promise<void> {
  if (shouldSkipBackfill()) {
    console.log('⏳ Skipping recent price backfill (population lock present)');
    return;
  }

  const safeHours = Math.max(1, Math.min(Math.floor(hours), 2000));
  const toTimestamp = Math.floor(Date.now() / 1000);

  try {
    const response = await ky.get('https://min-api.cryptocompare.com/data/v2/histohour', {
      searchParams: {
        fsym: 'FLUX',
        tsym: 'USD',
        toTs: toTimestamp.toString(),
        limit: safeHours.toString(),
      },
      timeout: 30000,
    }).json<{
      Response: string;
      Data: {
        Data: Array<{
          time: number;
          close: number;
        }>;
      };
    }>();

    if (response.Response !== 'Success' || !response.Data?.Data?.length) {
      console.warn('⚠️  Recent price backfill returned no data');
      return;
    }

    const prices: [number, number][] = response.Data.Data
      .filter((item) => item.close > 0)
      .map((item) => [item.time, item.close]);

    if (prices.length === 0) {
      console.warn('⚠️  Recent price backfill contained only zero prices');
      return;
    }

    batchSetPrices(prices);
    console.log(`🔁 Backfilled ${prices.length.toLocaleString()} hourly prices (last ${safeHours}h)`);
  } catch (error) {
    console.error('❌ Failed to backfill recent prices:', error);
  }
}

/**
 * Start continuous hourly price updates
 */
export function startHourlyPriceUpdates(): void {
  if (hourlyUpdateInterval) {
    console.log('⏰ Hourly price updates already running');
    return;
  }

  if (!isPriceCacheEnabled() || !envFlag('PRICE_CACHE_HOURLY_UPDATES', true)) {
    return;
  }

  // One instance should own hourly updates (shared volume deployments).
  if (!tryAcquireLock(HOURLY_LOCK_PATH, 2 * 60 * 60 * 1000)) {
    console.log('⏰ Skipping hourly price updates (lock held by another instance)');
    return;
  }
  hourlyLockHeld = true;

  console.log('⏰ Starting hourly price updates (runs every 60 minutes)');

  // Run immediately on startup
  updateLatestHourlyPrice();
  backfillRecentHourlyPrices();

  // Daily backfill to heal missed hours
  backfillInterval = setInterval(() => {
    touchLock(HOURLY_LOCK_PATH);
    backfillRecentHourlyPrices();
  }, 24 * 60 * 60 * 1000);

  // Then run every hour
  hourlyUpdateInterval = setInterval(() => {
    touchLock(HOURLY_LOCK_PATH);
    updateLatestHourlyPrice();
  }, 60 * 60 * 1000); // 1 hour in milliseconds
}

/**
 * Stop hourly updates (for cleanup)
 */
export function stopHourlyPriceUpdates(): void {
  if (hourlyUpdateInterval) {
    clearInterval(hourlyUpdateInterval);
    hourlyUpdateInterval = null;
    console.log('⏰ Stopped hourly price updates');
  }

  if (backfillInterval) {
    clearInterval(backfillInterval);
    backfillInterval = null;
  }

  if (hourlyLockHeld) {
    hourlyLockHeld = false;
    releaseLock(HOURLY_LOCK_PATH);
  }
}

/**
 * Auto-initialize on module load (only in production)
 */
if (isPriceCacheEnabled()) {
  // Run initialization check after a short delay to not block server startup
  setTimeout(() => {
    try {
      initializePriceData();

      // Start hourly updates after initialization
      // Wait 2 minutes to let initial population start if needed
      setTimeout(() => {
        startHourlyPriceUpdates();
      }, 120000); // 2 minute delay
    } catch (error) {
      console.error('❌ Failed to initialize price data:', error);
      console.error('   Run manually: npm run populate-prices');
    }
  }, 5000); // 5 second delay after app starts
}

process.on('exit', () => {
  stopHourlyPriceUpdates();
});
