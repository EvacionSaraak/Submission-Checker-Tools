// adoc_validation_shared.js
// -----------------------------------------------------------------------------
// Abu Dhabi Outpatient Classification (ADOC) 2027 framework.
//
// Source basis:
//   DoH Abu Dhabi Outpatient Classification (ADOC) Definitions Manual v1.4,
//   reviewed 17-Sep-2026 and issued for shadow-billing purposes.
//
// IMPORTANT:
//   This module is intentionally conservative. It activates by ENCOUNTER DATE
//   from 01-Jan-2027 onward, but only enforces rules that v1.4 states objectively.
//   It must NOT guess class/CPT mappings, prices, counting details, privileging
//   observation identifiers, or final production XML rules.
//
// Current v1.4 scope:
//   - ADOC is outpatient only.
//   - Encounter Type 1, 10 or 103 may be in scope.
//   - ADOC activities use Activity Type 11.
//   - Dental services are excluded from ADOC.
//   - Self-pay activities are excluded from ADOC.
//
// Production completion still requires DoH:
//   1. Final 2027 Claims & Adjudication Rules.
//   2. Final ADOC Counting Rules.
//   3. Final ADOC Price List and adjusters.
//   4. Production ADOC class/code crosswalk / reporting specification.
//   5. ClinicianPrivileging observation code/type/value specification.
//   6. Authoritative class-to-specialty / privileging machine-readable mapping.
// -----------------------------------------------------------------------------

(function(root) {
  'use strict';

  const EFFECTIVE_DATE_KEY = '2027-01-01';
  const ADOC_ACTIVITY_TYPE = '11';
  const ADOC_CODE_PATTERN = /^[PCSD]\d{2}$/i;
  const IN_SCOPE_ENCOUNTER_TYPES = new Set(['1', '10', '103']);
  const SELF_PAY_MARKERS = new Set(['CASH', 'SELF', 'SELFPAY', 'SELF PAY', 'SELF-PAY']);

  const DOH_PENDING = Object.freeze({
    schema: [
      'Final 2027 Claims & Adjudication Rules / production XML reporting specification.',
      'Authoritative rule defining when an otherwise outpatient encounter must carry an ADOC service event.',
      'Final exceptions for primary care, diagnostics ordered from out-of-scope settings, and other excluded services.'
    ],
    observations: [
      'Official ClinicianPrivileging observation Type/Code/Value representation.',
      'Any other mandatory ADOC observations and activity-level observation cardinality rules.',
      'Production examples for secondary/zero-value ADOC activities.'
    ],
    clinician: [
      'Authoritative machine-readable ADOC class-to-usual-provider mapping.',
      'Final clinician privileging rules and the source of truth for provider-granted/DoH privileges.',
      'Rules for specialties that legitimately span multiple ADOC classes.'
    ],
    pricing: [
      'Final ADOC Price List.',
      'All class base prices, adjusters, payer-specific exceptions, rounding and patient-share rules.',
      'Final Counting Rules governing highest-priced same-series selection and zero-value secondary classes.'
    ],
    counting: [
      'Full ADOC Counting Rules, including all general and supplementary counting rules.',
      'Rules for cross-claim same-patient/same-clinician/same-day grouping and diagnostic services.'
    ]
  });

  function directText(parent, tagName) {
    if (!parent) return '';
    const children = parent.children ? Array.from(parent.children) : [];
    const direct = children.find(child => child.tagName === tagName);
    if (direct) return String(direct.textContent || '').trim();
    const fallback = parent.getElementsByTagName?.(tagName)?.[0];
    return fallback ? String(fallback.textContent || '').trim() : '';
  }

  function normalize(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeUpper(value) {
    return normalize(value).toUpperCase();
  }

  function parseDateKey(value) {
    const raw = normalize(value);
    if (!raw) return '';
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (dmy) {
      const day = dmy[1].padStart(2, '0');
      const month = dmy[2].padStart(2, '0');
      return `${dmy[3]}-${month}-${day}`;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return '';
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getEncounter(claim) {
    return claim?.getElementsByTagName?.('Encounter')?.[0] || null;
  }

  function getEncounterDateKey(claim) {
    const encounter = getEncounter(claim);
    return parseDateKey(
      directText(encounter, 'Start') ||
      directText(encounter, 'End') ||
      directText(claim, 'EncounterStart')
    );
  }

  function isEffectiveForClaim(claim) {
    const dateKey = getEncounterDateKey(claim);
    return !!dateKey && dateKey >= EFFECTIVE_DATE_KEY;
  }

  function getClaimPayerID(claim) {
    return normalizeUpper(directText(claim, 'PayerID'));
  }

  function isSelfPayClaim(claim, options = {}) {
    const explicit = normalizeUpper(options.payerID || getClaimPayerID(claim));
    if (!explicit) return false;
    return SELF_PAY_MARKERS.has(explicit) ||
      explicit.includes('CASH') ||
      explicit.includes('SELF PAY') ||
      explicit.includes('SELFPAY');
  }

  function getClaimMode(options = {}) {
    return normalizeUpper(options.claimTypeMode);
  }

  function getActivities(claim) {
    return Array.from(claim?.getElementsByTagName?.('Activity') || []);
  }

  function getActivityInfo(activity) {
    return {
      node: activity,
      id: directText(activity, 'ID'),
      type: normalize(directText(activity, 'Type')),
      code: normalizeUpper(directText(activity, 'Code')),
      net: Number.parseFloat(directText(activity, 'Net')),
      clinician: normalizeUpper(
        directText(activity, 'Clinician') ||
        directText(activity, 'OrderingClinician')
      )
    };
  }

  function isAdocCode(code) {
    return ADOC_CODE_PATTERN.test(normalizeUpper(code));
  }

  function isAdocActivity(activity) {
    const info = activity?.node ? activity : getActivityInfo(activity);
    return info.type === ADOC_ACTIVITY_TYPE || isAdocCode(info.code);
  }

  function getScopeDecision(claim, options = {}) {
    const effective = isEffectiveForClaim(claim);
    const mode = getClaimMode(options);
    const selfPay = isSelfPayClaim(claim, options);
    const encounterType = normalize(directText(getEncounter(claim), 'Type'));

    if (!effective) {
      return { active: false, applicable: false, reason: 'before-effective-date', encounterType };
    }

    if (mode === 'DENTAL') {
      return { active: true, applicable: false, reason: 'dental-excluded', encounterType };
    }

    if (selfPay) {
      return { active: true, applicable: false, reason: 'self-pay-excluded', encounterType };
    }

    if (mode && mode !== 'MEDICAL') {
      return { active: true, applicable: false, reason: 'non-medical-mode', encounterType };
    }

    return {
      active: true,
      applicable: true,
      reason: 'medical-insured-candidate',
      encounterType,
      encounterTypeInScope: IN_SCOPE_ENCOUNTER_TYPES.has(encounterType)
    };
  }

  function finding(ruleId, remark, extra = {}) {
    return {
      ruleId,
      status: extra.status || 'Invalid',
      remark,
      activityID: extra.activityID || '',
      code: extra.code || '',
      source: 'ADOC v1.4 framework'
    };
  }

  function validateSchemaClaim(claim, options = {}) {
    const findings = [];
    const scope = getScopeDecision(claim, options);
    if (!scope.active) return findings;

    const activities = getActivities(claim).map(getActivityInfo);
    const adocActivities = activities.filter(isAdocActivity);
    if (!adocActivities.length) return findings;

    // Dental and self-pay are explicitly outside ADOC v1.4.
    if (!scope.applicable) {
      const label = scope.reason === 'dental-excluded'
        ? 'Dental services'
        : scope.reason === 'self-pay-excluded'
          ? 'Self-pay activities'
          : 'This claim type';
      findings.push(finding(
        'ADOC_SCOPE_EXCLUDED',
        `${label} are outside ADOC scope and must not be reported as ADOC activities.`
      ));
      return findings;
    }

    if (!scope.encounterTypeInScope) {
      findings.push(finding(
        'ADOC_ENCOUNTER_SCOPE',
        `ADOC activity is not valid for Encounter Type ${scope.encounterType || '(blank)'}. ADOC v1.4 allows outpatient Encounter Types 1, 10 and 103.`
      ));
    }

    adocActivities.forEach(activity => {
      if (activity.type === ADOC_ACTIVITY_TYPE && !isAdocCode(activity.code)) {
        findings.push(finding(
          'ADOC_CODE_FORMAT',
          `Activity Type 11 requires an ADOC class code in the form Pxx, Cxx, Sxx or Dxx; found "${activity.code || '(blank)'}".`,
          activity
        ));
      }

      if (isAdocCode(activity.code) && activity.type !== ADOC_ACTIVITY_TYPE) {
        findings.push(finding(
          'ADOC_ACTIVITY_TYPE',
          `ADOC class ${activity.code} must be reported with Activity Type 11; found Type ${activity.type || '(blank)'}.`,
          activity
        ));
      }
    });

    return findings;
  }

  function getObservationFramework(claim, options = {}) {
    const scope = getScopeDecision(claim, options);
    if (!scope.active) return { active: false, activities: [], pending: DOH_PENDING.observations };
    return {
      active: true,
      applicable: scope.applicable,
      activities: getActivities(claim).map(getActivityInfo).filter(isAdocActivity),
      pending: DOH_PENDING.observations
    };
  }

  function getClinicianFramework(claim, options = {}) {
    const scope = getScopeDecision(claim, options);
    if (!scope.active) return { active: false, activities: [], pending: DOH_PENDING.clinician };
    return {
      active: true,
      applicable: scope.applicable,
      activities: getActivities(claim).map(getActivityInfo).filter(isAdocActivity),
      pending: DOH_PENDING.clinician
    };
  }

  function getPricingFramework(claim, options = {}) {
    const scope = getScopeDecision(claim, options);
    if (!scope.active) return { active: false, activities: [], pending: DOH_PENDING.pricing };
    return {
      active: true,
      applicable: scope.applicable,
      activities: getActivities(claim).map(getActivityInfo).filter(isAdocActivity),
      pending: DOH_PENDING.pricing
    };
  }

  // Placeholder for the final cross-claim counting implementation.
  // v1.4 references General Counting Rule #3, but the Definitions Manual itself
  // says to refer to the full Counting Rules. Do not convert this into a hard
  // validator until the authoritative Counting Rules are loaded.
  function validateCountingDocument(xmlDocument, options = {}) {
    void xmlDocument;
    void options;
    return [];
  }

  const api = Object.freeze({
    EFFECTIVE_DATE_KEY,
    ADOC_ACTIVITY_TYPE,
    ADOC_CODE_PATTERN,
    IN_SCOPE_ENCOUNTER_TYPES,
    DOH_PENDING,
    parseDateKey,
    getEncounterDateKey,
    isEffectiveForClaim,
    isSelfPayClaim,
    getActivityInfo,
    isAdocCode,
    isAdocActivity,
    getScopeDecision,
    validateSchemaClaim,
    getObservationFramework,
    getClinicianFramework,
    getPricingFramework,
    validateCountingDocument
  });

  root.AdocValidationShared = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
