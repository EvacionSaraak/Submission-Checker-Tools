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

  function formatDxCode(rawCode) {
    const value = String(rawCode || '').trim().toUpperCase();
    if (!value) return '';
    const clean = value.replace(/[^A-Z0-9]/g, '');
    if (clean.length <= 3) return clean;
    return `${clean.slice(0, 3)}.${clean.slice(3)}`;
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

  function parseModifierValues(activity) {
    const mods = new Set();
    const observations = Array.from(activity.getElementsByTagName('Observation'));
    observations.forEach(obs => {
      const valueType = text(obs, 'ValueType').toUpperCase();
      if (valueType !== 'MODIFIERS') return;
      const raw = text(obs, 'Value');
      raw.split(/[;,\s]+/).forEach(token => {
        const cleaned = String(token || '').trim().toUpperCase();
        if (cleaned === 'VOID') mods.add('24');
        else if (cleaned === 'VOIEF1') mods.add('52');
        else if (cleaned) mods.add(cleaned);
      });
    });
    return Array.from(mods).filter(m => ['24', '25', '50', '52'].includes(m));
  }

  function getDxSets(context) {
    const principal = context.diagnoses.filter(d => normalizeLoose(d.type) === 'PRINCIPAL');
    const secondary = context.diagnoses.filter(d => normalizeLoose(d.type) !== 'PRINCIPAL');
    const all = context.diagnoses;
    const principalSet = new Set(principal.map(d => d.normalizedCode).filter(Boolean));
    const allSet = new Set(all.map(d => d.normalizedCode).filter(Boolean));
    return { principal, secondary, all, principalSet, allSet };
  }

  function hasDiagnosisPrefix(context, prefix) {
    const normalizedPrefix = normalizeDiagnosisCode(prefix);
    return (context.diagnoses || []).some(d => d.normalizedCode.startsWith(normalizedPrefix));
  }

  function buildMedicalClaimContext(claim, receiverID, options = {}) {
    const encounter = claim.getElementsByTagName('Encounter')[0] || null;
    const contract = claim.getElementsByTagName('Contract')[0] || null;
    const encounterStart = text(encounter, 'Start');
    const encounterEnd = text(encounter, 'End');
    const parsedStart = parseEncounterDateTime(encounterStart);
    const parsedEnd = parseEncounterDateTime(encounterEnd);
    const serviceDate = (parsedStart && parsedStart.dateKey) || (parsedEnd && parsedEnd.dateKey) || '';
    const specialtyMap = options.clinicianSpecialtyMap instanceof Map ? options.clinicianSpecialtyMap : new Map();

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
      const clinician = text(activity, 'Clinician').toUpperCase();
      const orderingClinician = text(activity, 'OrderingClinician').toUpperCase();
      return {
        id: text(activity, 'ID'),
        type: text(activity, 'Type'),
        code,
        normalizedCode: normalizeActivityCode(code),
        quantity: Number(text(activity, 'Quantity') || '0'),
        net: Number(text(activity, 'Net') || '0'),
        clinician,
        clinicianSpecialty: specialtyMap.get(clinician) || '',
        orderingClinician,
        orderingSpecialty: specialtyMap.get(orderingClinician) || '',
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
      return buildMedicalClaimContext(claim, receiverID, options);
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

  function normalizeStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'valid' || normalized === 'ok' || normalized === 'pass') return 'Valid';
    if (normalized === 'unknown' || normalized === 'warning') return 'Unknown';
    return 'Invalid';
  }

  function mergeFindingsBySeverity() {
    const merged = [];
    const seen = new Set();
    for (let i = 0; i < arguments.length; i += 1) {
      const group = arguments[i];
      if (!Array.isArray(group)) continue;
      group.forEach(finding => {
        if (!finding || !finding.remark) return;
        const normalized = {
          ...finding,
          status: normalizeStatus(finding.status)
        };
        const key = [
          normalized.ruleId || '',
          normalized.status || '',
          normalized.claimID || '',
          normalized.activityID || '',
          normalized.code || '',
          normalized.remark
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(normalized);
      });
    }
    const rank = { Invalid: 0, Unknown: 1, Valid: 2 };
    merged.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    return merged;
  }

  function getFinalStatusFromFindings(findings) {
    const merged = mergeFindingsBySeverity(findings);
    if (merged.some(f => f.status === 'Invalid')) return 'Invalid';
    if (merged.some(f => f.status === 'Unknown')) return 'Unknown';
    return 'Valid';
  }

  function applyFinalStatus(row) {
    const findings = Array.isArray(row.findings) ? row.findings : [];
    row.status = getFinalStatusFromFindings(findings);
    row.isValid = row.status === 'Valid';
    row.Remarks = findings
      .filter(f => f.status !== 'Valid')
      .map(f => f.remark)
      .filter(Boolean)
      .join(' ');
    return row;
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

  function validateFixedQuantityRules(context, rules) {
    const findings = [];
    const fixed = (rules && rules.fixedQuantityRules) || {};
    (context.activities || []).forEach(activity => {
      const code = activity.normalizedCode;
      const qty = Number(activity.quantity);
      if (Object.prototype.hasOwnProperty.call(fixed, code)) {
        const expectedQty = Number(fixed[code]);
        if (Number.isFinite(expectedQty) && qty !== expectedQty) {
          findings.push(makeFinding({
            ruleId: 'MED_FIXED_QTY',
            code: activity.code,
            activityID: activity.id,
            remark: `Code ${activity.code} must have quantity ${expectedQty}.`,
            expected: String(expectedQty),
            originalValue: String(qty),
            context
          }));
        }
      }
      if (Array.isArray(activity.modifiers) && activity.modifiers.length > 0 && qty !== 1) {
        findings.push(makeFinding({
          ruleId: 'MED_MODIFIER_QTY_1',
          code: activity.code,
          activityID: activity.id,
          remark: `Modifier-bearing code ${activity.code} must have quantity 1.`,
          expected: '1',
          originalValue: String(qty),
          context
        }));
      }
      if (Array.isArray(activity.modifiers) && activity.modifiers.includes('50') && qty !== 1) {
        findings.push(makeFinding({
          ruleId: 'MED_MOD50_QTY_1',
          code: activity.code,
          activityID: activity.id,
          remark: `Code ${activity.code} with modifier 50 must have quantity 1.`,
          expected: '1',
          originalValue: String(qty),
          context
        }));
      }
    });
    return findings;
  }

  function validateCodeCombinationRules(context, rules) {
    const findings = [];
    const activities = context.activities || [];
    const codes = new Set(activities.map(a => a.normalizedCode).filter(Boolean));
    const activityByCode = new Map();
    activities.forEach(a => {
      if (!a.normalizedCode) return;
      if (!activityByCode.has(a.normalizedCode)) activityByCode.set(a.normalizedCode, []);
      activityByCode.get(a.normalizedCode).push(a);
    });

    const combos = (rules && rules.mutuallyExclusiveCodes) || [];
    combos.forEach(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) return;
      const first = normalizeActivityCode(pair[0]);
      const second = normalizeActivityCode(pair[1]);
      if (codes.has(first) && codes.has(second)) {
        findings.push(makeFinding({
          ruleId: 'MED_COMBO_ACTIVITY',
          remark: `Codes ${pair[0]} and ${pair[1]} cannot coexist in the same claim.`,
          context
        }));
      }
    });

    const extraCombos = [[ '82150', '83690' ]];
    extraCombos.forEach(([a, b]) => {
      if (codes.has(a) && codes.has(b)) {
        findings.push(makeFinding({
          ruleId: 'MED_COMBO_ACTIVITY_EXTRA',
          remark: `Codes ${a} and ${b} cannot coexist in the same claim.`,
          context
        }));
      }
    });

    const has82947 = activityByCode.has('82947');
    const has82948 = activityByCode.has('82948');
    if (has82947 && has82948) {
      const pricedCount = (activityByCode.get('82947').concat(activityByCode.get('82948'))).filter(a => Number(a.net) > 0).length;
      if (pricedCount !== 1) {
        findings.push(makeFinding({
          ruleId: 'MED_82947_82948_PRICED',
          remark: 'Codes 82947 and 82948 require exactly one priced activity in the claim.',
          context
        }));
      }
    }

    const emActivities = activities.filter(a => /^92|^992/.test(String(a.normalizedCode || '')));
    const code5101 = activityByCode.get('5101') || activityByCode.get('51-01') || [];
    if (code5101.length > 0 && emActivities.length > 0) {
      const priced = code5101.concat(emActivities).filter(a => Number(a.net) > 0).length;
      if (priced !== 1) {
        findings.push(makeFinding({
          ruleId: 'MED_5101_EM_PRICED',
          remark: 'Code 51-01 with E/M activities requires exactly one priced activity.',
          context
        }));
      }
    }

    if (activityByCode.has('94760')) {
      const hasPricedEm = emActivities.some(a => Number(a.net) > 0);
      if (hasPricedEm) {
        findings.push(makeFinding({
          ruleId: 'MED_94760_EM',
          remark: 'Code 94760 cannot coexist with priced E/M activities.',
          context
        }));
      }
    }

    if (activityByCode.has('36591')) {
      findings.push(makeFinding({
        ruleId: 'MED_36591_INVALID',
        remark: 'Code 36591 is invalid and cannot be used.',
        context
      }));
    }

    const dxCodes = (context.diagnoses || []).map(d => d.normalizedCode);
    const hasJ309 = dxCodes.includes('J309');
    const hasJ459 = dxCodes.includes('J459');
    if (hasJ309 && hasJ459) {
      findings.push(makeFinding({
        ruleId: 'MED_DX_J309_J459',
        remark: 'Diagnosis J30.9 cannot be combined with J45.9 in the same claim.',
        context
      }));
    }

    const hasJ02Prefix = dxCodes.some(code => code.startsWith('J02'));
    const hasJ00 = dxCodes.includes('J00');
    if (hasJ02Prefix && hasJ00) {
      findings.push(makeFinding({
        ruleId: 'MED_DX_J02_J00',
        remark: 'Diagnosis J02* cannot be combined with J00 in the same claim.',
        context
      }));
    }

    return findings;
  }

  function validateActivityCoverageRules(context, rules) {
    const findings = [];
    const coverage = (rules && rules.activityCoverageExclusions) || {};
    const blockedByReceiver = new Set(((coverage[context.receiverID] || [])).map(normalizeActivityCode));
    const insuredOnlyBlocked = new Set((((rules && rules.coverageExclusions && rules.coverageExclusions.insuredOnlyBlockedCodes) || [])).map(normalizeActivityCode));
    const isInsured = !!context.claimPayerID && !['CASH', 'SELF', 'SELFPAY'].includes(normalizeLoose(context.claimPayerID));

    (context.activities || []).forEach(activity => {
      if (blockedByReceiver.has(activity.normalizedCode)) {
        findings.push(makeFinding({
          ruleId: 'MED_ACTIVITY_EXCLUSION',
          code: activity.code,
          activityID: activity.id,
          remark: `Code ${activity.code} is not covered for receiver ${context.receiverID}.`,
          context
        }));
      }
      if (insuredOnlyBlocked.has(activity.normalizedCode) && isInsured) {
        findings.push(makeFinding({
          ruleId: 'MED_INSURED_BLOCKED',
          code: activity.code,
          activityID: activity.id,
          remark: `Code ${activity.code} is blocked for insured claims.`,
          context
        }));
      }
    });

    return findings;
  }

  function validateDiagnosisRules(context, rules) {
    const findings = [];
    const dx = getDxSets(context);
    const receiver = context.receiverID;
    const principal = dx.principal;

    const diagnosisCoverage = (rules && rules.diagnosisCoverageExclusions) || {};
    const receiverDx = diagnosisCoverage[receiver] || {};
    const principalBlocked = new Set(((receiverDx.principal || [])).map(normalizeDiagnosisCode));
    principal.forEach(diag => {
      if (principalBlocked.has(diag.normalizedCode)) {
        findings.push(makeFinding({
          ruleId: 'MED_DX_COVERAGE_PRINCIPAL',
          remark: `Diagnosis ${formatDxCode(diag.code)} as Principal is not covered for receiver ${receiver}.`,
          context
        }));
      }
    });

    const hasOSeries = (context.diagnoses || []).some(d => d.normalizedCode.startsWith('O'));
    const hasN39 = (context.diagnoses || []).some(d => d.normalizedCode.startsWith('N39'));

    if (receiver === 'D004') {
      principal.forEach(diag => {
        if (diag.normalizedCode.startsWith('E66')) {
          findings.push(makeFinding({ ruleId: 'MED_DX_E66_PRINCIPAL_D004', remark: 'E66.* cannot be Principal under Daman Basic.', context }));
        }
        if (diag.normalizedCode === 'O9921') {
          findings.push(makeFinding({ ruleId: 'MED_DX_O9921_PRINCIPAL_D004', remark: 'O99.21 cannot be Principal under Daman Basic.', context }));
        }
        if (['L910', 'N529', 'A539', 'R5383'].includes(diag.normalizedCode)) {
          findings.push(makeFinding({ ruleId: 'MED_DX_PRINCIPAL_D004', remark: `${formatDxCode(diag.code)} cannot be Principal under Daman Basic.`, context }));
        }
        if (diag.normalizedCode.startsWith('Q')) {
          findings.push(makeFinding({ ruleId: 'MED_DX_Q_PRINCIPAL_D004', remark: 'Q-series diagnoses cannot be Principal under Daman Basic.', context }));
        }
        if (diag.normalizedCode.startsWith('F')) {
          findings.push(makeFinding({ ruleId: 'MED_DX_F_PRINCIPAL_D004', remark: 'F-series diagnoses cannot be Principal under Daman Basic.', context }));
        }
      });
    }

    if ((receiver === 'D004' || receiver === 'A001') && dx.allSet.has('E282')) {
      const e282Principal = principal.some(diag => diag.normalizedCode === 'E282');
      if (!e282Principal) {
        findings.push(makeFinding({
          ruleId: 'MED_DX_E282_PRINCIPAL',
          remark: 'E28.2 must be Principal for NAS and Daman Basic plans.',
          context
        }));
      }
    }

    if (hasOSeries && ['D649', 'R5383', 'N760', 'N96'].some(code => dx.allSet.has(code))) {
      findings.push(makeFinding({
        ruleId: 'MED_DX_O_SERIES_CONFLICT',
        remark: 'D64.9, R53.83, N76.0, and N96 cannot be combined with O-series diagnoses.',
        context
      }));
    }

    if (['O2341', 'O2342', 'O2343'].some(code => dx.allSet.has(code)) && !hasN39) {
      findings.push(makeFinding({
        ruleId: 'MED_DX_O234X_N39',
        remark: 'O23.41/O23.42/O23.43 requires companion diagnosis N39.*.',
        context
      }));
    }

    const hasZ68 = (context.diagnoses || []).some(d => d.normalizedCode.startsWith('Z68'));
    if (hasZ68 && !hasOSeries) {
      findings.push(makeFinding({
        ruleId: 'MED_DX_Z68_SUPPORT',
        remark: 'Z68.* requires O-series diagnosis support.',
        context
      }));
    }

    if (hasOSeries && hasZ68) {
      const exceptions = (((rules && rules.diagnosisRules) || {}).z68OCodeExceptions || []);
      if (!Array.isArray(exceptions) || exceptions.length === 0) {
        findings.push(makeFinding({
          ruleId: 'MED_DX_Z68_EXCEPTION_CONFIG',
          status: 'Unknown',
          remark: 'Z68/O-series exception list is incomplete; rule result is Unknown pending configured exceptions.',
          context
        }));
      }
    }

    if (hasOSeries) {
      const targetedActivities = new Set(['76856', '76857', '76830']);
      const conflict = (context.activities || []).find(a => targetedActivities.has(a.normalizedCode));
      if (conflict) {
        findings.push(makeFinding({
          ruleId: 'MED_ACTIVITY_O_SERIES_RESTRICTION',
          activityID: conflict.id,
          code: conflict.code,
          remark: `Code ${conflict.code} cannot be billed with O-series diagnoses.`,
          context
        }));
      }
      findings.push(makeFinding({
        ruleId: 'MED_O_TRIMESTER_UNVERIFIED',
        status: 'Unknown',
        remark: 'O-series trimester validation requires complete trimester mapping and is marked Unknown.',
        context
      }));
    }

    return findings;
  }

  function normalizeSpecialty(value) {
    return String(value || '').trim().toUpperCase();
  }

  function specialtyIncludes(value, term) {
    return normalizeSpecialty(value).includes(normalizeSpecialty(term));
  }

  function validateSpecialtyRules(context, rules) {
    const findings = [];
    const restrictions = (rules && rules.specialtyRestrictions) || {};
    const pathPrefixes = Array.isArray(restrictions.pathologyLabCodePrefixes) && restrictions.pathologyLabCodePrefixes.length ? restrictions.pathologyLabCodePrefixes : ['8'];
    const dieticianCodes = new Set((restrictions.dieticianCodes || []).map(normalizeActivityCode));

    const activities = context.activities || [];
    const requires992SpecialtyCheck = activities.length > 1;

    activities.forEach(activity => {
      const code = activity.normalizedCode;
      const performing = activity.clinicianSpecialty;
      const ordering = activity.orderingSpecialty;
      const performingKnown = !!normalizeSpecialty(performing);
      const orderingKnown = !!normalizeSpecialty(ordering);

      if (!performingKnown || !orderingKnown) {
        findings.push(makeFinding({
          ruleId: 'MED_SPECIALTY_SOURCE_MISSING',
          status: 'Unknown',
          activityID: activity.id,
          code: activity.code,
          remark: `Specialty source is missing for activity ${activity.code}; specialty validations are partial.`,
          context
        }));
      }

      const isLab = pathPrefixes.some(prefix => code.startsWith(normalizeActivityCode(prefix)));
      if (isLab && !specialtyIncludes(performing, 'PATHOLOGY')) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_PATHOLOGY_REQUIRED',
          code: activity.code,
          activityID: activity.id,
          remark: `Lab code ${activity.code} requires Performing specialty Pathology.`,
          context
        }));
      }

      if (specialtyIncludes(performing, 'PATHOLOGY') && !isLab) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_PATHOLOGY_RESTRICTED',
          code: activity.code,
          activityID: activity.id,
          remark: `Pathology clinicians are restricted to laboratory code families; found ${activity.code}.`,
          context
        }));
      }

      if (dieticianCodes.has(code) && !specialtyIncludes(performing, 'DIET')) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_DIETICIAN_REQUIRED',
          code: activity.code,
          activityID: activity.id,
          remark: `Code ${activity.code} requires Performing specialty Dietician.`,
          context
        }));
      }

      if (specialtyIncludes(performing, 'DIET') && !dieticianCodes.has(code)) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_DIETICIAN_RESTRICTED',
          code: activity.code,
          activityID: activity.id,
          remark: `Dietician specialty is restricted to 97802/97803; found ${activity.code}.`,
          context
        }));
      }

      if (requires992SpecialtyCheck && (code === '99202' || code === '99212') && !specialtyIncludes(ordering, 'GENERAL PRACTITIONER')) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_992_GP_REQUIRED',
          code: activity.code,
          activityID: activity.id,
          remark: `${activity.code} requires Ordering specialty General Practitioner.`,
          context
        }));
      }

      if ((code === '99203' || code === '99213') && specialtyIncludes(ordering, 'GENERAL PRACTITIONER') && Number(activity.net) !== 0) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_992_GP_FORBIDDEN',
          code: activity.code,
          activityID: activity.id,
          remark: `${activity.code} must not use General Practitioner ordering specialty unless zero-priced companion exception applies.`,
          context
        }));
      }

      if (code.startsWith('992') && (specialtyIncludes(ordering, 'OPTHALMOLOGY') || specialtyIncludes(ordering, 'OPHTHALMOLOGY') || specialtyIncludes(ordering, 'PSYCHIATRY'))) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_992_FORBIDDEN_SPECIALTY',
          code: activity.code,
          activityID: activity.id,
          remark: `${activity.code} cannot be ordered by Ophthalmology/Psychiatry specialties.`,
          context
        }));
      }

      if (code === '82607' && (context.receiverID === 'A001' || context.receiverID === 'D004') && !specialtyIncludes(ordering, 'GENERAL PRACTITIONER')) {
        findings.push(makeFinding({
          ruleId: 'MED_SPEC_82607_GP_DAMAN',
          code: activity.code,
          activityID: activity.id,
          remark: 'Code 82607 requires General Practitioner ordering specialty for Daman plans A001/D004.',
          context
        }));
      }
    });

    return findings;
  }

  function validateModifierRules(context, rules) {
    const findings = [];
    const modifierRules = (rules && rules.modifierRules) || {};
    const minorProcedureCodes = new Set((modifierRules.minorProcedureCodes || []).map(normalizeActivityCode));
    const emActivities = (context.activities || []).filter(a => /^(92|992)/.test(a.normalizedCode));
    const hasMinor = (context.activities || []).some(a => minorProcedureCodes.has(a.normalizedCode));
    const hasPricedConsult = emActivities.some(a => Number(a.net) > 0);
    const hasPregnancyDx = hasDiagnosisPrefix(context, 'O');

    (context.activities || []).forEach(activity => {
      const mods = Array.isArray(activity.modifiers) ? activity.modifiers : [];
      if (!mods.length) return;

      mods.forEach(mod => {
        const qty = Number(activity.quantity);
        if (qty !== 1) {
          findings.push(makeFinding({
            ruleId: 'MED_MODIFIER_QTY',
            code: activity.code,
            activityID: activity.id,
            remark: `Modifier ${mod} requires quantity 1 for code ${activity.code}.`,
            context
          }));
        }

        if ((mod === '24' || mod === '25' || mod === '52') && !/^(92|992)/.test(activity.normalizedCode)) {
          findings.push(makeFinding({
            ruleId: 'MED_MODIFIER_EM_REQUIRED',
            code: activity.code,
            activityID: activity.id,
            remark: `Modifier ${mod} requires an E/M code context.`,
            context
          }));
        }

        if (mod === '25') {
          if (!hasMinor) {
            findings.push(makeFinding({
              ruleId: 'MED_MODIFIER_25_MINOR',
              code: activity.code,
              activityID: activity.id,
              remark: 'Modifier 25 requires a minor procedure in the same claim.',
              context
            }));
          }
          if (!hasPricedConsult) {
            findings.push(makeFinding({
              ruleId: 'MED_MODIFIER_25_PRICED_EM',
              code: activity.code,
              activityID: activity.id,
              remark: 'Modifier 25 requires a priced E/M activity in the same claim.',
              context
            }));
          }
        }

        if (mod === '50' && !minorProcedureCodes.has(activity.normalizedCode)) {
          findings.push(makeFinding({
            ruleId: 'MED_MODIFIER_50_MINOR_ONLY',
            code: activity.code,
            activityID: activity.id,
            remark: `Modifier 50 is only allowed on configured minor procedure codes (${activity.code} not eligible).`,
            context
          }));
        }

        if (mod === '24' && hasPregnancyDx) {
          findings.push(makeFinding({
            ruleId: 'MED_MODIFIER_24_PREGNANCY',
            code: activity.code,
            activityID: activity.id,
            remark: 'Modifier 24 is restricted when pregnancy O-series diagnoses are present.',
            context
          }));
        }

        if ((mod === '24' || mod === '25' || mod === '52') && specialtyIncludes(activity.orderingSpecialty, 'PSYCHIATRY')) {
          findings.push(makeFinding({
            ruleId: 'MED_MODIFIER_PSYCHIATRY_RESTRICTION',
            code: activity.code,
            activityID: activity.id,
            remark: `Modifier ${mod} cannot be validated as eligible under Psychiatry specialty.`,
            context
          }));
        }
      });
    });

    const missing25Required = (context.activities || []).some(a => /^992/.test(a.normalizedCode) && Number(a.net) > 0 && hasMinor && !(a.modifiers || []).includes('25'));
    if (missing25Required) {
      findings.push(makeFinding({
        ruleId: 'MED_MODIFIER_25_MISSING',
        remark: 'Missing Modifier 25 for priced E/M with minor-procedure relationship.',
        context
      }));
    }

    return findings;
  }

  function validateAuthorizationRules(context, rules, options = {}) {
    const findings = [];
    const authorizationRules = (rules && rules.authorizationRequiredCodes) || {};
    const fixed = new Set((authorizationRules.fixed || []).map(normalizeActivityCode));
    const prefixes = (authorizationRules.prefixes || []).map(normalizeActivityCode);
    const approvalIndex = options.approvalIndex instanceof Map ? options.approvalIndex : new Map();

    const ctMriPrefixes = ['704', '705', '712', '721', '732', '737', '741', '742', '755', '763', '764'];
    const therapyGroups = (rules && rules.therapyCodeGroups) || {};
    const physio = new Set((therapyGroups.PHYSIOTHERAPY_CODES || []).map(normalizeActivityCode));
    const occupational = new Set((therapyGroups.OCCUPATIONAL_THERAPY_CODES || []).map(normalizeActivityCode));
    const speech = new Set((therapyGroups.SPEECH_THERAPY_CODES || []).map(normalizeActivityCode));

    (context.activities || []).forEach(activity => {
      const code = activity.normalizedCode;
      const requiresApproval =
        fixed.has(code) ||
        prefixes.some(prefix => code.startsWith(prefix)) ||
        ctMriPrefixes.some(prefix => code.startsWith(prefix)) ||
        code === '76816' ||
        physio.has(code) ||
        occupational.has(code) ||
        speech.has(code) ||
        code === '97802' ||
        code === '97803';

      if (code === '76815' && (context.receiverID === 'D001' || context.receiverID === 'C002')) {
        return;
      }

      if (!requiresApproval) return;

      const authId = String(activity.priorAuthorizationID || '').trim();
      if (!authId) {
        findings.push(makeFinding({
          ruleId: 'MED_AUTH_REQUIRED',
          activityID: activity.id,
          code: activity.code,
          remark: `Code ${activity.code} requires prior approval authorization.`,
          context
        }));
        return;
      }

      const approval = approvalIndex.get(normalizeLoose(authId));
      if (!approval) {
        findings.push(makeFinding({
          ruleId: 'MED_AUTH_SOURCE_UNKNOWN',
          status: 'Unknown',
          activityID: activity.id,
          code: activity.code,
          remark: `Authorization ${authId} was supplied for ${activity.code}, but approval source files were not available to verify it.`,
          context
        }));
        return;
      }

      if (approval.orderingClinician && activity.orderingClinician && normalizeLoose(approval.orderingClinician) !== normalizeLoose(activity.orderingClinician)) {
        findings.push(makeFinding({
          ruleId: 'MED_AUTH_ORDERING_MISMATCH',
          activityID: activity.id,
          code: activity.code,
          remark: `Authorization ${authId} Ordering Clinician does not match claim activity Ordering Clinician.`,
          context
        }));
      }

      if ((code === '97802' || code === '97803') && approval.hasReferral !== true) {
        findings.push(makeFinding({
          ruleId: 'MED_AUTH_DIET_REFERRAL',
          status: 'Unknown',
          activityID: activity.id,
          code: activity.code,
          remark: `Code ${activity.code} requires referral evidence; supplied files did not prove referral presence.`,
          context
        }));
      }

      if (context.receiverID === 'C002' && physio.has(code) && approval.hasAttachment !== true) {
        findings.push(makeFinding({
          ruleId: 'MED_AUTH_NEXTCARE_PHYSIO_ATTACHMENT',
          status: 'Unknown',
          activityID: activity.id,
          code: activity.code,
          remark: `Nextcare physiotherapy code ${activity.code} requires attachment evidence; supplied files did not prove attachment.`,
          context
        }));
      }
    });

    return findings;
  }

  function validateDrugRules(context, rules, options = {}) {
    const findings = [];
    const drugRules = (rules && rules.drugRules) || {};
    const drugsMap = options.drugsMap instanceof Map ? options.drugsMap : null;
    const thiqaReceivers = new Set((((drugRules.formularyReceivers || {}).thiqa) || []).map(normalizeLoose));
    const damanBasicReceivers = new Set((((drugRules.formularyReceivers || {}).damanBasic) || []).map(normalizeLoose));
    const quantityAuditorReceivers = new Set((drugRules.quantityAuditorReceivers || []).map(normalizeLoose));
    const amountThreshold = Number(drugRules.amountAuditorThresholdAED || 500);

    (context.activities || []).forEach(activity => {
      if (String(activity.type || '').trim() !== '5') return;
      const code = activity.normalizedCode;
      const receiver = normalizeLoose(context.receiverID);
      const drug = drugsMap ? drugsMap.get(code) : null;

      if (drug && String(drug['Drug Formulary Status'] || '').trim()) {
        const status = normalizeLoose(drug['Drug Formulary Status']);
        if (!['ACTIVE', 'GRACE'].includes(status)) {
          findings.push(makeFinding({
            ruleId: 'MED_DRUG_STATUS',
            code: activity.code,
            activityID: activity.id,
            remark: `Drug ${activity.code} has non-eligible formulary status ${drug['Drug Formulary Status']}.`,
            context
          }));
        }
      }

      if (code === normalizeActivityCode('L88-5151-05757-02') && receiver !== 'D001') {
        findings.push(makeFinding({
          ruleId: 'MED_DRUG_THIQA_ONLY',
          code: activity.code,
          activityID: activity.id,
          remark: 'Drug L88-5151-05757-02 is Thiqa-only.',
          context
        }));
      }

      if (code.startsWith('O') && receiver !== 'D001') {
        findings.push(makeFinding({
          ruleId: 'MED_DRUG_O_SERIES_THIQA_ONLY',
          code: activity.code,
          activityID: activity.id,
          remark: `Drug ${activity.code} is restricted to Thiqa receiver.`,
          context
        }));
      }

      if (Number(activity.net) > amountThreshold) {
        findings.push(makeFinding({
          ruleId: 'MED_DRUG_AUDIT_AMOUNT',
          status: 'Unknown',
          code: activity.code,
          activityID: activity.id,
          remark: `Drug ${activity.code} net amount exceeds AED ${amountThreshold}; auditor review required.`,
          context
        }));
      }

      if (quantityAuditorReceivers.has(receiver) && Number(activity.quantity) > 1) {
        findings.push(makeFinding({
          ruleId: 'MED_DRUG_AUDIT_QUANTITY',
          status: 'Unknown',
          code: activity.code,
          activityID: activity.id,
          remark: `Drug ${activity.code} quantity above 1 for receiver ${context.receiverID} requires auditor review.`,
          context
        }));
      }

      if ((thiqaReceivers.has(receiver) || damanBasicReceivers.has(receiver)) && !drug) {
        findings.push(makeFinding({
          ruleId: 'MED_DRUG_FORMULARY_UNKNOWN',
          status: 'Unknown',
          code: activity.code,
          activityID: activity.id,
          remark: `Drug ${activity.code} formulary could not be verified because drug source data is missing or unmatched.`,
          context
        }));
      }
    });

    return findings;
  }

  function buildHistoricalIndex(claimContexts) {
    const index = new Map();
    (claimContexts || []).forEach(ctx => {
      const member = normalizeMemberLike(ctx.memberID);
      const serviceDate = parseDateOnly(ctx.serviceDate);
      if (!member || !serviceDate) return;
      (ctx.activities || []).forEach(activity => {
        const code = normalizeActivityCode(activity.code || activity.normalizedCode);
        if (!code) return;
        const key = `${member}|${code}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(serviceDate.timestamp);
      });
    });
    index.forEach(values => values.sort((a, b) => a - b));
    return index;
  }

  function validateHistoricalFrequencyRules(context, rules, options = {}) {
    const findings = [];
    const historicalRules = (rules && rules.historicalFrequencyRules) || {};
    const historicalIndex = options.historicalIndex instanceof Map ? options.historicalIndex : null;
    const serviceDate = parseDateOnly(context.serviceDate);

    if (!serviceDate) {
      findings.push(makeFinding({
        ruleId: 'MED_HISTORICAL_DATE_MISSING',
        status: 'Unknown',
        remark: 'Historical validation requires a valid service date.',
        context
      }));
      return findings;
    }

    if (!historicalIndex) {
      const relevant = (context.activities || []).some(a => a.normalizedCode === '97803' || a.normalizedCode === '83036' || a.normalizedCode.startsWith('8'));
      if (relevant) {
        findings.push(makeFinding({
          ruleId: 'MED_HISTORICAL_INPUT_MISSING',
          status: 'Unknown',
          remark: 'Historical-claims input is missing; chronology rules cannot be fully validated.',
          context
        }));
      }
      return findings;
    }

    const member = normalizeMemberLike(context.memberID);
    const getPriorTimestamps = code => {
      const key = `${member}|${normalizeActivityCode(code)}`;
      const all = historicalIndex.get(key) || [];
      return all.filter(ts => ts < serviceDate.timestamp);
    };

    const exceptions = historicalRules.exceptionGroups || {};
    const cbc = Array.isArray(exceptions.CBC) ? exceptions.CBC.map(normalizeActivityCode) : [];
    const crp = Array.isArray(exceptions.CRP) ? exceptions.CRP.map(normalizeActivityCode) : [];
    const bhcg = Array.isArray(exceptions.BHCG) ? exceptions.BHCG.map(normalizeActivityCode) : [];
    const incompleteExceptions = cbc.length === 0 || crp.length === 0 || bhcg.length === 0;

    (context.activities || []).forEach(activity => {
      const code = activity.normalizedCode;
      if (code === '97803') {
        if (getPriorTimestamps('97802').length === 0) {
          findings.push(makeFinding({
            ruleId: 'MED_HIST_97802_BEFORE_97803',
            remark: 'Code 97803 requires historical 97802 before current service date.',
            context,
            code: activity.code,
            activityID: activity.id
          }));
        }
      }

      if (code === '83036') {
        const prior = getPriorTimestamps('83036');
        if (prior.length > 0) {
          const last = prior[prior.length - 1];
          const dayDiff = Math.floor((serviceDate.timestamp - last) / 86400000);
          if (dayDiff < Number(historicalRules['83036Days'] || 90)) {
            findings.push(makeFinding({
              ruleId: 'MED_HIST_83036_90D',
              remark: `Code 83036 requires at least ${historicalRules['83036Days'] || 90} days interval.`,
              context,
              code: activity.code,
              activityID: activity.id
            }));
          }
        }
      }

      if (code.startsWith('8')) {
        if (incompleteExceptions) {
          findings.push(makeFinding({
            ruleId: 'MED_HIST_EXCEPTION_CONFIG_INCOMPLETE',
            status: 'Unknown',
            remark: 'Historical exception lists (CBC/CRP/BHCG) are incomplete; laboratory frequency results are partially Unknown.',
            context,
            code: activity.code,
            activityID: activity.id
          }));
        }

        const prior = getPriorTimestamps(code);
        if (prior.length > 0) {
          const last = prior[prior.length - 1];
          const dayDiff = Math.floor((serviceDate.timestamp - last) / 86400000);
          if (code.startsWith('80')) {
            const minDays = Number(historicalRules.lab800Months || 6) * 30;
            if (dayDiff < minDays) {
              findings.push(makeFinding({
                ruleId: 'MED_HIST_800_6M',
                remark: `800-series laboratory code ${activity.code} requires at least ${historicalRules.lab800Months || 6} months interval.`,
                context,
                code: activity.code,
                activityID: activity.id
              }));
            }
          } else {
            const minDays = Number(historicalRules.otherLabDays || 3);
            if (dayDiff < minDays) {
              findings.push(makeFinding({
                ruleId: 'MED_HIST_LAB_3D',
                remark: `Laboratory code ${activity.code} requires at least ${historicalRules.otherLabDays || 3} days interval.`,
                context,
                code: activity.code,
                activityID: activity.id
              }));
            }
          }
        }
      }
    });

    return findings;
  }

  function validateMaternityRules(context) {
    const findings = [];
    const hasOSeries = hasDiagnosisPrefix(context, 'O');
    if (hasOSeries) {
      findings.push(makeFinding({
        ruleId: 'MED_MATERNITY_TRIMESTER_CONFIG',
        status: 'Unknown',
        remark: 'Maternity trimester exception matrix is incomplete; remaining maternity checks are Unknown.',
        context
      }));
    }
    return findings;
  }

  function validateTherapyRules(context, rules) {
    const findings = [];
    const therapyGroups = (rules && rules.therapyCodeGroups) || {};
    const allTherapyCodes = new Set([
      ...(therapyGroups.PHYSIOTHERAPY_CODES || []),
      ...(therapyGroups.OCCUPATIONAL_THERAPY_CODES || []),
      ...(therapyGroups.SPEECH_THERAPY_CODES || [])
    ].map(normalizeActivityCode));

    (context.activities || []).forEach(activity => {
      if (!allTherapyCodes.has(activity.normalizedCode)) return;
      if (activity.normalizedCode.startsWith('97') && Number(activity.quantity) < 1) {
        findings.push(makeFinding({
          ruleId: 'MED_THERAPY_QTY_INVALID',
          code: activity.code,
          activityID: activity.id,
          remark: `Therapy code ${activity.code} has invalid quantity ${activity.quantity}.`,
          context
        }));
      }
    });

    return findings;
  }

  function loadMedicalValidationRules(url = RULES_URL) {
    if (!rulesPromise) {
      rulesPromise = fetch(url)
        .then(response => {
          if (!response.ok) throw new Error(`Failed to load medical rules (${response.status})`);
          return response.json();
        })
        .catch(() => {
          throw new Error('Unable to load Medical validation rules.');
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
    validateSpecialtyRules,
    validateFixedQuantityRules,
    validateCodeCombinationRules,
    validateActivityCoverageRules,
    validateDiagnosisRules,
    validateAuthorizationRules,
    validateModifierRules,
    validateDrugRules,
    validateHistoricalFrequencyRules,
    validateMaternityRules,
    validateTherapyRules,
    mergeFindingsBySeverity,
    getFinalStatusFromFindings,
    applyFinalStatus,
    buildHistoricalIndex,
    loadMedicalValidationRules
  };

  if (typeof window !== 'undefined') {
    window.MedicalValidationShared = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
