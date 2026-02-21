/* ============================================
   Metrics Engine
   Computes all dashboard stats from ledger data
   Manages localStorage cache
   ============================================ */

const MetricsEngine = (() => {
    const CACHE_KEY = 'pftperry_metrics_cache';
    const DAILY_STATS_KEY = 'pftperry_daily_stats';
    const MAX_LEDGERS = 5000;
    const MAX_DAILY_DAYS = 90;
    const DAY_MS = 86400000;

    // In-memory data store
    let ledgers = [];           // Array of { seq, close_time, txn_count, transactions: [...] }
    let serverInfo = null;
    let explorerMetrics = null; // From explorer API (txn_sec, ledger_interval, etc.)
    let recentTxnTimes = [];    // For TPS calculation (last 10 ledger intervals)
    let lastLedgerTime = null;
    let dailyStats = {};        // { "2026-02-21": { txCount: N, activeWallets: N } }

    function init() {
        loadCache();
        loadDailyStats();
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

    function loadDailyStats() {
        try {
            const stored = localStorage.getItem(DAILY_STATS_KEY);
            if (stored) {
                dailyStats = JSON.parse(stored);
                const dayCount = Object.keys(dailyStats).length;
                console.log(`[Metrics] Loaded ${dayCount} days of historical stats`);
            }
        } catch (e) {
            console.warn('[Metrics] Daily stats load failed:', e);
        }
    }

    function saveDailyStats() {
        try {
            // Compute today's stats from current ledgers and merge into dailyStats
            const liveDays = computeLiveDailyRollups();
            for (const [date, data] of Object.entries(liveDays)) {
                const existing = dailyStats[date];
                if (!existing || data.txCount > existing.txCount) {
                    dailyStats[date] = data;
                }
            }

            // Trim to MAX_DAILY_DAYS most recent
            const sortedDates = Object.keys(dailyStats).sort();
            if (sortedDates.length > MAX_DAILY_DAYS) {
                const toRemove = sortedDates.slice(0, sortedDates.length - MAX_DAILY_DAYS);
                toRemove.forEach(d => delete dailyStats[d]);
            }

            localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(dailyStats));
        } catch (e) {
            console.warn('[Metrics] Daily stats save failed:', e);
        }
    }

    function computeLiveDailyRollups() {
        const dayBuckets = {};
        const dayWallets = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            dayBuckets[day] = (dayBuckets[day] || 0) + l.txn_count;
            if (!dayWallets[day]) dayWallets[day] = new Set();
            l.transactions.forEach(tx => {
                if (tx.account) dayWallets[day].add(tx.account);
            });
        });

        const result = {};
        for (const date of Object.keys(dayBuckets)) {
            result[date] = {
                txCount: dayBuckets[date],
                activeWallets: dayWallets[date] ? dayWallets[date].size : 0
            };
        }
        return result;
    }

    function saveCache() {
        try {
            // Keep only last MAX_LEDGERS
            const toSave = ledgers.slice(-MAX_LEDGERS);
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ledgers: toSave, savedAt: Date.now() }));
        } catch (e) {
            console.warn('[Metrics] Cache save failed:', e);
        }

        // Also persist daily rollups
        saveDailyStats();
    }

    function processServerInfo(info) {
        serverInfo = info;
    }

    function setExplorerMetrics(data) {
        explorerMetrics = data;
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
        // Prefer explorer API data
        if (explorerMetrics && explorerMetrics.txn_sec) {
            return parseFloat(explorerMetrics.txn_sec);
        }
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
        // Prefer explorer API data (returns in XRP like "0.00001000")
        if (explorerMetrics && explorerMetrics.avg_fee) {
            const feeXrp = parseFloat(explorerMetrics.avg_fee);
            return feeXrp * 1000000; // Convert to drops for display
        }
        const txns = getAllTransactions(DAY_MS);
        if (txns.length === 0) return 0;
        const totalFee = txns.reduce((s, tx) => s + (tx.fee || 0), 0);
        return totalFee / txns.length;
    }

    function getLedgerInterval() {
        // Prefer explorer API data
        if (explorerMetrics && explorerMetrics.ledger_interval) {
            return parseFloat(explorerMetrics.ledger_interval);
        }
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
        // Start with persistent historical data
        const merged = {};
        for (const [date, data] of Object.entries(dailyStats)) {
            merged[date] = data.activeWallets || 0;
        }

        // Overlay live session data (use max of stored vs live)
        const dayBuckets = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            if (!dayBuckets[day]) dayBuckets[day] = new Set();
            l.transactions.forEach(tx => {
                if (tx.account) dayBuckets[day].add(tx.account);
            });
        });
        for (const [date, accounts] of Object.entries(dayBuckets)) {
            merged[date] = Math.max(merged[date] || 0, accounts.size);
        }

        return Object.entries(merged)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-30);
    }

    function getDailyActiveWalletsMulti() {
        // Merge persistent + live wallet counts per day
        const dayCounts = {};
        for (const [date, data] of Object.entries(dailyStats)) {
            dayCounts[date] = data.activeWallets || 0;
        }

        // Overlay live session data
        const dayBuckets = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            if (!dayBuckets[day]) dayBuckets[day] = new Set();
            l.transactions.forEach(tx => {
                if (tx.account) dayBuckets[day].add(tx.account);
            });
        });
        for (const [date, accounts] of Object.entries(dayBuckets)) {
            dayCounts[date] = Math.max(dayCounts[date] || 0, accounts.size);
        }

        const sortedDays = Object.keys(dayCounts).sort();
        const result = [];

        for (let i = 0; i < sortedDays.length; i++) {
            const date = sortedDays[i];
            const day1 = dayCounts[date];

            // Rolling 7-day sum (approximate — uses stored counts, not unique sets)
            let day7 = 0;
            for (let j = Math.max(0, i - 6); j <= i; j++) {
                day7 = Math.max(day7, dayCounts[sortedDays[j]]);
            }
            // Sum is a better approximation for rolling unique
            let day7sum = 0;
            for (let j = Math.max(0, i - 6); j <= i; j++) {
                day7sum += dayCounts[sortedDays[j]];
            }
            day7 = Math.max(day1, Math.min(day7sum, day7sum)); // use sum as upper estimate

            // Rolling 30-day
            let day30sum = 0;
            for (let j = Math.max(0, i - 29); j <= i; j++) {
                day30sum += dayCounts[sortedDays[j]];
            }
            const day30 = Math.max(day7, day30sum);

            result.push({ date, day1, day7, day30 });
        }

        return result.slice(-30);
    }

    function getTxVolumeHistory() {
        // Start with persistent historical data
        const merged = {};
        for (const [date, data] of Object.entries(dailyStats)) {
            merged[date] = data.txCount || 0;
        }

        // Compute live session totals per day
        const liveDayTotals = {};
        ledgers.forEach(l => {
            const day = new Date(l.close_time).toISOString().slice(0, 10);
            liveDayTotals[day] = (liveDayTotals[day] || 0) + l.txn_count;
        });

        // Use max of stored vs live for each day
        for (const [date, count] of Object.entries(liveDayTotals)) {
            merged[date] = Math.max(merged[date] || 0, count);
        }

        return Object.entries(merged)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-7);
    }

    function getRetentionData() {
        // 1-day: use live session data (most accurate for today)
        const day1 = getActiveWallets(1);

        // 7-day and 30-day: computed from dailyStats history
        // Without historical data these can't be accurately computed
        const sortedDates = Object.keys(dailyStats).sort();
        let day7 = 0;
        let day30 = 0;

        if (sortedDates.length >= 2) {
            const last7 = sortedDates.slice(-7);
            const last30 = sortedDates.slice(-30);
            day7 = last7.reduce((s, d) => s + (dailyStats[d].activeWallets || 0), 0);
            day30 = last30.reduce((s, d) => s + (dailyStats[d].activeWallets || 0), 0);
            // Ensure monotonic: day30 >= day7 >= day1
            day7 = Math.max(day1, day7);
            day30 = Math.max(day7, day30);
        } else {
            // Only have today's data — just show 1D, leave others at 0
            day7 = 0;
            day30 = 0;
        }

        return { day1, day7, day30 };
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
            activeWallets1d: getActiveWallets(1),
            activeWallets7d: getActiveWallets(7),
            activeWallets30d: getActiveWallets(30),
            tps: getTPS(),
            totalAccounts: getTotalAccounts(),
            avgFee: getAvgFee(),
            ledgerInterval: getLedgerInterval(),
            ledgerHeight: getLedgerHeight(),
            avgTxnPerUser: getAvgTxnPerUser(),
            peakHour: getPeakHour(),
            txTypeDistribution: getTxTypeDistribution(),
            dawHistory: getDailyActiveWalletsHistory(),
            dawHistoryMulti: getDailyActiveWalletsMulti(),
            txVolHistory: getTxVolumeHistory(),
            retention: getRetentionData(),
            recentTxns: getRecentTransactions(50)
        };
    }

    async function loadRemoteStats() {
        try {
            const resp = await fetch('data/daily-stats.json', { cache: 'no-cache' });
            if (!resp.ok) {
                console.log('[Metrics] No remote daily-stats.json available');
                return;
            }
            const remote = await resp.json();
            if (!remote || !remote.days) return;

            const remoteCount = Object.keys(remote.days).length;
            console.log(`[Metrics] Loaded ${remoteCount} days from remote stats`);

            const today = new Date().toISOString().slice(0, 10);
            for (const [date, data] of Object.entries(remote.days)) {
                // Local session data takes priority for today (more accurate/real-time)
                if (date === today && dailyStats[date]) continue;
                // For past days, remote fills in gaps; keep whichever has higher txCount
                const existing = dailyStats[date];
                if (!existing || data.txCount > existing.txCount) {
                    dailyStats[date] = data;
                }
            }

            // Persist the merged data locally
            saveDailyStats();
        } catch (e) {
            console.warn('[Metrics] Remote stats load failed:', e);
        }
    }

    function hasData() {
        return ledgers.length > 0 || explorerMetrics !== null;
    }

    return {
        init,
        processServerInfo,
        processLedger,
        processLedgerClosed,
        setExplorerMetrics,
        saveCache,
        getAllStats,
        hasData,
        loadRemoteStats,
        getRecentTransactions,
        getDailyActiveWalletsHistory,
        getDailyActiveWalletsMulti,
        getTxVolumeHistory
    };
})();
