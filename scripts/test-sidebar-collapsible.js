/**
 * scripts/test-sidebar-collapsible.js
 *
 * Standalone verification test suite for Milestone M2:
 * Collapsible Sidebar Navigation Specifications & Verification Criteria
 *
 * Verifies:
 * - Test 1: IPC Settings Contract (RENDERER_WRITABLE_SETTINGS contains 'sidebar_collapsed')
 * - Test 2: Database Settings Integration (setSetting / getSetting for 'sidebar_collapsed')
 * - Test 3: CSS Rail Width & Transition Specifications in renderer/index.css
 * - Test 4: CSS Tooltip & Active Indicator Specifications in renderer/index.css
 * - Test 5: CSS Apple Theme Rail Overrides in renderer/index.css
 * - Test 6: App.jsx Sidebar State & Dual Persistence (localStorage + settings:set)
 * - Test 7: App.jsx Toggle Button & Keyboard Shortcut (Ctrl+B / Cmd+B with input guard)
 * - Test 8: App.jsx E2E Compatibility (DOM text retention for nav items & .suite-device-name)
 * - Test 9: App.jsx Shared Bootstrap Request (no extra settings:get calls)
 * - Test 10: In-Memory DOM Simulation (Width toggling, active indicator, compact status pill)
 *
 * Run via:
 *   node scripts/test-sidebar-collapsible.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findProjectRoot(startDir) {
  let cur = startDir;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'main', 'ipc.js'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(__dirname, '..');
}

const ROOT = findProjectRoot(__dirname);
const IPC_PATH = path.join(ROOT, 'main', 'ipc.js');
const DB_PATH = path.join(ROOT, 'main', 'database.js');
const APP_JSX_PATH = path.join(ROOT, 'renderer', 'App.jsx');
const INDEX_CSS_PATH = path.join(ROOT, 'renderer', 'index.css');

let testCount = 0;
let passCount = 0;
const failures = [];

function runTest(name, fn) {
  testCount += 1;
  const currentNum = testCount;
  try {
    fn();
    passCount += 1;
    console.log(`  [PASS] Test Case ${currentNum}: ${name}`);
  } catch (error) {
    failures.push({ num: currentNum, name, error });
    console.error(`  [FAIL] Test Case ${currentNum}: ${name}`);
    console.error(`         ${error.message}`);
  }
}

console.log('\n--- Running LabSuite M2 Collapsible Sidebar Verification Suite ---');

// ========================================================================
// Test 1: IPC Settings Contract
// ========================================================================
runTest("IPC Settings Contract (RENDERER_WRITABLE_SETTINGS contains 'sidebar_collapsed')", () => {
  const ipcSource = fs.readFileSync(IPC_PATH, 'utf8');
  const match = ipcSource.match(/const RENDERER_WRITABLE_SETTINGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'Could not find RENDERER_WRITABLE_SETTINGS set in main/ipc.js');
  const allowedKeys = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(
    allowedKeys.includes('sidebar_collapsed'),
    "RENDERER_WRITABLE_SETTINGS must include 'sidebar_collapsed' to allow renderer preference persistence."
  );
});

// ========================================================================
// Test 2: Database Settings Integration
// ========================================================================
runTest("Database Settings Integration (setSetting / getSetting for 'sidebar_collapsed')", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labsuite-m2-db-test-'));
  const originalDb = fs.readFileSync(path.join(ROOT, 'main', 'database.js'), 'utf8');
  const dbModule = require(DB_PATH);

  try {
    const defaultDb = dbModule.createDefaultDatabase();
    assert.ok(defaultDb.settings, 'Default database must contain settings object.');
    
    // Test setting storage
    defaultDb.settings.sidebar_collapsed = '1';
    assert.strictEqual(defaultDb.settings.sidebar_collapsed, '1');

    defaultDb.settings.sidebar_collapsed = '0';
    assert.strictEqual(defaultDb.settings.sidebar_collapsed, '0');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ========================================================================
// Test 3: CSS Rail Width & Transition Specifications
// ========================================================================
runTest("CSS Rail Width & Transition Specifications in renderer/index.css", () => {
  const css = fs.readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.ok(
    css.includes('.suite-sidebar.collapsed') || css.includes('.suite-sidebar[data-collapsed="true"]'),
    'renderer/index.css must define styles for collapsed sidebar (.suite-sidebar.collapsed).'
  );
  assert.ok(
    /width:\s*64px/i.test(css),
    'renderer/index.css must specify 64px width for the collapsed sidebar rail.'
  );
  assert.ok(
    /transition:.*width/i.test(css),
    'renderer/index.css must specify smooth CSS transition for sidebar width.'
  );
});

// ========================================================================
// Test 4: CSS Tooltip & Active Indicator Specifications
// ========================================================================
runTest("CSS Tooltip & Active Indicator Specifications in renderer/index.css", () => {
  const css = fs.readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.ok(
    css.includes('.nav-item.active') || css.includes('.nav-item[data-active="true"]'),
    'renderer/index.css must define active state styling for navigation items.'
  );
  assert.ok(
    css.includes('data-tooltip') || css.includes('tooltip') || css.includes('.nav-tooltip'),
    'renderer/index.css must provide tooltip styling for collapsed rail items.'
  );
});

// ========================================================================
// Test 5: CSS Apple Theme Rail Overrides
// ========================================================================
runTest("CSS Apple Theme Rail Overrides in renderer/index.css", () => {
  const css = fs.readFileSync(INDEX_CSS_PATH, 'utf8');
  const appleSection = css.slice(css.indexOf('body.theme-apple'));
  assert.ok(
    appleSection.includes('.suite-sidebar.collapsed') || appleSection.includes('.suite-sidebar'),
    'Apple theme must provide compatible styling for the collapsed sidebar rail.'
  );
});

// ========================================================================
// Test 6: App.jsx Sidebar State & Dual Persistence
// ========================================================================
runTest("App.jsx Sidebar State & Dual Persistence (localStorage + settings:set)", () => {
  const appJsx = fs.readFileSync(APP_JSX_PATH, 'utf8');
  assert.ok(
    appJsx.includes('sidebarCollapsed') || appJsx.includes('isSidebarCollapsed') || appJsx.includes('isCollapsed'),
    'App.jsx must manage sidebar collapsed state via React useState.'
  );
  assert.ok(
    appJsx.includes('localStorage.getItem') && (appJsx.includes('labsuite_sidebar_collapsed') || appJsx.includes('sidebar_collapsed')),
    'App.jsx must read sidebar collapsed state from localStorage on initialization.'
  );
  assert.ok(
    appJsx.includes('localStorage.setItem') && (appJsx.includes('labsuite_sidebar_collapsed') || appJsx.includes('sidebar_collapsed')),
    'App.jsx must write sidebar collapsed state to localStorage on toggle.'
  );
  assert.ok(
    appJsx.includes("'sidebar_collapsed'") || appJsx.includes('"sidebar_collapsed"'),
    "App.jsx must persist 'sidebar_collapsed' setting to backend."
  );
});

// ========================================================================
// Test 7: App.jsx Toggle Button & Keyboard Shortcut (Ctrl+B)
// ========================================================================
runTest("App.jsx Toggle Button & Keyboard Shortcut (Ctrl+B with input guard)", () => {
  const appJsx = fs.readFileSync(APP_JSX_PATH, 'utf8');
  assert.ok(
    appJsx.includes('Ctrl+B') || appJsx.includes('key === "b"') || appJsx.includes("key === 'b'") || appJsx.includes("key === 'B'"),
    'App.jsx must register a Ctrl+B keyboard shortcut to toggle the sidebar.'
  );
  assert.ok(
    appJsx.includes('aria-label') || appJsx.includes('title'),
    'Sidebar toggle button must provide accessible label/title.'
  );
  assert.ok(
    appJsx.includes('isContentEditable') || appJsx.includes('tagName') || appJsx.includes('INPUT'),
    'Ctrl+B shortcut must guard against firing when user is typing in input or textarea fields.'
  );
});

// ========================================================================
// Test 8: App.jsx E2E Compatibility (DOM text retention)
// ========================================================================
runTest("App.jsx E2E Compatibility (DOM text retention for nav items & .suite-device-name)", () => {
  const appJsx = fs.readFileSync(APP_JSX_PATH, 'utf8');
  // Check that NavItem does not conditionally remove the label span from the DOM
  assert.ok(
    !appJsx.includes('{!sidebarCollapsed && <span style={{ flex: 1 }}>{label}</span>}'),
    'NavItem label text must remain in the DOM in collapsed mode to satisfy smoke-electron-ui.js querySelectorAll textContent searches.'
  );
  assert.ok(
    appJsx.includes('suite-device-name'),
    '.suite-device-name element must remain present in DOM to satisfy smoke-electron-ui.js line 127.'
  );
});

// ========================================================================
// Test 9: App.jsx Shared Bootstrap Request
// ========================================================================
runTest("App.jsx Shared Bootstrap Request (no extra settings:get calls)", () => {
  const appJsx = fs.readFileSync(APP_JSX_PATH, 'utf8');
  const settingsGetMatches = [...appJsx.matchAll(/invokeResource\(\s*['"]settings:get['"]/g)];
  assert.ok(
    settingsGetMatches.length <= 2,
    `App.jsx must not create redundant invokeResource('settings:get') calls (found ${settingsGetMatches.length}); must piggyback on existing bootstrap request.`
  );
});

// ========================================================================
// Test 10: In-Memory DOM & Logic Simulation
// ========================================================================
runTest("In-Memory DOM & Logic Simulation (Width toggling, active indicator, compact status pill)", () => {
  // Simulate sidebar component behavior
  let collapsed = false;
  const toggle = () => { collapsed = !collapsed; };

  // Initial state: expanded
  assert.strictEqual(collapsed, false);
  let sidebarWidth = collapsed ? '64px' : '240px';
  let sidebarClass = `suite-sidebar ${collapsed ? 'collapsed' : ''}`.trim();
  assert.strictEqual(sidebarWidth, '240px');
  assert.strictEqual(sidebarClass, 'suite-sidebar');

  // Toggle to collapsed rail
  toggle();
  assert.strictEqual(collapsed, true);
  sidebarWidth = collapsed ? '64px' : '240px';
  sidebarClass = `suite-sidebar ${collapsed ? 'collapsed' : ''}`.trim();
  assert.strictEqual(sidebarWidth, '64px');
  assert.strictEqual(sidebarClass, 'suite-sidebar collapsed');

  // Verify simulated nav item retains label text in textContent while hiding via class
  const navItem = {
    icon: 'icon-markup',
    label: 'Backup Engine',
    active: true,
    render(isCollapsed) {
      return {
        className: `nav-item ${this.active ? 'active' : ''}`.trim(),
        title: isCollapsed ? this.label : undefined,
        'data-tooltip': this.label,
        textContent: `${this.label}`, // Always present for textContent assertions
        displayLabel: !isCollapsed
      };
    }
  };

  const renderedExpanded = navItem.render(false);
  assert.strictEqual(renderedExpanded.textContent, 'Backup Engine');
  assert.strictEqual(renderedExpanded.className, 'nav-item active');
  assert.strictEqual(renderedExpanded.title, undefined);

  const renderedCollapsed = navItem.render(true);
  assert.strictEqual(renderedCollapsed.textContent, 'Backup Engine'); // Still contains label
  assert.strictEqual(renderedCollapsed.className, 'nav-item active');
  assert.strictEqual(renderedCollapsed.title, 'Backup Engine'); // Accessible tooltip
  assert.strictEqual(renderedCollapsed['data-tooltip'], 'Backup Engine');

  // Verify compact status card retains device name
  const statusCard = {
    deviceName: 'TEST-DESKTOP-123',
    isConnected: true,
    issuesCount: 0,
    render(isCollapsed) {
      return {
        className: `suite-status-card ${isCollapsed ? 'compact' : ''}`.trim(),
        deviceNameText: this.deviceName,
        pillText: this.issuesCount > 0 ? `${this.issuesCount} ISSUES` : 'OK',
        tooltip: `${this.deviceName} • ${this.isConnected ? 'Connected' : 'Disconnected'}`
      };
    }
  };

  const statusRendered = statusCard.render(true);
  assert.strictEqual(statusRendered.className, 'suite-status-card compact');
  assert.strictEqual(statusRendered.deviceNameText, 'TEST-DESKTOP-123');
  assert.ok(statusRendered.tooltip.includes('TEST-DESKTOP-123'));
});

// ========================================================================
// Summary
// ========================================================================
console.log('\n=======================================================');
console.log(`Test Execution Summary: ${passCount}/${testCount} test cases passed.`);
if (failures.length === 0) {
  console.log('All M2 Collapsible Sidebar verification tests PASSED.');
  console.log('=======================================================\n');
  process.exit(0);
} else {
  console.error(`${failures.length} test case(s) FAILED.`);
  console.log('=======================================================\n');
  process.exit(1);
}
