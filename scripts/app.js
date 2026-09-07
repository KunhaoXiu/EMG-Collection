// ==================== 配置 ====================
const CONFIG = {
    BAUDRATE: 921600,
    FRAME_LEN: 29,
    FRAME_HEADER: 0xD2,
    PKT_EMG: 0xAA,
    PKT_IMU: 0xBB,
    EMG_CHANNELS: 8,
    GYRO_SCALE: 0.0012,       // rad/s
    ACC_SCALE: 0.0005978,     // m/s²
    EMG_MAX_POINTS: 6000,
    IMU_MAX_POINTS: 1000,
    LOG_MAX_LINES: 100,
    LOG_THROTTLE: 50,
    NO_DATA_TIMEOUT_MS: 3000,   // 连接后多久仍无数据就警告"设备可能未开机"
    RECORD_FLUSH_MS: 500,       // 定时刷盘间隔
    RECORD_FLUSH_MAX: 2000      // 缓冲达到该行数立即刷盘（安全阀）
};

const EMG_COLORS = ['#ef4444','#f97316','#f59e0b','#22c55e','#14b8a6','#0ea5e9','#8b5cf6','#ec4899'];
const IMU_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6'];

const DATE_FMT = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
});
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
});

// ==================== 状态 ====================
const state = {
    isPaused: false,
    isRecording: false,
    frameCount: 0,
    recordedCount: 0,
    errorCount: 0,
    emgFps: 0,
    imuFps: 0,
    emgCounter: 0,
    imuCounter: 0,
    lastFrameTime: performance.now(),
    connectStartTime: null,
    recordStartTime: null,
    currentTheme: 'dark',
    latestEmg: null,
    latestImu: null,
    uiDirty: false,
    logThrottle: 0,
    durationTimerId: null,
    recordFrozenMs: 0,
    zoomType: null,
    zoomIdx: null,
    zoomChart: null,
    // ==================== 边采边写盘（File System Access API）====================
    // 记录时不再把全量数据囤在 history，而是把每行格式化后批量追加写入磁盘文件。
    recordBuffer: [],           // 待写盘的已格式化 CSV 行
    recordFlushTimer: null,     // 定时刷盘句柄
    recordWritable: null,       // FileSystemWritableFileStream（非 null = 正在写盘记录）
    recordFileName: null,       // 当前记录文件名
    recordFlushing: false       // 刷盘在途标志，保证追加顺序、避免并发
};

// DOM 引用缓存（在 DOM 构建完成后填充）
const dom = {};

// ==================== 工具函数 ====================
function fmtPart(parts, type) {
    return parts.find(p => p.type === type)?.value || '00';
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// 记录时间戳精度到秒：同一秒内复用上次格式化结果，避免每个包都跑 Intl.formatToParts（记录热点）
let _wtCacheSec = -1, _wtCacheStr = '';
function formatWorldTime() {
    const ms = performance.timeOrigin + performance.now();
    const sec = Math.floor(ms / 1000);
    if (sec !== _wtCacheSec) {
        const parts = DATE_FMT.formatToParts(new Date(ms));
        _wtCacheStr = `${fmtPart(parts,'year')}-${fmtPart(parts,'month')}-${fmtPart(parts,'day')}-${fmtPart(parts,'hour')}-${fmtPart(parts,'minute')}-${fmtPart(parts,'second')}`;
        _wtCacheSec = sec;
    }
    return _wtCacheStr;
}

function formatBeijingClock(ms) {
    const parts = TIME_FMT.formatToParts(new Date(ms));
    const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
    return `${fmtPart(parts,'hour')}:${fmtPart(parts,'minute')}:${fmtPart(parts,'second')}.${cs}`;
}

function fmtNum(v, p) {
    return (typeof v === 'number' && !isNaN(v)) ? v.toFixed(p) : 'NaN';
}

// ==================== 图表 ====================
class LineChart {
    constructor(canvasOrId, colors, maxPoints = 300, yPrecision = 1, opts = {}) {
        this.canvas = typeof canvasOrId === 'string' ? document.getElementById(canvasOrId) : canvasOrId;
        this.ctx = this.canvas.getContext('2d');
        this.colors = colors;
        this.maxPoints = maxPoints;
        this.lines = colors.map(c => ({
            color: c,
            data: new Array(maxPoints),
            head: 0,
            count: 0
        }));
        this.yPrecision = yPrecision;
        this.pad = opts.pad || {top: 8, right: 6, bottom: 18, left: 32};
        this.lineWidth = opts.lineWidth || 1.2;
        this.showGrid = !!opts.showGrid;
        this.yTicks = opts.yTicks ?? 3;
        this.xTicks = opts.xTicks ?? 0;
        this.yFont = opts.yFont || '11px monospace';
        this.tickFont = opts.tickFont || '11px monospace';
        this.xTickRenderer = opts.xTickRenderer || null;
        this.resize();
        this._resizeHandler = () => this.resize();
        window.addEventListener('resize', this._resizeHandler);
    }
    destroy() {
        window.removeEventListener('resize', this._resizeHandler);
    }
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = rect.width;
        this.height = rect.height;
    }
    addPoint(values) {
        if (state.isPaused) return;
        const N = this.maxPoints;
        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            line.data[line.head] = values[i];
            line.head = (line.head + 1) % N;
            if (line.count < N) line.count++;
        }
    }
    clear() {
        for (const l of this.lines) {
            l.data = new Array(this.maxPoints);
            l.head = 0;
            l.count = 0;
        }
    }
    draw() {
        const ctx = this.ctx, w = this.width, h = this.height, N = this.maxPoints;
        const isLight = document.body.classList.contains('light-theme');
        ctx.clearRect(0, 0, w, h);

        // Y 轴范围：按与点数解耦的跳点采样求 min/max（避免长时间采集后全量扫描拖慢每帧）
        let min = Infinity, max = -Infinity;
        for (const l of this.lines) {
            const data = l.data, count = l.count;
            if (count === 0) continue;
            const base = count < N ? 0 : l.head;
            const scanStride = Math.max(1, Math.floor(count / (w * 2)));
            for (let i = 0; i < count; i += scanStride) {
                const v = data[(base + i) % N];
                if (isFinite(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }
        }
        if (!isFinite(min) || min === max) { min = -1; max = 1; }
        const range = max - min;

        // 根据刻度文字宽度动态调整左侧留白
        ctx.font = this.yFont;
        const textW = ctx.measureText(max.toFixed(this.yPrecision)).width + 10;
        const pad = {
            top: this.pad.top,
            right: this.pad.right,
            bottom: this.pad.bottom,
            left: Math.max(this.pad.left, textW)
        };
        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        // 网格
        if (this.showGrid) {
            ctx.strokeStyle = isLight ? '#e2e8f0' : '#1e293b';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i <= this.yTicks; i++) {
                const y = pad.top + plotH * i / this.yTicks;
                ctx.moveTo(pad.left, y);
                ctx.lineTo(w - pad.right, y);
            }
            if (this.xTicks > 1) {
                for (let i = 0; i < this.xTicks; i++) {
                    const x = pad.left + plotW * (i / (this.xTicks - 1));
                    ctx.moveTo(x, pad.top);
                    ctx.lineTo(x, h - pad.bottom);
                }
            }
            ctx.stroke();
        }

        // 坐标轴
        ctx.strokeStyle = isLight ? '#64748b' : '#cbd5e1';
        ctx.lineWidth = this.showGrid ? 2 : 1;
        ctx.beginPath();
        const bottomY = h - pad.bottom;
        ctx.moveTo(pad.left, bottomY);
        ctx.lineTo(w - pad.right, bottomY);
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, bottomY);
        ctx.stroke();

        // Y 刻度
        ctx.fillStyle = isLight ? '#334155' : '#ffffff';
        ctx.textAlign = 'right';
        for (let i = 0; i <= this.yTicks; i++) {
            const val = max - range * i / this.yTicks;
            ctx.fillText(val.toFixed(this.yPrecision), pad.left - 4, pad.top + plotH * i / this.yTicks + 3);
        }

        // X 刻度（自定义渲染器）
        if (this.xTickRenderer && this.xTicks > 1) {
            for (let i = 0; i < this.xTicks; i++) {
                const ratio = i / (this.xTicks - 1);
                this.xTickRenderer(ctx, w, h, pad, ratio, i, this);
            }
        }

        // 波形（点数远多于像素时按步长跳点）
        for (const line of this.lines) {
            const data = line.data, count = line.count;
            if (count < 2) continue;
            const base = count < N ? 0 : line.head;
            ctx.strokeStyle = line.color;
            ctx.lineWidth = this.lineWidth;
            ctx.beginPath();
            const stride = Math.max(1, Math.floor(count / (plotW * 2)));
            let first = true;
            for (let i = 0; i < count; i += stride) {
                const v = data[(base + i) % N];
                const x = pad.left + plotW * (i / (N - 1));
                const y = pad.top + plotH * (1 - (v - min) / range);
                if (first) { ctx.moveTo(x, y); first = false; }
                else ctx.lineTo(x, y);
            }
            // 确保最后一点画到
            const lastI = count - 1;
            if (lastI % stride !== 0) {
                const v = data[(base + lastI) % N];
                const x = pad.left + plotW * (lastI / (N - 1));
                const y = pad.top + plotH * (1 - (v - min) / range);
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    }
}

// ==================== 构建 EMG 面板 ====================
function buildEmgPanels() {
    const top = document.getElementById('row-emg-top');
    const bot = document.getElementById('row-emg-bottom');
    for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
        const panel = document.createElement('div');
        panel.className = 'panel emg-panel';
        panel.style.setProperty('--ch', EMG_COLORS[i]);
        panel.innerHTML = `
            <div class="panel-header">
                <div class="panel-title"><span class="dot"></span>CH${i+1}</div>
                <button class="btn-icon" onclick="openZoom('emg', ${i})" title="放大">🔍</button>
            </div>
            <canvas id="canvas-emg-${i}"></canvas>
            <div class="data-grid emg-grid-vals" id="vals-emg-${i}"></div>
        `;
        (i < 4 ? top : bot).appendChild(panel);
    }
}

function createValueGrid(containerId, labels, colors) {
    const container = document.getElementById(containerId);
    labels.forEach((label, i) => {
        const div = document.createElement('div');
        div.className = 'data-cell';
        const labelEl = document.createElement('span');
        labelEl.className = 'label';
        if (colors && colors[i]) labelEl.style.color = colors[i];
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'value';
        valueEl.id = `${containerId}-v${i}`;
        valueEl.textContent = '--';
        div.appendChild(labelEl);
        div.appendChild(valueEl);
        container.appendChild(div);
    });
}

function cacheValueRefs() {
    dom.emgVals = [];
    for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
        dom.emgVals.push(document.getElementById(`vals-emg-${i}-v0`));
    }
    dom.imuVals = [];
    for (let i = 0; i < 6; i++) {
        dom.imuVals.push(document.getElementById(`vals-imu-v${i}`));
    }
}

// ==================== 图表实例 ====================
let emgCharts, imuChart;

function initCharts() {
    emgCharts = [];
    for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
        emgCharts.push(new LineChart(`canvas-emg-${i}`, [EMG_COLORS[i]], CONFIG.EMG_MAX_POINTS));
    }
    imuChart = new LineChart('canvas-imu', IMU_COLORS, CONFIG.IMU_MAX_POINTS, 3);
}

// ==================== 缩放模态框 ====================
function openZoom(type, idx) {
    let sourceChart, title, labels, colors;
    if (type === 'emg') {
        sourceChart = emgCharts[idx];
        title = `EMG CH${idx + 1}`;
        labels = [`CH${idx+1}`];
        colors = [EMG_COLORS[idx]];
    } else {
        sourceChart = imuChart;
        title = 'IMU 传感器';
        labels = ['Ax','Ay','Az','Gx','Gy','Gz'];
        colors = IMU_COLORS;
    }

    state.zoomType = type;
    state.zoomIdx = idx;

    document.getElementById('zoom-title').textContent = '🔍 ' + title;
    document.getElementById('zoom-modal').style.display = 'flex';

    const grid = document.getElementById('zoom-data-grid');
    grid.innerHTML = '';
    grid.className = 'zoom-data-grid ' + type;
    labels.forEach((label, i) => {
        const div = document.createElement('div');
        div.className = 'zoom-data-cell';
        div.innerHTML = `<span class="z-label" style="color:${colors[i]}">${label}</span><span class="z-value" id="zoom-v${i}">--</span>`;
        grid.appendChild(div);
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (state.zoomChart) state.zoomChart.destroy();
        const zoomCanvas = document.getElementById('zoom-canvas');
        state.zoomChart = new LineChart(zoomCanvas, sourceChart.colors, sourceChart.maxPoints, sourceChart.yPrecision, {
            pad: {top: 16, right: 16, bottom: 44, left: 56},
            lineWidth: 2,
            showGrid: true,
            yTicks: 4,
            xTicks: 6,
            yFont: 'bold 15px monospace',
            tickFont: 'bold 12px monospace',
            xTickRenderer: (ctx, w, h, pad, ratio, i, chart) => {
                const xAxisY = h - pad.bottom;
                const x = pad.left + (w - pad.left - pad.right) * ratio;
                const isLight = document.body.classList.contains('light-theme');
                ctx.strokeStyle = isLight ? '#94a3b8' : '#cbd5e1';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, xAxisY);
                ctx.lineTo(x, xAxisY + 6);
                ctx.stroke();
                const fps = Math.max(state.zoomType === 'emg' ? state.emgFps : state.imuFps, 1);
                const points = Math.max(2, ...chart.lines.map(l => l.count || 0));
                const secAgo = ((points - 1) / fps) * (1 - ratio);
                ctx.fillStyle = '#94a3b8';
                ctx.font = chart.tickFont;
                ctx.textAlign = 'center';
                ctx.fillText(formatBeijingClock(Date.now() - secAgo * 1000), x, xAxisY + 24);
            }
        });
        // 共享源图表数据
        state.zoomChart.lines = sourceChart.lines;
    }));
}

function closeZoom() {
    document.getElementById('zoom-modal').style.display = 'none';
    if (state.zoomChart) state.zoomChart.destroy();
    state.zoomChart = null;
    state.zoomType = null;
    state.zoomIdx = null;
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeZoom(); });

// ==================== 主题 ====================
function applyTheme(theme) {
    state.currentTheme = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-theme', state.currentTheme === 'light');
    const label = state.currentTheme === 'light' ? '暗色模式' : '浅色模式';
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = label;
    const splashBtn = document.getElementById('splash-theme-btn');
    if (splashBtn) splashBtn.textContent = label;
    localStorage.setItem('theme-preference', state.currentTheme);
}

function toggleTheme() {
    applyTheme(state.currentTheme === 'light' ? 'dark' : 'light');
}

// ==================== 时长定时器 ====================
function tickDuration() {
    const now = Date.now();
    dom.connDuration.textContent = state.connectStartTime ? formatDuration(now - state.connectStartTime) : '00:00:00';
    let recMs = state.recordFrozenMs;
    if (state.recordStartTime) recMs = now - state.recordStartTime;
    dom.recordDuration.textContent = formatDuration(recMs);
}

function startDurationTimer() {
    if (state.durationTimerId !== null) return;
    tickDuration();
    state.durationTimerId = setInterval(tickDuration, 1000);
}

function stopDurationTimer() {
    if (state.durationTimerId !== null) {
        clearInterval(state.durationTimerId);
        state.durationTimerId = null;
    }
}

// ==================== CSV 格式化（导出与写盘共用，保证格式一致）====================
function csvHeader() {
    const cols = ['time'];
    for (let i = 1; i <= CONFIG.EMG_CHANNELS; i++) cols.push(`emg${i}`);
    cols.push('imu_ax', 'imu_ay', 'imu_az', 'imu_gx', 'imu_gy', 'imu_gz');
    return cols.join(',') + '\n';
}

function frameToCsvRow(f) {
    const emgPart = f.emg.map(v => fmtNum(v, 2)).join(',');
    const imuPart = [...f.imu.accel, ...f.imu.gyro].map(v => fmtNum(v, 4)).join(',');
    return `${f.time},${emgPart},${imuPart}\n`;
}

// ==================== 记录落点（边采边写盘入缓冲）====================
function recordFrame(frame) {
    if (!state.recordWritable) return;   // 统一边采边写盘：无写盘流则不记录
    // 行入缓冲，由定时器批量落盘；不囤内存、无内存上限
    state.recordBuffer.push(frameToCsvRow(frame));
    state.recordedCount++;
    if (state.recordBuffer.length >= CONFIG.RECORD_FLUSH_MAX) flushRecordBuffer();
}

// ==================== 写盘缓冲管理 ====================
// 把缓冲写净；recordFlushing 保证同一时刻只有一个 write 在途（追加顺序正确、无并发）。
async function flushRecordBuffer() {
    if (state.recordFlushing || !state.recordBuffer.length || !state.recordWritable) return true;
    state.recordFlushing = true;
    try {
        while (state.recordBuffer.length) {
            const batch = state.recordBuffer.join('');
            state.recordBuffer.length = 0;
            try {
                await state.recordWritable.write(batch);
            } catch (e) {
                // 写失败：把这批数据放回缓冲头部，保留待重试，并上报失败
                state.recordBuffer.unshift(batch);
                addLog('debug', `⚠ 写盘失败: ${e.message || e}`);
                return false;
            }
        }
    } finally {
        state.recordFlushing = false;
    }
    return true;
}

// 收尾记录：停定时器 → 等在途刷盘结束 → 写净剩余 → 关闭文件 → 复位状态与按钮。可安全重复调用。
async function stopRecordingIfActive() {
    if (state.recordFlushTimer) { clearInterval(state.recordFlushTimer); state.recordFlushTimer = null; }
    if (!state.recordWritable) return null;            // 非写盘记录态，无事可做
    while (state.recordFlushing) { await new Promise(r => setTimeout(r, 10)); }
    await flushRecordBuffer();                          // 写净剩余
    const savedName = state.recordFileName;
    try { await state.recordWritable.close(); }         // 关闭流 → 浏览器最终落盘
    catch (e) { addLog('debug', `关闭记录文件失败: ${e.message || e}`); }
    state.recordBuffer.length = 0;
    state.recordWritable = null;
    state.recordFileName = null;
    state.isRecording = false;
    if (state.recordStartTime) {
        state.recordFrozenMs = Date.now() - state.recordStartTime;
        state.recordStartTime = null;
    }
    tickDuration();
    setRecordButtons(false);
    return savedName;
}

// ==================== 记录控制（开始 / 停止 成对）====================
// 切换记录按钮可用状态：记录中 → "开始记录"禁用、"停止记录"启用；反之亦然。
function setRecordButtons(recording) {
    if (dom.btnRecord) dom.btnRecord.disabled = recording || !serial.connected;
    if (dom.btnRecordStop) dom.btnRecordStop.disabled = !recording;
}

// 开始记录：用 File System Access API 边采边写盘（统一记录方式）。
async function startRecording() {
    if (state.isRecording) return;
    if (!serial.connected) { addLog('debug', '请先连接串口'); return; }
    if (!window.showSaveFilePicker) {
        addLog('debug', '⚠ 当前环境不支持边采边写盘，请通过 localhost 或 https 访问后再记录');
        return;
    }
    const filename = `emg_data_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;

    let handle;
    try {
        handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }]
        });
    } catch (e) {
        if (e?.name === 'AbortError') { addLog('debug', '已取消开始记录'); return; }
        addLog('debug', `选择保存文件失败: ${e.message || e}`);
        return;
    }
    try {
        const writable = await handle.createWritable();
        await writable.write('﻿' + csvHeader());  // UTF-8 BOM + 表头
        state.recordWritable = writable;
        state.recordFileName = handle.name;
    } catch (e) {
        addLog('debug', `创建记录文件失败: ${e.message || e}`);
        state.recordWritable = null;
        return;
    }
    state.recordBuffer.length = 0;
    state.recordedCount = 0;
    state.isRecording = true;
    state.recordStartTime = Date.now();
    state.recordFrozenMs = 0;
    tickDuration();
    state.recordFlushTimer = setInterval(async () => {
        const ok = await flushRecordBuffer();
        if (!ok) { addLog('debug', '⚠ 写盘出错，自动停止记录'); await stopRecordingIfActive(); }
    }, CONFIG.RECORD_FLUSH_MS);
    setRecordButtons(true);
    addLog('debug', `▶ 开始记录到文件：${handle.name}`);
}

// 停止记录：写净缓冲并关闭文件。
async function stopRecording() {
    if (!state.isRecording) return;
    const saved = await stopRecordingIfActive();
    addLog('debug', saved ? `⏹ 已停止记录，文件已保存：${saved}` : '⏹ 已停止记录');
}

function togglePause() {
    state.isPaused = !state.isPaused;
    dom.btnPause.textContent = state.isPaused ? '继续绘图' : '暂停绘图';
    addLog('debug', state.isPaused ? '绘图已暂停（记录不受影响）' : '绘图已恢复');
}

// ==================== 二进制协议解析 ====================
// 帧头 D2 D2 D2，第 4 字节 AA=EMG / BB=IMU
// AA：8 通道 EMG，每通道 3 字节 24bit 有符号大端，单位 μV
// BB：保留 2 字节 + gyro xyz + acc xyz，每路 16bit 有符号大端
class BinaryParser {
    constructor() {
        this.buf = new Uint8Array(4096);
        this.bufLen = 0;
        this.lastSeq = -1;
    }

    feed(chunk) {
        if (this.bufLen + chunk.length > this.buf.length) {
            const newBuf = new Uint8Array((this.bufLen + chunk.length) * 2);
            newBuf.set(this.buf.subarray(0, this.bufLen));
            this.buf = newBuf;
        }
        this.buf.set(chunk, this.bufLen);
        this.bufLen += chunk.length;

        while (this.bufLen >= CONFIG.FRAME_LEN) {
            // 查找帧头 D2 D2 D2
            let headerPos = -1;
            const limit = this.bufLen - 2;
            for (let i = 0; i < limit; i++) {
                if (this.buf[i] === CONFIG.FRAME_HEADER &&
                    this.buf[i+1] === CONFIG.FRAME_HEADER &&
                    this.buf[i+2] === CONFIG.FRAME_HEADER) {
                    headerPos = i;
                    break;
                }
            }
            if (headerPos === -1) {
                // 保留最后 2 字节，避免帧头跨包丢失
                this.buf[0] = this.buf[this.bufLen - 2];
                this.buf[1] = this.buf[this.bufLen - 1];
                this.bufLen = 2;
                break;
            }
            if (headerPos > 0) {
                this.buf.copyWithin(0, headerPos, this.bufLen);
                this.bufLen -= headerPos;
            }
            if (this.bufLen < CONFIG.FRAME_LEN) break;

            // 第 4 字节必须是 AA/BB，否则视为假帧头，向后滑一个字节
            const pktType = this.buf[3];
            if (pktType !== CONFIG.PKT_EMG && pktType !== CONFIG.PKT_IMU) {
                this.buf.copyWithin(0, 1, this.bufLen);
                this.bufLen -= 1;
                continue;
            }

            this.parsePacket(this.buf);
            this.buf.copyWithin(0, CONFIG.FRAME_LEN, this.bufLen);
            this.bufLen -= CONFIG.FRAME_LEN;
        }
    }

    readInt24BE(buf, offset) {
        let val = (buf[offset] << 16) | (buf[offset+1] << 8) | buf[offset+2];
        if (val >= 0x800000) val -= 0x1000000;
        return val;
    }

    parsePacket(buf) {
        try {
            const pktType = buf[3];
            const seq = buf[4];

            // 丢包检测：AA/BB 共享序号，每包 +1，0xFF 后回绕
            let lostFrames = 0;
            if (this.lastSeq >= 0) {
                const expected = (this.lastSeq + 1) & 0xFF;
                if (seq !== expected) {
                    lostFrames = (seq - expected) & 0xFF;
                    state.errorCount += lostFrames;
                }
            }
            this.lastSeq = seq;

            if (pktType === CONFIG.PKT_EMG) {
                // 仅在 EMG 路径上补 NaN，避免 IMU 重复填充
                for (let i = 0; i < lostFrames; i++) this.insertNaNFrame();
                this.handleEmgPacket(seq, buf, 5);
            } else {
                this.handleImuPacket(buf, 5);
            }
        } catch (e) {
            state.errorCount++;
            addLog('debug', `解析错误: ${e.message}`);
        }
    }

    handleEmgPacket(seq, buf, offset) {
        const emg = new Array(8);
        for (let i = 0; i < 8; i++) {
            emg[i] = this.readInt24BE(buf, offset + i * 3);
        }

        // 记录：受"记录中"控制，独立于"暂停绘图"——暂停时仍持续写盘
        if (state.isRecording) {
            if (!state.recordStartTime) state.recordStartTime = Date.now();
            const imu = state.latestImu;
            recordFrame({
                emg,
                imu: {
                    accel: imu ? imu.acc : [NaN, NaN, NaN],
                    gyro:  imu ? imu.gyro : [NaN, NaN, NaN]
                },
                time: formatWorldTime()
            });
        }

        // 绘图与数值显示：受"暂停绘图"控制
        if (!state.isPaused) {
            for (let i = 0; i < 8; i++) emgCharts[i].addPoint([emg[i]]);
            state.latestEmg = emg;
            state.uiDirty = true;

            if (++state.logThrottle >= CONFIG.LOG_THROTTLE) {
                state.logThrottle = 0;
                const chStr = emg.map(v => String(v).padStart(7)).join(' ');
                addLog('data', `EMG #${String(seq).padStart(3)} | ${chStr}  (x${CONFIG.LOG_THROTTLE})`);
            }
        }
        state.frameCount++;
        state.emgCounter++;
    }

    handleImuPacket(buf, offset) {
        // payload 布局：+0..+1 保留，+2..+7 gyro xyz，+8..+13 acc xyz（16bit BE 有符号）
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const gx = dv.getInt16(offset + 2)  * CONFIG.GYRO_SCALE;
        const gy = dv.getInt16(offset + 4)  * CONFIG.GYRO_SCALE;
        const gz = dv.getInt16(offset + 6)  * CONFIG.GYRO_SCALE;
        const ax = dv.getInt16(offset + 8)  * CONFIG.ACC_SCALE;
        const ay = dv.getInt16(offset + 10) * CONFIG.ACC_SCALE;
        const az = dv.getInt16(offset + 12) * CONFIG.ACC_SCALE;

        // 始终更新最新 IMU 原始值（供记录取用，独立于"暂停绘图"）
        state.latestImu = { acc: [ax, ay, az], gyro: [gx, gy, gz] };

        // 绘图与数值显示：受"暂停绘图"控制
        if (!state.isPaused) {
            imuChart.addPoint([ax, ay, az, gx, gy, gz]);
            state.uiDirty = true;
        }
        state.frameCount++;
        state.imuCounter++;
    }

    insertNaNFrame() {
        // 绘图补帧：受"暂停绘图"控制
        if (!state.isPaused) {
            for (const c of emgCharts) c.addPoint([NaN]);
            imuChart.addPoint([NaN, NaN, NaN, NaN, NaN, NaN]);
        }
        // 记录补帧：独立于"暂停绘图"
        if (state.isRecording) {
            recordFrame({
                emg: Array(8).fill(NaN),
                imu: { accel: [NaN,NaN,NaN], gyro: [NaN,NaN,NaN] },
                time: formatWorldTime()
            });
        }
    }
}

// ==================== 串口连接 ====================
class SerialConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.parser = new BinaryParser();
        this.connected = false;
        this.ports = [];
        this.noDataTimer = null;
    }

    // 只列出已授权的串口（不弹选择框）。用于页面初始化、连接成功后刷新下拉。
    // 注意：requestPort() 必须由用户手势触发，故初始化/自动场景只能用 getPorts()。
    async listPorts() {
        if (!navigator.serial) { addLog('debug', '浏览器不支持 Web Serial API'); return; }
        try {
            this.ports = await navigator.serial.getPorts();
            this.renderPortOptions(this.ports);
        } catch (e) {
            addLog('debug', `读取串口列表失败: ${e.message}`);
        }
    }

    // 点击"刷新串口"：弹出浏览器设备选择框，可选择/更换任意设备（含没授权过的新设备）。
    // 选中的设备排到下拉首位并默认选中；取消则仅刷新已授权列表。
    async refreshPorts() {
        if (!navigator.serial) { addLog('debug', '浏览器不支持 Web Serial API'); return; }
        const refreshBtn = dom.btnRefreshPorts;
        try {
            if (refreshBtn) refreshBtn.disabled = true;
            let picked = null;
            try {
                picked = await navigator.serial.requestPort();
            } catch (e) {
                addLog('debug', e?.name === 'AbortError' ? '已取消选择设备' : `选择设备失败: ${e.message}`);
            }
            const granted = await navigator.serial.getPorts();
            // getPorts() 对同一物理串口返回同一实例，可直接按引用去重；刚选中的排首位
            this.ports = picked ? [picked, ...granted.filter(p => p !== picked)] : granted;
            this.renderPortOptions(this.ports);
            if (this.ports.length > 0) {
                addLog('debug', picked ? `已选择串口设备，共 ${this.ports.length} 个可选` : `已刷新串口列表：${this.ports.length} 个`);
            } else {
                addLog('debug', '未选择任何串口设备');
            }
        } catch (e) {
            addLog('debug', `刷新串口失败: ${e.message}`);
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    renderPortOptions(ports) {
        const sel = dom.portSelect;
        if (!sel) return;
        sel.innerHTML = '';
        if (!ports.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '点击"刷新串口"搜索设备';
            sel.appendChild(opt);
            return;
        }
        ports.forEach((port, i) => {
            const info = port.getInfo();
            const label = info.usbVendorId
                ? `USB Serial (VID:${info.usbVendorId.toString(16)} PID:${info.usbProductId.toString(16)})`
                : `串口 ${i + 1}`;
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = label;
            sel.appendChild(opt);
        });
        sel.value = '0';
    }

    getSelectedPort() {
        if (!dom.portSelect || !this.ports.length) return null;
        return this.ports[parseInt(dom.portSelect.value, 10)] || null;
    }

    async connect() {
        if (!navigator.serial) { alert('请使用 Chrome/Edge 浏览器'); return; }
        const port = this.getSelectedPort();
        if (!port) { addLog('debug', '请先点击"刷新串口"搜索并选择设备'); return; }
        try {
            this.port = port;
            await this.port.open({ baudRate: CONFIG.BAUDRATE });
            this.connected = true;
            state.connectStartTime = Date.now();
            startDurationTimer();
            this.parser = new BinaryParser();
            updateConnectionUI(true);
            addLog('debug', `串口已连接 @ ${CONFIG.BAUDRATE}bps`);
            setRecordButtons(false);   // 连接后启用"开始记录"、禁用"停止记录"
            this.listPorts();          // 仅刷新已授权列表，不弹选择框
            this.armNoDataWatch();     // 启动"无数据"看门狗：超时无帧则提示设备未开机
            this.readLoop();
        } catch (e) {
            addLog('debug', `连接失败: ${e.message}`);
        }
    }

    // 连接后看门狗：超时仍未收到任何帧 → 提示设备可能未开机。
    // 不自动断开：串口已 open，设备稍后开机会自动开始收数据并显示。
    armNoDataWatch() {
        if (this.noDataTimer) clearTimeout(this.noDataTimer);
        const baseline = state.frameCount;
        this.noDataTimer = setTimeout(() => {
            this.noDataTimer = null;
            if (this.connected && state.frameCount === baseline) {
                addLog('debug', `⚠ 已连接但 ${CONFIG.NO_DATA_TIMEOUT_MS / 1000}s 内未收到数据，请确认设备已开机并正常发送`);
            }
        }, CONFIG.NO_DATA_TIMEOUT_MS);
    }

    async readLoop() {
        this.reader = this.port.readable.getReader();
        try {
            while (this.connected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) this.parser.feed(value);
            }
        } catch (e) {
            if (this.connected) {
                addLog('debug', `读取异常/设备断开: ${e.message}`);
                await this.disconnect();
            }
        } finally {
            if (this.reader) {
                try { this.reader.releaseLock(); } catch {}
                this.reader = null;
            }
        }
    }

    async disconnect() {
        if (this.noDataTimer) { clearTimeout(this.noDataTimer); this.noDataTimer = null; }
        // 断开前若正在写盘记录，先安全收尾并关闭文件，避免句柄悬空
        if (state.isRecording) {
            try { await stopRecording(); } catch {}
        }
        this.connected = false;
        stopDurationTimer();
        state.connectStartTime = null;
        state.recordStartTime = null;
        state.recordFrozenMs = 0;
        state.isRecording = false;
        tickDuration();
        setRecordButtons(false);   // connected 已置 false → 同时禁用开始/停止记录
        if (this.reader) { try { await this.reader.cancel(); } catch {} }
        if (this.port) { try { await this.port.close(); } catch {} }
        this.port = null;
        this.reader = null;
        updateConnectionUI(false);
        addLog('debug', '串口已断开');
    }
}

const serial = new SerialConnection();

// ==================== UI 更新 ====================
function updateConnectionUI(connected) {
    dom.connDot.className = 'status-dot ' + (connected ? 'active' : '');
    dom.connText.textContent = connected ? '已连接' : '未连接';
    dom.btnConnect.disabled = connected;
    dom.btnDisconnect.disabled = !connected;
}

function addLog(type, msg) {
    // type: 'data' | 'debug'
    const container = type === 'data' ? dom.logData : dom.logDebug;
    const counter = type === 'data' ? dom.dataLogCount : dom.debugLogCount;
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`;
    entry.appendChild(ts);
    entry.appendChild(document.createTextNode(msg));
    container.appendChild(entry);
    while (container.children.length > CONFIG.LOG_MAX_LINES) {
        container.removeChild(container.firstChild);
    }
    container.scrollTop = container.scrollHeight;
    counter.textContent = container.children.length + ' 条';
}

function clearLogs() {
    dom.logData.innerHTML = '';
    dom.logDebug.innerHTML = '';
    dom.dataLogCount.textContent = '0 条';
    dom.debugLogCount.textContent = '0 条';
}

function clearData() {
    // 纯绘图操作：只清画面（波形 + 数值显示）。不碰接收统计（总帧/错误/fps/丢包基准）与记录域，
    // 也不被记录状态阻塞——记录进行中可随时清屏，正在写盘的文件不受影响。
    for (const c of emgCharts) c.clear();
    imuChart.clear();
    for (const el of dom.emgVals) if (el) el.textContent = '--';
    for (const el of dom.imuVals) if (el) el.textContent = '--';
    state.latestEmg = null;
    state.latestImu = null;
    addLog('debug', '绘图已清空');
}

// ==================== 动画循环 ====================
function animate() {
    try {
        const now = performance.now();
        const elapsed = now - state.lastFrameTime;
        if (elapsed >= 1000) {
            // 按实际经过时间归一化，避免渲染卡顿拉长结算窗口导致速率虚高/跳变
            state.emgFps = Math.round(state.emgCounter * 1000 / elapsed);
            state.imuFps = Math.round(state.imuCounter * 1000 / elapsed);
            state.emgCounter = 0;
            state.imuCounter = 0;
            state.lastFrameTime = now;
        }

        if (state.uiDirty) {
            state.uiDirty = false;
            dom.emgFps.textContent = state.emgFps;
            dom.imuFps.textContent = state.imuFps;
            dom.totalFrames.textContent = state.frameCount;
            dom.recordedFrames.textContent = state.recordedCount;
            dom.errLines.textContent = state.errorCount;
            dom.bufSize.textContent = state.recordBuffer.length;

            if (state.latestEmg) {
                for (let i = 0; i < state.latestEmg.length; i++) {
                    const el = dom.emgVals[i];
                    if (el) el.textContent = fmtNum(state.latestEmg[i], 1);
                }
            }
            if (state.latestImu) {
                const all = [...state.latestImu.acc, ...state.latestImu.gyro];
                for (let i = 0; i < all.length; i++) {
                    const el = dom.imuVals[i];
                    if (el) el.textContent = fmtNum(all[i], 3);
                }
            }
            if (state.zoomType) updateZoomData();

            // 仅在有新数据时重绘常驻图表；无数据/暂停时跳过，避免空转满负荷重绘
            for (const c of emgCharts) c.draw();
            imuChart.draw();
        }

        if (state.zoomChart) state.zoomChart.draw();
    } catch (e) {
        state.errorCount++;
        addLog('debug', `渲染异常: ${e.message}`);
    }
    requestAnimationFrame(animate);
}

function updateZoomData() {
    let values;
    if (state.zoomType === 'emg') {
        values = state.latestEmg ? [state.latestEmg[state.zoomIdx]] : null;
    } else {
        values = state.latestImu ? [...state.latestImu.acc, ...state.latestImu.gyro] : null;
    }
    if (!values) return;
    for (let i = 0; i < values.length; i++) {
        const el = document.getElementById(`zoom-v${i}`);
        if (el) el.textContent = fmtNum(values[i], 2);
    }
}

// ==================== 启动页 ====================
function runSplashIntro() {
    const splash = document.getElementById('splash-screen');
    const enterBtn = document.getElementById('enter-app-btn');
    if (!splash) {
        document.body.classList.remove('splash-active');
        document.body.classList.add('app-ready');
        return;
    }
    const enterApp = () => {
        splash.classList.add('is-hidden');
        document.body.classList.remove('splash-active');
        document.body.classList.add('app-ready');
        setTimeout(() => splash.remove(), 520);
    };
    if (enterBtn) {
        enterBtn.addEventListener('click', enterApp, { once: true });
        setTimeout(() => enterBtn.focus(), 1500);
    }
}

// ==================== 初始化 ====================
function cacheDom() {
    dom.connDot = document.getElementById('conn-dot');
    dom.connText = document.getElementById('conn-text');
    dom.btnConnect = document.getElementById('btn-connect');
    dom.btnDisconnect = document.getElementById('btn-disconnect');
    dom.btnRefreshPorts = document.getElementById('btn-refresh-ports');
    dom.btnRecord = document.getElementById('btn-record');
    dom.btnRecordStop = document.getElementById('btn-record-stop');
    dom.btnPause = document.getElementById('btn-pause');
    dom.portSelect = document.getElementById('serial-port-select');
    dom.emgFps = document.getElementById('emg-fps');
    dom.imuFps = document.getElementById('imu-fps');
    dom.totalFrames = document.getElementById('total-frames');
    dom.recordedFrames = document.getElementById('recorded-frames');
    dom.errLines = document.getElementById('err-lines');
    dom.bufSize = document.getElementById('buf-size');
    dom.connDuration = document.getElementById('conn-duration');
    dom.recordDuration = document.getElementById('record-duration');
    dom.logData = document.getElementById('logData');
    dom.logDebug = document.getElementById('logDebug');
    dom.dataLogCount = document.getElementById('data-log-count');
    dom.debugLogCount = document.getElementById('debug-log-count');
}

buildEmgPanels();
for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
    // EMG label 颜色由 CSS var(--ch) 接管，不传 colors
    createValueGrid(`vals-emg-${i}`, [`CH${i+1}(μV)`], null);
}
createValueGrid('vals-imu', ['Ax','Ay','Az','Gx','Gy','Gz'], IMU_COLORS);
cacheDom();
cacheValueRefs();
initCharts();
serial.listPorts();
animate();

window.addEventListener('load', runSplashIntro, { once: true });

applyTheme(localStorage.getItem('theme-preference') || 'dark');
addLog('debug', '系统就绪');
addLog('debug', `连接 EMG 手环 (${CONFIG.BAUDRATE}bps)`);
addLog('debug', '协议: D2D2D2帧头, AA=EMG(8ch×24bit), BB=IMU(6ch×16bit)');
addLog('debug', window.showSaveFilePicker
    ? '记录模式：边采边写盘（点"开始记录"选保存文件，数据实时写入磁盘，无内存上限）'
    : '⚠ 当前环境不支持边采边写盘记录，请通过 localhost 或 https 访问');
