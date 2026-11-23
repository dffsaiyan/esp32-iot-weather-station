/**
 * ENDERWOOD IOT WEATHER STATION - DASHBOARD LOGIC
 * Real-time Chart.js spline streaming & Flask REST API integration
 */

// ==================================================
// CONFIGURATION & GLOBAL STATE
// ==================================================

const API_BASE_URL = '';
const POLLING_INTERVAL_MS = 2000;
const HISTORY_POLL_INTERVAL_MS = 10000;
const MAX_CHART_POINTS = 16;

const BELL_RING_ICON = `
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
    <path d="M4 2C2.8 3.7 2 5.7 2 8"/>
    <path d="M22 8c0-2.3-.8-4.3-2-6"/>
  </svg>`;

const BELL_OFF_ICON = `
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/>
    <path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/>
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
    <path d="m2 2 20 20"/>
  </svg>`;

const WIFI_ICON_ON = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h.01"/>
    <path d="M2 8.82a15 15 0 0 1 20 0"/>
    <path d="M5 12.859a10 10 0 0 1 14 0"/>
    <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
  </svg>`;

const WIFI_ICON_OFF = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h.01"/>
    <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
    <path d="M5 12.859a10 10 0 0 1 5.17-2.69"/>
    <path d="M19 12.859a10 10 0 0 0-2.007-1.523"/>
    <path d="M2 8.82a15 15 0 0 1 4.177-2.643"/>
    <path d="M22 8.82a15 15 0 0 0-11.288-3.764"/>
    <path d="m2 2 20 20"/>
  </svg>`;

let pollingTimer = null;
let historyTimer = null;
let chartInstance = null;
let lastRenderedReceivedAt = null;
let isDangerActive = false;
let isBuzzerMuted = false;
let buzzerPendingUntil = 0;

// ==================================================
// DOM ELEMENTS
// ==================================================

const elCurrentTime = document.getElementById('currentTime');
const elConnectionStatusCard = document.getElementById('connectionStatusCard');
const elConnectionStatusText = document.getElementById('connectionStatusText');
const elConnectionStatusIcon = document.getElementById('connectionStatusIcon');

const elBuzzerBtn = document.getElementById('buzzerBtn');
const elBuzzerIcon = document.getElementById('buzzerIcon');
const elBuzzerSub = document.getElementById('buzzerSub');

const elTempValue = document.getElementById('tempValue');
const elTempGaugeBar = document.getElementById('tempGaugeBar');

const elHumValue = document.getElementById('humValue');
const elHumGaugeBar = document.getElementById('humGaugeBar');

const elLightValue = document.getElementById('lightValue');
const elLightIconBox = document.getElementById('lightIconBox');

const elStatusPill = document.getElementById('statusPill');
const elStatusPillText = document.getElementById('statusPillText');
const elStatusSubtext = document.getElementById('statusSubtext');

const elLogRecordCount = document.getElementById('logRecordCount');
const elSensorDataLogBody = document.getElementById('sensorDataLogBody');

const elViewDataBtn = document.getElementById('viewDataBtn');
const elLowerSections = document.getElementById('lowerSections');
const elRefreshHistoryBtn = document.getElementById('refreshHistoryBtn');

const elSettingsBtn = document.getElementById('settingsBtn');
const elSettingsModal = document.getElementById('settingsModal');
const elCloseSettingsBtn = document.getElementById('closeSettingsBtn');
const elOpenMobileQrBtn = document.getElementById('openMobileQrBtn');
const elMobileQrModal = document.getElementById('mobileQrModal');
const elCloseMobileQrBtn = document.getElementById('closeMobileQrBtn');
const elMobileQrBox = document.getElementById('mobileQrBox');
const elMobileQrUrl = document.getElementById('mobileQrUrl');
const elRefreshQrBtn = document.getElementById('refreshQrBtn');
const elCopyMobileUrlBtn = document.getElementById('copyMobileUrlBtn');
const elWifiCurrentCard = document.getElementById('wifiCurrentCard');
const elWifiCurrentSsid = document.getElementById('wifiCurrentSsid');
const elWifiCurrentMeta = document.getElementById('wifiCurrentMeta');
const elWifiDisconnectBtn = document.getElementById('wifiDisconnectBtn');
const elWifiDeviceStatus = document.getElementById('wifiDeviceStatus');
const elWifiCountLabel = document.getElementById('wifiCountLabel');
const elWifiScanBtn = document.getElementById('wifiScanBtn');
const elWifiList = document.getElementById('wifiList');
const elWifiPasswordSection = document.getElementById('wifiPasswordSection');
const elSelectedSsidLabel = document.getElementById('selectedSsidLabel');
const elWifiPassInput = document.getElementById('wifiPassInput');
const elToggleWifiPassBtn = document.getElementById('toggleWifiPassBtn');
const elWifiConnectBtn = document.getElementById('wifiConnectBtn');
const elWifiFeedbackBox = document.getElementById('wifiFeedbackBox');

// ==================================================
// REAL-TIME CLOCK
// ==================================================

function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  elCurrentTime.textContent = `${hours}:${minutes}:${seconds}`;
}

setInterval(updateClock, 1000);
updateClock();

// ==================================================
// INITIALIZE CHART.JS SPLINE CHART
// ==================================================

function formatChartTime(isoTimestamp) {
  const dateObj = isoTimestamp ? new Date(isoTimestamp) : new Date();
  const target = Number.isNaN(dateObj.getTime()) ? new Date() : dateObj;
  return [
    String(target.getHours()).padStart(2, '0'),
    String(target.getMinutes()).padStart(2, '0'),
    String(target.getSeconds()).padStart(2, '0')
  ].join(':');
}

function applyChartResponsiveOptions() {
  if (!chartInstance) return;
  const isMobile = window.innerWidth <= 640;
  const tickFontSize = isMobile ? 10.5 : 12.5;
  const tickPadding = isMobile ? 4 : 8;

  chartInstance.data.datasets[0].borderWidth = isMobile ? 2 : 2.5;
  chartInstance.data.datasets[0].pointRadius = isMobile ? 2.2 : 3.5;
  chartInstance.data.datasets[1].borderWidth = isMobile ? 2 : 2.2;
  chartInstance.data.datasets[1].pointRadius = isMobile ? 2.2 : 3.5;

  chartInstance.options.layout.padding.left = isMobile ? 0 : 6;
  chartInstance.options.layout.padding.right = isMobile ? 0 : 6;

  chartInstance.options.scales.x.ticks.maxTicksLimit = isMobile ? 4 : 8;
  chartInstance.options.scales.x.ticks.padding = tickPadding;
  chartInstance.options.scales.x.ticks.font.size = tickFontSize;

  chartInstance.options.scales.yTemp.ticks.padding = tickPadding;
  chartInstance.options.scales.yTemp.ticks.font.size = tickFontSize;

  chartInstance.options.scales.yHum.ticks.padding = tickPadding;
  chartInstance.options.scales.yHum.ticks.font.size = tickFontSize;
}

function initSplineChart() {
  if (typeof Chart === 'undefined') {
    return;
  }

  const isMobile = window.innerWidth <= 640;
  const tickFontSize = isMobile ? 10.5 : 12.5;
  const tickPadding = isMobile ? 4 : 8;
  const ctx = document.getElementById('realtimeSplineChart').getContext('2d');

  // Gradient for Temperature (Crisp White)
  const tempGradient = ctx.createLinearGradient(0, 0, 0, 260);
  tempGradient.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
  tempGradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

  // Gradient for Humidity (Subtle Sky Blue)
  const humGradient = ctx.createLinearGradient(0, 0, 0, 260);
  humGradient.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
  humGradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Nhiệt độ',
          yAxisID: 'yTemp',
          data: [],
          borderColor: '#ffffff',
          borderWidth: isMobile ? 2 : 2.5,
          backgroundColor: tempGradient,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#0e0e0e',
          pointBorderWidth: 1.5,
          pointRadius: isMobile ? 2.2 : 3.5,
          pointHoverRadius: 6,
        },
        {
          label: 'Độ ẩm',
          yAxisID: 'yHum',
          data: [],
          borderColor: '#38bdf8',
          borderWidth: isMobile ? 2 : 2.2,
          backgroundColor: humGradient,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#38bdf8',
          pointBorderColor: '#0e0e0e',
          pointBorderWidth: 1.5,
          pointRadius: isMobile ? 2.2 : 3.5,
          pointHoverRadius: 6,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(20, 22, 28, 0.96)',
          titleFont: { family: 'Inter, sans-serif', size: 13, weight: '600' },
          bodyFont: { family: 'Inter, sans-serif', size: 13, weight: '500' },
          borderColor: 'rgba(255, 255, 255, 0.16)',
          borderWidth: 1,
          padding: 12,
          boxPadding: 6,
          usePointStyle: true,
          callbacks: {
            label: function(context) {
              const val = context.datasetIndex === 0
                ? `${context.parsed.y.toFixed(1)} °C`
                : `${Math.round(context.parsed.y)} %`;
              return ` ${context.dataset.label}: ${val}`;
            }
          }
        }
      },
      layout: {
        padding: {
          left: isMobile ? 0 : 6,
          right: isMobile ? 0 : 6,
          top: 8,
          bottom: 2
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.06)',
            drawBorder: false,
          },
          ticks: {
            color: 'rgba(255, 255, 255, 0.72)',
            maxTicksLimit: isMobile ? 4 : 8,
            maxRotation: 0,
            padding: tickPadding,
            font: { family: 'Inter, sans-serif', size: tickFontSize, weight: '500' }
          }
        },
        yTemp: {
          type: 'linear',
          position: 'left',
          grace: 2,
          grid: {
            color: 'rgba(255, 255, 255, 0.07)',
            drawBorder: false,
          },
          ticks: {
            precision: 0,
            padding: tickPadding,
            color: 'rgba(255, 255, 255, 0.85)',
            font: { family: 'Inter, sans-serif', size: tickFontSize, weight: '500' },
            callback: function(value) {
              return `${Math.round(Number(value))}°C`;
            }
          }
        },
        yHum: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 100,
          grid: {
            drawOnChartArea: false,
            drawBorder: false,
          },
          ticks: {
            padding: tickPadding,
            color: 'rgba(56, 189, 248, 0.9)',
            font: { family: 'Inter, sans-serif', size: tickFontSize, weight: '500' },
            stepSize: 20,
            callback: function(value) {
              return `${value}%`;
            }
          }
        }
      }
    }
  });

  window.addEventListener('resize', () => {
    if (!chartInstance) return;
    applyChartResponsiveOptions();
    chartInstance.update('none');
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (chartInstance) {
        chartInstance.resize();
      }
    });
  }
}

function appendChartData(timeLabel, temp, hum, shouldUpdate = true) {
  if (!chartInstance) return;

  chartInstance.data.labels.push(timeLabel);
  chartInstance.data.datasets[0].data.push(temp);
  chartInstance.data.datasets[1].data.push(hum);

  if (chartInstance.data.labels.length > MAX_CHART_POINTS) {
    chartInstance.data.labels.shift();
    chartInstance.data.datasets[0].data.shift();
    chartInstance.data.datasets[1].data.shift();
  }

  if (shouldUpdate) {
    chartInstance.update('none');
  }
}

async function hydrateChartFromRecent() {
  if (!chartInstance) return;
  try {
    const res = await fetch(`${API_BASE_URL}/api/sensor/recent?limit=${MAX_CHART_POINTS}`, {
      cache: 'no-store'
    });
    if (!res.ok) return;

    const result = await res.json();
    const records = Array.isArray(result.data) ? result.data : [];
    if (!records.length) return;

    chartInstance.data.labels = [];
    chartInstance.data.datasets[0].data = [];
    chartInstance.data.datasets[1].data = [];

    records.forEach((item) => {
      appendChartData(
        formatChartTime(item.received_at),
        parseFloat(item.temperature),
        parseFloat(item.humidity),
        false
      );
      lastRenderedReceivedAt = item.received_at || lastRenderedReceivedAt;
    });

    chartInstance.update('none');
  } catch (err) {
    // Bo qua neu backend chua co du lieu hoac dang offline
  }
}

// ==================================================
// UPDATE UI STATE
// ==================================================

const TEMP_WARNING = 33.0;
const TEMP_DANGER = 37.0;
const HUM_WARNING = 76.0;
const HUM_DANGER = 85.0;

function applyGaugeThreshold(barEl, value, warnThreshold, dangerThreshold) {
  if (!barEl) return;
  barEl.classList.remove('is-warning', 'is-danger');
  if (value >= dangerThreshold) {
    barEl.classList.add('is-danger');
  } else if (value >= warnThreshold) {
    barEl.classList.add('is-warning');
  }
}

function updateKPIs(data) {
  const temp = parseFloat(data.temperature);
  const hum = parseFloat(data.humidity);
  const light = String(data.light).toUpperCase();
  const status = String(data.status).toUpperCase();

  // 1. Temperature Card
  elTempValue.textContent = temp.toFixed(1);
  const gaugePercent = Math.min(Math.max(((temp - 15) / 30) * 100, 6), 100);
  elTempGaugeBar.style.width = `${gaugePercent}%`;
  applyGaugeThreshold(elTempGaugeBar, temp, TEMP_WARNING, TEMP_DANGER);

  // 2. Humidity Card
  elHumValue.textContent = Math.round(hum);
  if (elHumGaugeBar) {
    elHumGaugeBar.style.width = `${Math.min(Math.max(hum, 5), 100)}%`;
    applyGaugeThreshold(elHumGaugeBar, hum, HUM_WARNING, HUM_DANGER);
  }

  // 3. Light Intensity Card
  elLightValue.textContent = light === 'BRIGHT' ? 'Sáng' : 'Tối';
  if (light === 'BRIGHT') {
    elLightIconBox.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
      </svg>`;
  } else {
    elLightIconBox.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
      </svg>`;
  }

  // 4. System Health / Status Text
  elStatusPill.classList.remove('status-normal', 'status-warning', 'status-danger');

  if (status === 'DANGER') {
    elStatusPill.classList.add('status-danger');
    elStatusPillText.textContent = 'Nguy hiểm';
    elStatusSubtext.textContent = 'Cảnh báo nguy hiểm! Nhiệt độ/Độ ẩm vượt ngưỡng';
  } else if (status === 'WARNING') {
    elStatusPill.classList.add('status-warning');
    elStatusPillText.textContent = 'Cảnh báo';
    elStatusSubtext.textContent = 'Lưu ý: Thông số đang ở mức cận nguy hiểm';
  } else {
    elStatusPill.classList.add('status-normal');
    elStatusPillText.textContent = 'Ổn định';
    elStatusSubtext.textContent = 'Tất cả thông số ở mức an toàn';
  }

  syncBuzzerFromTelemetry(status === 'DANGER', Boolean(data.buzzer_muted));

  // 5. Feed Chart (chỉ vẽ thêm điểm khi có bản tin mới từ ESP32)
  if (!data.received_at || data.received_at !== lastRenderedReceivedAt) {
    lastRenderedReceivedAt = data.received_at || null;
    appendChartData(formatChartTime(data.received_at), temp, hum);
  }
}

// ==================================================
// FETCH LATEST SENSOR DATA FROM BACKEND REST API
// ==================================================

async function fetchLatestSensorData() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sensor/latest`, {
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (!data || data.online === false) {
      setConnectionState(false);
      return;
    }

    setConnectionState(true);
    updateKPIs(data);

  } catch (err) {
    setConnectionState(false);
  }
}

function setConnectionState(isOnline) {
  elConnectionStatusCard.classList.toggle('is-live', isOnline);
  elConnectionStatusText.textContent = isOnline ? 'Live' : 'Offline';
  elConnectionStatusIcon.innerHTML = isOnline ? WIFI_ICON_ON : WIFI_ICON_OFF;

  elViewDataBtn.classList.toggle('is-disabled', !isOnline);
  elViewDataBtn.setAttribute('aria-disabled', String(!isOnline));

  const wasLocked = elLowerSections.classList.contains('is-locked');
  elLowerSections.classList.toggle('is-locked', !isOnline);

  if (isOnline && wasLocked && chartInstance) {
    requestAnimationFrame(() => chartInstance.resize());
  } else if (!isOnline) {
    isDangerActive = false;
    isBuzzerMuted = false;
    buzzerPendingUntil = 0;
    renderBuzzerSwitch();
    if (!wasLocked) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}

// ==================================================
// BUZZER 2-WAY MQTT CONTROL
// ==================================================

function renderBuzzerSwitch() {
  if (!elBuzzerBtn) return;

  elBuzzerBtn.classList.remove('is-locked', 'is-sounding', 'is-muted', 'is-on');
  if (!isDangerActive) {
    elBuzzerBtn.classList.add('is-locked');
    elBuzzerBtn.setAttribute('aria-disabled', 'true');
    elBuzzerIcon.innerHTML = BELL_OFF_ICON;
    elBuzzerSub.textContent = 'Chỉ mở khi Nguy hiểm';
  } else if (isBuzzerMuted) {
    elBuzzerBtn.classList.add('is-muted');
    elBuzzerBtn.setAttribute('aria-disabled', 'false');
    elBuzzerIcon.innerHTML = BELL_OFF_ICON;
    elBuzzerSub.textContent = 'Đã tắt · Bấm để bật lại';
  } else {
    elBuzzerBtn.classList.add('is-sounding', 'is-on');
    elBuzzerBtn.setAttribute('aria-disabled', 'false');
    elBuzzerIcon.innerHTML = BELL_RING_ICON;
    elBuzzerSub.textContent = 'Đang hú · Bấm để tắt';
  }
}

function syncBuzzerFromTelemetry(dangerNow, mutedFromDevice) {
  if (!dangerNow) {
    isDangerActive = false;
    isBuzzerMuted = false;
    buzzerPendingUntil = 0;
  } else {
    isDangerActive = true;
    if (Date.now() >= buzzerPendingUntil) {
      isBuzzerMuted = mutedFromDevice;
    }
  }
  renderBuzzerSwitch();
}

async function toggleBuzzerOverMqtt() {
  if (!isDangerActive) {
    return;
  }

  const nextMuted = !isBuzzerMuted;
  isBuzzerMuted = nextMuted;
  buzzerPendingUntil = Date.now() + 2500;
  renderBuzzerSwitch();

  try {
    const res = await fetch(`${API_BASE_URL}/api/buzzer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mute: nextMuted })
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    buzzerPendingUntil = 0;
    isBuzzerMuted = !nextMuted;
    renderBuzzerSwitch();
  }
}

// ==================================================
// FETCH SENSOR HISTORY FROM SQLITE
// ==================================================

async function fetchSensorHistory() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sensor/history?limit=8`, {
      cache: 'no-store'
    });

    if (!res.ok) throw new Error('Cannot load history');

    const result = await res.json();
    renderHistoryTable(result.data || []);

  } catch (err) {
    elSensorDataLogBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center loading-row">
          Chưa tải được lịch sử dữ liệu từ SQLite.
        </td>
      </tr>`;
  }
}

function renderHistoryTable(records) {
  if (!records || records.length === 0) {
    elSensorDataLogBody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center loading-row">Chưa có bản ghi nào trong cơ sở dữ liệu.</td>
      </tr>`;
    elLogRecordCount.textContent = '0 bản ghi';
    return;
  }

  elLogRecordCount.textContent = `${records.length} bản ghi gần nhất`;

  let html = '';
  records.forEach((row, idx) => {
    const dateObj = new Date(row.received_at || Date.now());
    const formattedDate = dateObj.toLocaleDateString('vi-VN') + ' ' + dateObj.toLocaleTimeString('vi-VN');

    const statusClass =
      row.status === 'DANGER' ? 'cell-status-danger' :
      row.status === 'WARNING' ? 'cell-status-warning' : 'cell-status-normal';

    const statusLabel =
      row.status === 'DANGER' ? 'Nguy hiểm' :
      row.status === 'WARNING' ? 'Cảnh báo' : 'Ổn định';

    const isBright = String(row.light).toUpperCase() === 'BRIGHT';
    const lightClass = isBright ? 'cell-light-bright' : 'cell-light-dark';
    const lightLabel = isBright ? 'Sáng' : 'Tối';

    html += `
      <tr>
        <td class="time-col">#${row.id || (idx + 1)}</td>
        <td class="time-col">${formattedDate}</td>
        <td><strong>${parseFloat(row.temperature).toFixed(1)}°C</strong></td>
        <td><strong>${parseFloat(row.humidity).toFixed(1)}%</strong></td>
        <td><span class="${lightClass}">${lightLabel}</span></td>
        <td><span class="${statusClass}">${statusLabel}</span></td>
      </tr>
    `;
  });

  elSensorDataLogBody.innerHTML = html;
}

function startPolling() {
  fetchLatestSensorData();
  fetchSensorHistory();

  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(fetchLatestSensorData, POLLING_INTERVAL_MS);

  if (historyTimer) clearInterval(historyTimer);
  historyTimer = setInterval(fetchSensorHistory, HISTORY_POLL_INTERVAL_MS);
}

// ==================================================
// SETTINGS MODAL (USB WIFI PROVISIONING)
// ==================================================

let scannedNetworks = [];
let selectedSsid = null;
let currentWifiStatus = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signalLabel(rssi) {
  if (rssi >= -60) return 'Mạnh';
  if (rssi >= -75) return 'Khá';
  return 'Yếu';
}

function showWifiFeedback(text, tone = 'info') {
  elWifiFeedbackBox.className = `wifi-feedback is-${tone}`;
  elWifiFeedbackBox.textContent = text;
}

function hideWifiFeedback() {
  elWifiFeedbackBox.className = 'wifi-feedback hidden';
  elWifiFeedbackBox.textContent = '';
}

function renderCurrentWifiCard() {
  if (!currentWifiStatus || !currentWifiStatus.connected || !currentWifiStatus.ssid) {
    elWifiCurrentCard.classList.add('hidden');
    return;
  }

  elWifiCurrentSsid.textContent = currentWifiStatus.ssid;
  const ipPart = currentWifiStatus.ip ? `IP: ${currentWifiStatus.ip}` : 'Đã cấp IP';
  const mqttPart = currentWifiStatus.mqtt ? 'MQTT: Đã nối' : 'MQTT: Đang nối';
  elWifiCurrentMeta.textContent = `${ipPart} · ${mqttPart}`;
  elWifiCurrentCard.classList.remove('hidden');
}

function renderScannedWifiList() {
  if (!scannedNetworks.length) {
    elWifiCountLabel.textContent = '';
    elWifiList.innerHTML = '<div class="wifi-empty">Không tìm thấy mạng WiFi 2.4GHz nào quanh mạch</div>';
    return;
  }

  const activeSsid = currentWifiStatus && currentWifiStatus.connected ? currentWifiStatus.ssid : null;
  elWifiCountLabel.textContent = `(${scannedNetworks.length} mạng)`;
  elWifiList.innerHTML = scannedNetworks.map((net, index) => {
    const isSelected = selectedSsid === net.ssid;
    const isActive = activeSsid && net.ssid === activeSsid;
    const activeBadge = isActive ? '<span class="wifi-row-active-tag">Đang dùng</span>' : '';
    const lockIcon = net.secured
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
      : '';

    return `
      <button type="button" class="wifi-row ${isSelected ? 'is-selected' : ''}" data-idx="${index}">
        <span class="wifi-row-ssid">${escapeHtml(net.ssid)}</span>
        <span class="wifi-row-meta">${activeBadge}${lockIcon}<span>${signalLabel(net.rssi)}</span></span>
      </button>
    `;
  }).join('');

  elWifiList.querySelectorAll('.wifi-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = scannedNetworks[Number(btn.dataset.idx)];
      if (item) {
        selectWifiNetwork(item);
      }
    });
  });
}

function selectWifiNetwork(net) {
  selectedSsid = net.ssid;
  renderScannedWifiList();

  const isSwitching = Boolean(currentWifiStatus && currentWifiStatus.connected && currentWifiStatus.ssid !== net.ssid);
  elSelectedSsidLabel.textContent = net.ssid;
  elWifiConnectBtn.textContent = isSwitching ? 'Đổi mạng' : 'Kết nối';
  elWifiPasswordSection.classList.remove('hidden');
  elWifiPassInput.value = '';
  elWifiPassInput.type = 'password';
  elToggleWifiPassBtn.textContent = 'Hiện';
  elWifiPassInput.placeholder = net.secured
    ? 'Nhập mật khẩu WiFi...'
    : 'Mạng mở (bỏ trống nếu không có mật khẩu)';
  hideWifiFeedback();
  elWifiPassInput.focus();
}

function showWifiLoadError(err) {
  scannedNetworks = [];
  currentWifiStatus = null;
  renderCurrentWifiCard();
  elWifiDeviceStatus.textContent = 'Chưa kết nối được mạch ESP32';
  elWifiCountLabel.textContent = '';
  elWifiList.innerHTML = '<div class="wifi-empty">Cắm mạch ESP32 qua USB, bật Backend rồi bấm Quét lại</div>';
  showWifiFeedback(
    err.message === 'Failed to fetch'
      ? 'Backend Python chưa chạy (hãy chạy python app.py trong thư mục backend).'
      : err.message,
    'err'
  );
}

async function loadWifiModalData() {
  selectedSsid = null;
  elWifiPasswordSection.classList.add('hidden');
  hideWifiFeedback();
  elWifiDeviceStatus.textContent = 'Đang kiểm tra trạng thái ESP32...';
  elWifiCountLabel.textContent = '';
  elWifiScanBtn.disabled = true;
  elWifiScanBtn.textContent = 'Đang quét...';
  elWifiList.innerHTML = '<div class="wifi-empty">Đang kiểm tra WiFi hiện tại và quét mạng xung quanh...</div>';

  try {
    const statusRes = await fetch(`${API_BASE_URL}/api/wifi/status`, { cache: 'no-store' });
    const statusData = await statusRes.json();
    if (!statusRes.ok) {
      throw new Error(statusData.error || 'Không thể kiểm tra trạng thái ESP32');
    }

    currentWifiStatus = statusData;
    renderCurrentWifiCard();
    elWifiDeviceStatus.textContent = `Đã nhận mạch (${statusData.port}) — đang quét WiFi...`;

    const scanRes = await fetch(`${API_BASE_URL}/api/wifi/scan`, { cache: 'no-store' });
    const scanData = await scanRes.json();
    if (!scanRes.ok) {
      throw new Error(scanData.error || 'Không thể quét WiFi từ ESP32');
    }

    scannedNetworks = Array.isArray(scanData.networks) ? scanData.networks : [];
    elWifiDeviceStatus.textContent = `Đã nhận mạch (${scanData.port})`;
    renderScannedWifiList();
  } catch (err) {
    showWifiLoadError(err);
  } finally {
    elWifiScanBtn.disabled = false;
    elWifiScanBtn.textContent = 'Quét lại';
  }
}

async function disconnectCurrentWifi() {
  elWifiDisconnectBtn.disabled = true;
  elWifiDisconnectBtn.textContent = 'Đang ngắt...';
  showWifiFeedback('Đang ngắt kết nối WiFi trên ESP32...', 'info');

  try {
    const res = await fetch(`${API_BASE_URL}/api/wifi/disconnect`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Không thể ngắt WiFi trên ESP32');
    }

    currentWifiStatus = { connected: false, ssid: '', ip: '', port: data.port };
    renderCurrentWifiCard();
    renderScannedWifiList();
    setConnectionState(false);
    showWifiFeedback('Đã ngắt kết nối WiFi trên ESP32. Chọn mạng bên dưới để kết nối lại.', 'ok');
  } catch (err) {
    showWifiFeedback(err.message || 'Ngắt kết nối WiFi thất bại.', 'err');
  } finally {
    elWifiDisconnectBtn.disabled = false;
    elWifiDisconnectBtn.textContent = 'Ngắt kết nối';
  }
}

async function connectSelectedWifi() {
  if (!selectedSsid) {
    showWifiFeedback('Hãy bấm chọn một mạng WiFi trong danh sách.', 'err');
    return;
  }

  const net = scannedNetworks.find((n) => n.ssid === selectedSsid);
  const password = elWifiPassInput.value;
  if (net && net.secured && !password) {
    showWifiFeedback('Mạng có khóa — vui lòng nhập mật khẩu WiFi.', 'err');
    elWifiPassInput.focus();
    return;
  }

  elWifiConnectBtn.disabled = true;
  elWifiConnectBtn.textContent = 'Đang gửi...';
  showWifiFeedback(`Đang gửi "${selectedSsid}" xuống ESP32 qua USB...`, 'info');

  try {
    const res = await fetch(`${API_BASE_URL}/api/wifi/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: selectedSsid, password })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'ESP32 không kết nối được WiFi');
    }

    currentWifiStatus = {
      connected: true,
      ssid: data.ssid,
      ip: data.ip || '',
      port: data.port,
      mqtt: false
    };
    selectedSsid = null;
    elWifiPasswordSection.classList.add('hidden');
    renderCurrentWifiCard();
    renderScannedWifiList();

    const ipNote = data.ip ? ` (IP: ${data.ip})` : '';
    showWifiFeedback(`ESP32 đã kết nối "${data.ssid}"${ipNote}. Dữ liệu sẽ tự cập nhật khi có gói tin MQTT.`, 'ok');
    fetchLatestSensorData();
  } catch (err) {
    showWifiFeedback(err.message || 'Gửi WiFi thất bại.', 'err');
  } finally {
    elWifiConnectBtn.disabled = false;
    elWifiConnectBtn.textContent = 'Kết nối';
  }
}

function toggleSettingsModal(show) {
  elSettingsModal.classList.toggle('hidden', !show);
  if (show) {
    loadWifiModalData();
  }
}

let currentMobileUrl = '';

async function loadMobileQrInfo() {
  elMobileQrBox.innerHTML = '<div class="qr-loading">Đang dò IP WiFi và tạo mã QR...</div>';
  elMobileQrUrl.textContent = '—';
  currentMobileUrl = '';
  elRefreshQrBtn.disabled = true;

  try {
    const port = window.location.port || '5000';
    const res = await fetch(`${API_BASE_URL}/api/lan-info?port=${encodeURIComponent(port)}`, {
      cache: 'no-store'
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        res.status === 404
          ? 'Backend đang chạy là bản cũ. Hãy đóng cửa sổ cmd cũ rồi mở lại start.bat.'
          : `Phản hồi không hợp lệ từ backend (HTTP ${res.status}).`
      );
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Không lấy được địa chỉ LAN.');
    }

    currentMobileUrl = data.url;
    elMobileQrUrl.textContent = data.url;
    elMobileQrBox.innerHTML = data.qr_svg;
  } catch (err) {
    elMobileQrBox.innerHTML = `<div class="qr-loading">${escapeHtml(err.message || 'Lỗi tạo mã QR.')}</div>`;
  } finally {
    elRefreshQrBtn.disabled = false;
  }
}

function toggleMobileQrModal(show) {
  elMobileQrModal.classList.toggle('hidden', !show);
  if (show) {
    loadMobileQrInfo();
  }
}

elSettingsBtn.addEventListener('click', () => toggleSettingsModal(true));
elCloseSettingsBtn.addEventListener('click', () => toggleSettingsModal(false));
elSettingsModal.addEventListener('click', (e) => {
  if (e.target === elSettingsModal) toggleSettingsModal(false);
});
if (elOpenMobileQrBtn) {
  elOpenMobileQrBtn.addEventListener('click', () => toggleMobileQrModal(true));
}
if (elCloseMobileQrBtn) {
  elCloseMobileQrBtn.addEventListener('click', () => toggleMobileQrModal(false));
}
if (elMobileQrModal) {
  elMobileQrModal.addEventListener('click', (e) => {
    if (e.target === elMobileQrModal) toggleMobileQrModal(false);
  });
}
if (elRefreshQrBtn) {
  elRefreshQrBtn.addEventListener('click', loadMobileQrInfo);
}
if (elCopyMobileUrlBtn) {
  elCopyMobileUrlBtn.addEventListener('click', async () => {
    if (!currentMobileUrl || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(currentMobileUrl);
      elCopyMobileUrlBtn.textContent = 'Đã copy';
      setTimeout(() => {
        elCopyMobileUrlBtn.textContent = 'Copy';
      }, 1500);
    } catch (err) {
      // Bo qua neu trinh duyet chan clipboard
    }
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!elSettingsModal.classList.contains('hidden')) {
    toggleSettingsModal(false);
  }
  if (elMobileQrModal && !elMobileQrModal.classList.contains('hidden')) {
    toggleMobileQrModal(false);
  }
});
elWifiScanBtn.addEventListener('click', loadWifiModalData);
elWifiDisconnectBtn.addEventListener('click', disconnectCurrentWifi);
elWifiConnectBtn.addEventListener('click', connectSelectedWifi);
elWifiPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    connectSelectedWifi();
  }
});
elToggleWifiPassBtn.addEventListener('click', () => {
  const isHidden = elWifiPassInput.type === 'password';
  elWifiPassInput.type = isHidden ? 'text' : 'password';
  elToggleWifiPassBtn.textContent = isHidden ? 'Ẩn' : 'Hiện';
});

// ==================================================
// EVENT LISTENERS & BOOTSTRAP
// ==================================================

elViewDataBtn.addEventListener('click', (e) => {
  if (elViewDataBtn.classList.contains('is-disabled')) {
    e.preventDefault();
  }
});

elRefreshHistoryBtn.addEventListener('click', () => {
  fetchSensorHistory();
});

if (elBuzzerBtn) {
  elBuzzerBtn.addEventListener('click', toggleBuzzerOverMqtt);
}

window.addEventListener('DOMContentLoaded', async () => {
  initSplineChart();
  setConnectionState(false);
  await hydrateChartFromRecent();
  startPolling();
});
