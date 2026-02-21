/* ============================================
   Chart.js Chart Creation & Updates
   Dark cyberpunk theme
   ============================================ */

const DashboardCharts = (() => {
    let dawChart = null;
    let txVolChart = null;
    let retentionChart = null;
    let txTypeChart = null;

    // Cyberpunk color palette
    const COLORS = {
        cyan: '#00f0ff',
        cyanAlpha: 'rgba(0, 240, 255, 0.2)',
        purple: '#7b2dff',
        purpleAlpha: 'rgba(123, 45, 255, 0.2)',
        green: '#00ff88',
        greenAlpha: 'rgba(0, 255, 136, 0.2)',
        pink: '#ff3366',
        pinkAlpha: 'rgba(255, 51, 102, 0.2)',
        yellow: '#ffaa00',
        yellowAlpha: 'rgba(255, 170, 0, 0.2)',
        gridColor: 'rgba(0, 240, 255, 0.06)',
        tickColor: 'rgba(224, 232, 255, 0.4)'
    };

    const TYPE_COLORS = [
        COLORS.cyan, COLORS.purple, COLORS.green,
        COLORS.pink, COLORS.yellow, '#00ccff', '#ff66aa'
    ];

    // Common chart options
    function baseOptions(showXTime) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 800,
                easing: 'easeOutQuart'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(10, 14, 23, 0.95)',
                    titleFont: { family: 'Orbitron', size: 10, weight: '600' },
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                    borderColor: COLORS.cyan,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 4,
                    titleColor: COLORS.cyan,
                    bodyColor: '#e0e8ff'
                }
            },
            scales: {
                x: {
                    type: showXTime ? 'time' : 'category',
                    ...(showXTime ? { time: { unit: 'day', tooltipFormat: 'MMM d' } } : {}),
                    grid: { color: COLORS.gridColor, drawBorder: false },
                    ticks: {
                        color: COLORS.tickColor,
                        font: { family: 'JetBrains Mono', size: 9 },
                        maxRotation: 0
                    },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: COLORS.gridColor, drawBorder: false },
                    ticks: {
                        color: COLORS.tickColor,
                        font: { family: 'JetBrains Mono', size: 9 }
                    },
                    border: { display: false }
                }
            }
        };
    }

    function init() {
        createDAWChart([]);
        createTxVolChart([]);
        createRetentionChart({ day1: 0, day7: 0, day30: 0 });
        createTxTypeChart({});
    }

    // Plugin to show "Waiting on data..." when chart has no data
    const noDataPlugin = {
        id: 'noDataMessage',
        afterDraw(chart) {
            const datasets = chart.data.datasets;
            const hasData = datasets.some(ds => ds.data && ds.data.some(v => v > 0));
            if (!hasData) {
                const { ctx, width, height } = chart;
                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = '12px "JetBrains Mono", monospace';
                ctx.fillStyle = COLORS.tickColor;
                ctx.fillText('Waiting on data\u2026', width / 2, height / 2);
                ctx.restore();
            }
        }
    };

    function dawDatasets(data) {
        // Only include datasets that have real data (any value > 0)
        const sets = [];
        const has1D = data.some(d => (d.day1 || d.count || 0) > 0);
        const has7D = data.some(d => (d.day7 || 0) > 0);
        const has30D = data.some(d => (d.day30 || 0) > 0);

        if (has1D) sets.push({
            label: '1D',
            data: data.map(d => d.day1 || d.count || 0),
            backgroundColor: COLORS.cyanAlpha,
            borderColor: COLORS.cyan,
            borderWidth: 1, borderRadius: 3, borderSkipped: false
        });
        if (has7D) sets.push({
            label: '7D',
            data: data.map(d => d.day7 || 0),
            backgroundColor: COLORS.purpleAlpha,
            borderColor: COLORS.purple,
            borderWidth: 1, borderRadius: 3, borderSkipped: false
        });
        if (has30D) sets.push({
            label: '30D',
            data: data.map(d => d.day30 || 0),
            backgroundColor: COLORS.greenAlpha,
            borderColor: COLORS.green,
            borderWidth: 1, borderRadius: 3, borderSkipped: false
        });

        return sets;
    }

    function createDAWChart(data) {
        const ctx = document.getElementById('chart-daw');
        if (!ctx) return;

        dawChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(d => d.date),
                datasets: dawDatasets(data)
            },
            plugins: [noDataPlugin],
            options: {
                ...baseOptions(false),
                plugins: {
                    ...baseOptions(false).plugins,
                    legend: {
                        display: true,
                        labels: {
                            color: COLORS.tickColor,
                            font: { family: 'JetBrains Mono', size: 10 },
                            usePointStyle: true,
                            pointStyleWidth: 8,
                            padding: 16
                        }
                    }
                }
            }
        });
    }

    function formatDateLabel(dateStr) {
        const d = new Date(dateStr + 'T00:00:00Z');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[d.getUTCMonth()] + ' ' + d.getUTCDate();
    }

    function createTxVolChart(data) {
        const ctx = document.getElementById('chart-txvol');
        if (!ctx) return;

        txVolChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => formatDateLabel(d.date)),
                datasets: [{
                    label: 'Transactions',
                    data: data.map(d => d.count),
                    borderColor: COLORS.purple,
                    backgroundColor: COLORS.purpleAlpha,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: COLORS.purple,
                    pointHoverRadius: 5
                }]
            },
            plugins: [noDataPlugin],
            options: baseOptions(false)
        });
    }

    function createRetentionChart(retention) {
        const ctx = document.getElementById('chart-retention');
        if (!ctx) return;

        const barColors = [COLORS.cyan, COLORS.purple, COLORS.green];

        retentionChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['1 Day', '7 Days', '30 Days'],
                datasets: [{
                    label: 'Active Users',
                    data: [retention.day1, retention.day7, retention.day30],
                    backgroundColor: [
                        COLORS.cyanAlpha,
                        COLORS.purpleAlpha,
                        COLORS.greenAlpha
                    ],
                    borderColor: barColors,
                    borderWidth: 1,
                    borderRadius: 4,
                    borderSkipped: false
                }]
            },
            plugins: [ChartDataLabels],
            options: {
                ...baseOptions(false),
                indexAxis: 'y',
                plugins: {
                    ...baseOptions(false).plugins,
                    legend: { display: false },
                    datalabels: {
                        display: true,
                        anchor: 'end',
                        align: 'right',
                        color: function(context) {
                            return barColors[context.dataIndex] || COLORS.cyan;
                        },
                        font: {
                            family: 'JetBrains Mono',
                            size: 11,
                            weight: '600'
                        },
                        formatter: function(value, context) {
                            if (value === 0 && context.dataIndex > 0) return 'Waiting on data\u2026';
                            return value + ' wallets';
                        }
                    }
                }
            }
        });
    }

    function createTxTypeChart(distribution) {
        const ctx = document.getElementById('chart-txtype');
        if (!ctx) return;

        const labels = Object.keys(distribution);
        const values = Object.values(distribution);

        txTypeChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels.length > 0 ? labels : ['No Data'],
                datasets: [{
                    data: values.length > 0 ? values : [1],
                    backgroundColor: labels.length > 0
                        ? labels.map((_, i) => TYPE_COLORS[i % TYPE_COLORS.length])
                        : ['rgba(0, 240, 255, 0.1)'],
                    borderColor: labels.length > 0
                        ? labels.map((_, i) => TYPE_COLORS[i % TYPE_COLORS.length])
                        : ['rgba(0, 240, 255, 0.3)'],
                    borderWidth: 1,
                    hoverOffset: 8
                }]
            },
            plugins: [ChartDataLabels],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '65%',
                animation: { duration: 800, easing: 'easeOutQuart' },
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: COLORS.tickColor,
                            font: { family: 'JetBrains Mono', size: 10 },
                            padding: 12,
                            usePointStyle: true,
                            pointStyleWidth: 8
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(10, 14, 23, 0.95)',
                        titleFont: { family: 'Orbitron', size: 10 },
                        bodyFont: { family: 'JetBrains Mono', size: 11 },
                        borderColor: COLORS.cyan,
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 4,
                        titleColor: COLORS.cyan,
                        bodyColor: '#e0e8ff'
                    },
                    datalabels: {
                        display: function(context) {
                            return context.dataset.data.length > 0 && context.dataset.data[0] !== 1;
                        },
                        color: '#ffffff',
                        font: {
                            family: 'JetBrains Mono',
                            size: 11,
                            weight: '600'
                        },
                        anchor: 'center',
                        align: 'center',
                        formatter: function(value, context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            if (total === 0) return '';
                            const pct = Math.round((value / total) * 100);
                            return pct + '%';
                        }
                    }
                }
            }
        });
    }

    function createGradient(ctx, color, alphaColor) {
        // For line chart fill gradient
        const canvas = ctx.getContext ? ctx : ctx.canvas || ctx;
        try {
            const context = canvas.getContext ? canvas.getContext('2d') : null;
            if (!context) return alphaColor;
            const gradient = context.createLinearGradient(0, 0, 0, 250);
            gradient.addColorStop(0, alphaColor);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            return gradient;
        } catch {
            return alphaColor;
        }
    }

    function update(stats) {
        const dawData = stats.dawHistoryMulti && stats.dawHistoryMulti.length > 0
            ? stats.dawHistoryMulti : stats.dawHistory;
        updateDAWChart(dawData);
        updateTxVolChart(stats.txVolHistory);
        updateRetentionChart(stats.retention);
        updateTxTypeChart(stats.txTypeDistribution);
    }

    function updateDAWChart(data) {
        if (!dawChart || !data) return;
        dawChart.data.labels = data.map(d => d.date);
        dawChart.data.datasets = dawDatasets(data);
        dawChart.update('none');
    }

    function updateTxVolChart(data) {
        if (!txVolChart || !data) return;
        txVolChart.data.labels = data.map(d => formatDateLabel(d.date));
        txVolChart.data.datasets[0].data = data.map(d => d.count);
        txVolChart.update('none');
    }

    function updateRetentionChart(retention) {
        if (!retentionChart || !retention) return;
        retentionChart.data.datasets[0].data = [retention.day1, retention.day7, retention.day30];
        retentionChart.update('none');
    }

    function updateTxTypeChart(distribution) {
        if (!txTypeChart || !distribution) return;
        const labels = Object.keys(distribution);
        const values = Object.values(distribution);
        if (labels.length === 0) return;

        txTypeChart.data.labels = labels;
        txTypeChart.data.datasets[0].data = values;
        txTypeChart.data.datasets[0].backgroundColor = labels.map((_, i) => TYPE_COLORS[i % TYPE_COLORS.length]);
        txTypeChart.data.datasets[0].borderColor = labels.map((_, i) => TYPE_COLORS[i % TYPE_COLORS.length]);
        txTypeChart.update('none');
    }

    return { init, update };
})();
