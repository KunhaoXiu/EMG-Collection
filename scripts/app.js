// ==================== 配置 ====================
const CONFIG = {
    BAUDRATE: 921600,
    FRAME_LEN: 29,        // 每包 29 字节
    FRAME_HEADER: 0xD2,   // 帧头 D2 D2 D2
    PKT_EMG: 0xAA,        // EMG 包类型
    PKT_IMU: 0xBB,        // IMU 包类型（陀螺仪+加速度）
    EMG_CHANNELS: 8,
    // IMU 换算系数（来自唯理科技协议）
    GYRO_SCALE: 0.0012,       // rad/s
    ACC_SCALE: 0.0005978      // m/s²
};

// ==================== EMG 通道颜色 ====================
const EMG_COLORS = [
    '#ef4444', // CH1 红
    '#f97316', // CH2 橙
    '#f59e0b', // CH3 黄
    '#22c55e', // CH4 绿
    '#14b8a6', // CH5 青
    '#0ea5e9', // CH6 蓝
    '#8b5cf6', // CH7 紫
    '#ec4899'  // CH8 粉
];
const IMU_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6'];

// ==================== 状态 ====================
let history = [];
let isPaused = false;
let isRecording = false;
let isCollecting = false;
let frameCount = 0;
let recordedCount = 0;
let errorCount = 0;
let fps = 0;
let frameCounter = 0;
let lastFrameTime = performance.now();
let connectStartTime = null;
let acquireStartTime = null;
let currentTheme = 'dark';

// Zoom 状态
let zoomType = null;
let zoomIdx = null;
let zoomChart = null;
let zoomSourceChart = null;

// 待刷新的最新 EMG/IMU 值（批量更新 UI 用）
let latestEmg = null;
let latestImu = null;
let uiDirty = false;
let logThrottle = 0;  // 日志节流计数器
let durationTimerId = null;  // 时长更新定时器

// ==================== 图表类 ====================
class LineChart {
    constructor(canvasOrId, colors, maxPoints = 300, yPrecision = 1, opts = {}) {
        this.canvas = typeof canvasOrId === 'string'
            ? document.getElementById(canvasOrId)
            : canvasOrId;
        this.ctx = this.canvas.getContext('2d');
        this.colors = colors;
        this.lines = colors.map(c => ({ color: c, data: [] }));
        this.maxPoints = maxPoints;
        this.yPrecision = yPrecision;
        // 绘制选项
        this.pad = opts.pad || {top: 8, right: 6, bottom: 18, left: 32};
        this.lineWidth = opts.lineWidth || 1.2;
        this.showGrid = opts.showGrid || false;
        this.yTicks = opts.yTicks ?? 3;
        this.xTicks = opts.xTicks ?? 0;
        this.yFont = opts.yFont || '11px monospace';
        this.tickFont = opts.tickFont || '11px monospace';
        this.xTickRenderer = opts.xTickRenderer || null;
        this.resize();
        this._resizeHandler = () => this.resize();
        window.addEventListener('resize', this._resizeHandler);
    }
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.width = rect.width;
        this.height = rect.height;
    }
    addPoint(values) {
        if (isPaused) return;
        this.lines.forEach((line, i) => {
            line.data.push(values[i]);
            if (line.data.length > this.maxPoints) line.data.shift();
        });
    }
    draw() {
        const ctx = this.ctx, w = this.width, h = this.height;
        const pad = this.pad;
        const isLight = document.body.classList.contains('light-theme');
        ctx.clearRect(0, 0, w, h);

        let min = Infinity, max = -Infinity;
        this.lines.forEach(l => l.data.forEach(v => {
            if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
        }));
        if (!isFinite(min) || min === max) { min = -1; max = 1; }
        const range = max - min;

        // 根据刻度文字宽度动态调整左侧留白
        ctx.font = this.yFont;
        const sampleVal = max.toFixed(this.yPrecision);
        const textW = ctx.measureText(sampleVal).width + 10;
        const effectivePad = {
            top: pad.top, right: pad.right, bottom: pad.bottom,
            left: Math.max(pad.left, textW)
        };

        // 网格
        if (this.showGrid) {
            ctx.strokeStyle = isLight ? '#e2e8f0' : '#1e293b';
            ctx.lineWidth = 1; ctx.beginPath();
            for (let i = 0; i <= this.yTicks; i++) {
                const y = effectivePad.top + (h - effectivePad.top - effectivePad.bottom) * i / this.yTicks;
                ctx.moveTo(effectivePad.left, y); ctx.lineTo(w - effectivePad.right, y);
            }
            if (this.xTicks > 1) {
                for (let i = 0; i < this.xTicks; i++) {
                    const x = effectivePad.left + (w - effectivePad.left - effectivePad.right) * (i / (this.xTicks - 1));
                    ctx.moveTo(x, effectivePad.top); ctx.lineTo(x, h - effectivePad.bottom);
                }
            }
            ctx.stroke();
        }

        // 坐标轴
        const axisColor = isLight ? '#64748b' : '#cbd5e1';
        const axisWidth = this.showGrid ? 2 : 1;
        ctx.strokeStyle = axisColor; ctx.lineWidth = axisWidth; ctx.beginPath();
        const bottomY = h - effectivePad.bottom;
        ctx.moveTo(effectivePad.left, bottomY); ctx.lineTo(w - effectivePad.right, bottomY);
        ctx.moveTo(effectivePad.left, effectivePad.top); ctx.lineTo(effectivePad.left, bottomY);
        ctx.stroke();

        // Y 刻度
        ctx.fillStyle = isLight ? '#334155' : '#ffffff';
        ctx.textAlign = 'right';
        for (let i = 0; i <= this.yTicks; i++) {
            const val = max - range * i / this.yTicks;
            ctx.fillText(val.toFixed(this.yPrecision), effectivePad.left - 4, effectivePad.top + (h - effectivePad.top - effectivePad.bottom) * i / this.yTicks + 3);
        }

        // X 刻度（自定义渲染器）
        if (this.xTickRenderer && this.xTicks > 1) {
            for (let i = 0; i < this.xTicks; i++) {
                const ratio = i / (this.xTicks - 1);
                this.xTickRenderer(ctx, w, h, effectivePad, ratio, i, this);
            }
        }

        // 波形（降采样：点数远多于像素时按步长跳点）
        const plotW = w - effectivePad.left - effectivePad.right;
        this.lines.forEach(line => {
            const len = line.data.length;
            if (len < 2) return;
            ctx.strokeStyle = line.color; ctx.lineWidth = this.lineWidth; ctx.beginPath();
            const stride = Math.max(1, Math.floor(len / (plotW * 2)));
            let first = true;
            for (let i = 0; i < len; i += stride) {
                const x = effectivePad.left + plotW * (i / (this.maxPoints - 1));
                const y = effectivePad.top + (h - effectivePad.top - effectivePad.bottom) * (1 - (line.data[i] - min) / range);
                first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
            }
            // 确保最后一个点画到
            const lastI = len - 1;
            if (lastI % stride !== 0) {
                const x = effectivePad.left + plotW * (lastI / (this.maxPoints - 1));
                const y = effectivePad.top + (h - effectivePad.top - effectivePad.bottom) * (1 - (line.data[lastI] - min) / range);
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        });
    }
}

// ==================== 初始化图表 ====================
const EMG_MAX_POINTS = 6000;  // EMG 绘图缓冲区
const IMU_MAX_POINTS = 1000;  // IMU 绘图缓冲区

const emgCharts = [];
for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
    emgCharts.push(new LineChart(`canvas-emg-${i}`, [EMG_COLORS[i]], EMG_MAX_POINTS));
}

const imuChart = new LineChart('canvas-imu', IMU_COLORS, IMU_MAX_POINTS, 3);


// ==================== 放大功能 ====================
function openZoom(type, idx) {
    let sourceChart, title;
    if (type === 'emg') {
        sourceChart = emgCharts[idx];
        title = `EMG CH${idx + 1}`;
    } else if (type === 'imu') {
        sourceChart = imuChart;
        title = 'IMU 传感器';
    }

    zoomSourceChart = sourceChart;
    zoomType = type;
    zoomIdx = idx;

    document.getElementById('zoom-title').textContent = '🔍 ' + title;
    const modal = document.getElementById('zoom-modal');
    modal.style.display = 'flex';

    const grid = document.getElementById('zoom-data-grid');
    grid.innerHTML = '';
    grid.className = 'zoom-data-grid ' + type;

    let labels, colors;
    if (type === 'emg') {
        labels = [`CH${idx+1}`];
        colors = [EMG_COLORS[idx]];
    } else {
        labels = ['Ax','Ay','Az','Gx','Gy','Gz'];
        colors = IMU_COLORS;
    }

    labels.forEach((label, i) => {
        const div = document.createElement('div');
        div.className = 'zoom-data-cell';
        div.innerHTML = `<span class="z-label" style="color:${colors[i]}">${label}</span><span class="z-value" id="zoom-v${i}">--</span>`;
        grid.appendChild(div);
    });

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const zoomCanvas = document.getElementById('zoom-canvas');
            zoomChart = new LineChart(zoomCanvas, sourceChart.colors, sourceChart.maxPoints, sourceChart.yPrecision, {
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
                    // 刻度线
                    const isLight = document.body.classList.contains('light-theme');
                    ctx.strokeStyle = isLight ? '#94a3b8' : '#cbd5e1';
                    ctx.lineWidth = 2; ctx.beginPath();
                    ctx.moveTo(x, xAxisY); ctx.lineTo(x, xAxisY + 6); ctx.stroke();
                    // 时间标签
                    const currentFps = Math.max(fps, 1);
                    const currentPoints = Math.max(2, ...chart.lines.map(l => l.data.length || 0));
                    const timeSpan = (currentPoints - 1) / currentFps;
                    const secAgo = timeSpan * (1 - ratio);
                    const tickMs = Date.now() - secAgo * 1000;
                    ctx.fillStyle = '#94a3b8'; ctx.font = chart.tickFont; ctx.textAlign = 'center';
                    ctx.fillText(formatBeijingClock(tickMs), x, xAxisY + 24);
                }
            });
            // 共享源图表的数据引用
            zoomChart.lines = sourceChart.lines;
        });
    });
}

function closeZoom() {
    document.getElementById('zoom-modal').style.display = 'none';
    zoomChart = null;
    zoomSourceChart = null;
    zoomType = null;
    zoomIdx = null;
}

// ESC 关闭模态框
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeZoom();
});

// ==================== 初始化数值显示区域 ====================
function createValueGrid(containerId, labels, colors) {
    const container = document.getElementById(containerId);
    labels.forEach((label, i) => {
        const div = document.createElement('div');
        div.className = 'data-cell';
        div.innerHTML = `<span class="label" style="color:${colors[i]||'#475569'}">${label}</span><span class="value" id="${containerId}-v${i}">--</span>`;
        container.appendChild(div);
    });
}

for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
    createValueGrid(`vals-emg-${i}`, [`CH${i+1}(μV)`], [EMG_COLORS[i]]);
}

createValueGrid('vals-imu', ['Ax','Ay','Az','Gx','Gy','Gz'], IMU_COLORS);

// ==================== 更新数值显示 ====================
function updateValues(containerId, values, precision = 1) {
    values.forEach((v, i) => {
        const el = document.getElementById(`${containerId}-v${i}`);
        if (el) el.textContent = (typeof v === 'number' && !isNaN(v)) ? v.toFixed(precision) : 'NaN';
    });
}

// ==================== 更新 Zoom 数据 ====================
function updateZoomData(emgValues, imuValues) {
    if (!zoomType) return;
    let values;
    if (zoomType === 'emg') {
        values = [emgValues[zoomIdx]];
    } else {
        values = imuValues;
    }
    values.forEach((v, i) => {
        const el = document.getElementById(`zoom-v${i}`);
        if (el) el.textContent = (typeof v === 'number' && !isNaN(v)) ? v.toFixed(2) : 'NaN';
    });
}

// ==================== 时长格式化 ====================
function formatDuration(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatWorldTime() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(now);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
    const centiseconds = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, '0');
    return `${getPart('year')}-${getPart('month')}-${getPart('day')}-${getPart('hour')}-${getPart('minute')}-${getPart('second')}.${centiseconds}`;
}

function formatBeijingClock(ms) {
    const date = new Date(ms);
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
    const centiseconds = String(Math.floor(date.getMilliseconds() / 10)).padStart(2, '0');
    return `${getPart('hour')}:${getPart('minute')}:${getPart('second')}.${centiseconds}`;
}

function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-theme', currentTheme === 'light');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = currentTheme === 'light' ? '暗色模式' : '浅色模式';
    const splashBtn = document.getElementById('splash-theme-btn');
    if (splashBtn) splashBtn.textContent = currentTheme === 'light' ? '暗色模式' : '浅色模式';
    localStorage.setItem('theme-preference', currentTheme);
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

function startDurationTimer() {
    if (durationTimerId !== null) return;
    durationTimerId = setInterval(() => {
        const now = Date.now();
        document.getElementById('conn-duration').textContent = connectStartTime ? formatDuration(now - connectStartTime) : '00:00:00';
        document.getElementById('acq-duration').textContent = acquireStartTime ? formatDuration(now - acquireStartTime) : '00:00:00';
    }, 1000);
}
function stopDurationTimer() {
    if (durationTimerId !== null) {
        clearInterval(durationTimerId);
        durationTimerId = null;
    }
}
startDurationTimer();

// ==================== 采集控制 ====================
function toggleCollect() {
    if (!serial.connected) {
        addLogDebug('请先连接串口');
        return;
    }
    const btn = document.getElementById('btn-collect');
    if (!isCollecting) {
        isCollecting = true;
        isRecording = true;
        if (!acquireStartTime) acquireStartTime = Date.now();
        btn.textContent = '停止采集';
        btn.className = 'btn-danger';
        addLogDebug('▶ 开始记录数据');
    } else {
        isCollecting = false;
        isRecording = false;
        btn.textContent = '开始采集';
        btn.className = 'btn-primary';
        addLogDebug('⏹ 停止记录数据');
    }
}


// ==================== 二进制协议解析器 ====================
// 唯理科技 EMG 手环协议：
// 帧头 D2 D2 D2，第 4 字节 AA=EMG / BB=陀螺仪+加速度
// AA 包：8 通道 EMG，每通道 3 字节 24bit 有符号数（大端），单位微伏
// BB 包：陀螺仪(gr_x/y/z) + 加速度(acc_x/y/z)，各 16bit 有符号数（大端）
class BinaryParser {
    constructor() {
        this.buf = new Uint8Array(4096);  // 预分配缓冲区
        this.bufLen = 0;
        // AA/BB 使用共享序号：每个包 seq+1，0~0xFF 循环
        this.lastSeq = -1;
        this.lastPacketTime = 0;
    }

    feed(chunk) {
        // 追加到缓冲区
        if (this.bufLen + chunk.length > this.buf.length) {
            // 扩容
            const newBuf = new Uint8Array((this.bufLen + chunk.length) * 2);
            newBuf.set(this.buf.subarray(0, this.bufLen));
            this.buf = newBuf;
        }
        this.buf.set(chunk, this.bufLen);
        this.bufLen += chunk.length;

        // 解析完整帧
        while (this.bufLen >= CONFIG.FRAME_LEN) {
            // 查找帧头 D2 D2 D2
            let headerPos = -1;
            for (let i = 0; i <= this.bufLen - 3; i++) {
                if (this.buf[i] === CONFIG.FRAME_HEADER &&
                    this.buf[i+1] === CONFIG.FRAME_HEADER &&
                    this.buf[i+2] === CONFIG.FRAME_HEADER) {
                    headerPos = i;
                    break;
                }
            }

            if (headerPos === -1) {
                // 没找到帧头，保留最后 2 字节
                this.buf[0] = this.buf[this.bufLen - 2];
                this.buf[1] = this.buf[this.bufLen - 1];
                this.bufLen = 2;
                break;
            }

            // 丢弃帧头之前的数据
            if (headerPos > 0) {
                const remain = this.bufLen - headerPos;
                this.buf.copyWithin(0, headerPos, this.bufLen);
                this.bufLen = remain;
            }

            if (this.bufLen < CONFIG.FRAME_LEN) break;

            // 最小校验：第 4 字节必须是 AA/BB，否则是假帧头，向后滑一个字节
            const pktType = this.buf[3];
            if (pktType !== CONFIG.PKT_EMG && pktType !== CONFIG.PKT_IMU) {
                this.buf.copyWithin(0, 1, this.bufLen);
                this.bufLen -= 1;
                continue;
            }

            // 直接从缓冲区解析（不创建新数组）
            this.parsePacket(this.buf);
            this.buf.copyWithin(0, CONFIG.FRAME_LEN, this.bufLen);
            this.bufLen -= CONFIG.FRAME_LEN;
        }
    }

    toSigned24(b0, b1, b2) {
        let val = (b0 << 16) | (b1 << 8) | b2;
        if (val >= 0x800000) val -= 0x1000000;
        return val;
    }

    toSigned16(b0, b1) {
        let val = (b0 << 8) | b1;
        if (val >= 0x8000) val -= 0x10000;
        return val;
    }

    parsePacket(buf) {
        try {
            const pktType = buf[3];
            const seq = buf[4];

            // 丢包检测：AA/BB 共享序号（每个包 seq+1，0~0xFF 循环）
            if (pktType === CONFIG.PKT_EMG || pktType === CONFIG.PKT_IMU) {
                if (this.lastSeq >= 0) {
                    const expected = (this.lastSeq + 1) & 0xFF;
                    if (seq !== expected) {
                        errorCount += (seq - expected) & 0xFF;
                    }
                }
                this.lastSeq = seq;
            }

            if (pktType === CONFIG.PKT_EMG) {
                this.handleEmgPacket(seq, buf, 5);
            } else if (pktType === CONFIG.PKT_IMU) {
                this.handleImuPacket(seq, buf, 5);
            } else {
                addLogDebug(`未知包类型: 0x${pktType.toString(16).padStart(2,'0')}`);
            }
        } catch (e) {
            errorCount++;
            addLogDebug(`解析错误: ${e.message}`);
        }
    }

    handleEmgPacket(seq, buf, offset) {
        const now = performance.now();

        // 丢包填充 NaN（基于时间间隔）
        if (this.lastPacketTime > 0) {
            const dt = now - this.lastPacketTime;
            if (dt > 65) {
                const lostCount = Math.max(1, Math.floor(dt / 50) - 1);
                for (let i = 0; i < lostCount; i++) this.insertNaNFrame();
            }
        }
        this.lastPacketTime = now;

        // 解析 8 通道 EMG，每通道 3 字节 24bit 有符号（大端），单位 μV
        const emg = [];
        for (let i = 0; i < 8; i++) {
            const o = offset + i * 3;
            emg.push(this.toSigned24(buf[o], buf[o+1], buf[o+2]));
        }

        if (!isPaused) {
            // 写入图表数据缓冲区（纯数组操作，很快）
            emg.forEach((v, i) => emgCharts[i].addPoint([v]));

            // 记录数据
            if (isRecording) {
                if (!acquireStartTime) acquireStartTime = Date.now();
                const imuValues = imuChart.lines.map(l => l.data.length > 0 ? l.data[l.data.length - 1] : 0);
                history.push({
                    timestamp: seq, emg,
                    imu: { accel: imuValues.slice(0, 3), gyro: imuValues.slice(3, 6) },
                    time: formatWorldTime()
                });
                recordedCount++;
            }

            // 标记 UI 需要刷新（不在这里操作 DOM）
            latestEmg = emg;
            uiDirty = true;

            // 日志节流：每 50 包输出一次
            logThrottle++;
            if (logThrottle >= 50) {
                logThrottle = 0;
                const chStr = emg.map(v => v.toString().padStart(7)).join(' ');
                addLogData(`EMG #${seq.toString().padStart(3)} | ${chStr}  (x50)`);
            }
        }
        frameCount++; frameCounter++;
    }

    handleImuPacket(seq, buf, offset) {
        // 协议载荷布局（payload 从 offset 起 24 字节）：
        //   +0..+1   保留（图中 ch1 的前两字节，BB 包未使用）
        //   +2..+3   gr_x
        //   +4..+5   gr_y
        //   +6..+7   gr_z
        //   +8..+9   acc_x
        //   +10..+11 acc_y
        //   +12..+13 acc_z
        const gr_x  = this.toSigned16(buf[offset+2],  buf[offset+3])  * CONFIG.GYRO_SCALE;
        const gr_y  = this.toSigned16(buf[offset+4],  buf[offset+5])  * CONFIG.GYRO_SCALE;
        const gr_z  = this.toSigned16(buf[offset+6],  buf[offset+7])  * CONFIG.GYRO_SCALE;
        const acc_x = this.toSigned16(buf[offset+8],  buf[offset+9])  * CONFIG.ACC_SCALE;
        const acc_y = this.toSigned16(buf[offset+10], buf[offset+11]) * CONFIG.ACC_SCALE;
        const acc_z = this.toSigned16(buf[offset+12], buf[offset+13]) * CONFIG.ACC_SCALE;

        const imu_acc = [acc_x, acc_y, acc_z];
        const imu_gyro = [gr_x, gr_y, gr_z];

        if (!isPaused) {
            imuChart.addPoint([...imu_acc, ...imu_gyro]);
            latestImu = { acc: imu_acc, gyro: imu_gyro };
            uiDirty = true;
        }
        frameCount++; frameCounter++;
    }

    insertNaNFrame() {
        emgCharts.forEach(c => c.addPoint([NaN]));
        imuChart.addPoint([NaN, NaN, NaN, NaN, NaN, NaN]);
        if (isRecording) {
            history.push({
                timestamp: NaN, emg: Array(8).fill(NaN),
                imu: { accel: [NaN,NaN,NaN], gyro: [NaN,NaN,NaN] },
                time: formatWorldTime()
            });
            recordedCount++;
        }
        errorCount++;
    }
}

// ==================== 串口连接 ====================
class SerialConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.parser = new BinaryParser();
        this.connected = false;
        this.portSelect = document.getElementById('serial-port-select');
        this.refreshButton = document.getElementById('btn-refresh-ports');
        this.ports = [];
    }
    async refreshPorts() {
        if (!navigator.serial) { addLogDebug('浏览器不支持 Web Serial API'); return; }
        try {
            if (this.refreshButton) this.refreshButton.disabled = true;
            const ports = await navigator.serial.getPorts();
            this.ports = ports;
            this.renderPortOptions(ports);
            if (ports.length > 0) {
                addLogDebug(`已刷新串口列表：${ports.length} 个`);
            } else {
                addLogDebug('未检测到已授权串口，请先连接设备并授权');
            }
        } catch (e) {
            addLogDebug(`刷新串口失败: ${e.message}`);
        } finally {
            if (this.refreshButton) this.refreshButton.disabled = false;
        }
    }
    renderPortOptions(ports) {
        if (!this.portSelect) return;
        this.portSelect.innerHTML = '';
        if (!Array.isArray(ports) || ports.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '无可用串口';
            this.portSelect.appendChild(option);
            this.portSelect.value = '';
            return;
        }
        ports.forEach((port, i) => {
            const info = port.getInfo();
            const label = info.usbVendorId
                ? `USB Serial (VID:${info.usbVendorId.toString(16)} PID:${info.usbProductId.toString(16)})`
                : `串口 ${i + 1}`;
            const option = document.createElement('option');
            option.value = i;
            option.textContent = label;
            this.portSelect.appendChild(option);
        });
        this.portSelect.value = '0';
    }
    getSelectedPort() {
        if (!this.portSelect || !this.ports.length) return null;
        const idx = parseInt(this.portSelect.value, 10);
        return this.ports[idx] || null;
    }
    async connect() {
        if (!navigator.serial) { alert('请使用 Chrome/Edge 浏览器'); return; }
        try {
            let port = this.getSelectedPort();
            if (!port) {
                port = await navigator.serial.requestPort();
            }
            this.port = port;
            await this.port.open({ baudRate: CONFIG.BAUDRATE });
            this.connected = true;
            connectStartTime = Date.now();
            startDurationTimer();
            this.parser = new BinaryParser();
            updateConnectionUI(true);
            addLogDebug(`串口已连接 @ ${CONFIG.BAUDRATE}bps`);
            document.getElementById('btn-collect').disabled = false;
            this.readLoop();
        } catch (e) { addLogDebug(`连接失败: ${e.message}`); }
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
                addLogDebug(`读取异常/设备断开: ${e.message}`);
                await this.disconnect();
            }
        } finally {
            if (this.reader) {
                try { this.reader.releaseLock(); } catch(e) {}
                this.reader = null;
            }
        }
    }
    async disconnect() {
        this.connected = false;
        stopDurationTimer();
        connectStartTime = null;
        acquireStartTime = null;
        isCollecting = false;
        isRecording = false;
        const btn = document.getElementById('btn-collect');
        btn.textContent = '开始采集';
        btn.className = 'btn-primary';
        btn.disabled = true;
        if (this.reader) {
            try { await this.reader.cancel(); } catch(e) {}
        }
        if (this.port) {
            try { await this.port.close(); } catch(e) {}
        }
        this.port = null; this.reader = null;
        updateConnectionUI(false);
        addLogDebug('串口已断开');
    }
}
const serial = new SerialConnection();
serial.refreshPorts();

// ==================== UI 辅助 ====================
function updateConnectionUI(connected) {
    document.getElementById('conn-dot').className = 'status-dot ' + (connected ? 'active' : '');
    document.getElementById('conn-text').textContent = connected ? '已连接' : '未连接';
    document.getElementById('btn-connect').disabled = connected;
    document.getElementById('btn-disconnect').disabled = !connected;
}
function addLogData(msg) {
    const container = document.getElementById('logData');
    const entry = document.createElement('div');
    entry.className = 'log-entry data';
    const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
    entry.innerHTML = `<span class="timestamp">[${time}]</span>${msg}`;
    container.appendChild(entry);
    // 限制 100 条，超出批量删除
    while (container.children.length > 100) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
    document.getElementById('data-log-count').textContent = container.children.length + ' 条';
}
function addLogDebug(msg) {
    const container = document.getElementById('logDebug');
    const entry = document.createElement('div');
    entry.className = 'log-entry debug';
    const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
    entry.innerHTML = `<span class="timestamp">[${time}]</span>${msg}`;
    container.appendChild(entry);
    while (container.children.length > 100) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
    document.getElementById('debug-log-count').textContent = container.children.length + ' 条';
}
function clearLogs() {
    document.getElementById('logData').innerHTML = '';
    document.getElementById('logDebug').innerHTML = '';
    document.getElementById('data-log-count').textContent = '0 条';
    document.getElementById('debug-log-count').textContent = '0 条';
}
function clearData() {
    history = [];
    frameCount = 0;
    recordedCount = 0;
    errorCount = 0;
    frameCounter = 0;
    fps = 0;
    acquireStartTime = null;
    document.getElementById('fps').textContent = '0';
    document.getElementById('total-frames').textContent = '0';
    document.getElementById('recorded-frames').textContent = '0';
    document.getElementById('buf-size').textContent = '0';

    emgCharts.forEach(c => c.lines.forEach(l => l.data = []));
    imuChart.lines.forEach(l => l.data = []);

    for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) {
        const el = document.getElementById(`vals-emg-${i}-v0`);
        if (el) el.textContent = '--';
    }
    for (let i = 0; i < 6; i++) {
        const el = document.getElementById(`vals-imu-v${i}`);
        if (el) el.textContent = '--';
    }


    addLogDebug('所有数据已清空，采集时长已重置');
}
function togglePause() {
    isPaused = !isPaused;
    document.getElementById('btn-pause').textContent = isPaused ? '继续' : '暂停';
    addLogDebug(isPaused ? '显示已暂停（后台仍接收）' : '显示已恢复');
}
async function exportCSV() {
    if (!history.length) { alert('暂无数据'); return; }
    let csv = 'time,timestamp,';
    for (let i = 0; i < CONFIG.EMG_CHANNELS; i++) csv += `emg${i+1},`;
    csv += 'imu_ax,imu_ay,imu_az,imu_gx,imu_gy,imu_gz\n';

    history.forEach(f => {
        csv += `${f.time},`;
        csv += `${f.timestamp},`;
        csv += f.emg.map(v => (typeof v === 'number' && !isNaN(v)) ? v.toFixed(2) : 'NaN').join(',') + ',';
        csv += [...f.imu.accel, ...f.imu.gyro].map(v => (typeof v === 'number' && !isNaN(v)) ? v.toFixed(4) : 'NaN').join(',') + '\n';
    });

    const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8;'});
    const filename = `emg_data_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;

    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            addLogDebug(`已导出 ${history.length} 帧`);
            return;
        } catch (e) {
            if (e && e.name === 'AbortError') {
                addLogDebug('已取消导出');
                return;
            }
            addLogDebug('保存对话框不可用，已回退为浏览器下载');
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    addLogDebug(`已导出 ${history.length} 帧`);
}

// ==================== 动画循环（所有 DOM 更新集中在这里）====================
function animate() {
    const now = performance.now();

    // 每秒更新帧率
    if (now - lastFrameTime >= 1000) {
        fps = frameCounter;
        frameCounter = 0;
        lastFrameTime = now;
    }

    // 批量更新 DOM（只在有新数据时）
    if (uiDirty) {
        uiDirty = false;

        // 统计
        document.getElementById('fps').textContent = fps;
        document.getElementById('total-frames').textContent = frameCount;
        document.getElementById('recorded-frames').textContent = recordedCount;
        document.getElementById('err-lines').textContent = errorCount;
        document.getElementById('buf-size').textContent = history.length;

        // EMG 数值
        if (latestEmg) {
            latestEmg.forEach((v, i) => updateValues(`vals-emg-${i}`, [v]));
        }

        // IMU 数值（精度 3 位，因为换算后数值很小）
        if (latestImu) {
            updateValues('vals-imu', [...latestImu.acc, ...latestImu.gyro], 3);
        }

        // Zoom 数据
        if (zoomType && latestEmg && latestImu) {
            updateZoomData(latestEmg, [...latestImu.acc, ...latestImu.gyro]);
        }
    }

    // 绘制图表（Canvas 操作，比 DOM 快得多）
    emgCharts.forEach(c => c.draw());
    imuChart.draw();
    if (zoomChart) zoomChart.draw();

    requestAnimationFrame(animate);
}
animate();

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
        window.setTimeout(() => splash.remove(), 520);
    };
    if (enterBtn) {
        enterBtn.addEventListener('click', enterApp, { once: true });
        window.setTimeout(() => enterBtn.focus(), 1500);
    }
}
window.addEventListener('load', runSplashIntro, { once: true });

// 初始化
applyTheme(localStorage.getItem('theme-preference') || 'dark');
addLogDebug('系统就绪');
addLogDebug(`连接 EMG 手环 (${CONFIG.BAUDRATE}bps)`);
addLogDebug('协议: D2D2D2帧头, AA=EMG(8ch×24bit), BB=IMU(6ch×16bit)');
