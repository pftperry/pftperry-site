#!/usr/bin/env node
/**
 * backfill-stats.js
 * Fetches complete historical data for past days missing from daily-stats.json.
 * Uses arithmetic estimation to locate each day's ledger range, with a buffer
 * at each boundary to handle close-time variance.
 *
 * Usage: node scripts/backfill-stats.js [--days=N]
 *   --days=N  Max days back to consider (default: 90)
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WS_URL = 'wss://ws.testnet.postfiat.org';
const EXPLORER_API = 'https://explorer.testnet.postfiat.org/api/v1';
const DATA_FILE = path.join(__dirname, '..', 'data', 'daily-stats.json');
const BATCH_SIZE = 20;
const SEQ_BUFFER = 600; // ~30 min of ledgers, covers arithmetic estimation error

const daysArg = process.argv.find(a => a.startsWith('--days='));
const MAX_DAYS = daysArg ? parseInt(daysArg.split('=')[1]) : 90;
const today = new Date().toISOString().slice(0, 10);

function loadExisting() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('[Data] Could not read existing file:', e.message);
    }
    return { lastUpdated: null, firstSeen: {}, days: {} };
}

function isComplete(day) {
    return day &&
        day.txCount !== undefined &&
        Array.isArray(day.walletAddresses) &&
        day.txTypeDistribution !== undefined &&
        Array.isArray(day.hourlyTxCounts) && day.hourlyTxCounts.length === 24;
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Bad JSON')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function wsSend(ws, msg) {
    return new Promise((resolve, reject) => {
        const id = msg.id || Math.floor(Math.random() * 1e9);
        msg.id = id;
        const timer = setTimeout(() => reject(new Error('WS timeout')), 15000);
        const handler = (raw) => {
            try {
                const data = JSON.parse(raw);
                if (data.id === id) {
                    ws.removeListener('message', handler);
                    clearTimeout(timer);
                    resolve(data);
                }
            } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(msg));
    });
}

function connectWS() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 15000);
    });
}

async function processDay(ws, date, currentSeq, currentUnixSec, avgCloseTime, existing) {
    const dayStartUnix = new Date(date + 'T00:00:00Z').getTime() / 1000;
    const dayEndUnix = dayStartUnix + 86400;

    // Arithmetic estimate of ledger range for this day
    const estStartSeq = Math.max(1, currentSeq - Math.ceil((currentUnixSec - dayStartUnix) / avgCloseTime));
    const estEndSeq   = Math.max(1, currentSeq - Math.floor((currentUnixSec - dayEndUnix) / avgCloseTime));

    const fetchStart = Math.max(1, estStartSeq - SEQ_BUFFER);
    const fetchEnd   = estEndSeq + SEQ_BUFFER;
    const numToFetch = fetchEnd - fetchStart + 1;

    console.log(`[${date}] Fetching ledgers ${fetchStart}–${fetchEnd} (${numToFetch} total, est. ${estStartSeq}–${estEndSeq})`);

    let txCount = 0;
    const accounts = new Set();
    const txTypes = {};
    const hourlyTxCounts = new Array(24).fill(0);

    for (let i = 0; i < numToFetch; i += BATCH_SIZE) {
        const promises = [];
        for (let j = 0; j < BATCH_SIZE && (i + j) < numToFetch; j++) {
            const seq = fetchStart + i + j;
            promises.push(
                wsSend(ws, { command: 'ledger', ledger_index: seq, transactions: true, expand: true })
                    .catch(() => null)
            );
        }
        const results = await Promise.all(promises);
        for (const resp of results) {
            if (!resp || !resp.result?.ledger) continue;
            const ledger = resp.result.ledger;
            const closeTime = ledger.close_time
                ? new Date((ledger.close_time + 946684800) * 1000)
                : null;
            if (!closeTime || closeTime.toISOString().slice(0, 10) !== date) continue;
            const hour = closeTime.getUTCHours();
            const txns = ledger.transactions || [];
            txCount += txns.length;
            if (txns.length > 0) hourlyTxCounts[hour] += txns.length;
            for (const tx of txns) {
                const inner = tx.tx || tx.tx_json || tx;
                if (inner.Account) accounts.add(inner.Account);
                const txType = inner.TransactionType || 'Unknown';
                txTypes[txType] = (txTypes[txType] || 0) + 1;
            }
        }
        process.stdout.write(`\r[${date}] ${Math.min(i + BATCH_SIZE, numToFetch)}/${numToFetch} fetched — ${txCount} txns`);
    }
    console.log('');
    console.log(`[${date}] Done: ${txCount} txns, ${accounts.size} wallets`);

    // Update firstSeen — never overwrite (preserves true first-seen date across days)
    if (!existing.firstSeen) existing.firstSeen = {};
    for (const wallet of accounts) {
        if (!existing.firstSeen[wallet]) {
            existing.firstSeen[wallet] = date;
        }
    }

    // For past complete days: replace entirely (full-day fetch = definitive data)
    const existingDay = existing.days[date] || {};
    existing.days[date] = {
        txCount,
        activeWallets: accounts.size,
        walletAddresses: [...accounts],
        txTypeDistribution: txTypes,
        hourlyTxCounts,
        // Preserve tps/avgFee/nodeCount/validatorCount from prior collect runs if present
        tps: existingDay.tps || 0,
        avgFee: existingDay.avgFee || '0.00001000',
        nodeCount: existingDay.nodeCount || 0,
        validatorCount: existingDay.validatorCount || 0
    };
}

async function main() {
    const existing = loadExisting();

    // Determine which past days need backfilling
    const targetDates = [];
    for (let i = 1; i <= MAX_DAYS; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().slice(0, 10);
        if (!isComplete(existing.days[date])) {
            targetDates.push(date);
        }
    }

    if (targetDates.length === 0) {
        console.log('[Backfill] All days already complete — nothing to do.');
        process.exit(0);
    }

    console.log(`[Backfill] Days to backfill (${targetDates.length}): ${targetDates.join(', ')}`);

    // Connect and get reference point
    console.log('[Backfill] Connecting...');
    const ws = await connectWS();
    console.log('[Backfill] Connected');

    const infoResp = await wsSend(ws, { command: 'server_info' });
    const info = infoResp.result?.info;
    if (!info) throw new Error('No server_info');
    const currentSeq = info.validated_ledger?.seq;
    // server_info doesn't include close_time; use Date.now() — the latest
    // validated ledger closed within the last few seconds so it's equivalent.
    const currentUnixSec = Math.floor(Date.now() / 1000);
    console.log(`[Backfill] Current ledger: seq=${currentSeq}, ref_time=${new Date(currentUnixSec * 1000).toISOString()}`);

    let avgCloseTime = 3.0;
    try {
        const metrics = await httpGet(EXPLORER_API + '/metrics');
        if (metrics.ledger_interval) avgCloseTime = parseFloat(metrics.ledger_interval);
    } catch {}
    console.log(`[Backfill] Avg ledger close time: ${avgCloseTime}s`);

    // Process oldest day first so firstSeen dates are assigned correctly
    const sortedDates = [...targetDates].sort();
    for (const date of sortedDates) {
        console.log(`\n--- Backfilling ${date} ---`);
        try {
            await processDay(ws, date, currentSeq, currentUnixSec, avgCloseTime, existing);
        } catch (err) {
            console.error(`[${date}] Failed: ${err.message} — skipping`);
            continue;
        }

        // Trim to 90 days and write after each day so progress is preserved
        const sortedAllDates = Object.keys(existing.days).sort();
        if (sortedAllDates.length > 90) {
            sortedAllDates.slice(0, sortedAllDates.length - 90).forEach(d => delete existing.days[d]);
        }
        existing.lastUpdated = new Date().toISOString();
        fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2) + '\n');
        console.log(`[${date}] Saved to ${DATA_FILE}`);
    }

    ws.close();
    console.log(`\n[Backfill] Complete. ${sortedDates.length} days processed.`);
    process.exit(0);
}

main().catch(err => {
    console.error('[Fatal]', err);
    process.exit(1);
});
