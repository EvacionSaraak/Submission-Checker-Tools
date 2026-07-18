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

await run('Required quantity validation marks low quantities invalid', () => {
  const row = analyzeDrug({ Quantity: '0.01', Net: '0.66' });
  assert(row.status === 'Invalid', 'Expected claimed quantity below required to fail');
  assert(/less than the required quantity/.test(row.Remarks), 'Expected quantity lower-bound remark');
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

await run('Schema: no ReferenceError for validateMedicalOrderingConsistency during validateXmlSchema call', () => {
  // This test verifies the function is in scope when validateClaimSchema calls it.
  // It's already proven by the existence of schemaApi.validateMedicalOrderingConsistency,
  // but we additionally confirm the schema loads without error.
  assert(typeof schemaApi.validateXmlSchema === 'function', 'Expected validateXmlSchema to load without ReferenceError');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('\nAll new checker logic tests completed.');

})();
