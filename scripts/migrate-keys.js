#!/usr/bin/env node
/**
 * Manually migrate legacy database keys to canonical form.
 *
 * Startup no longer runs this automatically. Always stop all writers, verify a
 * backup, inspect the dry-run, and review conflicting keys before using it.
 * This legacy script is not a complete transactional migration or rollback.
 *
 * Usage:
 *   node scripts/migrate-keys.js [--dry-run] [--force]
 */

import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePostgresPoolConfig } from '../src/config/database/postgres.js';
import { runKeyMigration } from '../src/utils/database/keyMigration.js';
import { logger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

async function run() {
    const pool = new Pool(resolvePostgresPoolConfig());

    try {
        const summary = await runKeyMigration({ pool, dryRun, force, logger });
        if (summary.errors || summary.skipped) {
            logger.warn('Key migration incomplete; review conflicts and errors.');
            process.exitCode = 1;
        }
        if (summary?.alreadyDone) {
            logger.info('Key migration already applied. Use --force to re-run.');
        }
    } finally {
        await pool.end();
    }
}

run().catch((error) => {
    logger.error('Key migration failed:', error);
    process.exit(1);
});
