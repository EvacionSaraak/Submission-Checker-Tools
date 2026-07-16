(function() {
  'use strict';

  const DEFAULT_MEDICAL_PAYER_CONFIG = {
    D001: { name: 'Thiqa', expectedClaimPayerIDs: ['E001'] },
    A001: { name: 'Daman Enhanced', expectedClaimPayerIDs: ['A001'] },
    D004: { name: 'Daman Basic', expectedClaimPayerIDs: ['A001'] },
    A025: { name: 'NGI' },
    C002: { name: 'Nextcare' }
  };

  const RULES_URL = '../json/medical_validation_rules.json';
  let rulesPromise = null;

  function text(node, tagName) {
    if (!node) return '';
    const child = node.getElementsByTagName(tagName)[0];
    return child && child.textContent ? child.textContent.trim() : '';
  }

  function normalizeLoose(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\.0+$/g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  function normalizeMemberLike(value) {
    const stripped = String(value || '').trim().replace(/\.0+$/g, '').replace(/^0+/, '');
    return stripped || '0';
  }

  function normalizeActivityCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\.0+$/g, '')
      .replace(/\s+/g, '')
      .replace(/[^A-Z0-9\-]/g, '');
  }

  function normalizeDiagnosisCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\.0+$/g, '')
      .replace(/\./g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  function parseEncounterDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parts = raw.split(' ');
    if (parts.length < 2) return null;
    const [datePart, timePart] = parts;
    const [d, m, y] = datePart.split('/').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    if ([d, m, y, hh, mm].some(n => !Number.isFinite(n))) return null;
    const date = new Date(y, m - 1, d, hh, mm);
    if (Number.isNaN(date.getTime())) return null;
    return {
      raw,
      timestamp: date.getTime(),
      date,
      dateKey: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    };
  }

  function calcAgeYears(dob, serviceDate) {
    if (!dob || !serviceDate) return null;
    const birth = parseEncounterDateTime(`${dob} 00:00`) || parseDateOnly(dob);
    const service = parseEncounterDateTime(`${serviceDate} 00:00`) || parseDateOnly(serviceDate);
    if (!birth || !service) return null;
    let years = service.date.getFullYear() - birth.date.getFullYear();
    const monthDiff = service.date.getMonth() - birth.date.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && service.date.getDate() < birth.date.getDate())) {
      years -= 1;
    }
    return years;
  }

  function parseDateOnly(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const m1 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m1) {
      const d = Number(m1[1]);
      const m = Number(m1[2]);
      const y = Number(m1[3]);
      const date = new Date(y, m - 1, d);
      if (!Number.isNaN(date.getTime())) {
        return { raw, timestamp: date.getTime(), date, dateKey: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
      }
    }
    const m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) {
      const y = Number(m2[1]);
      const m = Number(m2[2]);
      const d = Number(m2[3]);
      const date = new Date(y, m - 1, d);
      if (!Number.isNaN(date.getTime())) {
        return { raw, timestamp: date.getTime(), date, dateKey: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
      }
    }
    return null;
  }

  function parseModifierValues(activity) {
    const mods = new Set();
    const observations = Array.from(activity.getElementsByTagName('Observation'));
    observations.forEach(obs => {
      const valueType = text(obs, 'ValueType').toUpperCase();
      if (valueType !== 'MODIFIERS') return;
      const raw = text(obs, 'Value');
      raw.split(/[;,\s]+/).forEach(token => {
        const cleaned = String(token || '').trim().toUpperCase();
        if (cleaned) mods.add(cleaned);
      });
    });
    return Array.from(mods);
  }

  function buildMedicalClaimContext(claim, receiverID) {
    const encounter = claim.getElementsByTagName('Encounter')[0] || null;
    const contract = claim.getElementsByTagName('Contract')[0] || null;
    const encounterStart = text(encounter, 'Start');
    const encounterEnd = text(encounter, 'End');
    const parsedStart = parseEncounterDateTime(encounterStart);
    const parsedEnd = parseEncounterDateTime(encounterEnd);
    const serviceDate = (parsedStart && parsedStart.dateKey) || (parsedEnd && parsedEnd.dateKey) || '';

    const diagnoses = Array.from(claim.getElementsByTagName('Diagnosis')).map(diag => {
      const code = text(diag, 'Code');
      return {
        code,
        normalizedCode: normalizeDiagnosisCode(code),
        type: text(diag, 'Type')
      };
    }).filter(d => d.code);

    const activities = Array.from(claim.getElementsByTagName('Activity')).map(activity => {
      const code = text(activity, 'Code');
      return {
        id: text(activity, 'ID'),
        type: text(activity, 'Type'),
        code,
        normalizedCode: normalizeActivityCode(code),
        quantity: Number(text(activity, 'Quantity') || '0'),
        net: Number(text(activity, 'Net') || '0'),
        clinician: text(activity, 'Clinician').toUpperCase(),
        clinicianSpecialty: '',
        orderingClinician: text(activity, 'OrderingClinician').toUpperCase(),
        orderingSpecialty: '',
        priorAuthorizationID: text(activity, 'PriorAuthorizationID') || text(activity, 'PriorAuthorization'),
        modifiers: parseModifierValues(activity),
        observations: Array.from(activity.getElementsByTagName('Observation')).map(obs => ({
          type: text(obs, 'Type'),
          code: text(obs, 'Code'),
          valueType: text(obs, 'ValueType'),
          value: text(obs, 'Value')
        }))
      };
    });

    const patientDOB = text(claim, 'BirthDate') || text(claim, 'DateOfBirth');

    return {
      receiverID: String(receiverID || '').trim().toUpperCase(),
      claimPayerID: text(claim, 'PayerID').toUpperCase(),
      packageName: text(contract, 'PackageName'),
      claimID: text(claim, 'ID'),
      memberID: normalizeMemberLike(text(claim, 'MemberID')),
      providerID: text(claim, 'ProviderID').toUpperCase(),
      facilityID: text(encounter, 'FacilityID').toUpperCase(),
      encounterStart,
      encounterEnd,
      parsedEncounterStart: parsedStart,
      parsedEncounterEnd: parsedEnd,
      serviceDate,
      patientDOB,
      patientAge: calcAgeYears(patientDOB, serviceDate),
      diagnoses,
      activities
    };
  }

  function parseMedicalClaimContexts(xmlDoc, options = {}) {
    const receiverID = text(xmlDoc.getElementsByTagName('Header')[0], 'ReceiverID').toUpperCase();
    const requiredType = String(options.requiredEncounterType || '3');
    return Array.from(xmlDoc.getElementsByTagName('Claim')).map(claim => {
      const encounterType = text(claim.getElementsByTagName('Encounter')[0], 'Type');
      if (requiredType && encounterType !== requiredType) return null;
      return buildMedicalClaimContext(claim, receiverID);
    }).filter(Boolean);
  }

  function makeFinding({ ruleId, status = 'Invalid', remark, code = '', activityID = '', originalValue = '', expected = '', context }) {
    return {
      ruleId,
      status,
      remark,
      code,
      activityID,
      originalValue,
      expected,
      claimID: context && context.claimID ? context.claimID : '',
      receiverID: context && context.receiverID ? context.receiverID : '',
      planName: context && context.packageName ? context.packageName : ''
    };
  }

  function validateClaimPayerAndPlan(context, rules, eligibilityPackageName = '') {
    const findings = [];
    const payerConfig = (rules && rules.payers) || DEFAULT_MEDICAL_PAYER_CONFIG;
    const receiverID = String(context.receiverID || '').toUpperCase();
    const claimPayerID = String(context.claimPayerID || '').toUpperCase();

    if (!receiverID) {
      findings.push(makeFinding({
        ruleId: 'MED_RECEIVER_REQUIRED',
        remark: 'Header ReceiverID is missing.',
        originalValue: '(blank)',
        expected: 'ReceiverID must be present in Header',
        context
      }));
      return findings;
    }

    const receiverRule = payerConfig[receiverID];
    if (!receiverRule) {
      findings.push(makeFinding({
        ruleId: 'MED_RECEIVER_UNKNOWN',
        remark: `ReceiverID ${receiverID} is not configured for Medical validation.`,
        originalValue: receiverID,
        expected: `Configured ReceiverID (${Object.keys(payerConfig).join(', ')})`,
        context
      }));
      return findings;
    }

    const expectedPayers = Array.isArray(receiverRule.expectedClaimPayerIDs) ? receiverRule.expectedClaimPayerIDs.map(v => String(v).toUpperCase()) : [];
    if (expectedPayers.length > 0 && !expectedPayers.includes(claimPayerID)) {
      findings.push(makeFinding({
        ruleId: 'MED_PAYER_MISMATCH',
        remark: `Claim PayerID ${claimPayerID || '(blank)'} does not match ReceiverID ${receiverID}.`,
        originalValue: claimPayerID || '(blank)',
        expected: expectedPayers.join(' or '),
        context
      }));
    }

    if (context.packageName && eligibilityPackageName) {
      const claimPkg = normalizeLoose(context.packageName);
      const eligPkg = normalizeLoose(eligibilityPackageName);
      if (claimPkg && eligPkg && claimPkg !== eligPkg) {
        findings.push(makeFinding({
          ruleId: 'MED_PACKAGE_MISMATCH',
          remark: 'Contract PackageName does not match eligibility package name.',
          originalValue: context.packageName,
          expected: eligibilityPackageName,
          context
        }));
      }
    }

    return findings;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
  }

  function buildClaimMergeRemarks(contexts, rules) {
    const mergeReceivers = new Set((rules && rules.claimMerging && rules.claimMerging.receivers) || ['D001', 'A001', 'D004']);
    const remarks = new Map();
    const groups = new Map();
    const pairKeys = new Set();

    (contexts || []).forEach(ctx => {
      if (!mergeReceivers.has(String(ctx.receiverID || '').toUpperCase())) return;
      if (!ctx.memberID || !ctx.providerID || !ctx.facilityID || !ctx.serviceDate) return;
      const key = [ctx.receiverID, ctx.memberID, ctx.providerID, ctx.facilityID, ctx.serviceDate].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ctx);
    });

    groups.forEach(claims => {
      for (let i = 0; i < claims.length; i += 1) {
        for (let j = i + 1; j < claims.length; j += 1) {
          const a = claims[i];
          const b = claims[j];
          if (!a.claimID || !b.claimID || a.claimID === b.claimID) continue;
          if (!a.parsedEncounterStart || !a.parsedEncounterEnd || !b.parsedEncounterStart || !b.parsedEncounterEnd) continue;

          if (!overlaps(a.parsedEncounterStart.timestamp, a.parsedEncounterEnd.timestamp, b.parsedEncounterStart.timestamp, b.parsedEncounterEnd.timestamp)) {
            continue;
          }

          const aOrdering = new Set(a.activities.map(x => normalizeLoose(x.orderingClinician)).filter(Boolean));
          const bOrdering = new Set(b.activities.map(x => normalizeLoose(x.orderingClinician)).filter(Boolean));
          const sharedClinician = Array.from(aOrdering).some(v => bOrdering.has(v));
          if (!sharedClinician) continue;

          const aDx = new Set(a.diagnoses.map(d => d.normalizedCode).filter(Boolean));
          const bDx = new Set(b.diagnoses.map(d => d.normalizedCode).filter(Boolean));
          const sharedDx = Array.from(aDx).some(v => bDx.has(v));
          if (!sharedDx) continue;

          const pairKey = [a.claimID, b.claimID].sort().join('|');
          if (pairKeys.has(pairKey)) continue;
          pairKeys.add(pairKey);

          if (!remarks.has(a.claimID)) remarks.set(a.claimID, []);
          if (!remarks.has(b.claimID)) remarks.set(b.claimID, []);
          remarks.get(a.claimID).push(`${a.claimID} must be merged with ${b.claimID}.`);
          remarks.get(b.claimID).push(`${b.claimID} must be merged with ${a.claimID}.`);
        }
      }
    });

    return remarks;
  }

  function validateSingleOrderingClinician(context) {
    const findings = [];
    const nonBlank = new Set();
    const missingActivityIDs = [];
    (context.activities || []).forEach(activity => {
      const ord = normalizeLoose(activity.orderingClinician);
      if (!ord) {
        missingActivityIDs.push(activity.id || '(unknown)');
        return;
      }
      nonBlank.add(ord);
    });

    if (nonBlank.size > 1) {
      findings.push(makeFinding({
        ruleId: 'MED_ORDERING_SINGLE',
        remark: `Claim ${context.claimID} has multiple Ordering Clinicians: ${Array.from(nonBlank).join(', ')}.`,
        context
      }));
    }

    missingActivityIDs.forEach(activityID => {
      findings.push(makeFinding({
        ruleId: 'MED_ORDERING_REQUIRED',
        activityID,
        remark: `OrderingClinician is missing for activity ${activityID}.`,
        context
      }));
    });

    return findings;
  }

  function validateDuplicateCodeOrdering(context, rules) {
    const findings = [];
    const exceptionKeys = new Set(((rules && rules.duplicateActivityExceptions) || []).map(v => String(v || '').toUpperCase()));
    const seen = new Map();

    (context.activities || []).forEach(activity => {
      const code = activity.normalizedCode;
      const ordering = normalizeLoose(activity.orderingClinician);
      if (!code || !ordering) return;
      const key = `${code}|${ordering}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(activity);
    });

    seen.forEach((activities, key) => {
      if (activities.length < 2 || exceptionKeys.has(key)) return;
      const sample = activities[0];
      findings.push(makeFinding({
        ruleId: 'MED_DUPLICATE_CODE_ORDERING',
        code: sample.code,
        remark: `Duplicate code ${sample.code} with Ordering Clinician ${sample.orderingClinician}.`,
        context
      }));
    });

    return findings;
  }

  function validate97SeriesQuantityBands(context, rules) {
    const findings = [];
    const timingRules = (rules && rules.timing && rules.timing.series97) || {};
    const bands = Array.isArray(timingRules.bands) ? timingRules.bands.slice().sort((a, b) => a.min - b.min) : [];
    const prefixes = Array.isArray(timingRules.codePrefixes) && timingRules.codePrefixes.length > 0 ? timingRules.codePrefixes : ['97'];
    const relevantActivities = (context.activities || []).filter(activity => prefixes.some(prefix => activity.normalizedCode.startsWith(String(prefix).toUpperCase())));
    if (relevantActivities.length === 0) return findings;

    const start = context.parsedEncounterStart;
    const end = context.parsedEncounterEnd;
    if (!start || !end) {
      findings.push(makeFinding({
        ruleId: 'MED_97_DURATION_UNKNOWN',
        status: 'Unknown',
        remark: 'Unable to validate 97-series quantity because encounter start/end is missing.',
        context
      }));
      return findings;
    }

    const duration = Math.floor((end.timestamp - start.timestamp) / 60000);
    const totalQty = relevantActivities.reduce((sum, activity) => {
      const qty = Number(activity.quantity);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);

    if (!bands.length) {
      findings.push(makeFinding({
        ruleId: 'MED_97_BAND_CONFIG_MISSING',
        status: 'Unknown',
        remark: '97-series quantity bands are not configured.',
        context
      }));
      return findings;
    }

    const firstBand = bands[0];
    const lastBand = bands[bands.length - 1];
    if (duration < firstBand.min) {
      findings.push(makeFinding({
        ruleId: 'MED_97_DURATION_MIN',
        remark: `97-series duration ${duration} minutes is below the minimum ${firstBand.min} minutes.`,
        context
      }));
      return findings;
    }

    if (duration > lastBand.max || totalQty > Number(timingRules.maxSupportedQuantity || lastBand.quantity)) {
      findings.push(makeFinding({
        ruleId: 'MED_97_DURATION_RANGE',
        remark: `97-series duration ${duration} minutes with quantity ${totalQty} is outside configured range.`,
        context
      }));
      return findings;
    }

    const matchedBand = bands.find(band => duration >= band.min && duration <= band.max);
    if (!matchedBand) {
      findings.push(makeFinding({
        ruleId: 'MED_97_DURATION_BAND_MISSING',
        remark: `No configured 97-series timing band covers duration ${duration} minutes.`,
        context
      }));
      return findings;
    }

    if (totalQty !== matchedBand.quantity) {
      findings.push(makeFinding({
        ruleId: 'MED_97_QUANTITY_MISMATCH',
        remark: `97-series duration ${duration} minutes requires quantity ${matchedBand.quantity}, but found ${totalQty}.`,
        expected: String(matchedBand.quantity),
        originalValue: String(totalQty),
        context
      }));
    }

    return findings;
  }

  async function loadMedicalValidationRules(url = RULES_URL) {
    if (!rulesPromise) {
      rulesPromise = fetch(url)
        .then(response => {
          if (!response.ok) throw new Error(`Failed to load medical rules (${response.status})`);
          return response.json();
        })
        .catch(error => {
          console.warn('[MEDICAL] Failed to load centralized medical rules; using defaults.', error.message);
          return { payers: DEFAULT_MEDICAL_PAYER_CONFIG };
        });
    }
    return rulesPromise;
  }

  const api = {
    DEFAULT_MEDICAL_PAYER_CONFIG,
    normalizeLoose,
    normalizeMemberLike,
    normalizeActivityCode,
    normalizeDiagnosisCode,
    parseEncounterDateTime,
    parseMedicalClaimContexts,
    validateClaimPayerAndPlan,
    buildClaimMergeRemarks,
    validateSingleOrderingClinician,
    validateDuplicateCodeOrdering,
    validate97SeriesQuantityBands,
    loadMedicalValidationRules
  };

  if (typeof window !== 'undefined') {
    window.MedicalValidationShared = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
