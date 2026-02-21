/* ============================================
   WebSocket Connection Manager
   Connects to rippled node for real-time data
   ============================================ */

const WebSocketManager = (() => {
    const ENDPOINTS = [
        'wss://ws.devnet.postfiat.org',
        'wss://ws.devnet.postfiat.org:6006',
        'wss://ws.devnet.postfiat.org:2559'
    ];

    let ws = null;
    let currentEndpoint = 0;
    let reconnectTimer = null;
    let reconnectDelay = 2000;
    let isConnected = false;
    let requestId = 0;
    let pendingRequests = {};
    let onLedgerCallback = null;
    let onConnectionChange = null;

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const url = ENDPOINTS[currentEndpoint];
        console.log(`[WS] Connecting to ${url}...`);
        updateStatus('connecting');

        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.error('[WS] Connection error:', e);
            tryNextEndpoint();
            return;
        }

        ws.onopen = () => {
            console.log(`[WS] Connected to ${url}`);
            isConnected = true;
            reconnectDelay = 2000;
            updateStatus('connected');

            // Subscribe to ledger stream
            send({ command: 'subscribe', streams: ['ledger'] });

            // Get server info
            sendRequest({ command: 'server_info' }).then(resp => {
                if (resp && resp.result && resp.result.info) {
                    if (onLedgerCallback) {
                        onLedgerCallback('server_info', resp.result.info);
                    }
                }
            }).catch(() => {});

            // Get latest validated ledger with transactions
            sendRequest({ command: 'ledger', ledger_index: 'validated', transactions: true, expand: true })
                .then(resp => {
                    if (resp && resp.result && resp.result.ledger) {
                        if (onLedgerCallback) {
                            onLedgerCallback('ledger', resp.result.ledger);
                        }
                    }
                }).catch(() => {});
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle pending request responses
                if (data.id && pendingRequests[data.id]) {
                    pendingRequests[data.id].resolve(data);
                    delete pendingRequests[data.id];
                    return;
                }

                // Handle ledger stream
                if (data.type === 'ledgerClosed') {
                    if (onLedgerCallback) {
                        onLedgerCallback('ledgerClosed', data);
                    }
                    // Fetch full ledger with transactions
                    sendRequest({
                        command: 'ledger',
                        ledger_index: data.ledger_index,
                        transactions: true,
                        expand: true
                    }).then(resp => {
                        if (resp && resp.result && resp.result.ledger) {
                            if (onLedgerCallback) {
                                onLedgerCallback('ledger', resp.result.ledger);
                            }
                        }
                    }).catch(() => {});
                }
            } catch (e) {
                console.error('[WS] Parse error:', e);
            }
        };

        ws.onclose = () => {
            console.log('[WS] Connection closed');
            isConnected = false;
            updateStatus('disconnected');
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[WS] Error:', err);
            ws.close();
        };
    }

    function send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    function sendRequest(data) {
        return new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected'));
                return;
            }
            const id = ++requestId;
            data.id = id;
            pendingRequests[id] = { resolve, reject };
            ws.send(JSON.stringify(data));

            // Timeout after 15s
            setTimeout(() => {
                if (pendingRequests[id]) {
                    pendingRequests[id].reject(new Error('Request timeout'));
                    delete pendingRequests[id];
                }
            }, 15000);
        });
    }

    function tryNextEndpoint() {
        currentEndpoint = (currentEndpoint + 1) % ENDPOINTS.length;
        scheduleReconnect();
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
            connect();
        }, reconnectDelay);
    }

    function updateStatus(status) {
        if (onConnectionChange) {
            onConnectionChange(status);
        }
    }

    function onLedger(callback) {
        onLedgerCallback = callback;
    }

    function onConnection(callback) {
        onConnectionChange = callback;
    }

    function getServerInfo() {
        return sendRequest({ command: 'server_info' });
    }

    function getLedgerData(marker) {
        const req = { command: 'ledger_data', ledger_index: 'validated', limit: 256 };
        if (marker) req.marker = marker;
        return sendRequest(req);
    }

    function getIsConnected() {
        return isConnected;
    }

    return {
        connect,
        onLedger,
        onConnection,
        sendRequest,
        getServerInfo,
        getLedgerData,
        isConnected: getIsConnected
    };
})();
