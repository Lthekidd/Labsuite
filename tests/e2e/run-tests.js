const runner = require('./runner');
const tier1 = require('./tier1_feature_coverage');
const tier2 = require('./tier2_boundary_cases');
const tier3 = require('./tier3_cross_feature');
const tier4 = require('./tier4_real_world');
const tier5 = require('./tier5_advanced_features');

async function main() {
  console.log('==================================================');
  console.log('LabSuite E2E Test Suite');
  console.log('Running 53 tests sequentially...');
  console.log('==================================================\n');

  // Back up Windows Credential Manager password
  console.log('Backing up Windows Credential Manager password...');
  await runner.backupCredentialManager();

  const allTests = {
    // Tier 1 Feature Coverage
    ...tier1,
    // Tier 2 Boundary Cases
    ...tier2,
    // Tier 3 Cross Feature
    ...tier3,
    // Tier 4 Real World Scenarios
    ...tier4,
    // Tier 5 Advanced Features
    ...tier5
  };

  const testNames = Object.keys(allTests);
  console.log(`Loaded ${testNames.length} test cases.`);

  const passed = [];
  const failed = [];

  try {
    for (let i = 0; i < testNames.length; i++) {
      const name = testNames[i];
      const fn = allTests[name];
      process.stdout.write(`[${i + 1}/${testNames.length}] Running ${name}... `);

      const startTime = Date.now();
      try {
        await fn();
        const duration = Date.now() - startTime;
        console.log(`✅ PASSED (${duration}ms)`);
        passed.push({ name, duration });
      } catch (err) {
        const duration = Date.now() - startTime;
        console.log(`❌ FAILED (${duration}ms)`);
        console.error(`   Error: ${err.message}`);
        if (err.stack) {
          // Print a snippet of stack trace for debugging
          console.error(err.stack.split('\n').slice(0, 3).map(line => `      ${line}`).join('\n'));
        }
        failed.push({ name, duration, error: err.message });
      }
    }
  } finally {
    // Restore Windows Credential Manager password
    console.log('\nRestoring Windows Credential Manager password...');
    await runner.restoreCredentialManager();
  }

  console.log('\n==================================================');
  console.log('E2E TEST RUN SUMMARY');
  console.log(`Total Tests Run: ${testNames.length}`);
  console.log(`Passed:          ${passed.length}`);
  console.log(`Failed:          ${failed.length}`);
  console.log('==================================================');

  if (failed.length > 0) {
    console.log('\nFailed Tests:');
    failed.forEach(f => {
      console.log(`- ${f.name} (Error: ${f.error})`);
    });
    process.exit(1);
  } else {
    console.log('\n🎉 ALL E2E TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error running test suite:', err);
  process.exit(1);
});
