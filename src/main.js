import './style.css'
import { createPublicClient, http } from 'viem';
import Chart from 'chart.js/auto';
import FactoryABI from './abis/CatLabFactory.json';
import StoreABI from './abis/CatLabSecureSensorStore.abi.json';

// JIBCHAIN L1 Configuration
const jibchain = {
  id: 8899,
  name: 'JIBCHAIN L1',
  rpcUrls: {
    default: { http: ['https://rpc-l1.jibchain.net'] }
  }
};

const client = createPublicClient({
  chain: jibchain,
  transport: http()
});

// Constants
const FACTORY_ADDRESS = '0x63bB41b79b5aAc6e98C7b35Dcb0fE941b85Ba5Bb';
const FLOODBOY016_STORE = '0x0994Bc66b2863f8D58C8185b1ed6147895632812'; // Default Store
const UNIVERSAL_SIGNER = '0xcB0e58b011924e049ce4b4D62298Edf43dFF0BDd';

// State
let currentStore = FLOODBOY016_STORE;
let chartInstance = null;
let activeChartType = 'waterDepth';
let historicalCache = {
  waterDepth: [],
  batteryVoltage: []
};

document.querySelector('#app').innerHTML = `
  <div class="card">
    <header class="header">
      <div class="header-content">
        <h1 id="storeName">Loading Sensor Data...</h1>
        <p id="storeDesc" class="subtitle">Connecting to JIBCHAIN L1</p>
      </div>
      <div class="header-meta">
        <div class="status-badge"><span class="dot"></span><span id="currentBlock">Block: ---</span></div>
        <div class="update-time" id="lastUpdated">Last Updated: ---</div>
        <a id="storeLink" href="#" target="_blank" class="address-link">Store: 0x... <span class="icon">↗</span></a>
      </div>
    </header>

    <div class="chart-section">
      <div class="chart-controls">
        <button id="btnWaterDepth" class="toggle-btn active" data-type="waterDepth">Water Depth</button>
        <button id="btnBattery" class="toggle-btn" data-type="batteryVoltage">Battery Voltage</button>
      </div>
      <div class="chart-container">
        <canvas id="sensorChart"></canvas>
      </div>
      <div id="noDataMessage" class="hidden">No historical data available</div>
    </div>

    <div class="table-container">
      <table id="dataTable">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Current</th>
            <th>Min</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody id="dataTableBody">
          <tr><td colspan="4" class="loading-cell">Fetching latest records...</td></tr>
        </tbody>
      </table>
    </div>

    <footer class="footer">
      <div class="footer-info">
        <span id="footerUpdated">Last Updated: ---</span>
        <span class="separator">•</span>
        <span id="footerOwner">Owner: ---</span>
        <span class="separator">•</span>
        <span id="footerBlock">Deployed Block: ---</span>
        <span class="separator">•</span>
        <span id="footerSensors">Sensors: ---</span>
      </div>
    </footer>
  </div>
`;

// Helper: Format field names (snake_case -> Title Case)
function formatFieldName(fieldName) {
  return fieldName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Helper: Process and scale values based on unit
function processValue(value, unit) {
  const baseUnit = unit.replace(/ x\d+/, '');
  const numVal = Number(value);

  if (unit.includes('x10000')) return (numVal / 10000).toFixed(4) + ' ' + baseUnit;
  if (unit.includes('x1000')) return (numVal / 1000).toFixed(3) + ' ' + baseUnit;
  if (unit.includes('x100')) return (numVal / 100).toFixed(3) + ' ' + baseUnit;

  return value + ' ' + unit;
}

// Helper: Truncate address
function truncateAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

// Main logic
async function init() {
  try {
    const currentBlockNumber = await client.getBlockNumber();
    document.getElementById('currentBlock').textContent = `Block: ${currentBlockNumber}`;

    // 1. Fetch Store Meta from Factory
    const [nickname, owner, sensorCount, deployedBlock, description] = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: FactoryABI,
      functionName: 'getStoreInfo',
      args: [currentStore]
    });

    // Populate Header & Footer meta
    document.getElementById('storeName').textContent = nickname;
    document.getElementById('storeDesc').textContent = description;

    const storeLink = document.getElementById('storeLink');
    storeLink.textContent = `Store: ${truncateAddress(currentStore)}`;
    storeLink.href = `https://exp.jibchain.net/address/${currentStore}`;

    document.getElementById('footerOwner').innerHTML = `Owner: <a href="https://exp.jibchain.net/address/${owner}" target="_blank">${truncateAddress(owner)}</a>`;
    document.getElementById('footerBlock').innerHTML = `Deployed Block: <a href="https://exp.jibchain.net/block/${deployedBlock}" target="_blank">#${deployedBlock}</a>`;
    document.getElementById('footerSensors').textContent = `${sensorCount} authorized sensor${sensorCount > 1 ? 's' : ''}`;

    // 2. Fetch Fields & Latest Data
    const fields = await client.readContract({
      address: currentStore,
      abi: StoreABI,
      functionName: 'getAllFields'
    });

    const [timestamp, values] = await client.readContract({
      address: currentStore,
      abi: StoreABI,
      functionName: 'getLatestRecord',
      args: [UNIVERSAL_SIGNER]
    });

    const dateUpdated = new Date(Number(timestamp) * 1000);
    const dateStr = dateUpdated.toLocaleString();
    document.getElementById('lastUpdated').textContent = `Last Updated: ${dateUpdated.toLocaleTimeString()}`;
    document.getElementById('footerUpdated').textContent = `Last Updated: ${dateStr}`;

    // Calculate dynamic sample counts and find min/max
    const sampleCounts = {};
    fields.forEach(f => {
      const match = f.name.match(/^(.+)_count$/i);
      if (match) {
        const baseName = match[1].toLowerCase();
        const idx = fields.findIndex(field => field.name === f.name);
        sampleCounts[baseName] = values[idx];
      }
    });

    // Populate Table
    const tableBody = document.getElementById('dataTableBody');
    tableBody.innerHTML = '';

    const metrics = {};
    fields.forEach((f, idx) => {
      // Ignore count and min/max in main loop, we group them
      if (f.name.endsWith('_count') || f.name.endsWith('_min') || f.name.endsWith('_max')) return;

      const baseName = f.name;
      const titleName = formatFieldName(baseName);

      const minIdx = fields.findIndex(field => field.name === baseName + '_min');
      const maxIdx = fields.findIndex(field => field.name === baseName + '_max');

      let metricLabel = titleName;
      if (sampleCounts[baseName]) {
        metricLabel = `${titleName} (${sampleCounts[baseName]} samples)`;
      }

      metrics[baseName] = {
        label: metricLabel,
        current: processValue(values[idx], f.unit),
        min: minIdx >= 0 ? processValue(values[minIdx], fields[minIdx].unit) : '-',
        max: maxIdx >= 0 ? processValue(values[maxIdx], fields[maxIdx].unit) : '-'
      };
    });

    // Order rendering based on common requirements
    ['battery_voltage', 'installation_height', 'water_depth'].forEach(key => {
      if (metrics[key]) {
        const row = document.createElement('tr');
        row.innerHTML = `
           <td>${metrics[key].label}</td>
           <td class="val-current">${metrics[key].current}</td>
           <td class="val-min">${metrics[key].min}</td>
           <td class="val-max">${metrics[key].max}</td>
         `;
        tableBody.appendChild(row);
      }
    });

    // 3. Fetch Historical Data
    const fromBlock = currentBlockNumber - BigInt(28800); // ~24h

    document.getElementById('sensorChart').style.opacity = '0.5'; // Loading state

    const historicalEvents = await client.getContractEvents({
      address: currentStore,
      abi: StoreABI,
      eventName: 'RecordStored',
      fromBlock: fromBlock,
      toBlock: 'latest',
      args: {
        sensor: UNIVERSAL_SIGNER
      }
    });

    const waterDepthIndex = fields.findIndex(f => f.name === 'water_depth');
    const batteryVoltageIndex = fields.findIndex(f => f.name === 'battery_voltage');

    // Sort and map events
    const sortedEvents = historicalEvents.map(event => ({
      timestamp: Number(event.args.timestamp) * 1000,
      waterDepth: waterDepthIndex >= 0 ? Number(event.args.values[waterDepthIndex]) / 10000 : null,
      batteryVoltage: batteryVoltageIndex >= 0 ? Number(event.args.values[batteryVoltageIndex]) / 100 : null,
    })).sort((a, b) => a.timestamp - b.timestamp);

    // Grouping / Smoothing (30 min intervals -> average)
    const INTERVAL_MS = 30 * 60 * 1000;

    if (sortedEvents.length > 0) {
      document.getElementById('noDataMessage').classList.add('hidden');

      let currentInterval = Math.floor(sortedEvents[0].timestamp / INTERVAL_MS) * INTERVAL_MS;
      let sumWater = 0, countWater = 0, sumBattery = 0, countBattery = 0;

      sortedEvents.forEach(evt => {
        const evtInterval = Math.floor(evt.timestamp / INTERVAL_MS) * INTERVAL_MS;

        if (evtInterval > currentInterval) {
          if (countWater > 0) historicalCache.waterDepth.push({ x: currentInterval, y: sumWater / countWater });
          if (countBattery > 0) historicalCache.batteryVoltage.push({ x: currentInterval, y: sumBattery / countBattery });

          currentInterval = evtInterval;
          sumWater = countWater = sumBattery = countBattery = 0;
        }

        if (evt.waterDepth !== null) { sumWater += evt.waterDepth; countWater++; }
        if (evt.batteryVoltage !== null) { sumBattery += evt.batteryVoltage; countBattery++; }
      });

      // push last
      if (countWater > 0) historicalCache.waterDepth.push({ x: currentInterval, y: sumWater / countWater });
      if (countBattery > 0) historicalCache.batteryVoltage.push({ x: currentInterval, y: sumBattery / countBattery });

      renderChart();
    } else {
      document.getElementById('sensorChart').style.display = 'none';
      document.getElementById('noDataMessage').classList.remove('hidden');
    }

    document.getElementById('sensorChart').style.opacity = '1';

  } catch (err) {
    console.error("Error fetching data:", err);
    document.getElementById('storeName').textContent = 'Error Loading Data';
    document.getElementById('storeDesc').textContent = 'Please check console for details.';
  }
}

// Chart Rendering Logic
function renderChart() {
  const ctx = document.getElementById('sensorChart').getContext('2d');

  if (chartInstance) {
    chartInstance.destroy();
  }

  const isWater = activeChartType === 'waterDepth';
  const data = isWater ? historicalCache.waterDepth : historicalCache.batteryVoltage;
  const color = isWater ? '#3B82F6' : '#10B981';
  const label = isWater ? 'Water Depth (m)' : 'Battery Voltage (V)';

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: label,
        data: data.map(d => ({ x: new Date(d.x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), y: d.y })),
        borderColor: color,
        backgroundColor: color + '33',
        tension: 0.4,
        fill: true,
        pointBackgroundColor: color,
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        title: {
          display: true,
          text: `${isWater ? 'Water Depth' : 'Battery Voltage'} Over Time (30m avg)`,
          font: { size: 16, weight: '600' }
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return `${context.parsed.y.toFixed(isWater ? 4 : 3)} ${isWater ? 'm' : 'V'}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false }
        },
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: isWater ? 'Meters (m)' : 'Volts (V)'
          }
        }
      }
    }
  });

  // Update buttons
  document.getElementById('btnWaterDepth').classList.toggle('active', isWater);
  document.getElementById('btnBattery').classList.toggle('active', !isWater);

  // Update button colors based on active state
  document.getElementById('btnWaterDepth').style.backgroundColor = isWater ? '#3B82F6' : '#f3f4f6';
  document.getElementById('btnWaterDepth').style.color = isWater ? 'white' : '#4b5563';

  document.getElementById('btnBattery').style.backgroundColor = !isWater ? '#10B981' : '#f3f4f6';
  document.getElementById('btnBattery').style.color = !isWater ? 'white' : '#4b5563';
}

// Listeners
document.getElementById('btnWaterDepth').addEventListener('click', () => {
  activeChartType = 'waterDepth';
  renderChart();
});

document.getElementById('btnBattery').addEventListener('click', () => {
  activeChartType = 'batteryVoltage';
  renderChart();
});

// Run
init();
