/* ============================================
   Metrics Engine
   Computes all dashboard stats from ledger data
   Manages localStorage cache
   ============================================ */

const MetricsEngine = (() => {
    const CACHE_KEY = 'pftperry_metrics_cache';
    const MAX_LEDGERS = 5000;
    const DAY_MS = 86400000;

    // In-memory data store
    let ledgers = [];           // Array of { seq, close_time, txn_count, transactions: [...] }
    let serverInfo = null;
    let recentTxnTimes = [];    // For TPS calculation (last 10 ledger intervals)
    let lastLedgerTime = null;

    function init() {
        loadCache();
    }

    function loadCache() {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const data = JSON.parse(cached);
                ledgers = data.ledgers || [];
                console.log(`[Metrics] Loaded ${ledgers.length} cached ledgers`);
            }
        } catch (e) {
            console.warn('[Metrics] Cache load failed:', e);
        }
    }

    function saveCache() {
        try {
            // Keep only last MAX_LEDGERS
            const toSave = ledgers.slice(-MAX_LEDGERS);
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ledgers: toSave, savedAt: Date.now() }));
        } catch (e) {
            console.warn('[Metrics] Cache save failed:', e);
        }
    }

    function processServerInfo(info) {
        serverInfo = info;
    }

    function processLedger(ledger) {
        const seq = ledger.ledger_index || ledger.seqNum;
        if (!seq) return;

        // Avoid duplicates
        if (ledgers.find(l => l.seq === seq)) return;

        const closeTime = ledger.close_time
            ? (ledger.close_time + 946684800) * 1000  // Ripple epoch to JS epoch
            : Date.now();

        const txns = ledger.transactions || [];
        const processed = txns.map(tx => {
            if (typeof tx === 'string') return { hash: tx };
            const inner = tx.tx || tx.tx_json || tx;
            return {
                type: inner.TransactionType || 'Unknown',
                account: inner.Account || '',
                destination: inner.Destination || '',
                fee: parseInt(inner.Fee || '0', 10),
                amount: inner.Amount,
                hash: inner.hash || tx.hash || ''
            };
        });

        // Calculate ledger interval
        if (lastLedgerTime) {
            const interval = (closeTime - lastLedgerTime) / 1000;
            recentTxnTimes.push({ interval, txnCount: processed.length });
            if (recentTxnTimes.length > 10) recentTxnTimes.shift();
        }
        lastLedgerTime = closeTime;

        ledgers.push({
            seq: parseInt(seq, 10),
            close_time: closeTime,
            txn_count: processed.length,
            transactions: processed
        });

        // Sort and trim
        ledgers.sort((a, b) => a.seq - b.seq);
        if (ledgers.length > MAX_LEDGERS) {
            ledgers = ledgers.slice(-MAX_LEDGERS);
        }

        // Save periodically (every 10 ledgers)
        if (ledgers.length % 10 === 0) {
            saveCache();
        }
    }

    function processLedgerClosed(data) {
        // Lightweight update from stream
        if (data.validated_ledgers) {
            // Could parse range
        }
    }

    // ---- Computed Stats ----

    function getAllTransactions(sinceMs) {
        const cutoff = Date.now() - sinceMs;
        const txns = [];
        for (const l of ledgers) {
            if (l.close_time >= cutoff) {
                txns.push(...l.transactions);
            }
        }
        return txns;
    }

    function getDailyActiveWallets() {
        const txns = getAllTransactions(DAY_MS);
        const accounts = new Set();
        txns.forEach(tx => {
            if (tx.account) accounts.add(tx.account);
        });
        return accounts.size;
    }

    function getTPS() {
        if (recentTxnTimes.length < 2) return 0;
        const totalTxns = recentTxnTimes.reduce((s, r) => s + r.txnCount, 0);
        const totalTime = recentTxnTimes.reduce((s, r) => s + r.interval, 0);
        if (totalTime <= 0) return 0;
        return totalTxns / totalTime;
    }

    function getTotalAccounts() {
        if (serverInfo && serverInfo.validated_ledger) {
            // Rough estimate: not directly available from server_info
            // We'll track unique accounts we've seen
        }
        const accounts = new Set();
        ledgers.forEach(l => {
            l.transactions.forEach(tx => {
                if (tx.account) accounts.add(tx.account);
                if (tx.destination) accounts.add(tx.destination);
            });
        });
        return accounts.size;
    }

    function getAvgFee() {
        const txns = getAllTransactions(DAY_MS);
        if (txns.length === 0) return 0;
        const totalFee = txns.reduce((s, tx) => s + (tx.fee || 0), 0);
        return totalFee / txns.length;
    }

    function getLedgerInterval() {
        if (recentTxnTimes.length === 0) return 0;
        const avg = recentTxnTimes.reduce((s, r) => s + r.interval, 0) / recentTxnTimes.length;
        return avg;
    }

    function getLedgerHeight() {
        if (serverInfo && serverInfo.validated_ledger) {
            return serverInfo.validated_ledger.seq;
        }
        if (ledgers.length > 0) {
            return ledgers[ledgers.length - 1].seq;
        }
        return 0;
    }

    function getAvgTxnPerUser() {
        const txns = getAllTransactions(DAY_MS);
        const accounts = new Set();
        txns.forEach(tx => { if (tx.account) accounts.add(tx.account); });
        if (accounts.size === 0) return 0;
        return txns.length / accounts.size;
    }

    function getPeakHour() {
        const txns = getAllTransactions(DAY_MS);
        const hourCounts = new Array(24).fill(0);
        txns.forEach(tx => {
            // Use the ledger the tx was in
        });
        // Use ledger close times
        ledgers.forEach(l => {
            if (l.close_time >= Date.now() - DAY_MS) {
                const hour = new Date(l.close_time).getUTCHours();
                hourCounts[hour] += l.txn_count;
            }
        });
        let maxHour = 0;
        let maxCount = 0;
        hourCounts.forEach((c, h) => {
            if (c > maxCount) { maxCount = c; maxHour = h; }
        });
        return maxCount > 0 ? `${String(maxHour).padStart(2, '0')}:00 UTC` : '--';
    }

    function getActiveWallets(days) {
        const txns = getAllTransactions(days * DAY_MS);
        const accounts = new Set();
        txns.forEach(tx => { if (tx.account) accounts.add(tx.account); });
        return accounts.size;
    }

    function getTxTypeDistribution() {
        const txns = getAllTransactions(DAY_MS);
        const dist = {};
        txns.forEach(tx => {
            const type = tx.type || 'Unknown';
            dist[type] = (dist[type] || 0) + 1;
        });
        return dist;
    }

    function getDailyActiveWalletsHistory() {
        // Group ledgers by day, count unique accounts per day
        const dayBuckets = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            if (!dayBuckets[day]) dayBuckets[day] = new Set();
            l.transactions.forEach(tx => {
                if (tx.account) dayBuckets[day].add(tx.account);
            });
        });

        return Object.entries(dayBuckets)
            .map(([date, accounts]) => ({ date, count: accounts.size }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-30);
    }

    function getTxVolumeHistory() {
        const dayBuckets = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            dayBuckets[day] = (dayBuckets[day] || 0) + l.txn_count;
        });

        return Object.entries(dayBuckets)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-30);
    }

    function getRetentionData() {
        return {
            day1: getActiveWallets(1),
            day7: getActiveWallets(7),
            day30: getActiveWallets(30)
        };
    }

    function getRecentTransactions(count) {
        const recent = [];
        for (let i = ledgers.length - 1; i >= 0 && recent.length < count; i--) {
            const l = ledgers[i];
            for (let j = l.transactions.length - 1; j >= 0 && recent.length < count; j--) {
                recent.push({ ...l.transactions[j], time: l.close_time });
            }
        }
        return recent;
    }

    function getAllStats() {
        return {
            dailyActiveWallets: getDailyActiveWallets(),
            tps: getTPS(),
            totalAccounts: getTotalAccounts(),
            avgFee: getAvgFee(),
            ledgerInterval: getLedgerInterval(),
            ledgerHeight: getLedgerHeight(),
            avgTxnPerUser: getAvgTxnPerUser(),
            peakHour: getPeakHour(),
            txTypeDistribution: getTxTypeDistribution(),
            dawHistory: getDailyActiveWalletsHistory(),
            txVolHistory: getTxVolumeHistory(),
            retention: getRetentionData(),
            recentTxns: getRecentTransactions(50)
        };
    }

    function hasData() {
        return ledgers.length > 0;
    }

    return {
        init,
        processServerInfo,
        processLedger,
        processLedgerClosed,
        saveCache,
        getAllStats,
        hasData,
        getRecentTransactions,
        getDailyActiveWalletsHistory,
        getTxVolumeHistory
    };
})();
