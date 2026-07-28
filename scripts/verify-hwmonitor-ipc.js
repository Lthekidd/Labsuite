const labHwMonitor = require('../main/labHwMonitor');

async function testHwMonitor() {
  console.log('Running LabHWMonitor backend & IPC contract verification tests...');

  // 1. Check initial sampling state is inactive (Zero-Idle Overhead)
  if (labHwMonitor.isSampling()) {
    console.error('FAIL: LabHWMonitor sampling loop should be INACTIVE on startup.');
    process.exit(1);
  }

  // 2. Fetch snapshot directly
  const snapshot = await labHwMonitor.collectMetricsSnapshot();
  if (!snapshot || !snapshot.cpu || !snapshot.memory || !snapshot.system) {
    console.error('FAIL: Metrics snapshot missing expected payload structure.');
    process.exit(1);
  }

  console.log(`[PASS] CPU Model: ${snapshot.cpu.model}`);
  console.log(`[PASS] Total Memory: ${(snapshot.memory.total / (1024 * 1024 * 1024)).toFixed(1)} GB`);
  console.log(`[PASS] System Uptime: ${snapshot.system.uptimeFormatted}`);

  console.log('LabHWMonitor backend & IPC contract verification tests passed successfully!');
}

testHwMonitor().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
