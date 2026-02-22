#!/usr/bin/env node
/**
 * collect-daily-stats.js
 * Incrementally collects transactions since the last run and accumulates
 * a running daily total in data/daily-stats.json. Designed to run every
 * 30 minutes via GitHub Actions.
 *
 * Usage: node scripts/collect-daily-stats.js
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WS_URL = 'wss://ws.testnet.postfiat.org';
const EXPLORER_API = 'https://explorer.testnet.postfiat.org/api/v1';
const VHS_BASE = 'https://vhs.testnet.postfiat.org';
const DATA_FILE = path.join(__dirname, '..', 'data', 'daily-stats.json');
const TIMEOUT_MS = 120000;       // 2 min — handles large catch-up runs
const BATCH_SIZE = 20;
const FIRST_RUN_LOOKBACK = 700;  // ~35 min at 3s/ledger, covers schedule gaps on first run

const today = new Date().toISOString().slice(0, 10);

// Safety timeout
const safetyTimer = setTimeout(() => {
    console.error('[Timeout] Script exceeded timeout, exiting');
    process.exit(1);
}, TIMEOUT_MS);

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                res.resume();
                return;
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`Bad JSON from ${url}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    });
}

function wsSend(ws, msg) {
    return new Promise((resolve, reject) => {
        const id = msg.id || Math.floor(Math.random() * 1e9);
        msg.id = id;
        const timer = setTimeout(() => reject(new Error('WS request timeout')), 15000);
        const handler = (raw) => {
            try {
                const data = JSON.parse(raw);
                if (data.id === id) {
                    ws.removeListener('message', handler);
                    clearTimeout(timer);
                    resolve(data);
                }
            } catch (e) { /* ignore non-JSON */ }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(msg));
    });
}

// fromSeq: first ledger to fetch (inclusive). null = first run of day.
async function collectFromWebSocket(fromSeq) {
    console.log(`[WS] Connecting to ${WS_URL}...`);

    const ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 15000);
    });
    console.log('[WS] Connected');

    const infoResp = await wsSend(ws, { command: 'server_info' });
    const info = infoResp.result?.info;
    if (!info) throw new Error('No server_info result');
    const currentSeq = info.validated_ledger?.seq;
    console.log(`[WS] Current ledger: ${currentSeq}`);

    // Determine range: resume from last run, or look back ~35 min on first run
    const startSeq = (fromSeq != null) ? fromSeq : currentSeq - FIRST_RUN_LOOKBACK;
    const numToFetch = Math.max(currentSeq - startSeq + 1, 0);
    console.log(`[WS] Fetching ${numToFetch} ledgers (seq ${startSeq}–${currentSeq})`);

    let txCount = 0;
    const accounts = new Set();

    for (let i = 0; i < numToFetch; i += BATCH_SIZE) {
        const promises = [];
        for (let j = 0; j < BATCH_SIZE && (i + j) < numToFetch; j++) {
            const seq = startSeq + i + j;
            promises.push(
                wsSend(ws, {
                    command: 'ledger',
                    ledger_index: seq,
                    transactions: true,
                    expand: true
                }).catch(err => {
                    console.warn(`[WS] Ledger ${seq} failed: ${err.message}`);
                    return null;
                })
            );
        }
        const results = await Promise.all(promises);
        for (const resp of results) {
            if (!resp || !resp.result?.ledger) continue;
            const ledger = resp.result.ledger;
            const closeTime = ledger.close_time
                ? new Date((ledger.close_time + 946684800) * 1000)
                : null;
            // Only count transactions from today
            if (closeTime && closeTime.toISOString().slice(0, 10) !== today) continue;
            const txns = ledger.transactions || [];
            txCount += txns.length;
            for (const tx of txns) {
                const inner = tx.tx || tx.tx_json || tx;
                if (inner.Account) accounts.add(inner.Account);
            }
        }
        process.stdout.write(`\r[WS] Fetched ${Math.min(i + BATCH_SIZE, numToFetch)}/${numToFetch} ledgers`);
    }
    console.log('');
    console.log(`[WS] New txns this run: ${txCount}, new accounts: ${accounts.size}`);

    ws.close();
    return { txCount, walletAddresses: [...accounts], lastSeq: currentSeq };
}

async function collectExplorerMetrics() {
    try {
        const data = await httpGet(EXPLORER_API + '/metrics');
        console.log(`[Explorer] TPS=${data.txn_sec}, avg_fee=${data.avg_fee}, interval=${data.ledger_interval}`);
        return {
            tps: parseFloat(data.txn_sec || '0'),
            avgFee: data.avg_fee || '0.00001000',
            ledgerInterval: parseFloat(data.ledger_interval || '0')
        };
    } catch (e) {
        console.warn(`[Explorer] Metrics fetch failed: ${e.message}`);
        return { tps: 0, avgFee: '0.00001000', ledgerInterval: 0 };
    }
}

async function collectVHSData() {
    let nodeCount = 0;
    let validatorCount = 0;

    try {
        const topo = await httpGet(VHS_BASE + '/v1/network/topology/nodes/test');
        const nodes = topo.nodes || topo;
        if (Array.isArray(nodes)) nodeCount = nodes.length;
        console.log(`[VHS] Topology nodes: ${nodeCount}`);
    } catch (e) {
        console.warn(`[VHS] Topology fetch failed: ${e.message}`);
    }

    try {
        const vals = await httpGet(VHS_BASE + '/v1/network/validators/test');
        const validators = vals.validators || vals;
        if (Array.isArray(validators)) validatorCount = validators.length;
        console.log(`[VHS] Validators: ${validatorCount}`);
    } catch (e) {
        console.warn(`[VHS] Validators fetch failed: ${e.message}`);
    }

    return { nodeCount, validatorCount };
}

function loadExisting() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn(`[Data] Could not read existing file: ${e.message}`);
    }
    return { lastUpdated: null, firstSeen: {}, days: {} };
}

async function main() {
    console.log(`[Stats] Collecting daily stats for ${today}`);

    // Load existing data first so we know where to resume from
    const existing = loadExisting();
    const existingDay = existing.days[today] || {};
    const fromSeq = existingDay.lastSeq != null ? existingDay.lastSeq + 1 : null;

    if (fromSeq != null) {
        console.log(`[Stats] Resuming from ledger ${fromSeq} (running total: ${existingDay.txCount || 0} txns)`);
    } else {
        console.log(`[Stats] First run today — lookback ${FIRST_RUN_LOOKBACK} ledgers`);
    }

    const [wsData, explorerData, vhsData] = await Promise.all([
        collectFromWebSocket(fromSeq).catch(err => {
            console.error(`[WS] Collection failed: ${err.message}`);
            return { txCount: 0, walletAddresses: [], lastSeq: null };
        }),
        collectExplorerMetrics(),
        collectVHSData()
    ]);

    existing.lastUpdated = new Date().toISOString();

    if (!existing.firstSeen || typeof existing.firstSeen !== 'object') {
        existing.firstSeen = {};
    }

    // Merge wallet addresses with the existing set for today
    const existingWallets = new Set(existingDay.walletAddresses || []);
    for (const wallet of wsData.walletAddresses) {
        existingWallets.add(wallet);
        // firstSeen: never overwrite (preserves true first-seen date)
        if (!existing.firstSeen[wallet]) {
            existing.firstSeen[wallet] = today;
        }
    }

    existing.days[today] = {
        txCount: (existingDay.txCount || 0) + wsData.txCount,  // accumulate
        activeWallets: existingWallets.size,
        walletAddresses: [...existingWallets],
        tps: explorerData.tps,
        avgFee: explorerData.avgFee,
        nodeCount: vhsData.nodeCount,
        validatorCount: vhsData.validatorCount,
        lastSeq: wsData.lastSeq ?? existingDay.lastSeq  // keep existing if WS failed
    };

    // Trim to 90 days
    const sortedDates = Object.keys(existing.days).sort();
    if (sortedDates.length > 90) {
        sortedDates.slice(0, sortedDates.length - 90).forEach(d => delete existing.days[d]);
    }

    // Write output
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2) + '\n');

    const day = existing.days[today];
    console.log(`[Stats] Today's cumulative total: ${day.txCount} txns, ${day.activeWallets} wallets`);
    console.log(`[Stats] Last processed ledger: ${day.lastSeq}`);
    console.log(`[Stats] Total days tracked: ${Object.keys(existing.days).length}`);

    clearTimeout(safetyTimer);
    process.exit(0);
}

main().catch(err => {
    console.error('[Fatal]', err);
    clearTimeout(safetyTimer);
    process.exit(1);
});
