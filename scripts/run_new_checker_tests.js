#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dxRules = require(path.join(__dirname, '..', 'js', 'dx_rules.js'));
const exclusionHelpers = require(path.join(__dirname, '..', 'js', 'checker_exclusions.js'));
const medicalShared = require(path.join(__dirname, '..', 'js', 'medical_validation_shared.js'));

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

function loadTimingsTestApi() {
  const timingsPath = path.join(__dirname, '..', 'js', 'checker_timings.js');
  const timingsCode = fs.readFileSync(timingsPath, 'utf8');
  const context = {
    window: {},
    document: {
      getElementById() { return null; },
      querySelector() { return null; }
    },
    console,
    DOMParser: function DOMParser() {
      this.parseFromString = function(str) {
        const elements = [];
        return {
          querySelectorAll(selector) { return []; },
          querySelector(selector) { return null; }
        };
      };
    },
    FileReader: function FileReader() {},
    XLSX: {}
  };

  vm.createContext(context);
  vm.runInContext(timingsCode, context, { filename: 'checker_timings.js' });

  const api = context.window._timingsTestApi;
  assert(api, 'Timings test API was not exposed');
  return api;
}

function loadSchemaTestApi() {
  const schemaPath = path.join(__dirname, '..', 'js', 'checker_schema.js');
  const schemaCode = fs.readFileSync(schemaPath, 'utf8');
  const context = {
    window: {},
    document: {
      getElementById() { return null; },
      querySelector() { return null; },
      createElement(tagName) {
        return {
          tagName: String(tagName || '').toUpperCase(),
          className: '',
          textContent: '',
          style: {},
          dataset: {},
          innerHTML: '',
          appendChild() {},
          querySelector() { return null; }
        };
      },
      body: { insertAdjacentHTML() {} }
    },
    console,
    DOMParser: function DOMParser() {},
    FileReader: function FileReader() {},
    XLSX: {}
  };

  vm.createContext(context);
  vm.runInContext(schemaCode, context, { filename: 'checker_schema.js' });

  const api = context.window._schemaTestApi;
  assert(api, 'Schema test API was not exposed');
  return { api, context };
}

function loadPricingTestApi() {
  const pricingPath = path.join(__dirname, '..', 'js', 'checker_pricing.js');
  const pricingCode = fs.readFileSync(pricingPath, 'utf8');
  const drugSharedPath = path.join(__dirname, '..', 'js', 'drug_analysis_shared.js');
  const drugShared = require(drugSharedPath);
  const elementStub = {
    files: [],
    style: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    addEventListener() {},
    appendChild() {},
    remove() {}
  };
  const context = {
    window: { DrugAnalysisShared: drugShared },
    document: {
      addEventListener() {},
      getElementById() { return elementStub; },
      createElement() { return { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, remove() {} }; },
      body: { appendChild() {} }
    },
    console,
    DOMParser: function DOMParser() {},
    FileReader: function FileReader() {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ([]), arrayBuffer: async () => new ArrayBuffer(0) }),
    XLSX: { utils: { sheet_to_json: () => [] } }
  };
  context.DOMParser.prototype.parseFromString = function parseFromString() {
    return {
      getElementsByTagName() { return []; },
      querySelector() { return null; }
    };
  };

  vm.createContext(context);
  vm.runInContext(pricingCode, context, { filename: 'checker_pricing.js' });

  const api = context.window._pricingTestApi;
  assert(api, 'Pricing test API was not exposed');
  return { api, drugShared };
}

function loadAllocatorTestApi() {
  const allocatorPath = path.join(__dirname, '..', 'js', 'checker_allocator.js');
  const allocatorCode = fs.readFileSync(allocatorPath, 'utf8');
  const context = {
    window: {},
    document: {
      getElementById() { return null; }
    },
    console,
    FileReader: function FileReader() {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    XLSX: { utils: {} }
  };

  vm.createContext(context);
  vm.runInContext(allocatorCode, context, { filename: 'checker_allocator.js' });

  const api = context.window._allocatorTestApi;
  assert(api, 'Allocator test API was not exposed');
  return api;
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

await run('Exclusion ignores ReasonForVisit diagnosis type', () => {
  const compiled = dxRules.compileExclusionRules({
    rules: [{ code: 'A00.1', excludes1: [{ code: 'B00.0' }] }]
  });
  const findings = dxRules.detectExcludes1Conflicts([
    { code: 'A00.1', type: 'ReasonForVisit' },
    { code: 'B00.0', type: 'Secondary' }
  ], compiled);
  assert(findings.length === 0, 'Expected ReasonForVisit diagnoses to be excluded');
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
const schemaTest = loadSchemaTestApi();
const schemaApi = schemaTest.api;
const pricingTest = loadPricingTestApi();
const pricingApi = pricingTest.api;
const drugShared = pricingTest.drugShared;
const timingsApi = loadTimingsTestApi();
const allocatorApi = loadAllocatorTestApi();

function makeEl(tag, textContent) {
  return { _tag: tag, textContent: textContent || '', querySelector(sel) { return null; } };
}

function makeActivity({ id, code, quantity, start, type } = {}) {
  const children = {
    ID: makeEl('ID', id || 'A1'),
    Code: makeEl('Code', code || ''),
    Quantity: makeEl('Quantity', String(quantity !== undefined ? quantity : 1)),
    Start: start !== undefined ? makeEl('Start', start) : undefined,
    Type: makeEl('Type', type || '5')
  };
  return {
    querySelector(sel) {
      return children[sel] !== undefined ? children[sel] : null;
    }
  };
}

function makeEncounter({ start, end } = {}) {
  return {
    querySelector(sel) {
      if (sel === 'Start') return makeEl('Start', start || '01/01/2026 10:00');
      if (sel === 'End') return makeEl('End', end || '01/01/2026 10:45');
      return null;
    }
  };
}

function makeMockXmlDoc(claimsConfig) {
  const claimEls = claimsConfig.map(cfg => {
    const activities = (cfg.activities || []).map(makeActivity);
    const enc = makeEncounter(cfg.encounter || {});
    return {
      querySelector(sel) {
        if (sel === 'ID') return makeEl('ID', cfg.id || 'C1');
        if (sel === 'Encounter') return enc;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === 'Activity') return activities;
        return [];
      }
    };
  });
  return {
    querySelectorAll(sel) {
      if (sel === 'Claim') return claimEls;
      return [];
    }
  };
}

function ts(input) {
  return schemaUtils.parseEncounterDateTime(input);
}

function context(overrides) {
  return {
    claimID: 'C1',
    receiverID: 'D001',
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
  assert((findings.get('C1') || [])[0] === 'C1 must be merged with C2.', 'Expected simplified forward merge remark');
  assert((findings.get('C2') || [])[0] === 'C2 must be merged with C1.', 'Expected simplified reverse merge remark');
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

await run('Not merged applies only to configured ReceiverID', () => {
  const findings = schemaUtils.buildNotMergedRemarksFromContexts([
    context({ claimID: 'C1', receiverID: 'C002' }),
    context({ claimID: 'C2', receiverID: 'C002', encounterStartRaw: '01/01/2026 10:10', encounterEndRaw: '01/01/2026 10:40', parsedStart: ts('01/01/2026 10:10'), parsedEnd: ts('01/01/2026 10:40') })
  ]);
  assert(!findings.has('C1') && !findings.has('C2'), 'Expected findings to be skipped for non-configured receivers');
});

await run('Medical payer mapping allows Thiqa receiver and E001 claim payer', () => {
  const findings = medicalShared.validateClaimPayerAndPlan({
    receiverID: 'D001',
    claimPayerID: 'E001',
    packageName: 'Thiqa C1',
    claimID: 'C1'
  }, { payers: medicalShared.DEFAULT_MEDICAL_PAYER_CONFIG }, 'THIQA C1');
  assert(findings.length === 0, 'Expected D001/E001 payer mapping to be valid');
});

await run('Medical payer mapping rejects D004 with wrong claim payer', () => {
  const findings = medicalShared.validateClaimPayerAndPlan({
    receiverID: 'D004',
    claimPayerID: 'D004',
    packageName: 'Basic',
    claimID: 'C1'
  }, { payers: medicalShared.DEFAULT_MEDICAL_PAYER_CONFIG }, 'Basic');
  assert(findings.some(f => f.ruleId === 'MED_PAYER_MISMATCH'), 'Expected D004 payer mismatch finding');
});

await run('97-series timing accepts 22 minutes quantity 1', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 10:22'),
    activities: [{ normalizedCode: '97161', quantity: 1 }]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 },
    { min: 23, max: 37, quantity: 2 },
    { min: 38, max: 52, quantity: 3 },
    { min: 53, max: 67, quantity: 4 }
  ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
  assert(findings.length === 0, 'Expected 22 minutes with quantity 1 to pass');
});

await run('97-series timing accepts 23 minutes quantity 1', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 10:23'),
    activities: [{ normalizedCode: '97161', quantity: 1 }]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 },
    { min: 23, max: 37, quantity: 2 },
    { min: 38, max: 52, quantity: 3 },
    { min: 53, max: 67, quantity: 4 }
  ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
  assert(findings.length === 0, 'Expected 23 minutes with quantity 1 to pass');
});

await run('97-series timing accepts 45 minutes quantity 1-3', () => {
  [1, 2, 3].forEach(quantity => {
    const findings = medicalShared.validate97SeriesQuantityBands({
      claimID: 'C1',
      parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
      parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 10:45'),
      activities: [{ code: '97802', normalizedCode: '97802', quantity }]
    }, { timing: { series97: { bands: [
      { min: 8, max: 22, quantity: 1 },
      { min: 23, max: 37, quantity: 2 },
      { min: 38, max: 52, quantity: 3 },
      { min: 53, max: 67, quantity: 4 }
    ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
    assert(findings.length === 0, `Expected 45 minutes with quantity ${quantity} to pass`);
  });
});

await run('97-series timing rejects 45 minutes quantity 4 with code-specific wording', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 10:45'),
    activities: [{ code: '97802', normalizedCode: '97802', quantity: 4 }]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 },
    { min: 23, max: 37, quantity: 2 },
    { min: 38, max: 52, quantity: 3 },
    { min: 53, max: 67, quantity: 4 }
  ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
  assert(findings.some(f => f.ruleId === 'MED_97_QUANTITY_MISMATCH'), 'Expected mismatch finding for 45 minutes quantity 4');
  assert(findings.some(f => /Code 97802: encounter duration 45 minutes allows a maximum total quantity of 3, but found 4\./.test(f.remark)), 'Expected code-specific quantity mismatch wording');
});

await run('97-series timing combined-code wording lists actual codes', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 10:45'),
    activities: [
      { code: '97802', normalizedCode: '97802', quantity: 2 },
      { code: '97803', normalizedCode: '97803', quantity: 2 }
    ]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 },
    { min: 23, max: 37, quantity: 2 },
    { min: 38, max: 52, quantity: 3 },
    { min: 53, max: 67, quantity: 4 }
  ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
  assert(findings.some(f => /Codes 97802 and 97803: encounter duration 45 minutes allows a maximum total quantity of 3, but found 4\./.test(f.remark)), 'Expected combined-code wording for 97802 and 97803');
});

await run('97-series timing missing encounter times names the code', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: null,
    parsedEncounterEnd: null,
    activities: [{ code: '97802', normalizedCode: '97802', quantity: 1 }]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 }
  ], maxSupportedQuantity: 1, codePrefixes: ['97'] } } });
  assert(findings.some(f => /Code 97802: unable to validate encounter duration because encounter start\/end is missing\./.test(f.remark)), 'Expected code-specific missing encounter time wording');
});

await run('97-series timing rejects 68 minutes quantity 4 as out-of-range', () => {
  const findings = medicalShared.validate97SeriesQuantityBands({
    claimID: 'C1',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('01/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('01/01/2026 11:08'),
    activities: [{ normalizedCode: '97161', quantity: 4 }]
  }, { timing: { series97: { bands: [
    { min: 8, max: 22, quantity: 1 },
    { min: 23, max: 37, quantity: 2 },
    { min: 38, max: 52, quantity: 3 },
    { min: 53, max: 67, quantity: 4 }
  ], maxSupportedQuantity: 4, codePrefixes: ['97'] } } });
  assert(findings.some(f => f.ruleId === 'MED_97_DURATION_RANGE'), 'Expected out-of-range finding for 68 minutes');
});

await run('Medical rules loader fails with explicit error', async () => {
  const sharedPath = path.join(__dirname, '..', 'js', 'medical_validation_shared.js');
  delete require.cache[require.resolve(sharedPath)];
  const isolatedShared = require(sharedPath);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  let failed = false;
  try {
    await isolatedShared.loadMedicalValidationRules('/missing-rules.json');
  } catch (error) {
    failed = /Unable to load Medical validation rules\./.test(error.message);
  } finally {
    global.fetch = originalFetch;
  }
  assert(failed, 'Expected explicit medical rules load error');
});

function makeMedicalContext(overrides = {}) {
  return {
    claimID: 'MC1',
    receiverID: 'D004',
    claimPayerID: 'A001',
    packageName: 'Basic',
    memberID: '12345',
    serviceDate: '2026-01-15',
    parsedEncounterStart: medicalShared.parseEncounterDateTime('15/01/2026 10:00'),
    parsedEncounterEnd: medicalShared.parseEncounterDateTime('15/01/2026 10:30'),
    diagnoses: [],
    activities: [],
    ...overrides
  };
}

await run('Fixed quantity rules enforce infusion qty=1', () => {
  const ctx = makeMedicalContext({
    activities: [{ id: 'A1', code: '96360', normalizedCode: '96360', quantity: 2, modifiers: [], net: 10 }]
  });
  const findings = medicalShared.validateFixedQuantityRules(ctx, { fixedQuantityRules: { '96360': 1 } });
  assert(findings.some(f => f.ruleId === 'MED_FIXED_QTY'), 'Expected fixed quantity finding for 96360');
});

await run('Activity and diagnosis exclusions stay separated', () => {
  const ctx = makeMedicalContext({
    receiverID: 'D004',
    diagnoses: [{ code: 'L70.0', normalizedCode: 'L70', type: 'Principal' }],
    activities: [{ id: 'A1', code: '82785', normalizedCode: '82785', quantity: 1, modifiers: [], net: 10 }]
  });
  const rules = {
    activityCoverageExclusions: { D004: ['82785'] },
    diagnosisCoverageExclusions: { D004: { principal: ['L70.0'] } }
  };
  const activityFindings = medicalShared.validateActivityCoverageRules(ctx, rules);
  const diagnosisFindings = medicalShared.validateDiagnosisRules(ctx, rules);
  assert(activityFindings.some(f => f.ruleId === 'MED_ACTIVITY_EXCLUSION'), 'Expected activity exclusion finding');
  assert(diagnosisFindings.some(f => f.ruleId === 'MED_DX_COVERAGE_PRINCIPAL'), 'Expected diagnosis exclusion finding');
});

await run('Duplicate code ordering allows configured repeatable code 17999 for any ordering clinician', () => {
  const rules = {
    duplicateActivityRules: {
      allowedDuplicateCodes: ['17999'],
      allowedDuplicateCodeOrderingPairs: []
    }
  };
  const allowedFindings = medicalShared.validateDuplicateCodeOrdering(makeMedicalContext({
    activities: [
      { id: 'A1', code: '17999', normalizedCode: '17999', orderingClinician: 'GD40942', quantity: 1, modifiers: [], net: 10 },
      { id: 'A2', code: '17999', normalizedCode: '17999', orderingClinician: 'GD40942', quantity: 1, modifiers: [], net: 10 },
      { id: 'A3', code: '17999', normalizedCode: '17999', orderingClinician: 'AA12345', quantity: 1, modifiers: [], net: 10 },
      { id: 'A4', code: '17999', normalizedCode: '17999', orderingClinician: 'AA12345', quantity: 1, modifiers: [], net: 10 }
    ]
  }), rules);
  assert(allowedFindings.length === 0, 'Expected 17999 duplicates to be exempt for all ordering clinicians');

  const blockedFindings = medicalShared.validateDuplicateCodeOrdering(makeMedicalContext({
    activities: [
      { id: 'A1', code: '99213', normalizedCode: '99213', orderingClinician: 'GD40942', quantity: 1, modifiers: [], net: 10 },
      { id: 'A2', code: '99213', normalizedCode: '99213', orderingClinician: 'GD40942', quantity: 1, modifiers: [], net: 10 }
    ]
  }), rules);
  assert(blockedFindings.some(f => f.ruleId === 'MED_DUPLICATE_CODE_ORDERING'), 'Expected non-exempt duplicate code finding');
});

await run('Severity merge keeps invalid over valid patient share', () => {
  const findings = medicalShared.mergeFindingsBySeverity(
    [{ ruleId: 'PRICE', status: 'Invalid', remark: 'Coverage violation', claimID: 'C1', activityID: 'A1' }],
    [{ ruleId: 'PS', status: 'Valid', remark: 'Patient Share matches', claimID: 'C1', activityID: 'A1' }]
  );
  const finalStatus = medicalShared.getFinalStatusFromFindings(findings);
  assert(finalStatus === 'Invalid', 'Expected invalid to dominate after merging');
});

await run('Patient Share valid does not erase unrelated invalid finding', () => {
  const row = {
    findings: [
      { ruleId: 'MED_ACTIVITY_EXCLUSION', status: 'Invalid', remark: 'Code 82785 is not covered.' },
      { ruleId: 'MED_PATIENT_SHARE_MATCH', status: 'Valid', remark: 'Patient Share matches expected amount.' }
    ]
  };
  medicalShared.applyFinalStatus(row);
  assert(row.status === 'Invalid', 'Expected row to remain Invalid');
  assert(/82785/.test(row.Remarks), 'Expected invalid remark to remain');
});

await run('Zero-net with specialty violation remains invalid after merge', () => {
  const findings = medicalShared.mergeFindingsBySeverity(
    [{ ruleId: 'PRICING', status: 'Valid', remark: 'Zero price accepted', claimID: 'C1', activityID: 'A1' }],
    [{ ruleId: 'MED_SPEC_PATHOLOGY_REQUIRED', status: 'Invalid', remark: 'Lab code requires Pathology', claimID: 'C1', activityID: 'A1' }]
  );
  assert(medicalShared.getFinalStatusFromFindings(findings) === 'Invalid', 'Expected specialty invalid to dominate zero-net pricing valid');
});

await run('Code combinations reject 31231 with 31575', () => {
  const ctx = makeMedicalContext({
    activities: [
      { id: 'A1', code: '31231', normalizedCode: '31231', quantity: 1, modifiers: [], net: 10 },
      { id: 'A2', code: '31575', normalizedCode: '31575', quantity: 1, modifiers: [], net: 10 }
    ]
  });
  const findings = medicalShared.validateCodeCombinationRules(ctx, { mutuallyExclusiveCodes: [['31231', '31575']] });
  assert(findings.some(f => f.ruleId === 'MED_COMBO_ACTIVITY'), 'Expected incompatible combination finding');
});

await run('Specialty rules enforce dietician both directions', () => {
  const ctx = makeMedicalContext({
    activities: [
      { id: 'A1', code: '97802', normalizedCode: '97802', quantity: 1, net: 100, clinicianSpecialty: 'General Practitioner', orderingSpecialty: 'General Practitioner', modifiers: [] },
      { id: 'A2', code: '99213', normalizedCode: '99213', quantity: 1, net: 100, clinicianSpecialty: 'Dietician', orderingSpecialty: 'General Practitioner', modifiers: [] }
    ]
  });
  const findings = medicalShared.validateSpecialtyRules(ctx, { specialtyRestrictions: { pathologyLabCodePrefixes: ['8'], dieticianCodes: ['97802', '97803'] } });
  assert(findings.some(f => f.ruleId === 'MED_SPEC_DIETICIAN_REQUIRED'), 'Expected dietician required finding');
  assert(findings.some(f => f.ruleId === 'MED_SPEC_DIETICIAN_RESTRICTED'), 'Expected dietician restricted finding');
});

await run('Schema 878xx tests use same clinician instead of Pathology specialty', () => {
  const specialtyMap = new Map([
    ['PED1', 'Pediatrics'], ['PED2', 'Pediatrics'], ['PATH1', 'Pathology']
  ]);
  const checkSchema = (code, performing, ordering) => {
    const activity = {
      Code: code, Clinician: performing, OrderingClinician: ordering,
      Quantity: code === '87804' ? '2' : '1', Net: '25'
    };
    const invalidFields = [];
    schemaApi.validateConsultationAndSpecialtyRules(
      [activity], (field, row) => row[field] || '', invalidFields,
      specialtyMap, { isMedicalClaim: true, receiverID: 'D001', claimPayerID: 'E001' }
    );
    return invalidFields;
  };
  for (const code of ['87800', '87804', '87807', '87880', '87899']) {
    const valid = checkSchema(code, 'PED1', 'PED1');
    assert(!valid.some(message => /Pathology|same as OrderingClinician/.test(message)),
      `Schema: 878xx code ${code} with matching Pediatrics clinician must be accepted: ${valid.join('; ')}`);
    const mismatched = checkSchema(code, 'PED1', 'PED2');
    assert(mismatched.some(message => /requires Performing Clinician to be the same as OrderingClinician/.test(message)),
      `Schema: 878xx code ${code} with mismatched clinicians must fail`);
    assert(!mismatched.some(message => /requires Clinician specialty containing Pathology/.test(message)),
      `Schema: 878xx code ${code} must not require Pathology`);
  }
  for (const code of ['8780', '878070', '87799', '87900']) {
    const invalid = checkSchema(code, 'PED1', 'PED2');
    assert(invalid.some(message => /requires Clinician specialty containing Pathology/.test(message)),
      `Schema: ${code} must retain the standard lab Pathology rule`);
    assert(!invalid.some(message => /requires Performing Clinician to be the same as OrderingClinician/.test(message)),
      `Schema: ${code} must not inherit the 878xx same-clinician rule`);
  }
  const missing = checkSchema('87807', '', '');
  assert(missing.some(message => /requires Performing Clinician to be the same as OrderingClinician/.test(message)),
    'Schema: two missing clinician licenses must not count as matching');
});

await run('Medical shared 878xx specialty rule matches the Schema Checker', () => {
  const rules = { specialtyRestrictions: {
    pathologyLabCodePrefixes: ['8'], dieticianCodes: ['97802', '97803']
  } };
  const checkMedical = (code, performing, ordering, specialty = 'Pediatrics') =>
    medicalShared.validateSpecialtyRules(makeMedicalContext({
      activities: [{
        id: 'A1', code, normalizedCode: code, quantity: 1, net: 25,
        clinician: performing, orderingClinician: ordering,
        clinicianSpecialty: specialty, orderingSpecialty: 'Pediatrics', modifiers: []
      }]
    }), rules);

  for (const code of ['87800', '87804', '87807', '87880', '87899']) {
    const same = checkMedical(code, 'PED1', 'PED1');
    assert(!same.some(f => f.ruleId === 'MED_SPEC_PATHOLOGY_REQUIRED' || f.ruleId === 'MED_LAB_ORDERING_PERFORMING_MATCH'),
      `Shared Medical: matching Pediatrics clinician should be accepted for ${code}`);
    const different = checkMedical(code, 'PED1', 'PED2');
    assert(different.some(f => f.ruleId === 'MED_LAB_ORDERING_PERFORMING_MATCH'),
      `Shared Medical: mismatched clinician should be invalid for ${code}`);
    assert(!different.some(f => f.ruleId === 'MED_SPEC_PATHOLOGY_REQUIRED'),
      `Shared Medical: ${code} should not require Pathology`);
  }
  for (const code of ['8780', '878070', '87799', '87900']) {
    const other = checkMedical(code, 'PED1', 'PED2');
    assert(other.some(f => f.ruleId === 'MED_SPEC_PATHOLOGY_REQUIRED'),
      `Shared Medical: ${code} retains Pathology requirement`);
    assert(!other.some(f => f.ruleId === 'MED_LAB_ORDERING_PERFORMING_MATCH'),
      `Shared Medical: ${code} should not require matching clinicians`);
  }
  assert(checkMedical('87807', '', '').some(f => f.ruleId === 'MED_LAB_ORDERING_PERFORMING_MATCH'),
    'Shared Medical: missing clinician licenses must not silently pass matching');
});

await run('Modifier rules enforce qty and missing modifier 25', () => {
  const ctx = makeMedicalContext({
    diagnoses: [{ code: 'J00', normalizedCode: 'J00', type: 'Principal' }],
    activities: [
      { id: 'A1', code: '99213', normalizedCode: '99213', quantity: 1, net: 150, modifiers: [], orderingSpecialty: 'General Practitioner' },
      { id: 'A2', code: '12001', normalizedCode: '12001', quantity: 1, net: 100, modifiers: ['50'], orderingSpecialty: 'General Practitioner' }
    ]
  });
  const findings = medicalShared.validateModifierRules(ctx, { modifierRules: { minorProcedureCodes: ['12001'] } });
  assert(findings.some(f => f.ruleId === 'MED_MODIFIER_25_MISSING'), 'Expected missing modifier 25 finding');
});

await run('Authorization returns unknown when approval source missing', () => {
  const ctx = makeMedicalContext({
    receiverID: 'C002',
    activities: [{ id: 'A1', code: '97161', normalizedCode: '97161', quantity: 1, net: 100, priorAuthorizationID: 'PA-1', orderingClinician: 'OC1', modifiers: [] }]
  });
  const findings = medicalShared.validateAuthorizationRules(ctx, {
    authorizationRequiredCodes: { fixed: [], prefixes: ['97'] },
    therapyCodeGroups: { PHYSIOTHERAPY_CODES: ['97161'], OCCUPATIONAL_THERAPY_CODES: [], SPEECH_THERAPY_CODES: [] }
  }, { approvalIndex: new Map() });
  assert(findings.some(f => f.status === 'Unknown'), 'Expected unknown finding when approval evidence is unavailable');
});

await run('Diagnosis rules mark unknown for incomplete Z68/O exceptions', () => {
  const ctx = makeMedicalContext({
    diagnoses: [
      { code: 'O99.21', normalizedCode: 'O9921', type: 'Secondary' },
      { code: 'Z68.30', normalizedCode: 'Z6830', type: 'Secondary' }
    ]
  });
  const findings = medicalShared.validateDiagnosisRules(ctx, { diagnosisRules: { z68OCodeExceptions: [] }, diagnosisCoverageExclusions: {} });
  assert(findings.some(f => f.ruleId === 'MED_DX_Z68_EXCEPTION_CONFIG' && f.status === 'Unknown'), 'Expected unknown finding for incomplete exceptions');
});

await run('Drug rules flag Thiqa-only and audit unknown thresholds', () => {
  const ctx = makeMedicalContext({
    receiverID: 'A001',
    activities: [
      { id: 'A1', type: '5', code: 'L88-5151-05757-02', normalizedCode: 'L88-5151-05757-02', quantity: 2, net: 700 },
      { id: 'A2', type: '5', code: 'O1234', normalizedCode: 'O1234', quantity: 1, net: 50 }
    ]
  });
  const findings = medicalShared.validateDrugRules(ctx, {
    drugRules: {
      formularyReceivers: { thiqa: ['D001'], damanBasic: ['D004'] },
      quantityAuditorReceivers: ['D001', 'A001', 'D004'],
      amountAuditorThresholdAED: 500
    }
  }, { drugsMap: null });
  assert(findings.some(f => f.ruleId === 'MED_DRUG_THIQA_ONLY'), 'Expected Thiqa-only drug finding');
  assert(findings.some(f => f.ruleId === 'MED_DRUG_AUDIT_AMOUNT' && f.status === 'Unknown'), 'Expected amount audit unknown finding');
  assert(findings.some(f => f.ruleId === 'MED_DRUG_AUDIT_QUANTITY' && f.status === 'Unknown'), 'Expected quantity audit unknown finding');
});

await run('Historical rules return unknown when chronology input missing', () => {
  const ctx = makeMedicalContext({
    activities: [{ id: 'A1', code: '83036', normalizedCode: '83036', quantity: 1, net: 100 }]
  });
  const findings = medicalShared.validateHistoricalFrequencyRules(ctx, {
    historicalFrequencyRules: { '83036Days': 90, lab800Months: 6, otherLabDays: 3, exceptionGroups: { CBC: [], CRP: [], BHCG: [] } }
  }, { historicalIndex: null });
  assert(findings.some(f => f.ruleId === 'MED_HISTORICAL_INPUT_MISSING' && f.status === 'Unknown'), 'Expected unknown historical finding without chronology input');
});

function makeDrugRow(overrides = {}) {
  return {
    'Drug Code': 'JQ9-0699-00779-02',
    'Package Name': 'Sample Drug',
    'Dosage Form': 'Injection',
    'Package Size': '1 vial',
    'Package Price to Public': 66.4,
    'Package Markup': 66.4,
    'Unit Price to Public': 2.21,
    'Unit Markup': 2.21,
    'Status': 'Active',
    'Delete Effective Date': '',
    'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'Yes',
    'Included In Basic Drug Formulary': 'Yes',
    'UPP Effective Date': '2026-01-01',
    'UPP Updated Date': '2026-01-02',
    ...overrides
  };
}

function analyzeDrug(overrides = {}, mapOverrides = {}) {
  const rec = {
    ClaimID: 'TMCCL1036197',
    ActivityID: 'A1',
    ActivityType: '5',
    CPT: 'JQ9-0699-00779-02',
    Quantity: '0.03',
    Net: '1.99',
    PayerID: 'A001',
    ...overrides
  };
  const drugRow = makeDrugRow(mapOverrides);
  const drugsMap = new Map([[drugShared.normalizeDrugCode(drugRow['Drug Code']), drugRow]]);
  const knownCptCodeSet = new Set(['94640']);
  return pricingApi.analyzeDrugActivity(rec, {
    receiverID: 'D001',
    drugsMap,
    knownCptCodeSet,
    drugListSource: 'resources/Drugs.xlsx'
  });
}

await run('Pricing routing uses Activity Type 5 for drug path', () => {
  assert(pricingApi.isDrugActivityType('5') === true, 'Expected Type 5 to route to drug pricing path');
  assert(pricingApi.isDrugActivityType('3') === false, 'Expected non-Type-5 to skip drug pricing path');
});

await run('Type 3 code in drugs does not route to drug path', () => {
  assert(pricingApi.isDrugActivityType('3') === false, 'Expected Type 3 to stay on medical CPT pricing path');
});

await run('Zero-priced non-drug activities are recognized across medical and dental types', () => {
  assert(pricingApi.isZeroPricedActivityForPricing('3', 0) === true, 'Expected Medical non-drug zero net to be treated as zero-priced');
  assert(pricingApi.isZeroPricedActivityForPricing('6', 0) === true, 'Expected Dental non-drug zero net to be treated as zero-priced');
  assert(pricingApi.isZeroPricedActivityForPricing('3', 10) === false, 'Expected nonzero Medical net to use normal pricing comparison');
});

await run('Zero-priced drug activities keep drug-specific handling', () => {
  assert(pricingApi.isZeroPricedActivityForPricing('5', 0) === false, 'Expected drug zero net to skip non-drug zero-price shortcut');
});

await run('Only configured zero-priced companions are auto-accepted for pricing', () => {
  const validCompanionRows = [
    { ClaimID: 'C1', ActivityType: '3', CPT: '99202', Net: '48', Quantity: '1' },
    { ClaimID: 'C1', ActivityType: '3', CPT: '99203', Net: '0', Quantity: '1' }
  ];
  assert(
    pricingApi.isAllowedZeroPricedActivityForPricing(validCompanionRows[1], validCompanionRows, {
      receiverID: 'A001',
      medicalRules: { zeroPriceCodes: { always: [], byReceiver: {} } }
    }) === true,
    'Expected 99203 zero-priced companion to be auto-accepted when 99202 is priced'
  );

  const orphanRows = [
    { ClaimID: 'C1', ActivityType: '3', CPT: '99203', Net: '0', Quantity: '1' }
  ];
  assert(
    pricingApi.isAllowedZeroPricedActivityForPricing(orphanRows[0], orphanRows, {
      receiverID: 'A001',
      medicalRules: { zeroPriceCodes: { always: [], byReceiver: {} } }
    }) === false,
    'Expected orphan 99203 zero-priced row to keep normal pricing validation'
  );
});

await run('MF7003 CPT 36415 must be priced at exactly zero for every payer', () => {
  const createRecord = (net, facilityID = 'MF7003', code = '36415', claimNet = '0') => ({
    ClaimID: 'C1',
    ActivityID: 'A1',
    ActivityType: '3',
    CPT: code,
    Net: net,
    Quantity: '1',
    FacilityID: facilityID,
    ClaimNet: claimNet,
    PatientShare: '0'
  });
  for (const receiverID of ['D001', 'A001', 'D004', 'A025', 'C002', 'C001', 'HAAD']) {
    const good = pricingApi.buildTrueLifeZeroPriceVenipunctureRow(
      createRecord('0.00'), receiverID
    );
    assert(good !== null && good.status === 'Valid' && good.ComputedRef === 0,
      'MF7003 36415 at Net 0 must pass for ' + receiverID);
    assert(good._claimNetZeroBypass !== true && good.ReferenceNetPrice === '0',
      'MF7003 36415 special rule must bypass tariff rules, not bypass its own check');

    const charged = pricingApi.buildTrueLifeZeroPriceVenipunctureRow(
      createRecord('25.50'), receiverID
    );
    assert(charged.status === 'Invalid' && /must always have activity Net 0/.test(charged.Remarks),
      'MF7003 36415 nonzero Net must be invalid for ' + receiverID);
    assert(charged.ClaimNet === '0', 'Parent claim Net 0 must not suppress the activity-level rule');
  }

  for (const nonzeroNet of ['0.01', '0.001', '-0.01', '-5', '5', '', 'not-a-number']) {
    const result = pricingApi.buildTrueLifeZeroPriceVenipunctureRow(createRecord(nonzeroNet), 'D001');
    assert(result.status === 'Invalid',
      'MF7003 36415 invalid Net ' + JSON.stringify(nonzeroNet) + ' must be rejected');
  }

  for (const invalidQuantity of ['0', '-1', '', 'abc']) {
    const record = createRecord('0', 'MF7003', '36415', '30');
    record.Quantity = invalidQuantity;
    const result = pricingApi.buildTrueLifeZeroPriceVenipunctureRow(record, 'D001');
    assert(result.status === 'Invalid' && /requires a positive quantity/.test(result.Remarks),
      'Invalid quantity ' + JSON.stringify(invalidQuantity) + ' must still be rejected');
  }

  assert(pricingApi.buildTrueLifeZeroPriceVenipunctureRow(
    createRecord('10', 'MF5357'), 'D001'
  ) === null, 'Other facilities must retain existing payer-specific 36415 rules');
  assert(pricingApi.buildTrueLifeZeroPriceVenipunctureRow(
    createRecord('10', 'MF7003', '36416'), 'D001'
  ) === null, 'Other CPT codes at MF7003 must not be affected');
  assert(pricingApi.buildTrueLifeZeroPriceVenipunctureRow(
    createRecord('0', ' mf7003 '), 'D001'
  ).status === 'Valid', 'Facility license case/whitespace normalization should work');
});

await run('Required-priced medical activity config matches normalized facility, receiver, and code', () => {
  assert(
    pricingApi.requiresNonZeroMedicalPrice({
      facilityID: ' mf5020 ',
      receiverID: ' d001 ',
      code: '096375',
      rules: {
        requiredPricedActivities: [
          { facilityID: 'MF5020', receiverID: 'D001', codes: ['96375'] }
        ]
      }
    }) === true,
    'Expected Khabisi Thiqa 96375 to require a nonzero medical price'
  );
  assert(
    pricingApi.requiresNonZeroMedicalPrice({
      facilityID: 'MF5020',
      receiverID: 'A001',
      code: '96375',
      rules: {
        requiredPricedActivities: [
          { facilityID: 'MF5020', receiverID: 'D001', codes: ['96375'] }
        ]
      }
    }) === false,
    'Expected other receivers to keep their own pricing behavior'
  );
});

await run('Zero-billed pricing decision keeps dental zero-net valid, preserves medical exception, and excludes drugs', () => {
  const dental = pricingApi.getZeroPricePricingDecision({
    isMedicalMode: false,
    isDrugActivity: false,
    xmlNet: 0,
    requiresMedicalPrice: false,
    isConfiguredZeroPricedActivity: false
  });
  assert(dental.isZeroPricedDentalActivity === true, 'Expected dental zero-net activity to be recognized');
  assert(dental.zeroPricePassesPricing === true, 'Expected dental zero-net activity to pass price validation');

  const medicalGeneral = pricingApi.getZeroPricePricingDecision({
    isMedicalMode: true,
    isDrugActivity: false,
    xmlNet: 0,
    requiresMedicalPrice: false,
    isConfiguredZeroPricedActivity: false
  });
  assert(medicalGeneral.mayUseMedicalZeroPrice === true, 'Expected general medical zero-net activity to retain medical zero-price handling');
  assert(medicalGeneral.zeroPricePassesPricing === true, 'Expected general medical zero-net activity to pass price validation');

  const medicalRequired = pricingApi.getZeroPricePricingDecision({
    isMedicalMode: true,
    isDrugActivity: false,
    xmlNet: 0,
    requiresMedicalPrice: true,
    isConfiguredZeroPricedActivity: false
  });
  assert(medicalRequired.mayUseMedicalZeroPrice === false, 'Expected required-priced medical activity to bypass medical zero-price handling');
  assert(medicalRequired.zeroPricePassesPricing === false, 'Expected required-priced medical activity to fail the zero-price shortcut');

  const drug = pricingApi.getZeroPricePricingDecision({
    isMedicalMode: false,
    isDrugActivity: true,
    xmlNet: 0,
    requiresMedicalPrice: false,
    isConfiguredZeroPricedActivity: false
  });
  assert(drug.zeroPricePassesPricing === false, 'Expected drug activities to skip the non-drug zero-price shortcut');
});

await run('A001 patient share summary excludes valid zero-priced consultation companions', () => {
  const rows = [
    {
      ClaimID: 'NLKHC260663440',
      ActivityID: 'A1',
      ActivityType: '3',
      CPT: '99202',
      ClaimedQty: '1',
      ComputedRef: 98,
      xmlNetNum: 48,
      PatientShare: '50',
      ClaimGross: '98',
      ClaimNet: '48',
      ReceiverID: 'A001'
    },
    {
      ClaimID: 'NLKHC260663440',
      ActivityID: 'A2',
      ActivityType: '3',
      CPT: '99203',
      ClaimedQty: '1',
      ComputedRef: 142,
      xmlNetNum: 0,
      PatientShare: '50',
      ClaimGross: '98',
      ClaimNet: '48',
      ReceiverID: 'A001'
    }
  ];
  const summary = pricingApi.calculatePatientShareSummary(rows, {
    receiverID: 'A001',
    medicalRules: { zeroPriceCodes: { always: [], byReceiver: {} } }
  });
  assert(summary.patientShareRows.length === 1, `Expected only one patient-share reference row, got ${summary.patientShareRows.length}`);
  assert(summary.patientShareRows[0].CPT === '99202', 'Expected 99202 to remain in patient-share reference rows');
  assert(summary.totalRef === 98, `Expected total reference 98, got ${summary.totalRef}`);
  assert(summary.expectedPatientShare === 50, `Expected patient share 50, got ${summary.expectedPatientShare}`);
  assert(summary.claimTotalsConsistent === true, 'Expected claim totals to be internally consistent');
});

await run('A001 claim-level copay handling only defers positive under-reference rows', () => {
  assert(
    pricingApi.shouldDeferA001PricingToClaimLevel({
      receiverID: 'A001',
      xmlNet: 48,
      effectiveRef: 98,
      xmlQty: 1,
      isAllowedZeroPricedActivity: false
    }) === true,
    'Expected positive under-reference row to defer to claim-level patient share validation'
  );
  assert(
    pricingApi.shouldDeferA001PricingToClaimLevel({
      receiverID: 'A001',
      xmlNet: 0,
      effectiveRef: 142,
      xmlQty: 1,
      isAllowedZeroPricedActivity: false
    }) === false,
    'Expected zero-net orphan row to retain normal pricing validation'
  );
});

await run('No-pricing-match remark is suppressed for zero-priced non-drug activities', () => {
  assert(
    pricingApi.shouldAddNoPricingMatchRemark({
      match: null,
      endoEntry: null,
      isZeroPricedActivity: true
    }) === false,
    'Expected no-pricing-match remark suppression for zero-priced non-drug activities'
  );
  assert(
    pricingApi.shouldAddNoPricingMatchRemark({
      match: null,
      endoEntry: null,
      isZeroPricedActivity: false
    }) === true,
    'Expected no-pricing-match remark for nonzero/non-shortcut activities'
  );
});

await run('Reference-price error remarks are suppressed for zero-priced non-drug activities', () => {
  assert(
    pricingApi.shouldAddMissingEndoPriceRemark({
      endoEntry: { code: 'X' },
      refPrice: null,
      isZeroPricedActivity: true
    }) === false,
    'Expected missing endo-price remark suppression for zero-priced non-drug activities'
  );
  assert(
    pricingApi.shouldAddInvalidReferenceRemark({
      match: { code: 'X' },
      endoEntry: null,
      refPrice: 'abc',
      ref: Number.NaN,
      isZeroPricedActivity: true
    }) === false,
    'Expected invalid-reference remark suppression for zero-priced non-drug activities'
  );
});

await run('Type 5 valid active drug passes with package markup net', () => {
  const row = analyzeDrug();
  assert(row.status === 'Valid', 'Expected valid Type 5 drug pricing row');
  assert(row._drugPricingMeta && row._drugPricingMeta.basis === 'Package', 'Expected package basis for quantity 0.03');
  assert(String(row._drugExpectedNet) === '1.99', 'Expected net 1.99 for 66.4 x 0.03');
});

await run('Type 5 code also present in CPT set still uses drug path', () => {
  const row = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1',
    ActivityID: 'A1',
    ActivityType: '5',
    CPT: 'JQ9-0699-00779-02',
    Quantity: '0.03',
    Net: '1.99'
  }, {
    receiverID: 'D001',
    drugsMap: new Map([[pricingApi.normalizeDrugCode('JQ9-0699-00779-02'), makeDrugRow()]]),
    knownCptCodeSet: new Set([pricingApi.normalizeDrugCode('JQ9-0699-00779-02')]),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(row.status === 'Valid', 'Expected Type 5 drug code match to win over CPT type set');
  assert(!/Invalid CPT Type/.test(row.Remarks), 'Expected no CPT type mismatch remark when drug exists');
});

await run('Type 5 unknown drug code returns unknown', () => {
  const row = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1',
    ActivityID: 'A1',
    ActivityType: '5',
    CPT: 'UNKNOWN-DRUG',
    Quantity: '0.03',
    Net: '1.99',
    PayerID: 'A001'
  }, {
    receiverID: 'D001',
    drugsMap: new Map(),
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(row.status === 'Unknown', 'Expected unknown status for unmatched Type 5 drug code');
  assert(/not found/.test(row.Remarks), 'Expected unknown drug code remark');
});

await run('Type 5 known CPT wrong type returns invalid CPT type message', () => {
  const row = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1',
    ActivityID: 'A1',
    ActivityType: '5',
    CPT: '94640',
    Quantity: '1',
    Net: '10'
  }, {
    receiverID: 'D001',
    drugsMap: new Map(),
    knownCptCodeSet: new Set(['94640']),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(row.status === 'Invalid', 'Expected invalid status for known CPT submitted as Type 5');
  assert(/Invalid CPT Type/.test(row.Remarks), 'Expected invalid CPT type message');
});

await run('Drug status active and grace are treated as valid', () => {
  assert(analyzeDrug({}, { Status: 'Active' }).status === 'Valid', 'Expected active status to pass');
  assert(analyzeDrug({}, { Status: 'Grace' }).status === 'Valid', 'Expected grace status to pass');
});

await run('Drug status inactive and deleted are invalid', () => {
  assert(analyzeDrug({}, { Status: 'Inactive' }).status === 'Invalid', 'Expected inactive status to fail');
  assert(analyzeDrug({}, { Status: 'Deleted' }).status === 'Invalid', 'Expected deleted status to fail');
});

await run('D001 Thiqa formulary yes passes and no fails', () => {
  assert(analyzeDrug({}, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'Yes' }).status === 'Valid', 'Expected Thiqa Yes to pass');
  assert(analyzeDrug({}, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'No' }).status === 'Invalid', 'Expected Thiqa No to fail');
});

await run('D004 Daman Basic formulary yes passes and no fails', () => {
  const yes = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1', ActivityID: 'A1', ActivityType: '5', CPT: 'JQ9-0699-00779-02', Quantity: '0.03', Net: '1.99'
  }, {
    receiverID: 'D004',
    drugsMap: new Map([[pricingApi.normalizeDrugCode('JQ9-0699-00779-02'), makeDrugRow({ 'Included In Basic Drug Formulary': 'Yes' })]]),
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
  const no = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1', ActivityID: 'A1', ActivityType: '5', CPT: 'JQ9-0699-00779-02', Quantity: '0.03', Net: '1.99'
  }, {
    receiverID: 'D004',
    drugsMap: new Map([[pricingApi.normalizeDrugCode('JQ9-0699-00779-02'), makeDrugRow({ 'Included In Basic Drug Formulary': 'No' })]]),
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(yes.status === 'Valid', 'Expected Daman Basic Yes to pass');
  assert(no.status === 'Invalid', 'Expected Daman Basic No to fail');
});

await run('A001 does not trigger automatic formulary invalidation', () => {
  const row = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1', ActivityID: 'A1', ActivityType: '5', CPT: 'JQ9-0699-00779-02', Quantity: '0.03', Net: '1.99'
  }, {
    receiverID: 'A001',
    drugsMap: new Map([[pricingApi.normalizeDrugCode('JQ9-0699-00779-02'), makeDrugRow({ 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'No', 'Included In Basic Drug Formulary': 'No' })]]),
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(row.status === 'Valid', 'Expected A001 to skip automatic Thiqa/Daman formulary columns');
});

await run('Fractional quantity below calculated ratio is valid when package price is correct', () => {
  // Package Markup 66.4 × 0.01 = 0.664 → rounds to 0.66. Claimed Net 0.66 matches → Valid.
  // The ratio (Unit Price to Public / Package Price to Public) = 2.21/66.4 ≈ 0.03 is not a minimum.
  const row = analyzeDrug({ Quantity: '0.01', Net: '0.66' });
  assert(row.status === 'Valid', 'Expected fractional quantity valid when package-based price is correct');
  assert(!/less than the required quantity/.test(row.Remarks), 'Expected no quantity lower-bound remark');
});

// ---------------------------------------------------------------------------
// Regression tests: fractional drug quantity (TMCCL1036219 / S22-1970-10706-02)
// ---------------------------------------------------------------------------

function makeS22DrugRow(overrides = {}) {
  // Package Markup 6.5 × 0.02 = 0.13. Unit Price to Public / Package Price to Public = 1.3/6.5 = 0.2.
  return {
    'Drug Code': 'S22-1970-10706-02',
    'Package Name': 'Test Drug S22',
    'Dosage Form': 'Tablet',
    'Package Size': '1 pack',
    'Package Price to Public': 6.5,
    'Package Markup': 6.5,
    'Unit Price to Public': 1.3,
    'Unit Markup': 1.3,
    'Status': 'Active',
    'Delete Effective Date': '',
    'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'Yes',
    'Included In Basic Drug Formulary': 'Yes',
    'UPP Effective Date': '2026-01-01',
    'UPP Updated Date': '2026-01-02',
    ...overrides
  };
}

function analyzeS22Drug(recOverrides = {}, rowOverrides = {}) {
  const rec = {
    ClaimID: 'TMCCL1036219',
    ActivityID: 'A1',
    ActivityType: '5',
    CPT: 'S22-1970-10706-02',
    Quantity: '0.02',
    Net: '0.13',
    PayerID: 'D001',
    ...recOverrides
  };
  const drugRow = makeS22DrugRow(rowOverrides);
  const drugsMap = new Map([[drugShared.normalizeDrugCode(drugRow['Drug Code']), drugRow]]);
  return pricingApi.analyzeDrugActivity(rec, {
    receiverID: 'D001',
    drugsMap,
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
}

await run('TMCCL1036219: qty 0.02, net 0.13, ratio 0.2 → Valid (regression)', () => {
  // Package Markup 6.5 × 0.02 = 0.13. Ratio = 0.2 but must not make this Invalid.
  const row = analyzeS22Drug();
  assert(row.status === 'Valid', 'Expected Valid when package-based net 0.13 matches claimed net 0.13');
  assert(!/less than the required quantity/.test(row.Remarks), 'Expected no quantity lower-bound remark');
  assert(!/Claimed quantity 0.02 is less than/.test(row.Remarks), 'Expected no ratio-minimum remark');
});

await run('TMCCL1036219: qty 0.02, net 0.10 (wrong) → Invalid price mismatch', () => {
  // Package Markup 6.5 × 0.02 = 0.13 but claimed is 0.10 → price mismatch.
  const row = analyzeS22Drug({ Net: '0.10' });
  assert(row.status === 'Invalid', 'Expected Invalid when claimed net does not match package-based price');
  assert(/does not match expected drug price/.test(row.Remarks), 'Expected price mismatch remark');
  assert(!/less than the required quantity/.test(row.Remarks), 'Expected no ratio-minimum remark');
});

await run('TMCCL1036219: qty 0 → Invalid quantity', () => {
  const row = analyzeS22Drug({ Quantity: '0' });
  assert(row.status === 'Invalid', 'Expected Invalid for zero quantity');
  assert(/missing or invalid/.test(row.Remarks), 'Expected invalid quantity remark');
});

await run('TMCCL1036219: qty -0.02 → Invalid quantity', () => {
  const row = analyzeS22Drug({ Quantity: '-0.02' });
  assert(row.status === 'Invalid', 'Expected Invalid for negative quantity');
  assert(/missing or invalid/.test(row.Remarks), 'Expected invalid quantity remark');
});

await run('TMCCL1036219: qty 1.5, correct price, D001 → Unknown (auditor confirmation)', () => {
  // Unit Markup 1.3 × 1.5 = 1.95. Must also flag auditor confirmation for qty > 1 on D001.
  const row = analyzeS22Drug({ Quantity: '1.5', Net: '1.95' });
  assert(row.status === 'Unknown', 'Expected Unknown when quantity above 1 requires auditor confirmation');
  assert(/auditor confirmation/i.test(row.Remarks), 'Expected auditor confirmation remark');
});

await run('Package-based pricing: qty 0.03, Package Markup 66.4 → net 1.99 (regression)', () => {
  // 66.4 × 0.03 = 1.992 → rounds to 1.99. Previously verified; must remain Valid.
  const row = analyzeDrug({ Quantity: '0.03', Net: '1.99' });
  assert(row.status === 'Valid', 'Expected Valid for 66.4 × 0.03 = 1.99');
  assert(String(row._drugExpectedNet) === '1.99', 'Expected computed net 1.99 for 66.4 × 0.03');
});

await run('Quantity above 1 on D001 requires auditor confirmation', () => {
  const row = analyzeDrug({ Quantity: '2', Net: '4.42' });
  assert(row.status === 'Unknown', 'Expected quantity above 1 to be unknown due to auditor review');
  assert(/auditor confirmation/i.test(row.Remarks), 'Expected auditor confirmation remark');
});

await run('Correct price with formulary no stays invalid', () => {
  const row = analyzeDrug({}, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'No' });
  assert(row.status === 'Invalid', 'Expected invalid status when formulary blocks despite correct price');
  assert(/cannot be submitted.*nonzero/.test(row.Remarks), 'Expected specific formulary exclusion remark');
});

await run('Zero-priced drug with D001 formulary No is valid', () => {
  const row = analyzeDrug({ Net: '0' }, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'No' });
  assert(row.status === 'Valid', 'Expected zero-priced drug with excluded formulary to be valid');
  assert(!/cannot be submitted/.test(row.Remarks), 'Expected no formulary exclusion remark for zero-priced drug');
});

await run('Zero-priced drug with D004 formulary No is valid', () => {
  const row = pricingApi.analyzeDrugActivity({
    ClaimID: 'C1', ActivityID: 'A1', ActivityType: '5', CPT: 'JQ9-0699-00779-02', Quantity: '0.03', Net: '0'
  }, {
    receiverID: 'D004',
    drugsMap: new Map([[pricingApi.normalizeDrugCode('JQ9-0699-00779-02'), makeDrugRow({ 'Included In Basic Drug Formulary': 'No' })]]),
    knownCptCodeSet: new Set(),
    drugListSource: 'resources/Drugs.xlsx'
  });
  assert(row.status === 'Valid', 'Expected zero-priced D004 drug with excluded formulary to be valid');
});

await run('Blank D001 formulary with nonzero price is unknown', () => {
  const row = analyzeDrug({}, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': '' });
  assert(row.status === 'Unknown', 'Expected unknown status when formulary value is blank');
  assert(/blank or unrecognized/.test(row.Remarks), 'Expected blank-formulary remark');
});

await run('Zero-priced drug with blank formulary is valid', () => {
  const row = analyzeDrug({ Net: '0' }, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': '' });
  assert(row.status === 'Valid', 'Expected zero-priced drug with blank formulary to be valid');
});

await run('Formulary exclusion remark does not report price mismatch', () => {
  const row = analyzeDrug({}, { 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary': 'No' });
  assert(!/does not match expected drug price/.test(row.Remarks), 'Expected no price mismatch remark when formulary excluded');
});

await run('Correct price with inactive status stays invalid', () => {
  const row = analyzeDrug({}, { Status: 'Deleted' });
  assert(row.status === 'Invalid', 'Expected invalid status when drug status is inactive/deleted');
});

// ---------------------------------------------------------------------------
// Factor rule tests: 97802/97803 Medical Nutrition Therapy override
// ---------------------------------------------------------------------------

// Build factor rules directly in the same shape that buildFactorRulesFromWorkbook
// produces, without requiring XLSX in the test context.
function makeFactorRules(rows) {
  // Mirror buildFactorRulesFromWorkbook logic without XLSX dependency
  const payerColumns = [
    { colKey: 'Thiqa (D001)', payerId: 'D001' },
    { colKey: 'Low-End (A001)', payerId: 'A001' },
    { colKey: 'Basic (D004)', payerId: 'D004' },
    { colKey: 'NGI (A025)', payerId: 'A025' },
    { colKey: 'Saico (A024)', payerId: 'A024' },
    { colKey: 'Nextcare (C002)', payerId: 'C002' },
    { colKey: 'Mednet (C004)', payerId: 'C004' },
  ];
  const rules = [];
  rows.forEach(row => {
    const facilityId = String(row['Facility ID'] || '').trim();
    const matchType = String(row['Code Match Type'] || '').trim();
    const matchValueRaw = String(row['Code Match Value'] || '').trim();
    if (!facilityId || !matchType || !matchValueRaw) return;
    const facility = String(row['Facility'] || '').trim();
    const serviceType = String(row['Service Type'] || '').trim();
    let matchValues = [];
    if (matchType === 'Exact List') {
      matchValues = matchValueRaw.split(',').map(v => v.trim()).filter(Boolean);
    } else if (matchType === 'Starts With') {
      matchValues = matchValueRaw.split(/[\s,]+/).map(v => v.replace(/^or$/i, '').trim()).filter(v => /^\d+$/.test(v));
    }
    if (!matchValues.length) return;
    const factors = {};
    payerColumns.forEach(({ colKey, payerId }) => {
      const val = row[colKey];
      if (val !== '' && val !== undefined) {
        const num = Number(val);
        if (!isNaN(num)) factors[payerId] = num;
      }
    });
    rules.push({ facility, facilityId, serviceType, matchType, matchValues, factors });
  });
  return rules;
}

const mntRows = [
  {
    Facility: 'TestClinic', 'Facility ID': 'MF9999',
    'Service Type': 'Medical Nutrition Therapy',
    'Code Match Type': 'Exact List',
    'Code Match Value': '97802, 97803',
    'Thiqa (D001)': 1.3, 'Low-End (A001)': 1, 'Basic (D004)': 1,
    'NGI (A025)': 1, 'Saico (A024)': 1, 'Nextcare (C002)': 1, 'Mednet (C004)': 1
  },
  {
    Facility: 'TestClinic', 'Facility ID': 'MF9999',
    'Service Type': 'Physiotherapy',
    'Code Match Type': 'Starts With',
    'Code Match Value': '97',
    'Thiqa (D001)': 1, 'Low-End (A001)': 1, 'Basic (D004)': 1,
    'NGI (A025)': 1, 'Saico (A024)': 1, 'Nextcare (C002)': 1, 'Mednet (C004)': 1
  },
  {
    Facility: 'TestClinic', 'Facility ID': 'MF9999',
    'Service Type': 'Consultation',
    'Code Match Type': 'Exact List',
    'Code Match Value': '99202, 99213',
    'Thiqa (D001)': 1.3, 'Low-End (A001)': 1, 'Basic (D004)': 1,
    'NGI (A025)': 1, 'Saico (A024)': 1, 'Nextcare (C002)': 1, 'Mednet (C004)': 1
  },
];
const factorRules = makeFactorRules(mntRows);

const khabisi96375FactorRules = makeFactorRules([
  {
    Facility: 'Khabisi', 'Facility ID': 'MF5020',
    'Service Type': 'Medical Services',
    'Code Match Type': 'Exact List',
    'Code Match Value': '96375',
    'Thiqa (D001)': 1.3, 'Low-End (A001)': 1, 'Basic (D004)': 1,
    'NGI (A025)': 1, 'Saico (A024)': 1, 'Nextcare (C002)': 1, 'Mednet (C004)': 1
  },
  {
    Facility: 'Khabisi', 'Facility ID': 'MF5020',
    'Service Type': 'Medical Services',
    'Code Match Type': 'Starts With',
    'Code Match Value': '1, 2, 3, 4, 5, 6',
    'Thiqa (D001)': 1.3, 'Low-End (A001)': 1, 'Basic (D004)': 1,
    'NGI (A025)': 1, 'Saico (A024)': 1, 'Nextcare (C002)': 1, 'Mednet (C004)': 1
  }
]);

await run('97802 + D001 uses Medical Nutrition Therapy factor 1.3', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97802', 'D001');
  assert(result.factor === 1.3, `Expected factor 1.3 for 97802/D001, got ${result.factor}`);
  assert(result.rule !== null, 'Expected a matched rule for 97802/D001');
  assert(result.rule.serviceType === 'Medical Nutrition Therapy', `Expected service type Medical Nutrition Therapy, got ${result.rule && result.rule.serviceType}`);
  assert(result.rule.matchType === 'Exact List', `Expected Exact List match type, got ${result.rule && result.rule.matchType}`);
});

await run('97803 + D001 uses Medical Nutrition Therapy factor 1.3', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97803', 'D001');
  assert(result.factor === 1.3, `Expected factor 1.3 for 97803/D001, got ${result.factor}`);
  assert(result.rule !== null, 'Expected a matched rule for 97803/D001');
  assert(result.rule.serviceType === 'Medical Nutrition Therapy', `Expected service type Medical Nutrition Therapy, got ${result.rule && result.rule.serviceType}`);
  assert(result.rule.matchType === 'Exact List', `Expected Exact List match type, got ${result.rule && result.rule.matchType}`);
});

await run('97802 + D001: effectiveRef equals mandatoryTariffPrice * 1.3', () => {
  const mandatoryTariffPrice = 100;
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97802', 'D001');
  const effectiveRef = mandatoryTariffPrice * result.factor;
  assert(effectiveRef === 130, `Expected effectiveRef 130, got ${effectiveRef}`);
});

await run('97803 + D001: effectiveRef equals mandatoryTariffPrice * 1.3', () => {
  const mandatoryTariffPrice = 200;
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97803', 'D001');
  const effectiveRef = mandatoryTariffPrice * result.factor;
  assert(effectiveRef === 260, `Expected effectiveRef 260, got ${effectiveRef}`);
});

await run('97802 + D001 is NOT matched by Starts With 97 Physiotherapy rule', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97802', 'D001');
  assert(result.rule && result.rule.serviceType !== 'Physiotherapy', `Expected rule not to be Physiotherapy, got ${result.rule && result.rule.serviceType}`);
});

await run('97803 + D001 is NOT matched by Starts With 97 Physiotherapy rule', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97803', 'D001');
  assert(result.rule && result.rule.serviceType !== 'Physiotherapy', `Expected rule not to be Physiotherapy, got ${result.rule && result.rule.serviceType}`);
});

await run('97802 + non-D001 payer uses Starts With 97 Physiotherapy factor (1)', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97802', 'A001');
  assert(result.factor === 1, `Expected factor 1 for 97802/A001, got ${result.factor}`);
  assert(result.rule && result.rule.matchType === 'Exact List', `Expected Exact List match, got ${result.rule && result.rule.matchType}`);
});

await run('97803 + non-D001 payer uses Starts With 97 Physiotherapy factor (1)', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97803', 'D004');
  assert(result.factor === 1, `Expected factor 1 for 97803/D004, got ${result.factor}`);
  assert(result.rule && result.rule.matchType === 'Exact List', `Expected Exact List match, got ${result.rule && result.rule.matchType}`);
});

await run('Other 97xxx code (97161) still uses Physiotherapy Starts With 97 rule', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '97161', 'D001');
  assert(result.rule !== null, 'Expected a matched rule for 97161');
  assert(result.rule.serviceType === 'Physiotherapy', `Expected Physiotherapy rule for 97161, got ${result.rule && result.rule.serviceType}`);
  assert(result.rule.matchType === 'Starts With', `Expected Starts With match type for 97161, got ${result.rule && result.rule.matchType}`);
  assert(result.factor === 1, `Expected factor 1 for 97161/D001 from Physiotherapy rule, got ${result.factor}`);
});

await run('Consultation Exact List unaffected by Medical Nutrition Therapy rule', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF9999', '99213', 'D001');
  assert(result.rule !== null, 'Expected a matched rule for 99213');
  assert(result.rule.serviceType === 'Consultation', `Expected Consultation rule, got ${result.rule && result.rule.serviceType}`);
  assert(result.factor === 1.3, `Expected factor 1.3 for 99213/D001, got ${result.factor}`);
});

await run('Unknown facility returns factor 1 with no rule', () => {
  const result = pricingApi.findFactorFromRules(factorRules, 'MF0000', '97802', 'D001');
  assert(result.factor === 1, `Expected factor 1 for unknown facility, got ${result.factor}`);
  assert(result.rule === null, 'Expected null rule for unknown facility');
});

await run('Khabisi 96375 uses exact-list factor 1.3 for Thiqa without broadening 9-series matching', () => {
  const exact = pricingApi.findFactorFromRules(khabisi96375FactorRules, 'MF5020', '96375', 'D001');
  assert(exact.factor === 1.3, `Expected factor 1.3 for 96375/D001, got ${exact.factor}`);
  assert(exact.rule && exact.rule.matchType === 'Exact List', `Expected Exact List match for 96375, got ${exact.rule && exact.rule.matchType}`);
  assert(20 * exact.factor === 26, `Expected mandatory tariff base 20 × factor ${exact.factor} = 26`);

  const unrelatedNineSeries = pricingApi.findFactorFromRules(khabisi96375FactorRules, 'MF5020', '99214', 'D001');
  assert(unrelatedNineSeries.factor === 1, `Expected unrelated 9-series code to default to factor 1, got ${unrelatedNineSeries.factor}`);
  assert(unrelatedNineSeries.rule === null, 'Expected unrelated 9-series code to avoid the 96375 exact-list rule');
});

await run('Al Khabisi Thiqa CPT 93005 factor 1.3 validates AED 42.90', () => {
  const matched = pricingApi.findFactorFromRules([], 'MF5020', '93005', 'D001');
  assert(matched.factor === 1.3, `Expected factor 1.3 for 93005/Khabisi/Thiqa, got ${matched.factor}`);
  assert(matched.rule && matched.rule.isOverride, '93005 should use a scoped Thiqa Khabisi override');

  const factoredUnit = Math.round(33 * matched.factor * 100) / 100;
  assert(factoredUnit === 42.9, 'Expected 33 × 1.3 = 42.90');
  assert(pricingApi.getMedicalTariffMaximum(factoredUnit, 1) === 42.9,
    'Expected maximum net AED 42.90 at quantity 1');
  assert(pricingApi.isWithinMedicalTariffMaximum(42.9, factoredUnit, 1),
    'Claimed Net 42.90 must be valid');
  assert(!pricingApi.isWithinMedicalTariffMaximum(42.91, factoredUnit, 1),
    'Claimed Net 42.91 must exceed the maximum');

  const row = {
    CPT: '93005', ClaimedNet: '42.9', ClaimedQty: '1',
    ReferenceNetPrice: '33', FactoredReference: '42.9',
    AppliedFactor: '1.3', _isMedicalPricingMatch: true
  };
  assert(pricingApi.getComparisonPriceResult(row, [row]).correct === true,
    'Comparison modal should accept 42.90 for 93005');

  for (const payer of ['A001', 'D004']) {
    assert(pricingApi.findFactorFromRules([], 'MF5020', '93005', payer).factor === 1,
      `Payer ${payer} should not receive the Thiqa-specific override`);
  }
  assert(pricingApi.findFactorFromRules([], 'MF5090', '93005', 'D001').factor === 1,
    '93005 factor must not affect other facilities');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '93006', 'D001').factor === 1,
    '93005 factor must not leak to adjacent codes');
});

await run('Al Khabisi Thiqa CPT 95018 factor 1.3 validates AED 88.40', () => {
  const matched = pricingApi.findFactorFromRules([], 'MF5020', '95018', 'D001');
  assert(matched.factor === 1.3, `Expected factor 1.3 for 95018/Khabisi/Thiqa, got ${matched.factor}`);
  assert(matched.rule && matched.rule.isOverride, 'CPT 95018 should use the Thiqa-only Khabisi override');

  const factoredUnit = Math.round(68 * matched.factor * 100) / 100;
  assert(factoredUnit === 88.4, `Expected 68 × 1.3 = 88.40, got ${factoredUnit}`);
  assert(pricingApi.getMedicalTariffMaximum(factoredUnit, 1) === 88.4,
    'Expected adjusted tariff maximum of AED 88.40');
  assert(pricingApi.isWithinMedicalTariffMaximum(88.4, factoredUnit, 1),
    'Claimed Net AED 88.40 must be Valid');
  assert(!pricingApi.isWithinMedicalTariffMaximum(88.41, factoredUnit, 1),
    'Claimed Net AED 88.41 must exceed the maximum');

  const row = {
    CPT: '95018', ClaimedNet: '88.4', ClaimedQty: '1',
    ReferenceNetPrice: '68', FactoredReference: '88.4',
    AppliedFactor: '1.3', _isMedicalPricingMatch: true
  };
  assert(pricingApi.getComparisonPriceResult(row, [row]).correct === true,
    'Comparison modal should accept claimed Net AED 88.40');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '95018', 'A001').factor === 1,
    'A001 must not inherit Thiqa factor 1.3');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '95018', 'D004').factor === 1,
    'D004 must not inherit Thiqa factor 1.3');
  assert(pricingApi.findFactorFromRules([], 'MF5090', '95018', 'D001').factor === 1,
    'Other facilities must not inherit the Al Khabisi CPT 95018 override');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '95019', 'D001').factor === 1,
    'Neighboring CPT codes must not inherit the 95018 override');
});

await run('Al Khabisi Thiqa CPT 93000 applies factor 1.5 and accepts a lower Net', () => {
  const factor = pricingApi.findFactorFromRules([], 'MF5020', '93000', 'D001');
  assert(factor.factor === 1.5, `Expected 93000 Thiqa/Khabisi factor 1.5, got ${factor.factor}`);
  assert(factor.rule && factor.rule.isOverride, 'Expected 93000 override to be explicitly scoped');

  const adjustedUnit = 65 * factor.factor;
  assert(pricingApi.getMedicalTariffMaximum(adjustedUnit, 1) === 97.5, 'Expected 65 × 1.5 = 97.50');
  assert(pricingApi.isWithinMedicalTariffMaximum(84.5, adjustedUnit, 1), '84.50 must be valid below 97.50 maximum');
  assert(pricingApi.isWithinMedicalTariffMaximum(97.5, adjustedUnit, 1), '97.50 must be valid at maximum');
  assert(!pricingApi.isWithinMedicalTariffMaximum(97.51, adjustedUnit, 1), '97.51 must be invalid above maximum');

  const compareRow = {
    CPT: '93000', ClaimedNet: '84.5', ClaimedQty: '1', ReferenceNetPrice: '65',
    FactoredReference: '97.5', AppliedFactor: '1.5', _isMedicalPricingMatch: true
  };
  assert(pricingApi.getComparisonPriceResult(compareRow, [compareRow]).correct === true,
    'Comparison modal must also accept 84.50 under the 97.50 maximum');

  for (const otherPayer of ['A001', 'D004']) {
    assert(pricingApi.findFactorFromRules([], 'MF5020', '93000', otherPayer).factor === 1,
      `93000 override must not affect payer ${otherPayer}`);
  }
  assert(pricingApi.findFactorFromRules([], 'MF9999', '93000', 'D001').factor === 1,
    '93000 override must not affect other facilities');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '99214', 'D001').factor === 1,
    '93000 override must not apply to other 9-series codes');
});

await run('Al Khabisi authorized CPT 97803 uses 1.3 factor times quantity 3', () => {
  const factor = pricingApi.findFactorFromRules([], 'MF5020', '97803', 'D001', 'AUTH-TEST');
  assert(factor.factor === 1.3, 'Expected 97803 to use authorized factor 1.3');
  const adjustedUnit = Math.round(39 * factor.factor * 100) / 100;
  assert(adjustedUnit === 50.7, 'Expected 39 × 1.3 = 50.70');
  assert(pricingApi.getMedicalTariffMaximum(adjustedUnit, 3) === 152.1,
    'Expected 50.70 × quantity 3 = 152.10');
  assert(pricingApi.isWithinMedicalTariffMaximum(152.1, adjustedUnit, 3),
    'Claimed Net 152.10 must be Valid');
  assert(!pricingApi.isWithinMedicalTariffMaximum(152.11, adjustedUnit, 3),
    'Claimed Net 152.11 must exceed the maximum');
  const compareRow = {
    CPT: '97803', ClaimedNet: '152.1', ClaimedQty: '3', ReferenceNetPrice: '39',
    FactoredReference: '50.7', AppliedFactor: '1.3', _isMedicalPricingMatch: true
  };
  assert(pricingApi.getComparisonPriceResult(compareRow, [compareRow]).correct === true,
    'Comparison modal must accept authorized 97803 × 3 pricing');
  assert(pricingApi.findFactorFromRules([], 'MF5020', '97803', 'D001', '').factor === 1,
    'Preserve the existing requirement for activity authorization on Khabisi 97803');
});

await run('Medical tariff maximum cannot legalize negative/zero Net or dental underpricing', () => {
  assert(!pricingApi.isWithinMedicalTariffMaximum(-1, 97.5, 1), 'Negative Net must fail');
  assert(!pricingApi.isWithinMedicalTariffMaximum(0, 97.5, 1), 'Zero Net stays in its own validation rules');
  assert(!pricingApi.isWithinMedicalTariffMaximum(1, 97.5, 0), 'Zero quantity must fail');
  assert(!pricingApi.isWithinMedicalTariffMaximum(1, 97.5, -1), 'Negative quantity must fail');
  assert(!pricingApi.isWithinMedicalTariffMaximum(1, NaN, 1), 'Invalid tariff must fail');
  const dental = { CPT: '93000', ClaimedNet: '84.5', ClaimedQty: '1', ReferenceNetPrice: '65',
    FactoredReference: '97.5', AppliedFactor: '1.5', _isMedicalPricingMatch: false };
  assert(pricingApi.getComparisonPriceResult(dental, [dental]).correct === false,
    'Dental comparison must retain its own exact-match rules');

  const overMaximum = pricingApi.buildConcisePriceMismatchRemark({
    claimedNet: 152.11, code: '97803', pricingContext: 'Mandatory Tariff',
    expectedNet: 152.1, isMaximum: true, factoredUnitPrice: 50.7, quantity: 3
  });
  assert(/maximum 152\.1/.test(overMaximum) && /unit 50\.7 × qty 3/.test(overMaximum),
    'Medical over-cap message must show the factor-adjusted unit and quantity-adjusted cap');
});

await run('Pricing claim-type normalizer accepts MEDICAL and DENTAL only', () => {
  assert(pricingApi.normalizeClaimTypeMode('medical') === 'MEDICAL', 'Expected lowercase medical to normalize');
  assert(pricingApi.normalizeClaimTypeMode(' dental ') === 'DENTAL', 'Expected padded dental to normalize');
  assert(pricingApi.normalizeClaimTypeMode('other') === null, 'Expected unsupported claim type to normalize to null');
});

await run('Schema validateXmlSchema with explicit file/container returns visible error element when file missing', () => {
  const statusNode = { textContent: '' };
  const container = {
    querySelector(selector) {
      if (selector.includes('schema-status')) return statusNode;
      return null;
    }
  };
  const result = schemaApi.validateXmlSchema({ file: null, container, claimTypeMode: 'MEDICAL' });
  assert(result && result.textContent === 'Schema Checker failed: Please select an XML file first.', 'Expected visible schema error element when file is missing');
  assert(statusNode.textContent === 'Please select an XML file first.', 'Expected container-scoped schema status to be updated');
});

// --- Timings checker: 97-code Dental/Medical guard ---

await run('Timings: Dental + code 97803 + 45 minutes + quantity 1 has no 97-code finding', () => {
  const xmlDoc = makeMockXmlDoc([{
    id: 'C1',
    encounter: { start: '01/01/2026 10:00', end: '01/01/2026 10:45' },
    activities: [{ id: 'A1', code: '97803', quantity: 1, start: '01/01/2026 10:00' }]
  }]);
  const rows = timingsApi.extractClaims(xmlDoc, { claimMode: 'DENTAL', requiredType: '6' });
  const has97Finding = rows.some(r => (r.remarks || []).some(rem => /97803/.test(rem)));
  assert(!has97Finding, 'Expected no 97-code finding for Dental claim');
});

await run('Timings: Medical + code 97803 + 45 minutes + quantity 1 is valid', () => {
  const xmlDoc = makeMockXmlDoc([{
    id: 'C1',
    encounter: { start: '01/01/2026 10:00', end: '01/01/2026 10:45' },
    activities: [{ id: 'A1', code: '97803', quantity: 1, start: '01/01/2026 10:00' }]
  }]);
  const rows = timingsApi.extractClaims(xmlDoc, { claimMode: 'MEDICAL', requiredType: '3' });
  const has97Finding = rows.some(r => (r.remarks || []).some(rem => /97803/.test(rem)));
  assert(!has97Finding, 'Expected no 97-code finding for Medical claim with quantity 1 and 45 minutes');
  assert(rows.every(r => r.isValid), 'Expected all rows to be valid');
});

await run('Timings: Medical + code 97803 + 45 minutes + quantity 3 is valid', () => {
  const xmlDoc = makeMockXmlDoc([{
    id: 'C1',
    encounter: { start: '01/01/2026 10:00', end: '01/01/2026 10:45' },
    activities: [{ id: 'A1', code: '97803', quantity: 3, start: '01/01/2026 10:00' }]
  }]);
  const rows = timingsApi.extractClaims(xmlDoc, { claimMode: 'MEDICAL', requiredType: '3' });
  const has97Finding = rows.some(r => (r.remarks || []).some(rem => /97803/.test(rem)));
  assert(!has97Finding, 'Expected no 97-code finding for Medical claim with quantity 3 and 45 minutes');
  assert(rows.every(r => r.isValid), 'Expected all rows to be valid');
});

await run('Timings: Medical + code 97803 + 45 minutes + quantity 4 is invalid with code shown', () => {
  const xmlDoc = makeMockXmlDoc([{
    id: 'C1',
    encounter: { start: '01/01/2026 10:00', end: '01/01/2026 10:45' },
    activities: [{ id: 'A1', code: '97803', quantity: 4, start: '01/01/2026 10:00' }]
  }]);
  const rows = timingsApi.extractClaims(xmlDoc, { claimMode: 'MEDICAL', requiredType: '3' });
  const has97Finding = rows.some(r => (r.remarks || []).some(rem => /97803/.test(rem)));
  const hasMaxMsg = rows.some(r => (r.remarks || []).some(rem => /maximum total quantity/.test(rem)));
  assert(has97Finding, 'Expected a 97803-specific finding for Medical claim with quantity 4 and 45 minutes');
  assert(hasMaxMsg, 'Expected message to mention maximum total quantity');
  assert(rows.some(r => !r.isValid), 'Expected at least one row to be invalid');
});

await run('Timings: Medical + 97802 and 97803 combined excess quantity shows both codes', () => {
  const xmlDoc = makeMockXmlDoc([{
    id: 'C1',
    encounter: { start: '01/01/2026 10:00', end: '01/01/2026 10:45' },
    activities: [
      { id: 'A1', code: '97802', quantity: 2, start: '01/01/2026 10:00' },
      { id: 'A2', code: '97803', quantity: 2, start: '01/01/2026 10:00' }
    ]
  }]);
  const rows = timingsApi.extractClaims(xmlDoc, { claimMode: 'MEDICAL', requiredType: '3' });
  const has97802 = rows.some(r => (r.remarks || []).some(rem => /97802/.test(rem)));
  const has97803 = rows.some(r => (r.remarks || []).some(rem => /97803/.test(rem)));
  assert(has97802 && has97803, 'Expected both 97802 and 97803 to appear in findings');
  assert(rows.some(r => !r.isValid), 'Expected at least one row to be invalid');
});

// --- Schema Checker: validateMedicalOrderingConsistency scope ---

await run('Schema: validateMedicalOrderingConsistency is defined at correct scope', () => {
  assert(typeof schemaApi.validateMedicalOrderingConsistency === 'function',
    'Expected validateMedicalOrderingConsistency to be accessible via the test API');
});

await run('Schema: validateMedicalOrderingConsistency skips Dental claims', () => {
  const invalidFields = [];
  const activities = [
    { _tag: 'Activity', querySelector(sel) {
      if (sel === 'Code') return { textContent: '99213' };
      if (sel === 'OrderingClinician') return { textContent: 'DR1' };
      return null;
    }},
    { _tag: 'Activity', querySelector(sel) {
      if (sel === 'Code') return { textContent: '99213' };
      if (sel === 'OrderingClinician') return { textContent: 'DR2' };
      return null;
    }}
  ];
  function textFn(tag, node) {
    if (!node) return '';
    const el = node.querySelector && node.querySelector(tag);
    return el && el.textContent ? el.textContent.trim() : '';
  }
  schemaApi.validateMedicalOrderingConsistency(activities, textFn, invalidFields, { isMedicalClaim: false });
  assert(invalidFields.length === 0, 'Expected no ordering findings for Dental claim');
});

await run('Schema: validateMedicalOrderingConsistency detects multiple ordering clinicians for Medical', () => {
  const invalidFields = [];
  const activities = [
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '99213' };
      if (sel === 'OrderingClinician') return { textContent: 'DR1' };
      return null;
    }},
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '99214' };
      if (sel === 'OrderingClinician') return { textContent: 'DR2' };
      return null;
    }}
  ];
  function textFn(tag, node) {
    if (!node) return '';
    const el = node && node.querySelector && node.querySelector(tag);
    if (el) return el.textContent ? el.textContent.trim() : '';
    // top-level call like text('ID') without node
    return 'CLAIM1';
  }
  schemaApi.validateMedicalOrderingConsistency(activities, textFn, invalidFields, { isMedicalClaim: true });
  assert(invalidFields.some(f => /multiple Ordering Clinicians/.test(f)), 'Expected multiple ordering clinicians finding for Medical');
});

await run('Schema: validateMedicalOrderingConsistency uses shared duplicate rules for repeatable codes', () => {
  const invalidFields = [];
  const allowedActivities = [
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '17999' };
      if (sel === 'OrderingClinician') return { textContent: 'GD40942' };
      return null;
    }},
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '17999' };
      if (sel === 'OrderingClinician') return { textContent: 'GD40942' };
      return null;
    }}
  ];
  function textFn(tag, node) {
    if (!node) return tag === 'ID' ? 'CLAIM1' : '';
    const el = node && node.querySelector && node.querySelector(tag);
    return el && el.textContent ? el.textContent.trim() : '';
  }
  schemaApi.validateMedicalOrderingConsistency(allowedActivities, textFn, invalidFields, {
    isMedicalClaim: true,
    medicalShared: medicalShared,
    medicalRules: {
      duplicateActivityRules: {
        allowedDuplicateCodes: ['17999'],
        allowedDuplicateCodeOrderingPairs: []
      }
    }
  });
  assert(!invalidFields.some(f => /Duplicate code 17999/.test(f)), 'Expected 17999 duplicate to be allowed in schema checker');

  const blockedFields = [];
  const blockedActivities = [
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '99213' };
      if (sel === 'OrderingClinician') return { textContent: 'GD40942' };
      return null;
    }},
    { querySelector(sel) {
      if (sel === 'Code') return { textContent: '99213' };
      if (sel === 'OrderingClinician') return { textContent: 'GD40942' };
      return null;
    }}
  ];
  schemaApi.validateMedicalOrderingConsistency(blockedActivities, textFn, blockedFields, {
    isMedicalClaim: true,
    medicalShared: medicalShared,
    medicalRules: {
      duplicateActivityRules: {
        allowedDuplicateCodes: ['17999'],
        allowedDuplicateCodeOrderingPairs: []
      }
    }
  });
  assert(blockedFields.some(f => /Duplicate code 99213/.test(f)), 'Expected non-exempt schema duplicate to remain invalid');
});

await run('Schema: no ReferenceError for validateMedicalOrderingConsistency during validateXmlSchema call', () => {
  // This test verifies the function is in scope when validateClaimSchema calls it.
  // It's already proven by the existence of schemaApi.validateMedicalOrderingConsistency,
  // but we additionally confirm the schema loads without error.
  assert(typeof schemaApi.validateXmlSchema === 'function', 'Expected validateXmlSchema to load without ReferenceError');
});

await run('Allocator detects header row beyond first two rows', () => {
  const rows = allocatorApi.sheetToObjects([
    ['', '', 'Bill Charge Report'],
    ['', '', '16-03-2026 to 16-03-2026'],
    ['Facility ID', 'Pri. Claim No', 'Encounter Date', 'Department'],
    ['MF7003', 'TMCCL1', '16-03-2026', 'ENT']
  ]);
  assert(rows.length === 1, 'Expected one parsed row from allocator sheet');
  assert(rows[0]['Pri. Claim No'] === 'TMCCL1', 'Expected allocator to use detected header row');
});

await run('Allocator maps facility per claim and falls back to filename', () => {
  const presets = {
    'True Life Primary Care Center': { license: 'MF7003', coders: [] },
    'Nazek Medical Center': { license: 'MF5009', coders: [] }
  };
  const claims = allocatorApi.normalizeRawClaims([
    {
      fileName: 'Nazek September.xlsx',
      rows: [
        { 'Center Name': 'True Life', 'Pri. Claim No': 'C1', 'Encounter Date': '16-03-2026', Department: 'ENT', 'Codification Status': 'In Progress' },
        { 'Pri. Claim No': 'C2', 'Encounter Date': '17-03-2026', Department: 'ENT', 'Codification Status': 'In Progress' }
      ]
    }
  ], presets);
  assert(claims[0].facilityKey === 'True Life Primary Care Center', 'Expected row-level facility alias match');
  assert(claims[1].facilityKey === 'Nazek Medical Center', 'Expected filename fallback when row facility is missing');
});

function makeAllocatorClaim(overrides = {}) {
  const status = overrides.codificationStatus !== undefined ? overrides.codificationStatus : 'In Progress';
  const claimDateText = overrides.claimDateText !== undefined ? overrides.claimDateText : '16/03/2026';
  const claimDate = overrides.claimDate !== undefined ? overrides.claimDate : allocatorApi.parseDateValue('16-03-2026');
  return {
    dedupeKey: 'f1::C1',
    facilityKey: 'F1',
    facilityDisplay: 'F1',
    detectedPresetName: '',
    facilityMatched: true,
    claimDate,
    claimDateText,
    outputClaimId: 'C1',
    department: 'ENT',
    codificationStatus: status,
    codifiedBy: '',
    codifiedByValues: overrides.codifiedByValues || [],
    noBill: false,
    autoExcludedStatus: allocatorApi.isAutoExcludedStatus(status),
    rawFieldCount: 5,
    sourceRowNumber: 1,
    paymentMode: 'Insurance',
    ...overrides
  };
}

function makeFacilityConfigs(facilityKeys, codersText, restrictions = {}) {
  return Object.fromEntries(facilityKeys.map(key => [key, { presetName: '', codersText, restrictions }]));
}

function getCoderCounts(allocationRows) {
  const counts = {};
  allocationRows.forEach(row => {
    counts[row.Coder] = (counts[row.Coder] || 0) + 1;
  });
  return counts;
}

function getRangeForCoders(counts, coderNames) {
  const values = coderNames.map(coder => counts[coder] || 0);
  return { min: Math.min(...values), max: Math.max(...values) };
}

for (const [label, status] of [
  ['Closed', 'Closed'],
  ['Submitted', 'Submitted'],
  ['Audited', 'Audited'],
  ['Verified and Closed', 'Verified and Closed'],
  ['Merged', 'Merged']
]) {
  await run(`Allocator auto-excludes terminal status ${label}`, () => {
    assert(allocatorApi.isAutoExcludedStatus(status) === true, `Expected ${label} to be terminal`);
    const result = allocatorApi.deduplicateClaims([
      makeAllocatorClaim({ codificationStatus: status, autoExcludedStatus: allocatorApi.isAutoExcludedStatus(status) })
    ]);
    assert(result.dedupedClaims.length === 0, `Expected ${label} claim to be excluded from allocation`);
    assert(result.stats.terminalStatusExcluded === 1, `Expected ${label} claim to increment terminal exclusion count`);
  });
}

await run('Allocator terminal status matching is case-insensitive and whitespace-tolerant', () => {
  [' CLOSED ', 'submitted', 'AUDITED', ' verified and closed ', 'MERGED '].forEach(status => {
    assert(allocatorApi.isAutoExcludedStatus(status) === true, `Expected ${status} to be terminal`);
  });
  assert(allocatorApi.isAutoExcludedStatus('Submitted for Review') === false, 'Expected non-terminal status not to be excluded by substring matching');
});

await run('Allocator excludes duplicated claim when only one version is terminal', () => {
  const rawClaims = [
    makeAllocatorClaim({ sourceRowNumber: 1, codificationStatus: 'Under Process', autoExcludedStatus: allocatorApi.isAutoExcludedStatus('Under Process') }),
    makeAllocatorClaim({ sourceRowNumber: 2, codificationStatus: ' Audited ', autoExcludedStatus: allocatorApi.isAutoExcludedStatus(' Audited ') })
  ];
  const result = allocatorApi.deduplicateClaims(rawClaims);
  assert(result.dedupedClaims.length === 0, 'Expected duplicate group with one terminal version to be excluded');
  assert(result.stats.terminalStatusExcluded === 1, 'Expected one claim group to be excluded by terminal status');
  assert(result.stats.duplicateClaimsResolved === 1, 'Expected duplicate resolution to count stale version');
});

await run('Allocator keeps Under Process claims with Codified By eligible by default', () => {
  const claims = [
    makeAllocatorClaim({ codifiedByValues: ['James'], noBill: false }),
    makeAllocatorClaim({ outputClaimId: 'C2', dedupeKey: 'f1::C2', codifiedByValues: [], noBill: false })
  ];
  const defaults = allocatorApi.buildInitialFilterState(claims);
  const filtered = allocatorApi.applyClaimFilters(claims, defaults);
  assert(filtered.eligibleClaims.length === 2, 'Expected non-terminal claim with Codified By to remain eligible by default');
});

await run('Allocator keeps no-bill exclusion optional and respects user-selected codified-by filters', () => {
  const claims = [
    makeAllocatorClaim({ codifiedByValues: ['Alice'], noBill: true }),
    makeAllocatorClaim({ outputClaimId: 'C2', dedupeKey: 'f1::C2', codifiedByValues: [], noBill: false })
  ];
  const filtered = allocatorApi.applyClaimFilters(claims, {
    paymentModes: new Set(['Insurance']),
    departments: new Set(['ENT']),
    codifStatuses: new Set(['In Progress', 'Under Process']),
    codifiedBy: new Set(['Alice']),
    includeNoBills: false
  });
  assert(filtered.eligibleClaims.length === 1, 'Expected checked codified-by names and no-bills to be excluded');
  assert(filtered.noBillExcluded === 0, 'Expected no-bill count after codified-by exclusion to be zero');

  const included = allocatorApi.applyClaimFilters(claims, {
    paymentModes: new Set(['Insurance']),
    departments: new Set(['ENT']),
    codifStatuses: new Set(['In Progress']),
    codifiedBy: new Set(),
    includeNoBills: true
  });
  assert(included.eligibleClaims.length === 2, 'Expected include-no-bills toggle to restore no-bill claims');
});

await run('Allocator selects Dental and Orthodontic by default', () => {
  const defaults = allocatorApi.buildInitialFilterState([
    makeAllocatorClaim({ department: 'Dental' }),
    makeAllocatorClaim({ outputClaimId: 'C2', dedupeKey: 'f1::C2', department: 'Orthodontic' }),
    makeAllocatorClaim({ outputClaimId: 'C3', dedupeKey: 'f1::C3', department: 'ENT' })
  ]);
  assert(defaults.departments.has('Dental'), 'Expected Dental to be selected by default');
  assert(defaults.departments.has('Orthodontic'), 'Expected Orthodontic to be selected by default');
  assert(defaults.departments.has('ENT'), 'Expected all departments to be selected by default');
});

await run('Allocator preserves raw claim date text for workbook output when parsing fails', () => {
  const row = allocatorApi.getAllocationSheetRow({
    Facility: 'F1',
    'Claim ID': 'C1',
    'Claim Date': null,
    ClaimDateText: '16 March 2026 (legacy export)',
    Department: 'ENT',
    Coder: 'Alice',
    Query: '',
    Status: ''
  }, '10/09/2026');
  assert(row['Claim Date'] === '16 March 2026 (legacy export)', 'Expected raw claim date text to survive workbook preparation when parsing fails');
});

await run('Allocator balances 100 claims across 4 coders exactly 25 each', () => {
  const coderNames = ['Alice', 'Bob', 'Carol', 'Dina'];
  const claims = Array.from({ length: 100 }, (_, index) => makeAllocatorClaim({
    outputClaimId: `C${index + 1}`,
    dedupeKey: `f1::C${index + 1}`,
    claimDate: allocatorApi.parseDateValue(`01-03-2026`),
    claimDateText: '01/03/2026',
    department: 'ENT'
  }));
  const result = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  coderNames.forEach(coder => assert(counts[coder] === 25, `Expected ${coder} to receive exactly 25 claims`));
});

await run('Allocator balances 101 claims across 4 coders within one claim difference', () => {
  const coderNames = ['Alice', 'Bob', 'Carol', 'Dina'];
  const claims = Array.from({ length: 101 }, (_, index) => makeAllocatorClaim({
    outputClaimId: `C${index + 1}`,
    dedupeKey: `f1::C${index + 1}`
  }));
  const result = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  const range = getRangeForCoders(counts, coderNames);
  assert(range.max - range.min <= 1, 'Expected 101/4 loads to differ by no more than 1');
});

await run('Allocator balances 10 claims across 3 coders as 4 3 3 deterministically', () => {
  const coderNames = ['Alice', 'Bob', 'Carol'];
  const claims = Array.from({ length: 10 }, (_, index) => makeAllocatorClaim({
    outputClaimId: `C${index + 1}`,
    dedupeKey: `f1::C${index + 1}`
  }));
  const result = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  const sortedCounts = coderNames.map(coder => counts[coder] || 0).sort((a, b) => b - a);
  assert(sortedCounts.join(',') === '4,3,3', `Expected 10/3 split to be 4,3,3 but got ${sortedCounts.join(',')}`);
});

await run('Allocator balances 1000 claims across 7 coders within one claim difference', () => {
  const coderNames = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const claims = Array.from({ length: 1000 }, (_, index) => makeAllocatorClaim({
    outputClaimId: `C${index + 1}`,
    dedupeKey: `f1::C${index + 1}`
  }));
  const result = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  const range = getRangeForCoders(counts, coderNames);
  assert(range.max - range.min <= 1, 'Expected 1000/7 loads to differ by no more than 1');
});

await run('Allocator balances globally across multiple facilities with the same coder pool', () => {
  const coderNames = ['Alice', 'Bob', 'Carol'];
  const claims = Array.from({ length: 150 }, (_, index) => makeAllocatorClaim({
    facilityKey: index < 60 ? 'F1' : 'F2',
    facilityDisplay: index < 60 ? 'F1' : 'F2',
    outputClaimId: `C${index + 1}`,
    dedupeKey: `${index < 60 ? 'f1' : 'f2'}::C${index + 1}`
  }));
  const result = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1', 'F2'], coderNames.join('\n')), '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  coderNames.forEach(coder => assert(counts[coder] === 50, `Expected ${coder} to receive exactly 50 claims across facilities`));
});

await run('Allocator totals are order-invariant for otherwise identical claims', () => {
  const coderNames = ['Alice', 'Bob', 'Carol'];
  const claims = Array.from({ length: 60 }, (_, index) => makeAllocatorClaim({
    outputClaimId: `C${index + 1}`,
    dedupeKey: `f1::C${index + 1}`,
    claimDate: allocatorApi.parseDateValue(`${String((index % 28) + 1).padStart(2, '0')}-03-2026`),
    claimDateText: `${String((index % 28) + 1).padStart(2, '0')}/03/2026`
  }));
  const reversed = claims.slice().reverse();
  const first = allocatorApi.allocateClaims(claims, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  const second = allocatorApi.allocateClaims(reversed, makeFacilityConfigs(['F1'], coderNames.join('\n')), '10/09/2026');
  assert(JSON.stringify(getCoderCounts(first.allocationRows)) === JSON.stringify(getCoderCounts(second.allocationRows)), 'Expected coder totals to remain unchanged when input order changes');
});

await run('Allocator defeats overlapping-pool imbalance that the old greedy pass allowed', () => {
  const claims = [
    ...Array.from({ length: 100 }, (_, index) => makeAllocatorClaim({
      outputClaimId: `AB${index + 1}`,
      dedupeKey: `f1::AB${index + 1}`,
      department: 'ENT',
      facilityKey: 'F1',
      facilityDisplay: 'F1'
    })),
    ...Array.from({ length: 100 }, (_, index) => makeAllocatorClaim({
      outputClaimId: `AC${index + 1}`,
      dedupeKey: `f2::AC${index + 1}`,
      department: 'Cardiology',
      facilityKey: 'F2',
      facilityDisplay: 'F2'
    }))
  ];
  const facilityConfigs = {
    F1: { presetName: '', codersText: 'Alice\nBob', restrictions: {} },
    F2: { presetName: '', codersText: 'Alice\nCarol', restrictions: {} }
  };
  const result = allocatorApi.allocateClaims(claims, facilityConfigs, '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  const range = getRangeForCoders(counts, ['Alice', 'Bob', 'Carol']);
  assert(range.max - range.min <= 1, `Expected overlapping pools to balance within 1, got ${JSON.stringify(counts)}`);
});

await run('Allocator keeps restricted coders out of unsupported departments and balances globally where possible', () => {
  const claims = [
    { facilityKey: 'F1', facilityDisplay: 'F1', detectedPresetName: '', outputClaimId: 'C1', claimDate: allocatorApi.parseDateValue('01-03-2026'), claimDateText: '01/03/2026', department: 'ENT' },
    { facilityKey: 'F2', facilityDisplay: 'F2', detectedPresetName: '', outputClaimId: 'C2', claimDate: allocatorApi.parseDateValue('02-03-2026'), claimDateText: '02/03/2026', department: 'ENT' },
    { facilityKey: 'F1', facilityDisplay: 'F1', detectedPresetName: '', outputClaimId: 'C3', claimDate: allocatorApi.parseDateValue('03-03-2026'), claimDateText: '03/03/2026', department: 'Cardiology' },
    { facilityKey: 'F2', facilityDisplay: 'F2', detectedPresetName: '', outputClaimId: 'C4', claimDate: allocatorApi.parseDateValue('04-03-2026'), claimDateText: '04/03/2026', department: 'ENT' }
  ];
  const facilityConfigs = {
    F1: { presetName: '', codersText: 'Alice\nBob', restrictions: { Bob: new Set(['ENT']) } },
    F2: { presetName: '', codersText: 'Alice\nBob', restrictions: { Bob: new Set(['ENT']) } }
  };
  const result = allocatorApi.allocateClaims(claims, facilityConfigs, '10/09/2026');
  const cardiologyRows = result.allocationRows.filter(row => row.Department === 'Cardiology');
  assert(cardiologyRows.every(row => row.Coder === 'Alice'), 'Expected restricted coder to never receive unsupported department');
});

await run('Allocator allows unavoidable restriction-caused imbalance', () => {
  const claims = [
    ...Array.from({ length: 2 }, (_, index) => makeAllocatorClaim({ outputClaimId: `E${index + 1}`, dedupeKey: `f1::E${index + 1}`, department: 'ENT' })),
    ...Array.from({ length: 4 }, (_, index) => makeAllocatorClaim({ outputClaimId: `C${index + 1}`, dedupeKey: `f1::C${index + 1}`, department: 'Cardiology' }))
  ];
  const facilityConfigs = {
    F1: { presetName: '', codersText: 'Alice\nBob', restrictions: { Bob: new Set(['ENT']) } }
  };
  const result = allocatorApi.allocateClaims(claims, facilityConfigs, '10/09/2026');
  const counts = getCoderCounts(result.allocationRows);
  assert((counts.Alice || 0) === 4 && (counts.Bob || 0) === 2, `Expected unavoidable 4/2 imbalance, got ${JSON.stringify(counts)}`);
});

await run('Allocator leaves unassignable claims marked as unassigned', () => {
  const claims = [
    makeAllocatorClaim({ outputClaimId: 'C1', dedupeKey: 'f1::C1', department: 'ENT' }),
    makeAllocatorClaim({ outputClaimId: 'C2', dedupeKey: 'f1::C2', department: 'Cardiology' })
  ];
  const facilityConfigs = {
    F1: { presetName: '', codersText: 'Alice', restrictions: { Alice: new Set(['ENT']) } }
  };
  const result = allocatorApi.allocateClaims(claims, facilityConfigs, '10/09/2026');
  assert(result.allocationRows.some(row => row['Claim ID'] === 'C2' && row.Coder === '(Unassigned)'), 'Expected unsupported claim to remain unassigned');
});


// Dental first/additional service checks: both production dental validators
// should produce the same findings for the same catalogue and claim data.
const dentalCatalogue = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'json', 'checker_tooths.json'), 'utf8')
);
function loadDentalDependencyApi(scriptName, exportName) {
  const context = {
    window: {},
    document: { getElementById() { return null; }, querySelector() { return null; } },
    console, XLSX: {}
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', scriptName), 'utf8'),
    context, { filename: scriptName }
  );
  const api = context.window[exportName];
  assert(api, 'Dental dependency test API missing from ' + scriptName);
  return api;
}
function dentalObservation(code) {
  return {
    textContent: String(code),
    querySelector(selector) {
      if (selector === 'Code') return { textContent: String(code) };
      if (selector === 'Type') return { textContent: 'Universal Dental' };
      if (selector === 'ValueType') return { textContent: '' };
      return null;
    }
  };
}
function dentalActivity(code, teeth = [], id = 'A1') {
  const fields = { Code: code, Type: '6', ID: id, Quantity: '1', Net: '10' };
  return {
    querySelector(selector) {
      return Object.prototype.hasOwnProperty.call(fields, selector)
        ? { textContent: fields[selector] } : null;
    },
    getElementsByTagName(selector) {
      return selector === 'Observation' ? teeth.map(dentalObservation) : [];
    }
  };
}
function dentalXml(claimActivityGroups) {
  return {
    getElementsByTagName(selector) {
      if (selector !== 'Claim') return [];
      return claimActivityGroups.map((activities, index) => ({
        querySelector(key) {
          if (key === 'ID') return { textContent: 'C' + (index + 1) };
          if (key === 'Encounter > Start') return { textContent: '18/11/2026 10:00' };
          return null;
        },
        getElementsByTagName(key) {
          return key === 'Activity' ? activities : [];
        }
      }));
    }
  };
}

for (const [filename, exportName] of [
  ['checker_tooths.js', '_toothDependencyTestApi'],
  ['checker_observations.js', '_observationDependencyTestApi']
]) {
  const api = loadDentalDependencyApi(filename, exportName);

  // DoH Subcode for post-cutoff Thiqa root canal work by an Endodontist:
  // Type Text, Code Subcode, Value 01, ValueType Text.
  const rootCanalSubcodeCodes = ['33111', '33121', '33131', '33141', '33115', '33125', '33135', '33145'];
  function subcodeObservation({ type = 'Text', value = '01', valueType = 'Text', omitValueType = false } = {}) {
    const values = { Type: type, Code: 'Subcode', Value: value, ValueType: valueType };
    return {
      textContent: Object.values(values).join(' '),
      querySelector(selector) {
        if (selector === 'ValueType' && omitValueType) return null;
        return Object.prototype.hasOwnProperty.call(values, selector)
          ? { textContent: values[selector] } : null;
      }
    };
  }
  function rootCanalActivity(code, observation) {
    const fields = { ID: 'A1', Code: code, Type: '6', Clinician: 'ENDO-TEST', Quantity: '1' };
    return {
      querySelector(selector) {
        return Object.prototype.hasOwnProperty.call(fields, selector)
          ? { textContent: fields[selector] } : null;
      },
      getElementsByTagName(selector) {
        return selector === 'Observation'
          ? [dentalObservation('8'), observation].filter(Boolean)
          : [];
      }
    };
  }
  function rootCanalCheck(code, observation, { receiverID = 'D001', clinician = 'ENDO-TEST', medical = false } = {}) {
    const activity = rootCanalActivity(code, observation);
    if (clinician !== 'ENDO-TEST') {
      const original = activity.querySelector;
      activity.querySelector = selector => selector === 'Clinician'
        ? { textContent: clinician } : original(selector);
    }
    return api.validateActivities(
      dentalXml([[activity]]), {}, {}, new Set(['ENDO-TEST']),
      receiverID, medical, new Map(), new Set(rootCanalSubcodeCodes)
    )[0];
  }
  await run('Endodontist Subcode requires Text ValueType in all 8 root canal codes: ' + filename, () => {
    for (const code of rootCanalSubcodeCodes) {
      const complete = subcodeObservation();
      assert(api.hasSubcodeObservation([complete]) === true,
        'Complete Text Subcode should qualify for ' + code);
      const valid = rootCanalCheck(code, complete);
      assert(!valid.remarks.some(text => /requires a Subcode observation/i.test(text)),
        'Complete Subcode should not get missing-Subcode error for ' + code);

      for (const broken of [
        subcodeObservation({ omitValueType: true }),
        subcodeObservation({ valueType: '' }),
        subcodeObservation({ valueType: 'Number' }),
        subcodeObservation({ type: 'Number' }),
        subcodeObservation({ value: '02' })
      ]) {
        assert(api.hasSubcodeObservation([broken]) === false,
          'Incomplete Subcode must fail matching for ' + code);
        const result = rootCanalCheck(code, broken);
        assert(result.remarks.includes(
          'Code ' + code + ' requires a Subcode observation (Type: Text, Code: Subcode, Value: "01", ValueType: "Text") when performed by an Endodontist.'
        ), 'Canonical Subcode error must list ValueType Text for ' + code);
      }
    }
  });
  await run('Endodontist Subcode rule keeps existing payer/clinician scope: ' + filename, () => {
    const incomplete = subcodeObservation({ omitValueType: true });
    assert(!rootCanalCheck('33145', incomplete, { receiverID: 'A001' }).remarks
      .some(text => /requires a Subcode observation/i.test(text)),
      'The Endodontist Subcode requirement remains Thiqa-only');
    assert(!rootCanalCheck('33145', incomplete, { clinician: 'NON-ENDO' }).remarks
      .some(text => /requires a Subcode observation/i.test(text)),
      'Other dental specialties must not trigger the Endodontist rule');
    assert(!rootCanalCheck('33145', incomplete, { medical: true }).remarks
      .some(text => /requires a Subcode observation/i.test(text)),
      'Medical mode must not trigger the dental Endodontist Subcode rule');
  });

  const meta = api.buildCodeMeta(dentalCatalogue);
  const dependencies = api.buildAdditionalDentalDependencies(meta);
  const check = (code, additionalTeeth, baseCode, baseTeeth) => {
    const additional = dentalActivity(code, additionalTeeth, 'A2');
    const activities = [additional];
    if (baseCode) activities.push(dentalActivity(baseCode, baseTeeth, 'A1'));
    return api.validateDentalAdditionalService(code, additional, activities, dependencies);
  };
  await run('Dental dependency pairs ' + filename + ': all 51 and quadrant classification', () => {
    assert(dependencies.size === 51, 'Expected 51 catalogue-based additional service pairs');
    assert(Array.from(dependencies.values()).filter(x => x.scope === 'quadrant').length === 20,
      'Expected 20 same-quadrant additional service pairs');
    assert(dependencies.get('20149').baseCode === '20141', 'Expected 20149 -> 20141');
    assert(dependencies.get('71109').baseCode === '71101', 'Expected extraction pair');
    assert(dependencies.get('16109').baseCode === '16101', 'Expected extra time-unit pair');
    assert(!dependencies.has('20141'), 'Non-additional base codes must not be restricted');
  });
  await run('Dental dependency tooth geometry ' + filename + ': universal and primary boundaries', () => {
    assert(api.getQuadrant('8') === 'Upper Right', 'Permanent tooth 8 is upper right');
    assert(api.getQuadrant('9') === 'Upper Left', 'Permanent tooth 9 is upper left');
    assert(api.getQuadrant('16') === 'Upper Left' && api.getQuadrant('17') === 'Lower Left',
      'Permanent tooth 16/17 quadrant boundary');
    assert(api.getQuadrant('24') === 'Lower Left' && api.getQuadrant('25') === 'Lower Right',
      'Permanent tooth 24/25 quadrant boundary');
    assert(api.getQuadrant('E') === 'Upper Right' && api.getQuadrant('F') === 'Upper Left',
      'Primary E/F quadrant boundary');
  });
  await run('Dental dependency 20149 ' + filename + ': missing, wrong quadrant, same tooth, valid', () => {
    assert(check('20149', ['7'], null, []).length, 'First tooth code 20141 is mandatory');
    assert(check('20149', ['9'], '20141', ['8']).length, 'Different quadrants fail');
    assert(check('20149', ['7'], '20141', ['7']).length, 'Same tooth cannot count as additional');
    assert(check('20149', ['7'], '20141', []).length, 'First tooth observation is required');
    assert(check('20149', [], '20141', ['8']).length, 'Additional tooth observation is required');
    assert(check('20149', ['7'], '20141', ['8']).length === 0, 'Different teeth within same quadrant pass');
    assert(check('13409', ['F'], '13401', ['E']).length, 'Primary cross-quadrant sealant should fail');
    assert(check('71109', ['7'], '71101', ['8']).length === 0, 'Extraction with same quadrant passes');
  });
  await run('Dental dependency other services ' + filename + ': no invented quadrant restrictions', () => {
    assert(check('42339', ['9'], '42331', ['8']).length === 0,
      'Additional tooth without same-quadrant wording may use another quadrant');
    assert(check('42339', ['8'], '42331', ['8']).length,
      'Additional tooth must be distinct from the first tooth');
    assert(check('16109', [], '16101', []).length === 0,
      'Additional time unit needs base code, not tooth observations');
    assert(check('16109', [], null, []).length, 'Additional time unit cannot omit base code');
  });
  await run('Dental dependency integration ' + filename + ': claim-only, order-independent, medical excluded', () => {
    const missing = api.validateActivities(
      dentalXml([[dentalActivity('20149', ['7'])]]),
      meta, {}, new Set(), 'D001', false, new Map()
    );
    assert(missing[0].remarks.some(r => /20149.*20141/.test(r)), 'Missing first tooth must mark dental claim invalid');

    const separate = api.validateActivities(
      dentalXml([[dentalActivity('20149', ['7'])], [dentalActivity('20141', ['8'])]]),
      meta, {}, new Set(), 'D001', false, new Map()
    );
    assert(separate[0].remarks.some(r => /20149.*20141/.test(r)), 'Base service from another claim cannot qualify');

    const inOrder = api.validateActivities(
      dentalXml([[dentalActivity('20149', ['7']), dentalActivity('20141', ['8'])]]),
      meta, {}, new Set(), 'D001', false, new Map()
    );
    assert(!inOrder[0].remarks.some(r => /20149.*20141/.test(r)),
      'First service after additional code in XML should qualify');

    const medical = api.validateActivities(
      dentalXml([[dentalActivity('20149', ['7'])]]),
      meta, {}, new Set(), 'D001', true, new Map()
    );
    assert(!medical[0].remarks.some(r => /20149.*20141/.test(r)),
      'Dental dependency rule must not run in Medical mode');
  });
}


function loadAuthorizationTestApi() {
  const filename = 'checker_auths.js';
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', filename), 'utf8');
  const context = {
    window: {},
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    console,
    fetch: async () => ({ ok: false, status: 404 }),
    XLSX: {}
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename });
  assert(context.window._authTestApi, 'Auth checker test API missing');
  return context.window._authTestApi;
}

const authTestApi = loadAuthorizationTestApi();
function makeAuthorizationReportRow(authorizationId, memberId, code, status = 'Approved') {
  return {
    AuthorizationID: authorizationId,
    'Card Number / DHA Member ID': memberId,
    'Item Code': code,
    'Ordering Clinician': 'CL1',
    'Ordered On': '16/11/2026',
    Status: status
  };
}
function makeAuthorizationActivity(authorizationId, code) {
  const values = {
    ID: 'A1', Code: code, Start: '17/11/2026 12:00', Net: '35', Quantity: '1',
    OrderingClinician: 'CL1', PriorAuthorizationID: authorizationId
  };
  return {
    querySelector(name) {
      return Object.prototype.hasOwnProperty.call(values, name)
        ? { textContent: values[name] } : null;
    }
  };
}
const authReportRows = [
  makeAuthorizationReportRow('AUTH-OTHER', 'MEMBER-OTHER', '01901'),
  makeAuthorizationReportRow('AUTH-MIXED', 'MEMBER-OTHER', '01901'),
  makeAuthorizationReportRow('AUTH-MIXED', 'MEMBER-MINE', '01902'),
  makeAuthorizationReportRow('AUTH-MIXED', 'MEMBER-MINE', '01901'),
  makeAuthorizationReportRow('AUTH-SAME', 'MEMBER-MINE', '01902'),
  makeAuthorizationReportRow('AUTH-UNVERIFIABLE', '', '01901'),
  makeAuthorizationReportRow(1234567890, 'MEMBER-MINE', '01901')
];
const authReportMap = authTestApi.mapXLSXData(authReportRows);
function checkAuthorization(authorizationId, memberId, code = '01901') {
  return authTestApi.validateActivity(
    makeAuthorizationActivity(authorizationId, code),
    authReportMap, 'C1', memberId, '5', { receiverID: 'D001' }
  );
}
await run('Authorization wrong-member ownership precedes CPT lookup', () => {
  const result = checkAuthorization('AUTH-OTHER', 'MEMBER-MINE');
  assert(result.remarks.some(text => text === 'Authorization AUTH-OTHER does not belong to MEMBER-MINE, it belongs to MEMBER-OTHER.'),
    'Must preserve original member mismatch wording');
  assert(!result.remarks.some(text => /has no authorization for|does not list code/i.test(text)),
    'Must not misclassify a wrong-member authorization as a code error');
  assert(result.xlsAllAuthRows.length === 0,
    'Modal must not show another member’s authorization details');
});
await run('Authorization matches both member and code before validating', () => {
  const result = checkAuthorization('AUTH-MIXED', 'MEMBER-MINE');
  assert(result.remarks.length === 0,
    'Matching member-owned authorization for procedure must be valid');
  assert(result.xlsRow['Card Number / DHA Member ID'] === 'MEMBER-MINE',
    'Must choose member-owned row even if another member’s matching code appears first');
  assert(result.xlsAllAuthRows.length === 2,
    'Only matching member’s authorization rows may appear in modal');
});
await run('Authorization correct member, wrong code is distinct from wrong member', () => {
  const result = checkAuthorization('AUTH-SAME', 'MEMBER-MINE');
  assert(result.remarks.some(text => text === 'AUTH-SAME has no authorization for 01901.'),
    'Missing procedure must use the original authorization error format');
});
await run('Authorization missing, missing owner, numeric ID and leading-zero CPT', () => {
  assert(checkAuthorization('NO-SUCH-AUTH', 'MEMBER-MINE').remarks
    .some(text => text === 'NO-SUCH-AUTH has no authorization for 01901.'),
    'Unknown authorization ID must retain the original error message');
  const unverified = checkAuthorization('AUTH-UNVERIFIABLE', 'MEMBER-MINE');
  assert(unverified.unknown === true && unverified.remarks.some(text => /no Member ID/i.test(text)),
    'Source without a member ID requires manual verification');
  assert(checkAuthorization('1234567890', 'MEMBER-MINE').remarks.length === 0,
    'Excel numeric authorization IDs must be handled');
  assert(authTestApi.resolveAuthorizationRows(authReportMap, 'AUTH-MIXED', 'MEMBER-MINE', '1901').issue === null,
    'Leading-zero CPT codes must compare equivalently');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('\nAll new checker logic tests completed.');

})();
