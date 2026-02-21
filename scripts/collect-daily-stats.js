#!/usr/bin/env node
/**
 * collect-daily-stats.js
 * Connects via WebSocket to the Post Fiat testnet, fetches recent ledgers,
 * counts today's transactions and unique accounts, fetches explorer/VHS
 * metrics, and writes data/daily-stats.json.
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
const TIMEOUT_MS = 60000;
const LEDGERS_TO_FETCH = 200;

const today = new Date().toISOString().slice(0, 10);

// Safety timeout
const safetyTimer = setTimeout(() => {
    console.error('[Timeout] Script exceeded 60s, exiting');
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

async function collectFromWebSocket() {
    console.log(`[WS] Connecting to ${WS_URL}...`);

    const ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 15000);
    });
    console.log('[WS] Connected');

    // Get server_info for current ledger height
    const infoResp = await wsSend(ws, { command: 'server_info' });
    const info = infoResp.result?.info;
    if (!info) throw new Error('No server_info result');
    const currentSeq = info.validated_ledger?.seq;
    console.log(`[WS] Current ledger: ${currentSeq}`);

    // Fetch recent ledgers with transactions
    let txCount = 0;
    const accounts = new Set();
    const startSeq = currentSeq - LEDGERS_TO_FETCH + 1;

    // Fetch in batches of 20 for efficiency
    const batchSize = 20;
    for (let i = 0; i < LEDGERS_TO_FETCH; i += batchSize) {
        const promises = [];
        for (let j = 0; j < batchSize && (i + j) < LEDGERS_TO_FETCH; j++) {
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

            // Convert ripple epoch close_time to JS Date
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
        process.stdout.write(`\r[WS] Fetched ${Math.min(i + batchSize, LEDGERS_TO_FETCH)}/${LEDGERS_TO_FETCH} ledgers`);
    }
    console.log('');
    console.log(`[WS] Today (${today}): ${txCount} txns, ${accounts.size} unique accounts`);

    ws.close();
    return { txCount, activeWallets: accounts.size, walletAddresses: [...accounts] };
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

    // Run all collectors in parallel
    const [wsData, explorerData, vhsData] = await Promise.all([
        collectFromWebSocket().catch(err => {
            console.error(`[WS] Collection failed: ${err.message}`);
            return { txCount: 0, activeWallets: 0 };
        }),
        collectExplorerMetrics(),
        collectVHSData()
    ]);

    // Merge into existing data
    const existing = loadExisting();
    existing.lastUpdated = new Date().toISOString();

    // Ensure firstSeen map exists
    if (!existing.firstSeen || typeof existing.firstSeen !== 'object') {
        existing.firstSeen = {};
    }

    // Update firstSeen — never overwrite existing entries (preserves true first-seen date)
    for (const wallet of (wsData.walletAddresses || [])) {
        if (!existing.firstSeen[wallet]) {
            existing.firstSeen[wallet] = today;
        }
    }

    existing.days[today] = {
        txCount: wsData.txCount,
        activeWallets: wsData.activeWallets,
        walletAddresses: wsData.walletAddresses || [],
        tps: explorerData.tps,
        avgFee: explorerData.avgFee,
        nodeCount: vhsData.nodeCount,
        validatorCount: vhsData.validatorCount
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
    console.log(`[Stats] Written to ${DATA_FILE}`);
    console.log(`[Stats] Total days tracked: ${Object.keys(existing.days).length}`);

    clearTimeout(safetyTimer);
    process.exit(0);
}

main().catch(err => {
    console.error('[Fatal]', err);
    clearTimeout(safetyTimer);
    process.exit(1);
});
