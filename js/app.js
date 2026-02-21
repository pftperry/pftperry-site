/* ============================================
   App Orchestrator
   Init sequence, VHS fetch, mock data, DOM updates
   ============================================ */

const App = (() => {
    const VHS_BASE = 'https://vhs.testnet.postfiat.org';
    const EXPLORER_API = 'https://explorer.testnet.postfiat.org/api/v1';
    const UPDATE_INTERVAL = 5000;
    let updateTimer = null;
    let usingMockData = false;
    let nodesData = null;
    let validatorsData = [];   // Array of validator objects from VHS
    let validatorLookup = {};  // signing_key -> { domain, ... }
    let mockFeedInterval = null;

    // ---- Mock Data ----
    function getMockStats() {
        const today = new Date().toISOString().slice(0, 10);
        const history = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            history.push({
                date: d.toISOString().slice(0, 10),
                count: Math.floor(Math.random() * 40 + 15 + (30 - i) * 1.5)
            });
        }
        const txHistory = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            txHistory.push({
                date: d.toISOString().slice(0, 10),
                count: Math.floor(Math.random() * 300 + 100 + (30 - i) * 5)
            });
        }

        // Build 7-day DAW by-day data for new chart format
        const dawByDay = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            dawByDay.push({
                date: d.toISOString().slice(0, 10),
                count: Math.floor(Math.random() * 30 + 15)
            });
        }

        // Build multi-line DAW history (kept for backwards compat)
        const dawHistoryMulti = history.map((h, i) => {
            const day1 = h.count;
            const set7 = history.slice(Math.max(0, i - 6), i + 1);
            const day7 = Math.min(day1 + Math.floor(Math.random() * 30 + 20), set7.reduce((s, x) => s + x.count, 0));
            const set30 = history.slice(Math.max(0, i - 29), i + 1);
            const day30 = Math.min(day7 + Math.floor(Math.random() * 50 + 30), set30.reduce((s, x) => s + x.count, 0));
            return { date: h.date, day1, day7, day30 };
        });

        const aw1d = Math.floor(Math.random() * 30 + 25);
        const aw7d = aw1d + Math.floor(Math.random() * 30 + 20);
        const aw30d = aw7d + Math.floor(Math.random() * 50 + 30);

        return {
            dailyActiveWallets: aw1d,
            activeWallets1d: aw1d,
            activeWallets7d: aw7d,
            activeWallets30d: aw30d,
            tps: (Math.random() * 2 + 0.5).toFixed(2),
            totalAccounts: Math.floor(Math.random() * 200 + 150),
            avgFee: Math.floor(Math.random() * 50 + 10),
            ledgerInterval: (Math.random() * 2 + 3).toFixed(1),
            ledgerHeight: Math.floor(Math.random() * 100000 + 500000),
            avgTxnPerUser: (Math.random() * 5 + 2).toFixed(1),
            peakHour: `${String(Math.floor(Math.random() * 24)).padStart(2, '0')}:00 UTC`,
            txTypeDistribution: {
                'Payment': Math.floor(Math.random() * 200 + 100),
                'TrustSet': Math.floor(Math.random() * 80 + 20),
                'OfferCreate': Math.floor(Math.random() * 40 + 10),
                'AccountSet': Math.floor(Math.random() * 30 + 5),
                'Memo': Math.floor(Math.random() * 60 + 15)
            },
            dawHistory: history,
            dawHistoryMulti: dawHistoryMulti,
            dawByDay: dawByDay,
            txVolHistory: txHistory.slice(-7),
            retention: {
                day7: '--',
                day7numeric: 0,
                day30: '--',
                day30numeric: 0
            },
            recentTxns: generateMockTxns(20)
        };
    }

    function generateMockTxns(count) {
        const types = ['Payment', 'TrustSet', 'OfferCreate', 'AccountSet', 'Payment', 'Payment'];
        const txns = [];
        for (let i = 0; i < count; i++) {
            txns.push({
                type: types[Math.floor(Math.random() * types.length)],
                account: 'r' + randomHex(24),
                hash: randomHex(64),
                fee: Math.floor(Math.random() * 100 + 10),
                amount: Math.random() > 0.5 ? String(Math.floor(Math.random() * 1000000)) : undefined,
                time: Date.now() - Math.floor(Math.random() * 300000)
            });
        }
        return txns.sort((a, b) => b.time - a.time);
    }

    function randomHex(len) {
        const chars = '0123456789abcdef';
        let s = '';
        for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
        return s;
    }

    // ---- DOM Updates ----
    function updateMetricEl(id, value, format) {
        const el = document.getElementById(id);
        if (!el) return;

        let displayValue = value;
        if (format === 'number') displayValue = formatNumber(value);
        else if (format === 'tps') displayValue = Number(value).toFixed(2);
        else if (format === 'fee') displayValue = formatFee(value);
        else if (format === 'interval') displayValue = Number(value).toFixed(1) + 's';

        if (el.textContent !== String(displayValue)) {
            el.textContent = displayValue;
            // Trigger glow animation on parent card
            const card = el.closest('.metric-card');
            if (card) {
                card.classList.remove('updated');
                void card.offsetWidth; // force reflow
                card.classList.add('updated');
            }
        }
    }

    function formatNumber(n) {
        if (n === undefined || n === null || n === '--') return '--';
        n = Number(n);
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toLocaleString();
    }

    function formatFee(drops) {
        if (!drops || drops === '--') return '--';
        drops = Number(drops);
        if (drops >= 1000000) return (drops / 1000000).toFixed(4) + ' XRP';
        return drops.toLocaleString() + ' drops';
    }

    function updateDashboard(stats) {
        updateMetricEl('metric-fee', stats.avgFee, 'fee');
        updateMetricEl('metric-interval', stats.ledgerInterval, 'interval');
        updateMetricEl('metric-height', stats.ledgerHeight, 'number');
        updateMetricEl('metric-txnuser', stats.avgTxnPerUser, 'tps');
        updateMetricEl('metric-peakhour', stats.peakHour);

        // Update charts
        DashboardCharts.update(stats);

        // Update live feed
        updateLiveFeed(stats.recentTxns);

        // Update last updated
        const lastUpdated = document.getElementById('last-updated');
        if (lastUpdated) {
            lastUpdated.textContent = new Date().toLocaleTimeString('en-US', {
                hour12: false, timeZone: 'UTC'
            }) + ' UTC';
        }
    }

    function updateLiveFeed(txns) {
        const feed = document.getElementById('live-feed');
        if (!feed || !txns || txns.length === 0) return;

        const existingItems = feed.querySelectorAll('.feed-item');
        const existingHashes = new Set();
        existingItems.forEach(el => existingHashes.add(el.dataset.hash));

        // Only add new transactions
        const newTxns = txns.filter(tx => !existingHashes.has(tx.hash));

        if (newTxns.length === 0 && existingItems.length > 0) return;

        // Clear placeholder
        const placeholder = feed.querySelector('.feed-placeholder');
        if (placeholder) placeholder.remove();

        newTxns.forEach(tx => {
            const item = document.createElement('div');
            item.className = 'feed-item';
            item.dataset.hash = tx.hash;

            const typeClass = getTypeClass(tx.type);
            const shortAccount = tx.account ? tx.account.slice(0, 8) + '...' + tx.account.slice(-4) : '???';
            const amount = tx.amount ? formatFeedAmount(tx.amount) : '';
            const timeStr = tx.time ? new Date(tx.time).toLocaleTimeString('en-US', {
                hour12: false, timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit'
            }) : '';

            item.innerHTML = `
                <span class="feed-type ${typeClass}">${tx.type}</span>
                <span class="feed-account">${shortAccount}</span>
                ${amount ? `<span class="feed-amount">${amount}</span>` : ''}
                <span class="feed-time">${timeStr}</span>
            `;

            feed.insertBefore(item, feed.firstChild);
        });

        // Limit feed items
        while (feed.children.length > 100) {
            feed.removeChild(feed.lastChild);
        }
    }

    function getTypeClass(type) {
        if (!type) return 'other';
        const t = type.toLowerCase();
        if (t.includes('payment')) return 'payment';
        if (t.includes('trust')) return 'trustset';
        if (t.includes('offer')) return 'offer';
        return 'other';
    }

    function formatFeedAmount(amount) {
        if (typeof amount === 'object') {
            return `${Number(amount.value).toFixed(2)} ${amount.currency}`;
        }
        const xrp = Number(amount) / 1000000;
        if (xrp > 0) return xrp.toFixed(2) + ' XRP';
        return '';
    }

    // ---- Node Grid ----
    function resolveNodeName(node) {
        // Check if this node's public key matches a validator's signing_key
        const pubKey = node.node_public_key || '';
        const validator = validatorLookup[pubKey];
        if (validator && validator.domain) {
            return validator.domain;
        }
        // Fallback: city, country_code
        if (node.city && node.country_code) {
            return node.city + ', ' + node.country_code;
        }
        if (node.city) return node.city;
        if (node.country_code) return node.country_code;
        // Last resort
        return pubKey ? pubKey.slice(0, 12) + '...' : 'Node';
    }

    function updateNodeGrid(nodes) {
        const grid = document.getElementById('node-grid');
        if (!grid) return;

        if (!nodes || nodes.length === 0) {
            grid.innerHTML = '<div class="node-placeholder">No node data available</div>';
            return;
        }

        grid.innerHTML = '';
        nodes.forEach(node => {
            const card = document.createElement('div');
            card.className = 'node-card';
            const statusClass = node.uptime ? 'online' : 'offline';
            const nodeName = resolveNodeName(node);
            const serverState = node.server_state ? 'State: ' + node.server_state : '';
            card.innerHTML = `
                <div class="node-name"><span class="node-status ${statusClass}"></span>${nodeName}</div>
                <div class="node-detail">${node.version || 'Unknown version'}</div>
                ${serverState ? `<div class="node-detail">${serverState}</div>` : ''}
                <div class="node-detail">${node.uptime ? 'Uptime: ' + formatUptime(node.uptime) : ''}</div>
            `;
            grid.appendChild(card);
        });
    }

    function updateValidatorGrid(validators) {
        const grid = document.getElementById('node-grid');
        if (!grid) return;

        if (!validators || validators.length === 0) {
            grid.innerHTML = '<div class="node-placeholder">No validator data available</div>';
            return;
        }

        grid.innerHTML = '';
        // Sort by 24h agreement score descending, with our validator pinned first
        const sorted = [...validators].sort((a, b) => {
            const aIsMine = a.domain === 'validator.pftperry.com';
            const bIsMine = b.domain === 'validator.pftperry.com';
            if (aIsMine) return -1;
            if (bIsMine) return 1;
            const aScore = a.agreement_24h ? parseFloat(a.agreement_24h.score) : 0;
            const bScore = b.agreement_24h ? parseFloat(b.agreement_24h.score) : 0;
            return bScore - aScore;
        });
        sorted.forEach(v => {
            const card = document.createElement('div');
            const isMine = v.domain === 'validator.pftperry.com';
            card.className = 'node-card' + (isMine ? ' my-validator' : '');

            // Use agreement_24h score to determine online status
            const score24h = v.agreement_24h ? parseFloat(v.agreement_24h.score) : 0;
            const statusClass = score24h > 0.5 ? 'online' : 'offline';

            // Display domain if available, otherwise truncated validation_public_key
            const name = v.domain || (v.validation_public_key ? v.validation_public_key.slice(0, 12) + '...' : 'Validator');

            const version = v.server_version ? 'v' + v.server_version : '';
            const agreement = score24h > 0 ? (score24h * 100).toFixed(1) + '% (24h)' : '';
            const unl = v.unl === 'rpc' ? ' [UNL]' : '';

            card.innerHTML = `
                <div class="node-name"><span class="node-status ${statusClass}"></span>${name}${unl}</div>
                ${version ? `<div class="node-detail">${version}</div>` : ''}
                ${agreement ? `<div class="node-detail">Agreement: ${agreement}</div>` : ''}
            `;
            grid.appendChild(card);
        });
    }

    function formatUptime(seconds) {
        if (!seconds) return '--';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
        return h + 'h ' + m + 'm';
    }

    function updateValidatorCards(v) {
        if (!v) return;
        // Agreement 24H — number first, then label
        const score24 = v.agreement_24h ? (parseFloat(v.agreement_24h.score) * 100).toFixed(2) + '%' : '--';
        updateMetricEl('metric-agreement', score24);
        // Agreement 30D — number first, then label
        const score30 = v.agreement_30day ? (parseFloat(v.agreement_30day.score) * 100).toFixed(2) + '%' : '--';
        updateMetricEl('metric-agreement-30d', score30);
        // Missed validations (30D)
        const missed = v.agreement_30day ? Number(v.agreement_30day.missed).toLocaleString() : '--';
        updateMetricEl('metric-missed', missed);
        // Total validations (30D)
        const total = v.agreement_30day ? Number(v.agreement_30day.total).toLocaleString() : '--';
        updateMetricEl('metric-total', total);
    }

    // ---- VHS API ----
    async function fetchVHS() {
        // Fetch validators first to build lookup and populate grid
        await fetchWithFallback(
            VHS_BASE + '/v1/network/validators/test',
            (data) => {
                const validators = data.validators || data;
                if (Array.isArray(validators)) {
                    console.log(`[VHS] Loaded ${validators.length} validators`);
                    validatorsData = validators;
                    validatorLookup = {};
                    validators.forEach(v => {
                        if (v.signing_key) {
                            validatorLookup[v.signing_key] = {
                                domain: v.domain || '',
                                server_version: v.server_version || ''
                            };
                        }
                    });
                    updateValidatorGrid(validators);
                    // Find our validator and update top cards
                    const myValidator = validators.find(v => v.domain === 'validator.pftperry.com');
                    updateValidatorCards(myValidator);
                }
            }
        );

        // Fetch topology nodes (for supplementary data)
        await fetchWithFallback(
            VHS_BASE + '/v1/network/topology/nodes/test',
            (data) => {
                const nodes = data.nodes || data;
                if (Array.isArray(nodes) && nodes.length > 0) {
                    nodesData = nodes;
                    console.log(`[VHS] Loaded ${nodes.length} topology nodes`);
                }
            }
        );

        // Fetch explorer metrics for TPS data
        await fetchWithFallback(
            EXPLORER_API + '/metrics',
            (data) => {
                if (data.txn_sec) {
                    MetricsEngine.setExplorerMetrics(data);
                    console.log(`[Explorer] Metrics loaded: TPS=${data.txn_sec}, interval=${data.ledger_interval}`);
                }
            }
        );
    }

    async function fetchWithFallback(url, onSuccess) {
        const corsProxies = [
            '',  // Direct first
            'https://corsproxy.io/?'
        ];

        for (const proxy of corsProxies) {
            try {
                const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;
                const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(10000) });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data) {
                        onSuccess(data);
                        return true;
                    }
                }
            } catch (e) {
                console.log(`[Fetch] ${url} failed (proxy: ${proxy || 'direct'}):`, e.message);
            }
        }
        return false;
    }

    // ---- Clock ----
    function startClock() {
        function tick() {
            const el = document.getElementById('live-clock');
            if (el) {
                el.textContent = new Date().toLocaleTimeString('en-US', {
                    hour12: false, timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit'
                }) + ' UTC';
            }
        }
        tick();
        setInterval(tick, 1000);
    }

    // ---- Connection Status ----
    function setConnectionStatus(status) {
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        const badge = document.getElementById('api-badge');

        if (dot) {
            dot.className = 'status-dot ' + status;
        }
        if (text) {
            const labels = {
                connected: 'CONNECTED',
                connecting: 'CONNECTING',
                disconnected: 'DISCONNECTED',
                mock: 'DEMO MODE'
            };
            text.textContent = labels[status] || 'UNKNOWN';
        }
        if (badge) {
            if (status === 'connected') {
                badge.classList.add('hidden');
                usingMockData = false;
                if (mockFeedInterval) {
                    clearInterval(mockFeedInterval);
                    mockFeedInterval = null;
                }
            } else if (status === 'mock') {
                badge.textContent = 'DEMO MODE — LIVE DATA UNAVAILABLE';
                badge.classList.remove('hidden');
            } else if (status === 'connecting') {
                badge.textContent = 'API CONNECTING...';
                badge.classList.remove('hidden');
            }
        }
    }

    // ---- Mock data feed simulation ----
    function startMockFeed() {
        if (mockFeedInterval) return;
        mockFeedInterval = setInterval(() => {
            const txns = generateMockTxns(Math.floor(Math.random() * 3) + 1);
            updateLiveFeed(txns);
        }, 4000);
    }

    // ---- Init ----
    async function init() {
        console.log('[App] Initializing PFT Perry Dashboard...');

        // Start visual effects
        ParticleBackground.init();
        startClock();

        // Init metrics & charts
        MetricsEngine.init();
        await MetricsEngine.loadRemoteStats();
        DashboardCharts.init();

        // Show dashboard, hide splash
        setTimeout(() => {
            const splash = document.getElementById('splash-fallback');
            const dashboard = document.getElementById('dashboard');
            if (splash) splash.classList.add('hidden');
            if (dashboard) dashboard.classList.add('visible');
        }, 500);

        // Connect WebSocket
        WebSocketManager.onConnection(setConnectionStatus);

        WebSocketManager.onLedger((type, data) => {
            if (type === 'server_info') {
                MetricsEngine.processServerInfo(data);
            } else if (type === 'ledger') {
                MetricsEngine.processLedger(data);
            } else if (type === 'ledgerClosed') {
                MetricsEngine.processLedgerClosed(data);
            }

            // Update dashboard with real data
            const stats = MetricsEngine.getAllStats();
            updateDashboard(stats);
        });

        WebSocketManager.connect();

        // Fetch VHS data
        fetchVHS();

        // Fallback to mock data after 10 seconds if no WS connection
        setTimeout(() => {
            if (!WebSocketManager.isConnected() && !MetricsEngine.hasData()) {
                console.log('[App] No live data, switching to demo mode');
                usingMockData = true;
                setConnectionStatus('mock');
                const mockStats = getMockStats();
                updateDashboard(mockStats);
                startMockFeed();
            }
        }, 10000);

        // Periodic refresh
        updateTimer = setInterval(() => {
            if (usingMockData) {
                // Slightly mutate mock data for realism
                const stats = getMockStats();
                updateDashboard(stats);
            } else if (MetricsEngine.hasData()) {
                const stats = MetricsEngine.getAllStats();
                updateDashboard(stats);
            }
        }, UPDATE_INTERVAL);

        // Re-fetch VHS/explorer data every 2 minutes
        setInterval(fetchVHS, 120000);
    }

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init };
})();
