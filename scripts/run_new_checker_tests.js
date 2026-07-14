#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dxRules = require(path.join(__dirname, '..', 'js', 'dx_rules.js'));
const exclusionHelpers = require(path.join(__dirname, '..', 'js', 'checker_exclusions.js'));

(async () => {

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

function loadSchemaNotMergedUtils() {
  const schemaPath = path.join(__dirname, '..', 'js', 'checker_schema.js');
  const schemaCode = fs.readFileSync(schemaPath, 'utf8');
  const context = {
    window: {},
    document: {},
    console,
    DOMParser: function DOMParser() {},
    FileReader: function FileReader() {},
    XLSX: {}
  };

  vm.createContext(context);
  vm.runInContext(schemaCode, context, { filename: 'checker_schema.js' });

  const utils = context.window._schemaNotMergedUtils;
  assert(utils, 'Schema not-merged test utils were not exposed');
  return utils;
}

function createElement(name, text = '', children = []) {
  return {
    localName: name,
    nodeName: name,
    textContent: text,
    children
  };
}

await run('Exclusion exact rule match', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'J30.2', excludes1: [{ code: 'J31.0' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'J30.2', type: 'Principal' },
    { code: 'J31.0', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 1, 'Expected one exact conflict');
});

await run('Exclusion category parent-child match', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ category: 'E10', excludes1: [{ category: 'E11' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'E10.21', type: 'Principal' },
    { code: 'E11.9', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 1, 'Expected parent category to match child diagnosis');
});

await run('Exclusion prefix and range match', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ prefix: 'K35-', excludes1: [{ range: 'K36-K38' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'K35.80', type: 'Principal' },
    { code: 'K36', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 1, 'Expected prefix/range conflict');
});

await run('Exclusion detects ReasonForVisit conflicts', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'A00.1', excludes1: [{ code: 'B00.0' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'A00.1', type: 'ReasonForVisit' },
    { code: 'B00.0', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 1, 'Expected non-principal/ReasonForVisit conflict');
});

await run('Exclusion no-conflict path', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'A00.1', excludes1: [{ code: 'B00.0' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'A00.1', type: 'Principal' },
    { code: 'B99.9', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 0, 'Expected no exclusion conflict');
});

await run('Exclusion dedupes reverse duplicate rules', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [
      { code: 'J30.2', excludes1: [{ code: 'J31.0' }] },
      { code: 'J31.0', excludes1: [{ code: 'J30.2' }] }
    ]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'J31.0', type: 'Secondary' },
    { code: 'J30.2', type: 'Principal' }
  ], compiled);
  assert(findings.length === 1, 'Expected one deduplicated conflict for reverse rules');
});

await run('Exclusion ignores missing diagnosis code', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'J30.2', excludes1: [{ code: 'J31.0' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: '', type: 'Principal' },
    { code: 'J31.0', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 0, 'Expected missing code to be ignored');
});

await run('Exclusion direct child extraction ignores nested DxInfo code', () => {
  const diagnosis = createElement('Diagnosis', '', [
    createElement('Type', 'Secondary', []),
    createElement('DxInfo', '', [createElement('Code', 'J31.0', [])])
  ]);
  const extracted = exclusionHelpers.extractClaimDiagnoses({
    children: [diagnosis]
  });
  assert(extracted.length === 0, 'Expected nested DxInfo code to be ignored');
});

await run('Exclusion malformed rules are skipped safely', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'A00.1', excludes1: [{}] }, { nonsense: true }]
  });
  assert(compiled.rules.length === 0, 'Expected malformed rules to compile to zero active rules');
  assert(compiled.malformedEntries.length >= 2, 'Expected malformed entries to be reported');
});

await run('Exclusion rules-load failure surfaces error', async () => {
  dxRules.resetExclusionRulesCache();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });

  let failed = false;
  try {
    await dxRules.loadExclusionRules('/mock-path.json');
  } catch (error) {
    failed = /Failed to load Excludes1 rules/.test(error.message);
  } finally {
    global.fetch = originalFetch;
    dxRules.resetExclusionRulesCache();
  }

  assert(failed, 'Expected explicit rules load failure');
});

const schemaUtils = loadSchemaNotMergedUtils();

function ts(input) {
  return schemaUtils.parseEncounterDateTime(input);
}

function context(overrides) {
  return {
    claimID: 'C1',
    memberID: 'M1',
    payerID: 'A02',
    providerID: 'P1',
    facilityID: 'F1',
    encounterDate: '2026-01-01',
    encounterStartRaw: '01/01/2026 10:00',
    encounterEndRaw: '01/01/2026 10:30',
    parsedStart: ts('01/01/2026 10:00'),
    parsedEnd: ts('01/01/2026 10:30'),
    clinicians: new Set(['ORD1']),
    diagnosisCodes: new Set(['J302']),
    ...overrides
  };
}

await run('Not merged overlap with shared dx and clinician', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1' }),
    context({ claimID: 'C2', encounterStartRaw: '01/01/2026 10:15', encounterEndRaw: '01/01/2026 10:45', parsedStart: ts('01/01/2026 10:15'), parsedEnd: ts('01/01/2026 10:45') })
  ]);
  assert(findings.has('C1') && findings.has('C2'), 'Expected both claims to receive not-merged remarks');
});

await run('Not merged rejects non-overlap', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1' }),
    context({ claimID: 'C2', encounterStartRaw: '01/01/2026 11:00', encounterEndRaw: '01/01/2026 11:30', parsedStart: ts('01/01/2026 11:00'), parsedEnd: ts('01/01/2026 11:30') })
  ]);
  assert(!findings.has('C1') && !findings.has('C2'), 'Expected no findings when encounters do not overlap');
});

await run('Not merged requires shared diagnosis', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', diagnosisCodes: new Set(['J302']) }),
    context({ claimID: 'C2', diagnosisCodes: new Set(['J310']) })
  ]);
  assert(findings.size === 0, 'Expected no findings without shared diagnosis');
});

await run('Not merged requires shared clinician', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', clinicians: new Set(['ORD1']) }),
    context({ claimID: 'C2', clinicians: new Set(['ORD2']) })
  ]);
  assert(findings.size === 0, 'Expected no findings without shared clinician');
});

await run('Not merged enforces grouping fields', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', facilityID: 'F1' }),
    context({ claimID: 'C2', facilityID: 'F2' })
  ]);
  assert(findings.size === 0, 'Expected no findings across different facilities');
});

await run('Not merged skips self-comparisons and reverse dedupe', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1' }),
    context({ claimID: 'C1' }),
    context({ claimID: 'C2', encounterStartRaw: '01/01/2026 10:10', encounterEndRaw: '01/01/2026 10:40', parsedStart: ts('01/01/2026 10:10'), parsedEnd: ts('01/01/2026 10:40') }),
    context({ claimID: 'C2', encounterStartRaw: '01/01/2026 10:12', encounterEndRaw: '01/01/2026 10:42', parsedStart: ts('01/01/2026 10:12'), parsedEnd: ts('01/01/2026 10:42') })
  ]);
  assert((findings.get('C1') || []).length === 1, 'Expected stable pair dedupe to avoid duplicate findings');
});

await run('Not merged skips invalid encounter date and missing data', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', parsedStart: null, parsedEnd: null, encounterDate: null }),
    context({ claimID: 'C2', clinicians: new Set(), diagnosisCodes: new Set() })
  ]);
  assert(findings.size === 0, 'Expected no findings for invalid/missing date and clinician/diagnosis');
});

await run('Not merged skips payer out of scope', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', payerID: 'B01' }),
    context({ claimID: 'C2', payerID: 'B01' })
  ]);
  assert(findings.size === 0, 'Expected no findings for payer not in NOT_MERGED_PAYER_IDS');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('\nAll new checker logic tests completed.');

})();
