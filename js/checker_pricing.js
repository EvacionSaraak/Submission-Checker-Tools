(function () { try { // checker_pricing.js
let lastResults = [];
let lastWorkbook = null;
function getDrugShared(required = true) {
  const shared = window.DrugAnalysisShared || null;
  if (!shared && required) {
    throw new Error('Drug analysis shared module is unavailable.');
  }
  return shared;
}

// Payer IDs that have a defined factor in Factors.xlsx and are valid for Medical mode
const MEDICAL_CONFIGURED_PAYERS = new Set(['D001', 'A001', 'D004', 'A025', 'A024', 'C002', 'C004']);

// Activity Type → Mandatory Tariff Type mapping
const ACTIVITY_TYPE_TO_TARIFF_TYPE = {
  '3': 'CPT',
  '6': 'USCLS',
  '8': 'SERVICE'
};

// ---- Monetary helpers ----
function moneyToCents(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100)
    : null;
}

function moneyEqual(a, b) {
  const centsA = moneyToCents(a);
  const centsB = moneyToCents(b);
  return centsA !== null && centsB !== null && centsA === centsB;
}

function compareMoney(a, b) {
  const centsA = moneyToCents(a);
  const centsB = moneyToCents(b);
  if (centsA === null || centsB === null) return null;
  if (centsA < centsB) return -1;
  if (centsA > centsB) return 1;
  return 0;
}

function roundMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : null;
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

function parseOptionalMoney(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDrugCode(value) {
  const shared = getDrugShared(false);
  if (shared && typeof shared.normalizeDrugCode === 'function') {
    return shared.normalizeDrugCode(value);
  }
  return String(value || '').trim().toUpperCase();
}

function isDrugActivityType(activityType) {
  return String(activityType || '').trim() === '5';
}

function isZeroPricedActivityForPricing(activityType, net) {
  return !isDrugActivityType(activityType) && moneyEqual(net, 0);
}

function getPricingRowActivityType(row) {
  return row && (row.ActivityType || (row.XmlRow && row.XmlRow.ActivityType) || row.type || '');
}

function getPricingRowCode(row) {
  return normalizeCode(row && (row.CPT || row.code || row.Code || ''));
}

function getPricingRowNet(row) {
  if (row && row.xmlNetNum != null) return Number(row.xmlNetNum || 0);
  return Number(row && (row.Net || row.net || 0));
}

function getPricingRowClaimGross(row) {
  return parseOptionalMoney(row && (row.ClaimGross || (row.XmlRow && row.XmlRow.ClaimGross) || ''));
}

function getPricingRowClaimNet(row) {
  return parseOptionalMoney(row && (row.ClaimNet || (row.XmlRow && row.XmlRow.ClaimNet) || ''));
}

function buildConfiguredZeroPriceCodeSet(receiverID, medicalRules) {
  const normalizedReceiver = String(receiverID || '').trim().toUpperCase();
  const zeroPriceRules = (medicalRules && medicalRules.zeroPriceCodes) || {};
  const allowed = new Set([
    ...((zeroPriceRules.always) || []),
    ...(((zeroPriceRules.byReceiver || {})[normalizedReceiver]) || [])
  ].map(normalizeCode));

  if (allowed.size === 0) {
    allowed.add('99173');
    if (['A001', 'D001', 'D004', 'A025'].includes(normalizedReceiver)) {
      allowed.add('36415');
    }
  }

  return allowed;
}

function isValidZeroPricedConsultationCompanion(row, claimRows) {
  if (!moneyEqual(getPricingRowNet(row), 0)) {
    return false;
  }

  const code = getPricingRowCode(row);
  const pairedCode = {
    '99203': '99202',
    '99213': '99212'
  }[code];

  if (!pairedCode) {
    return false;
  }

  return (claimRows || []).some(other =>
    getPricingRowCode(other) === pairedCode
    && Number(getPricingRowNet(other)) > 0
  );
}

function isAllowedZeroPricedActivityForPricing(row, claimRows, options = {}) {
  if (!isZeroPricedActivityForPricing(getPricingRowActivityType(row), getPricingRowNet(row))) {
    return false;
  }

  const allowedCodes = buildConfiguredZeroPriceCodeSet(
    options.receiverID || (row && (row.ReceiverID || row.PayerID)) || '',
    options.medicalRules || null
  );

  return allowedCodes.has(getPricingRowCode(row))
    || isValidZeroPricedConsultationCompanion(row, claimRows);
}

function requiresNonZeroMedicalPrice({ facilityID, receiverID, code, rules }) {
  const normalizedFacility = String(facilityID || '').trim().toUpperCase();
  const normalizedReceiver = String(receiverID || '').trim().toUpperCase();
  const normalizedCode = normalizeCode(code);

  return ((rules && rules.requiredPricedActivities) || []).some(rule => {
    const ruleCodes = Array.isArray(rule.codes)
      ? rule.codes
      : [rule.code];

    return String(rule.facilityID || '').trim().toUpperCase() === normalizedFacility
      && String(rule.receiverID || '').trim().toUpperCase() === normalizedReceiver
      && ruleCodes.map(normalizeCode).includes(normalizedCode);
  });
}

function getZeroPricePricingDecision({
  isMedicalMode,
  isDrugActivity,
  xmlNet,
  requiresMedicalPrice,
  isConfiguredZeroPricedActivity
}) {
  const isZeroBilled = moneyEqual(xmlNet, 0);
  const isZeroPricedDentalActivity = !isMedicalMode && !isDrugActivity && isZeroBilled;
  const mayUseMedicalZeroPrice = isMedicalMode && isZeroBilled && !requiresMedicalPrice;

  return {
    isZeroBilled,
    isZeroPricedDentalActivity,
    mayUseMedicalZeroPrice,
    zeroPricePassesPricing: isConfiguredZeroPricedActivity || isZeroPricedDentalActivity || mayUseMedicalZeroPrice
  };
}

function shouldDeferA001PricingToClaimLevel({ receiverID, xmlNet, effectiveRef, xmlQty, isAllowedZeroPricedActivity, claimPatientShare }) {
  if (isAllowedZeroPricedActivity) return false;
  // D001 (Thiqa) uses 0 patient share — no deferral
  if (receiverID === 'D001') return false;
  // For A001: always defer when net < reference (claim-level PS check handles it)
  // For other payers: defer only when patient share is applied
  const hasPatientShare = Number(claimPatientShare || 0) > 0;
  if (receiverID !== 'A001' && !hasPatientShare) return false;
  const referenceTotal = Number(effectiveRef) * Number(xmlQty || 0);
  return Number.isFinite(referenceTotal)
    && referenceTotal > 0
    && Number(xmlNet) > 0
    && Number(xmlNet) < referenceTotal;
}

function getPatientShareReferenceRows(actRows, options = {}) {
  return (actRows || []).filter(row =>
    !isAllowedZeroPricedActivityForPricing(row, actRows, {
      receiverID: options.receiverID || (row && row.ReceiverID) || '',
      medicalRules: options.medicalRules || null
    })
  );
}

function calculatePatientShareSummary(actRows, options = {}) {
  const patientShareRows = getPatientShareReferenceRows(actRows, options);
  const totalRef = roundMoney(patientShareRows.reduce((sum, row) => {
    const quantity = Number(row.ClaimedQty || row.Quantity || 1);
    const reference = row.ComputedRef !== null && row.ComputedRef !== undefined
      ? Number(row.ComputedRef)
      : getPricingRowNet(row);
    return sum + (reference * quantity);
  }, 0)) || 0;
  const totalXmlNet = roundMoney((actRows || []).reduce((sum, row) => sum + getPricingRowNet(row), 0)) || 0;
  const expectedPatientShare = roundMoney(totalRef - totalXmlNet) || 0;
  const claimGross = (actRows || []).map(getPricingRowClaimGross).find(value => value !== null) ?? null;
  const claimNet = (actRows || []).map(getPricingRowClaimNet).find(value => value !== null) ?? null;
  const actualPatientShare = Number(((actRows || [])[0] && (actRows[0].PatientShare || actRows[0].ClaimPatientShare)) || 0);

  return {
    patientShareRows,
    totalRef,
    totalXmlNet,
    expectedPatientShare,
    claimGross,
    claimNet,
    claimTotalsConsistent: claimGross !== null && claimNet !== null
      ? moneyEqual(claimGross, claimNet + actualPatientShare)
      : null
  };
}

// Apply the 3-way patient share comparison (below=Invalid, equal=Valid, above=Unknown) to the
// primary row of a claim group. Uses severity merging so existing findings are never erased.
function applyClaimLevelPatientShare(actRows, options) {
  const { receiverID, medicalRules, isMedicalMode, medicalShared } = options || {};
  const primaryRow = actRows[0];
  const actualPS = Number(primaryRow.PatientShare || 0);
  const summary = calculatePatientShareSummary(actRows, { receiverID, medicalRules });
  const totalClaimedNet = summary.totalXmlNet;
  const totalRef = summary.totalRef;
  const isMulti = actRows.length > 1;

  const comparison = compareMoney(totalClaimedNet + actualPS, totalRef);
  if (comparison === null) return;

  const netLabel = isMulti
    ? `Total Net ${formatMoney(totalClaimedNet)}`
    : `Net ${formatMoney(totalClaimedNet)}`;
  const psLabel = `Patient Share ${formatMoney(actualPS)}`;
  const refLabel = isMulti
    ? `total reference of ${formatMoney(totalRef)}`
    : `reference price of ${formatMoney(totalRef)}`;

  let psStatus, psRemark, psRuleId;
  if (comparison < 0) {
    psStatus = 'Invalid';
    psRemark = `${netLabel} plus ${psLabel} is below the ${refLabel}.`;
    psRuleId = 'MED_PATIENT_SHARE_BELOW';
  } else if (comparison === 0) {
    psStatus = 'Valid';
    psRemark = '';
    psRuleId = 'MED_PATIENT_SHARE_MATCH';
  } else {
    psStatus = 'Unknown';
    psRemark = `${netLabel} plus ${psLabel} exceeds the ${refLabel}; manual review is required.`;
    psRuleId = 'MED_PATIENT_SHARE_ABOVE';
  }

  if (isMedicalMode && medicalShared && medicalRules) {
    primaryRow.findings = medicalShared.mergeFindingsBySeverity(
      primaryRow.findings,
      [asMedicalFinding({
        ruleId: psRuleId,
        status: psStatus,
        remark: psRemark,
        claimID: primaryRow.ClaimID,
        activityID: primaryRow.ActivityID,
        code: primaryRow.CPT
      })]
    );
    medicalShared.applyFinalStatus(primaryRow);
  } else {
    // Only escalate severity; never lower an existing Invalid/Unknown status
    const sev = { 'Invalid': 3, 'Unknown': 2, 'Valid': 1 };
    const existingSev = sev[primaryRow.status] || 0;
    const psSev = sev[psStatus] || 0;
    if (psSev > existingSev) {
      primaryRow.status = psStatus;
      primaryRow.isValid = psStatus === 'Valid';
    }
    if (psRemark) {
      primaryRow.Remarks = primaryRow.Remarks ? `${primaryRow.Remarks} ${psRemark}` : psRemark;
    }
  }
}

function shouldAddNoPricingMatchRemark({ match, endoEntry, isZeroPricedActivity }) {
  return !match && !endoEntry && !isZeroPricedActivity;
}

function shouldAddMissingEndoPriceRemark({ endoEntry, refPrice, isZeroPricedActivity }) {
  return !!endoEntry && refPrice === null && !isZeroPricedActivity;
}

function shouldAddInvalidReferenceRemark({ match, endoEntry, refPrice, ref, isZeroPricedActivity }) {
  return (match || endoEntry) && refPrice !== null && Number.isNaN(ref) && !isZeroPricedActivity;
}

// Return the Bootstrap row-class for a pricing result row.
function getPricingRowClass(row) {
  const status = String(row.status || '').trim().toLowerCase();
  if (status === 'valid' || status === 'ok') return 'table-success';
  if (status === 'unknown') return 'table-warning';
  return 'table-danger';
}

function buildModifierPriceMismatchRemark({ claimedNet, code, modifier, expectedPrice }) {
  return (
    `Claimed Net ${formatMoney(claimedNet)} ` +
    `(for ${code}) does not match the price under ` +
    `modifier ${modifier} ` +
    `(should be ${formatMoney(expectedPrice)}).`
  );
}

function buildMissingModifierRemark({ modifier, code, multiplier }) {
  return (
    `Modifier ${modifier} is missing from ${code} ` +
    `but price was changed with ${multiplier} quantity.`
  );
}

function asMedicalFinding({ ruleId, status, remark, claimID, activityID, code }) {
  return {
    ruleId: ruleId || 'PRICING',
    status: status || 'Invalid',
    remark: remark || '',
    claimID: claimID || '',
    activityID: activityID || '',
    code: code || ''
  };
}

function findingKey(claimID, activityID) {
  return `${String(claimID || '')}|${String(activityID || '')}`;
}

function dedupeFindingsByRuleAndSeverity(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const deduped = [];
  const seen = new Set();
  list.forEach(f => {
    if (!f || !f.ruleId) return;
    const key = `${f.ruleId}|${f.status || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(f);
  });
  return deduped;
}

function getKnownCptTypeResult(rec, drugsMap, knownCptCodeSet, drugListSource) {
  const codeRaw = String(rec.CPT || '').trim();
  const code = normalizeCode(codeRaw);
  const hasDrugMatch = !!(drugsMap && drugsMap.has(normalizeDrugCode(codeRaw)));

  if (!hasDrugMatch && code && knownCptCodeSet && knownCptCodeSet.has(code)) {
    return {
      status: 'Invalid',
      findings: [{
        ruleId: 'DRUG_CPT_TYPE',
        status: 'Invalid',
        remark: `Invalid CPT Type for ${codeRaw} (should be 3).`
      }]
    };
  }

  return {
    status: 'Unknown',
    findings: [{
      ruleId: 'DRUG_CODE_UNKNOWN',
      status: 'Unknown',
      remark: `Drug code ${codeRaw} was not found in ${drugListSource}.`
    }]
  };
}

function analyzeDrugActivity(rec, options = {}) {
  const shared = getDrugShared();
  const receiverID = String(options.receiverID || '').trim().toUpperCase();
  const codeRaw = String(rec.CPT || '').trim();
  const quantity = Number(rec.Quantity || 0);
  const claimedNet = Number(rec.Net || 0);
  const activityType = String(rec.ActivityType || '').trim();
  const drugListSource = options.drugListSource || 'resources/Drugs.xlsx';
  const drugsMap = options.drugsMap && typeof options.drugsMap.get === 'function' ? options.drugsMap : null;
  const knownCptCodeSet = options.knownCptCodeSet || new Set();
  const quantityAuditorReceivers = options.quantityAuditorReceivers || shared.DEFAULT_QUANTITY_AUDITOR_RECEIVERS;
  const isZeroPriced = moneyEqual(claimedNet, 0);

  let findings = [];
  let drug = null;
  const normalizedDrugCode = normalizeDrugCode(codeRaw);
  if (drugsMap) {
    drug = drugsMap.get(normalizedDrugCode) || null;
  }

  if (!codeRaw) {
    findings.push({
      ruleId: 'DRUG_CODE_MISSING',
      status: 'Invalid',
      remark: 'Type 5 activity has a missing drug code.'
    });
  } else if (!drug) {
    const unknownCodeResult = getKnownCptTypeResult(rec, drugsMap, knownCptCodeSet, drugListSource);
    findings = findings.concat(unknownCodeResult.findings);
  }

  const statusInfo = drug ? shared.validateDrugStatus(drug, codeRaw) : null;
  if (statusInfo && statusInfo.remark) {
    findings.push({
      ruleId: statusInfo.ruleId,
      status: statusInfo.status,
      remark: statusInfo.remark
    });
  }

  const formularyInfo = drug
    ? shared.validateDrugFormulary(drug, receiverID, codeRaw)
    : { formularyName: '', valueRaw: '', applies: false, included: null };

  if (!isZeroPriced && formularyInfo && formularyInfo.remark) {
    findings.push({
      ruleId: formularyInfo.ruleId,
      status: formularyInfo.status,
      remark: formularyInfo.remark
    });
  }

  const requiredQuantity = drug ? shared.calculateRequiredDrugQuantity(drug) : null;
  if (drug) {
    findings = findings.concat(shared.validateDrugQuantity({
      code: codeRaw,
      quantity,
      requiredQuantity,
      receiverID,
      quantityAuditorReceivers
    }));
  }

  const selectedPricing = drug ? shared.selectDrugPricing(drug, quantity) : { value: null, source: '', basis: '' };
  const expectedNet = shared.calculateExpectedDrugNet(selectedPricing.value, quantity);
  let priceResult = 'Unknown';

  if (isZeroPriced) {
    priceResult = 'Valid';
  } else if (!formularyInfo.applies || formularyInfo.included === true) {
    if (drug) {
      if (selectedPricing.value === null || expectedNet === null) {
        findings.push({
          ruleId: 'DRUG_PRICE_SOURCE',
          status: 'Unknown',
          remark: `Unable to determine a pricing source for drug ${codeRaw}.`
        });
      } else if (shared.moneyEqual(claimedNet, expectedNet)) {
        priceResult = 'Valid';
      } else {
        priceResult = 'Invalid';
        findings.push({
          ruleId: 'DRUG_PRICING',
          status: 'Invalid',
          remark: `Claimed Net ${formatMoney(claimedNet)} (for ${codeRaw}) does not match expected drug price ${formatMoney(selectedPricing.value)} × ${formatMoney(quantity)} = ${formatMoney(expectedNet)}.`
        });
      }
    }
  }

  findings = dedupeFindingsByRuleAndSeverity(shared.mergeDrugFindings(findings));
  const finalStatus = shared.getFinalStatusFromFindings(findings);
  const nonValidRemarks = findings.filter(f => f.status !== 'Valid').map(f => f.remark).filter(Boolean);

  return {
    ClaimID: rec.ClaimID || '',
    ActivityID: rec.ActivityID || '',
    ActivityType: activityType || '5',
    CPT: rec.CPT || '',
    DrugCode: codeRaw,
    ClaimedNet: rec.Net || '',
    ClaimedQty: rec.Quantity || '',
    ReferenceNetPrice: selectedPricing.value == null ? '' : String(selectedPricing.value),
    AppliedFactor: '',
    FactoredReference: expectedNet == null ? '' : String(expectedNet),
    PricingRow: drug,
    XmlRow: rec,
    isValid: finalStatus === 'Valid',
    status: finalStatus,
    Remarks: nonValidRemarks.join(' '),
    ComputedRef: expectedNet,
    xmlNetNum: claimedNet,
    PatientShare: rec.PatientShare || '0',
    ClaimGross: rec.ClaimGross || '',
    ClaimNet: rec.ClaimNet || '',
    ReceiverID: receiverID,
    ClaimPayerID: String(rec.PayerID || '').trim().toUpperCase(),
    PayerID: receiverID,
    _matchedFactorRule: null,
    _modifierMultiplier: 1,
    _drugPricingMeta: drug ? {
      drug,
      basis: selectedPricing.basis,
      source: selectedPricing.source,
      pricePerBasis: selectedPricing.value
    } : null,
    _drugExpectedNet: expectedNet,
    _drugRequiredQuantity: requiredQuantity,
    _drugQuantityResult: findings.find(f => f.ruleId === 'DRUG_QUANTITY')?.status || '',
    _drugPriceResult: priceResult,
    _drugStatus: statusInfo ? statusInfo.value : '',
    _drugFormularyName: formularyInfo.formularyName || '',
    _drugFormularyValue: formularyInfo.valueRaw || '',
    findings: findings.map(f => asMedicalFinding({
      ruleId: f.ruleId,
      status: f.status,
      remark: f.remark,
      claimID: rec.ClaimID,
      activityID: rec.ActivityID,
      code: codeRaw
    }))
  };
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const runBtn = el('run-button');
    const dlBtn = el('export-invalids-button');
    const dlAllBtn = el('export-all-button');
    if (runBtn) runBtn.addEventListener('click', handleRun);
    if (dlBtn) dlBtn.addEventListener('click', handleDownload);
    if (dlAllBtn) dlAllBtn.addEventListener('click', handleDownloadAll);
    resetUI();
  } catch (error) { console.error('[PRICING] DOMContentLoaded initialization error:', error); }
});

// ----------------- Main run handler -----------------
function normalizeClaimTypeMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'MEDICAL' || normalized === 'DENTAL' ? normalized : null;
}

async function handleRun(options = {}) {
  resetUI();
  try {
    const explicitMode = String(options.claimTypeMode || '').trim().toUpperCase();
    const selectedMode = explicitMode || String(getSelectedClaimTypeMode() || '').trim().toUpperCase();
    const isMedicalMode = selectedMode === 'MEDICAL';

    console.log(`[PRICING] Claim type mode: ${selectedMode || '(missing)'}`);

    if (!['MEDICAL', 'DENTAL'].includes(selectedMode)) {
      throw new Error('Pricing Checker could not determine the selected claim type.');
    }

    let xmlFile =
      options.xmlFile ||
      fileEl('xml-file') ||
      window.unifiedCheckerFiles?.xml;

    let xlsxFile =
      options.xlsxFile ||
      fileEl('xlsx-file') ||
      window.unifiedCheckerFiles?.pricing ||
      null;

    let drugsFile =
      options.drugsFile ||
      fileEl('drugs-file') ||
      window.unifiedCheckerFiles?.drugs ||
      null;

    if (!xmlFile) throw new Error('Please select an XML file.');
    showProgress(5, 'Reading files');

    const [xmlText, dentalPricingRaw, clinicianData, endoPricingRaw, medicalPricingRaw, minorProceduresRaw] = await Promise.all([
      readFileText(xmlFile),
      fetch('../json/dental_pricing.json').then(r => r.json()).catch(e => { console.warn('[PRICING] Failed to load dental_pricing.json:', e); return []; }),
      fetch('../json/clinician_licenses.json').then(r => r.json()).catch(() => []),
      fetch('../json/endo_pricing.json').then(r => r.json()).catch(() => []),
      fetch('../json/medical_pricing.json').then(r => r.json()).catch(e => { console.warn('[PRICING] Failed to load medical_pricing.json:', e); return []; }),
      fetch('../json/minor_procedures.json').then(r => r.json()).catch(() => [])
    ]);

    if (!Array.isArray(dentalPricingRaw) || dentalPricingRaw.length === 0) throw new Error('Dental pricing data could not be loaded.\nEnsure dental_pricing.json is present in the json/ folder.');

    // Build set of minor procedure codes for modifier 50 multiplier
    const minorProcedureCodes = new Set((Array.isArray(minorProceduresRaw) ? minorProceduresRaw : [])
      .map(item => normalizeCode(typeof item === 'string' ? item : (item && item.code) ? item.code : ''))
      .filter(Boolean));

    let xlsxMatcher = null;
    if (xlsxFile) {
      const xlsxObj = await readXlsx(xlsxFile);
      xlsxMatcher = buildPricingMatcher(xlsxObj.rows);
      console.log('[PRICING] Using uploaded XLSX for pricing override');
    }

    // Load drug pricing from Drugs XLSX ("Drugs" sheet), then fallback to bundled resources/Drugs.xlsx
    let drugsMap = null;
    let usingBundledDrugs = false;
    if (drugsFile) {
      const loaded = await loadDrugsMap(drugsFile);
      drugsMap = loaded.map;
      console.log('[PRICING] Drugs map loaded, entries:', drugsMap ? drugsMap.size : 0);
    } else {
      const loaded = await loadBundledDrugsMap();
      drugsMap = loaded.map;
      usingBundledDrugs = !!drugsMap;
      console.log('[PRICING] Bundled drugs map loaded, entries:', drugsMap ? drugsMap.size : 0);
    }

    // Load factor rules from bundled resources/Factors.xlsx (Medical mode only; throws user-facing error if unavailable in medical mode)
    const factorRules = await loadBundledFactorRules(isMedicalMode);
    console.log('[PRICING] Factor rules loaded, count:', factorRules ? factorRules.length : 0);

    showProgress(25, 'Parsing XML & pricing data');

    const xmlDoc = parseXml(xmlText);
    const headerNode = xmlDoc.querySelector('Header');
    const receiverID = headerNode?.querySelector('ReceiverID')?.textContent.trim() || '';
    const pricingReceiverID = receiverID.toUpperCase();

    console.log(`[PRICING] ReceiverID: ${pricingReceiverID || '(MISSING)'}`);
    if (pricingReceiverID !== 'D001' && pricingReceiverID !== 'A001') console.log(`[PRICING] ReceiverID "${pricingReceiverID}" is non-Thiqa/non-Daman — prices will be marked Unknown; PS=0 check will still apply.`);

    const extracted = extractPricingRecords(xmlDoc);
    const jsonMatcher = buildJsonPricingMatcher(dentalPricingRaw);
    const medicalMatcher = buildMedicalPricingMatcher(medicalPricingRaw);
    const knownCptCodeSet = buildKnownCptCodeSet({
      jsonMatcher,
      xlsxMatcher,
      medicalPricingRaw
    });

    const clinicianSpecialtyMap = new Map();
    (Array.isArray(clinicianData) ? clinicianData : []).forEach(e => {
      const lic = String(e['Phy Lic'] || '').trim();
      if (lic) clinicianSpecialtyMap.set(lic, String(e['Specialty'] || '').trim());
    });
    const claimRecordsByID = new Map();
    extracted.forEach(rec => {
      if (!claimRecordsByID.has(rec.ClaimID)) claimRecordsByID.set(rec.ClaimID, []);
      claimRecordsByID.get(rec.ClaimID).push(rec);
    });

    const endoPricingMap = new Map();
    (Array.isArray(endoPricingRaw) ? endoPricingRaw : []).forEach(e => {
      if (e.code) endoPricingMap.set(normalizeCode(e.code), e);
    });

    const medicalShared = window.MedicalValidationShared || null;
    let medicalRules = null;
    const businessFindingsByRowKey = new Map();
    const claimLevelBusinessFindings = new Map();

    if (isMedicalMode) {
      if (!medicalShared) {
        throw new Error('Medical validation shared module is unavailable.');
      }
      medicalRules = await medicalShared.loadMedicalValidationRules();
      if (!medicalRules || typeof medicalRules !== 'object') {
        throw new Error('Unable to load Medical validation rules.');
      }
      const modifierRules = medicalRules.modifierRules || {};
      if (!Array.isArray(modifierRules.minorProcedureCodes) || modifierRules.minorProcedureCodes.length === 0) {
        modifierRules.minorProcedureCodes = Array.from(minorProcedureCodes || []);
      }
      medicalRules.modifierRules = modifierRules;

      const historicalIndex = null;
      const contexts = medicalShared.parseMedicalClaimContexts(xmlDoc, {
        requiredEncounterType: '3',
        clinicianSpecialtyMap
      });

      contexts.forEach(ctx => {
        const sharedFindings = medicalShared.mergeFindingsBySeverity(
          medicalShared.validateClaimPayerAndPlan(ctx, medicalRules),
          medicalShared.validateSingleOrderingClinician(ctx),
          medicalShared.validateDuplicateCodeOrdering(ctx, medicalRules),
          medicalShared.validate97SeriesQuantityBands(ctx, medicalRules),
          medicalShared.validateSpecialtyRules(ctx, medicalRules),
          medicalShared.validateFixedQuantityRules(ctx, medicalRules),
          medicalShared.validateCodeCombinationRules(ctx, medicalRules),
          medicalShared.validateActivityCoverageRules(ctx, medicalRules),
          medicalShared.validateDiagnosisRules(ctx, medicalRules),
          medicalShared.validateAuthorizationRules(ctx, medicalRules, { approvalIndex: null }),
          medicalShared.validateModifierRules(ctx, medicalRules),
          medicalShared.validateDrugRules(ctx, medicalRules, { drugsMap }),
          medicalShared.validateHistoricalFrequencyRules(ctx, medicalRules, { historicalIndex }),
          medicalShared.validateMaternityRules(ctx, medicalRules),
          medicalShared.validateTherapyRules(ctx, medicalRules)
        );

        sharedFindings.forEach(finding => {
          const key = findingKey(finding.claimID || ctx.claimID, finding.activityID || '');
          if (!finding.activityID) {
            if (!claimLevelBusinessFindings.has(ctx.claimID)) claimLevelBusinessFindings.set(ctx.claimID, []);
            claimLevelBusinessFindings.get(ctx.claimID).push(finding);
            return;
          }
          if (!businessFindingsByRowKey.has(key)) businessFindingsByRowKey.set(key, []);
          businessFindingsByRowKey.get(key).push(finding);
        });
      });
    }

    showProgress(50, 'Comparing records');

    const output = extracted.map(rec => {
      const remarks = [];
      let status = 'Invalid';
      const facility = rec.FacilityID || '';
      const xmlNet = Number(rec.Net || 0);
      const xmlQty = Number(rec.Quantity || 0);
      const isDrugActivity = isDrugActivityType(rec.ActivityType);
      const claimRows = claimRecordsByID.get(rec.ClaimID) || [];
      const isConfiguredZeroPricedActivity = isAllowedZeroPricedActivityForPricing(rec, claimRows, {
        receiverID: pricingReceiverID,
        medicalRules
      });
      const claimPayerID = String(rec.PayerID || '').trim().toUpperCase();

      if (!isDrugActivity && pricingReceiverID !== 'D001' && pricingReceiverID !== 'A001') {
        if (isMedicalMode && MEDICAL_CONFIGURED_PAYERS.has(pricingReceiverID)) {
          // Configured medical payer — fall through to medical pricing
        } else if (isMedicalMode) {
          // Unconfigured payer in Medical mode
          const missingReceiver = !pricingReceiverID;
          return {
            ClaimID: rec.ClaimID || '',
            ActivityID: rec.ActivityID || '',
            CPT: rec.CPT || '',
            ClaimedNet: rec.Net || '',
            ClaimedQty: rec.Quantity || '',
            Modifiers: rec.Modifiers || '',
            ReferenceNetPrice: '',
            AppliedFactor: '',
            FactoredReference: '',
            PricingRow: null,
            XmlRow: rec,
            isValid: false,
            status: 'Unknown',
            Remarks: missingReceiver
              ? 'Header ReceiverID is missing. Medical factor pricing requires ReceiverID from the submission header.'
              : `No medical pricing factor configuration is available for receiver ${pricingReceiverID}.`,
            ComputedRef: null,
            xmlNetNum: xmlNet,
            PatientShare: rec.PatientShare || '0',
            ClaimGross: rec.ClaimGross || '',
            ClaimNet: rec.ClaimNet || '',
            ReceiverID: pricingReceiverID,
            ClaimPayerID: claimPayerID,
            PayerID: pricingReceiverID,
            _matchedFactorRule: null,
            _modifierMultiplier: 1
          };
        } else {
          return {
            ClaimID: rec.ClaimID || '',
            ActivityID: rec.ActivityID || '',
            CPT: rec.CPT || '',
            ClaimedNet: rec.Net || '',
            ClaimedQty: rec.Quantity || '',
            Modifiers: rec.Modifiers || '',
            ReferenceNetPrice: '',
            AppliedFactor: '',
            FactoredReference: '',
            PricingRow: null,
            XmlRow: rec,
            isValid: false,
            status: 'Unknown',
            Remarks: '',
            ComputedRef: null,
            xmlNetNum: xmlNet,
            PatientShare: rec.PatientShare || '0',
            ClaimGross: rec.ClaimGross || '',
            ClaimNet: rec.ClaimNet || '',
            ReceiverID: pricingReceiverID,
            ClaimPayerID: claimPayerID,
            PayerID: pricingReceiverID,
            _matchedFactorRule: null,
            _modifierMultiplier: 1
          };
        }
      }

      if (isDrugActivity) {
        const drugListSource = usingBundledDrugs ? 'resources/Drugs.xlsx' : 'the uploaded Drugs sheet';
        return analyzeDrugActivity(rec, {
          receiverID: pricingReceiverID,
          drugsMap,
          knownCptCodeSet,
          drugListSource,
          quantityAuditorReceivers: (medicalRules && medicalRules.drugRules && Array.isArray(medicalRules.drugRules.quantityAuditorReceivers))
            ? new Set(medicalRules.drugRules.quantityAuditorReceivers.map(v => String(v || '').trim().toUpperCase()))
            : getDrugShared().DEFAULT_QUANTITY_AUDITOR_RECEIVERS
        });
      }

      if (normalizeCode(rec.CPT) === '2111' && (pricingReceiverID === 'D001' || pricingReceiverID === 'A001')) {
        const insurerLabel = pricingReceiverID === 'D001' ? 'Thiqa' : 'Daman';
        if (xmlNet === 0) {
          status = 'Valid';
          remarks.push(`Code 02111 is correctly priced at 0 for ${insurerLabel}.`);
        } else {
          status = 'Invalid';
          remarks.push(`Code 02111 must always have a net price of 0 for ${insurerLabel}.\nClaimed Net: ${xmlNet}.`);
        }
        return {
          ClaimID: rec.ClaimID || '',
          ActivityID: rec.ActivityID || '',
          CPT: rec.CPT || '',
          ClaimedNet: rec.Net || '',
          ClaimedQty: rec.Quantity || '',
          Modifiers: rec.Modifiers || '',
          ReferenceNetPrice: '0',
          AppliedFactor: '',
          FactoredReference: '0',
          PricingRow: null,
          XmlRow: rec,
          isValid: status === 'Valid',
          status,
          Remarks: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join(' '),
          ComputedRef: 0,
          xmlNetNum: xmlNet,
          PatientShare: rec.PatientShare || '0',
          ClaimGross: rec.ClaimGross || '',
          ClaimNet: rec.ClaimNet || '',
          ReceiverID: pricingReceiverID,
          ClaimPayerID: claimPayerID,
          PayerID: pricingReceiverID,
          _matchedFactorRule: null,
          _modifierMultiplier: 1
        };
      }

      let refPrice = '';
      let matchRow = null;
      let pricingContext;
      let isMedicalPricingMatch = false;

      if (!isMedicalMode && xlsxMatcher) {
        const isAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
        pricingContext = isAlyaharGroup ? 'Alyahar/Emirates/Al Wagan Thiqa Pricing' : 'Standard Thiqa Pricing';
      } else if (!isMedicalMode && pricingReceiverID === 'A001') {
        const isDamanKhabisiAlyahar = facility === 'MF5020' || facility === 'MF5357';
        pricingContext = isDamanKhabisiAlyahar ? 'Daman – Khabisi/Al Yahar pricing' : 'Daman – Standard pricing';
      } else if (!isMedicalMode) {
        const isThiqaAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
        pricingContext = isThiqaAlyaharGroup ? 'Alyahar/Emirates/Al Wagan Thiqa Pricing' : 'Standard Thiqa Pricing';
      }
      // Medical mode: pricingContext will be set after medicalMatch is found below

      if (!isMedicalMode && xlsxMatcher) {
        const xlsxMatch = xlsxMatcher.find(rec.CPT);
        if (xlsxMatch) {
          const isAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
          refPrice = isAlyaharGroup ? xlsxMatch._secondaryPrice : xlsxMatch._primaryPrice;
          matchRow = xlsxMatch;
        }
      } else if (!isMedicalMode) {
        // Bundled Dental pricing
        const jsonMatch = jsonMatcher.find(rec.CPT);
        if (jsonMatch) {
          if (pricingReceiverID === 'A001') {
            const isDamanKhabisiAlyahar = facility === 'MF5020' || facility === 'MF5357';
            refPrice = isDamanKhabisiAlyahar ? jsonMatch.daman_khabisi_alyahar : jsonMatch.daman_default;
          } else {
            const isThiqaAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
            refPrice = isThiqaAlyaharGroup ? jsonMatch.thiqa_alyahar : jsonMatch.thiqa_other;
          }
          matchRow = jsonMatch;
        }
      } else {
        // Medical mandatory-tariff pricing
        const medicalMatch = medicalMatcher.find(rec.ActivityType, rec.CPT);
        if (medicalMatch) {
          refPrice = medicalMatch.price;
          matchRow = medicalMatch;
          pricingContext = 'Mandatory Tariff Standard Pricing';
          isMedicalPricingMatch = true;
        }
      }

      let drugPricingMeta = null;

      let endoEntry = null;
      let nonEndoUsedEndoPrice = false;
      let nonEndoClinicianSpec = '';

      if (pricingReceiverID === 'D001') {
        const encounterDate = parseEncounterDate(rec.EncounterDate);
        const isAfterCutoff = encounterDate !== null && encounterDate >= ENDO_PRICING_CUTOFF;
        const clinicianSpec = clinicianSpecialtyMap.get(rec.ClinicianLic || '') || '';
        const isEndo = clinicianSpec === 'Endodontics';

        if (isAfterCutoff) {
          const pricingEntry = endoPricingMap.get(normalizeCode(rec.CPT)) || null;
          if (pricingEntry) {
            const endoRef = Number(pricingEntry.endo_price);
            const gpRef = pricingEntry.gp_price;
            const xmlUnit = xmlQty > 0 ? xmlNet / xmlQty : NaN;

            if (isEndo) {
              endoEntry = pricingEntry;
              refPrice = pricingEntry.endo_price;
              pricingContext = 'Endodontist Pricing';
            } else {
              nonEndoClinicianSpec = clinicianSpec || 'General Dentist';
              nonEndoUsedEndoPrice = Number.isFinite(endoRef) && (moneyEqual(xmlNet, endoRef) || moneyEqual(xmlUnit, endoRef) || moneyEqual(xmlNet * 2, endoRef));

              if (gpRef !== undefined && gpRef !== null && gpRef !== '') {
                endoEntry = pricingEntry;
                refPrice = gpRef;
                pricingContext = 'Endo GD Pricing';
              }
            }
          }
        }
      }

      const match = matchRow;
      let ref = Number(refPrice ?? NaN);
      let effectiveRef = ref; // ref after applying factor and modifier multipliers
      let referenceFactor = 1;
      let appliedFactor = 1;
      let modifierMultiplier = 1;
      let matchedFactorRule = null;

      if (isMedicalMode && isMedicalPricingMatch) {
        // Step 1: look up the facility/payer factor from Factors.xlsx rules
        const factorResult = findFactorFromRules(factorRules || [], rec.FacilityID, rec.CPT, pricingReceiverID);
        appliedFactor = factorResult.factor;
        matchedFactorRule = factorResult.rule;

        // Step 2: modifier multiplier is a separate adjustment on top of the factor
        if (rec.Modifier === '52') modifierMultiplier = 0.5;
        else if (rec.Modifier === '50') modifierMultiplier = 1.5;
        // Modifiers 24 and 25: no price change (multiplier stays 1)

        referenceFactor = appliedFactor * modifierMultiplier;
        if (!Number.isNaN(ref) && ref > 0) {
          effectiveRef = Math.round(ref * referenceFactor * 100) / 100;
        }

        // Update pricing context with matched rule details for remark/audit
        if (matchedFactorRule) {
          pricingContext = `Mandatory Tariff [${matchedFactorRule.serviceType || matchedFactorRule.matchType}; Factor ${appliedFactor} for ${pricingReceiverID}]`;
        }
      } else if (!Number.isNaN(ref) && ref > 0 && rec.Modifier) {
        // Apply modifier price multipliers (dental/non-medical pricing, existing behavior)
        if (rec.Modifier === '52') {
          // Consultation price halved
          referenceFactor = 0.5;
          effectiveRef = Math.round(ref * referenceFactor * 100) / 100;
        } else if (rec.Modifier === '50') {
          // Minor procedure: ×1.5 for A001, ×(1.3×1.5) for D001
          const mult = pricingReceiverID === 'D001' ? 1.3 * 1.5 : 1.5;
          referenceFactor = mult;
          effectiveRef = Math.round(ref * referenceFactor * 100) / 100;
        }
        // Modifier 25 and 24: no price change
      }

      // Ensure pricingContext has a fallback for Medical mode when no tariff match was found
      if (!pricingContext) {
        pricingContext = isMedicalMode ? 'Mandatory Tariff Pricing' : 'Standard Thiqa Pricing';
      }

      const computedRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref) ? effectiveRef : null;

      if (xmlQty <= 0) remarks.push(xmlQty === 0 ? 'Quantity is 0 (invalid)' : 'Quantity is less than 0 (invalid)');
      const requiresMedicalPrice = isMedicalMode
        ? requiresNonZeroMedicalPrice({
            facilityID: rec.FacilityID,
            receiverID: pricingReceiverID,
            code: rec.CPT,
            rules: medicalRules
          })
        : false;
      const zeroPriceDecision = getZeroPricePricingDecision({
        isMedicalMode,
        isDrugActivity,
        xmlNet,
        requiresMedicalPrice,
        isConfiguredZeroPricedActivity
      });
      const {
        isZeroBilled,
        isZeroPricedDentalActivity,
        mayUseMedicalZeroPrice,
        zeroPricePassesPricing: isZeroPricedActivity
      } = zeroPriceDecision;

      if (shouldAddNoPricingMatchRemark({ match, endoEntry, isZeroPricedActivity })) {
        if (isDrugActivity) {
          status = 'Unknown';
          if (drugsMap) {
            const drugListSource = usingBundledDrugs ? 'resources/Drugs.xlsx' : 'the uploaded Drugs sheet';
            remarks.push(`Drug code ${rec.CPT} was not found in ${drugListSource}.`);
          } else {
            remarks.push('Drug list could not be loaded; pricing status is Unknown for this drug code.');
          }
        } else {
          remarks.push(`No pricing match was found under ${pricingContext}.`);
        }
      }
      if (shouldAddMissingEndoPriceRemark({ endoEntry, refPrice, isZeroPricedActivity })) remarks.push(`Code ${rec.CPT} has no available price under ${pricingContext}.`);
      if (shouldAddInvalidReferenceRemark({ match, endoEntry, refPrice, ref, isZeroPricedActivity })) remarks.push(`The reference price is not a valid number under ${pricingContext}.`);

      const hasValidRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref);

      if (isZeroPricedDentalActivity) {
        status = 'Valid';
      } else if (isMedicalMode && isZeroBilled && requiresMedicalPrice) {
        status = 'Invalid';
        remarks.push(
          `Code ${rec.CPT} must have a price for Khabisi under Thiqa ` +
          `(should be ${formatMoney(effectiveRef)}).`
        );
      } else if (isConfiguredZeroPricedActivity || mayUseMedicalZeroPrice) {
        status = 'Valid';
      } else if (hasValidRef && effectiveRef === 0) {
        status = 'Unknown';
        remarks.push(`The reference price is 0 under ${pricingContext} (status Unknown).`);
      } else if (hasValidRef && xmlQty > 0) {
          // Price-changing modifiers (52 = ×0.5, 50 = ×1.5); 24 and 25 do not change the price
          const isPriceModifier = rec.Modifier === '52' || rec.Modifier === '50';
          if (moneyEqual(xmlNet, effectiveRef)) {
            status = 'Valid';
          } else if (moneyEqual(xmlNet / xmlQty, effectiveRef)) {
            status = 'Valid';
          } else if (moneyEqual(xmlNet * 2, effectiveRef)) {
            status = 'Valid';
          } else if (normalizeCode(rec.CPT) === '42702' && moneyEqual(xmlNet, effectiveRef * 2)) {
            status = 'Valid';
          } else if (nonEndoUsedEndoPrice) {
            remarks.push(`Pricing for ${rec.CPT} is ${effectiveRef} following ${pricingContext}.\nEndo Pricing cannot be used for ${nonEndoClinicianSpec}.`);
          } else if (shouldDeferA001PricingToClaimLevel({
            receiverID: pricingReceiverID,
            xmlNet,
            effectiveRef,
            xmlQty,
            isAllowedZeroPricedActivity: isZeroPricedActivity,
            claimPatientShare: rec.PatientShare
          })) {
            status = 'Valid';
          } else if (pricingReceiverID === 'A001') {
            const copayPct = Math.round((effectiveRef * xmlQty - xmlNet) / (effectiveRef * xmlQty) * 10000) / 100;
            remarks.push(`Copay: ${copayPct}%.`);
          } else if (isPriceModifier) {
            // Modifier is present but the claimed price doesn't match — use simplified message
            remarks.push(buildModifierPriceMismatchRemark({
              claimedNet: xmlNet,
              code: rec.CPT,
              modifier: rec.Modifier,
              expectedPrice: effectiveRef
            }));
          } else {
            // No price-changing modifier present — check if claimed price matches a modifier-adjusted alternative
            const baseForModCheck = isMedicalMode && isMedicalPricingMatch ? ref * appliedFactor : effectiveRef;
            const mod50Price = Math.round(baseForModCheck * 1.5 * 100) / 100;
            const mod52Price = Math.round(baseForModCheck * 0.5 * 100) / 100;
            const modifiersPresent = String(rec.Modifiers || '');
            if (moneyEqual(xmlNet, mod50Price) && !modifiersPresent.includes('50')) {
              remarks.push(buildMissingModifierRemark({
                modifier: '50',
                code: rec.CPT,
                multiplier: '1.5'
              }));
            } else {
              remarks.push(`Claimed Net ${formatMoney(xmlNet)} (for ${rec.CPT}) does not match the reference price of ${formatMoney(effectiveRef)} under ${pricingContext}.`);
          }
        }
      }

      const normalizedCode = normalizeCode(rec.CPT);
      if ((normalizedCode === '87400' || normalizedCode === '87804') && xmlQty !== 2) {
        status = 'Invalid';
        remarks.push(`Code ${rec.CPT} must always have quantity 2.`);
      }

      if ((normalizedCode === '82307' || normalizedCode === '82652') && !['A001', 'D001'].includes(pricingReceiverID) && xmlNet !== 0) {
        status = 'Invalid';
        remarks.push(`Code ${rec.CPT} must have net price 0 for payer ${pricingReceiverID || '(missing)'}.`);
      }

      if (normalizedCode === '92015' && pricingReceiverID !== 'D001' && xmlNet !== 0) {
        status = 'Invalid';
        remarks.push(`Code 92015 can only have price for payer D001.`);
      }

      if (normalizedCode === '99173' && xmlNet !== 0) {
        status = 'Invalid';
        remarks.push('Code 99173 cannot have price.');
      }

      if (normalizedCode === '36415' && ['A001', 'D001', 'D004', 'A025'].includes(pricingReceiverID) && xmlNet !== 0) {
        status = 'Invalid';
        remarks.push(`Code 36415 must have net price 0 for payer ${pricingReceiverID}.`);
      }

      return {
        ClaimID: rec.ClaimID || '',
        ActivityID: rec.ActivityID || '',
        CPT: rec.CPT || '',
        ClaimedNet: rec.Net || '',
        ClaimedQty: rec.Quantity || '',
        Modifiers: rec.Modifiers || '',
        ReferenceNetPrice: Number.isNaN(ref) ? (refPrice || '') : String(ref),
        AppliedFactor: (isMedicalMode && isMedicalPricingMatch) ? String(appliedFactor) : '',
        FactoredReference: Number.isNaN(effectiveRef) ? '' : String(effectiveRef),
        PricingRow: endoEntry || matchRow || null,
        XmlRow: rec,
        isValid: status === 'Valid',
        status,
        Remarks: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join(' '),
        ComputedRef: computedRef,
        xmlNetNum: xmlNet,
        PatientShare: rec.PatientShare || '0',
        ClaimGross: rec.ClaimGross || '',
        ClaimNet: rec.ClaimNet || '',
        ReceiverID: pricingReceiverID,
        ClaimPayerID: claimPayerID,
        PayerID: pricingReceiverID,
        _matchedFactorRule: matchedFactorRule,
        _modifierMultiplier: modifierMultiplier,
        _drugPricingMeta: drugPricingMeta,
        _drugExpectedNet: null
      };
    });

    output.forEach(row => {
      const pricingRemark = String(row.Remarks || '').trim();
      const pricingStatus = String(row.status || '').trim() || 'Invalid';
      row.findings = Array.isArray(row.findings) ? row.findings.slice() : [];

      if (row._drugPricingMeta == null && (pricingStatus !== 'Valid' || pricingRemark)) {
        row.findings.push(asMedicalFinding({
          ruleId: 'PRICING',
          status: pricingStatus,
          remark: pricingRemark || (pricingStatus === 'Unknown' ? 'Pricing result is Unknown.' : 'Pricing result is Invalid.'),
          claimID: row.ClaimID,
          activityID: row.ActivityID,
          code: row.CPT
        }));
      }

      if (isMedicalMode && medicalShared && medicalRules) {
        const rowKey = findingKey(row.ClaimID, row.ActivityID);
        const activityFindings = businessFindingsByRowKey.get(rowKey) || [];
        const claimFindings = claimLevelBusinessFindings.get(row.ClaimID) || [];
        row.findings = medicalShared.mergeFindingsBySeverity(row.findings, activityFindings, claimFindings);
        medicalShared.applyFinalStatus(row);
      } else if (row._drugPricingMeta != null) {
        row.findings = dedupeFindingsByRuleAndSeverity(row.findings);
        row.status = getDrugShared().getFinalStatusFromFindings(row.findings);
        row.isValid = row.status === 'Valid';
        row.Remarks = row.findings.filter(f => f.status !== 'Valid').map(f => f.remark).filter(Boolean).join(' ');
      }
    });

    // Claim-level Patient Share validation (all non-D001 payers)
    if (pricingReceiverID !== 'D001') {
      const claimGroups = new Map();
      output.forEach(r => {
        if (!claimGroups.has(r.ClaimID)) claimGroups.set(r.ClaimID, []);
        claimGroups.get(r.ClaimID).push(r);
      });

      for (const [, actRows] of claimGroups) {
        const primaryRow = actRows[0];
        const actualPS = Number(primaryRow.PatientShare || 0);

        // A001 (Daman): flag zero patient share for non-Thiqa
        if (pricingReceiverID === 'A001' && actualPS === 0) {
          const msg = 'Patient Share is 0 — this is invalid for Daman (non-Thiqa) claims.';
          if (isMedicalMode && medicalShared && medicalRules) {
            primaryRow.findings = medicalShared.mergeFindingsBySeverity(
              primaryRow.findings,
              [asMedicalFinding({
                ruleId: 'MED_PATIENT_SHARE_ZERO',
                status: 'Unknown',
                remark: msg,
                claimID: primaryRow.ClaimID,
                activityID: primaryRow.ActivityID,
                code: primaryRow.CPT
              })]
            );
            medicalShared.applyFinalStatus(primaryRow);
          } else {
            const sev = { 'Invalid': 3, 'Unknown': 2, 'Valid': 1 };
            if ((sev['Unknown'] || 0) > (sev[primaryRow.status] || 0)) {
              primaryRow.status = 'Unknown';
              primaryRow.isValid = false;
            }
            primaryRow.Remarks = primaryRow.Remarks ? `${primaryRow.Remarks} ${msg}` : msg;
          }
          continue;
        }

        // 3-way patient share comparison: Net + PS vs Reference
        applyClaimLevelPatientShare(actRows, {
          receiverID: pricingReceiverID,
          medicalRules,
          isMedicalMode,
          medicalShared
        });

        // A001: also validate claim-level gross/net/PS consistency
        if (pricingReceiverID === 'A001') {
          const summary = calculatePatientShareSummary(actRows, { receiverID: pricingReceiverID, medicalRules });
          if (summary.claimTotalsConsistent === false) {
            const consistencyMsg = `Claim totals are inconsistent.\nGross: ${summary.claimGross}.\nNet: ${summary.claimNet}.\nPatient Share: ${actualPS}.`;
            if (isMedicalMode && medicalShared && medicalRules) {
              primaryRow.findings = medicalShared.mergeFindingsBySeverity(
                primaryRow.findings,
                [asMedicalFinding({
                  ruleId: 'MED_PATIENT_SHARE_CLAIM_TOTALS',
                  status: 'Invalid',
                  remark: consistencyMsg,
                  claimID: primaryRow.ClaimID,
                  activityID: primaryRow.ActivityID,
                  code: primaryRow.CPT
                })]
              );
              medicalShared.applyFinalStatus(primaryRow);
            } else {
              primaryRow.status = 'Invalid';
              primaryRow.isValid = false;
              primaryRow.Remarks = primaryRow.Remarks ? `${primaryRow.Remarks} ${consistencyMsg}` : consistencyMsg;
            }
          }
        }
      }
    }

    const mergedOutput = output;
    lastResults = mergedOutput;
    const tableElement = buildResultsTable(mergedOutput);
    lastWorkbook = makeWorkbookFromJson(mergedOutput, 'checker_pricing_results');
    toggleDownload(mergedOutput.length > 0);

    const validCount = mergedOutput.filter(r => r.isValid).length;
    const totalCount = mergedOutput.length;
    const numericPercent = totalCount ? (validCount / totalCount) * 100 : 0;
    const percentText = totalCount ? numericPercent.toFixed(2) : '0.00';
    const color = numericPercent === 100 ? 'green' : 'orange';
    message(`Completed — ${validCount}/${totalCount} rows correct (${percentText}%)`, color);
    return tableElement;
  } catch (err) {
    showError(err);
    return null;
  }
}

// ----------------- Download -----------------
function handleDownload() {
  if (!lastResults.length) {
    showError(new Error('Nothing to download'));
    return;
  }

  const invalids = lastResults.filter(r => !r.isValid);
  if (!invalids.length) {
    showError(new Error('No invalid rows to export'));
    return;
  }

  try {
    XLSX.writeFile(makeWorkbookFromJson(invalids, 'checker_pricing_invalids'), 'checker_pricing_invalids.xlsx');
  } catch (err) { showError(err); }
}

function handleDownloadAll() {
  if (!lastWorkbook || !lastResults.length) {
    showError(new Error('Nothing to download'));
    return;
  }

  try {
    XLSX.writeFile(lastWorkbook, 'checker_pricing_results.xlsx');
  } catch (err) {
    try {
      XLSX.writeFile(makeWorkbookFromJson(lastResults, 'checker_pricing_results'), 'checker_pricing_results.xlsx');
    } catch (e) { showError(e); }
  }
}

// ----------------- File helpers -----------------
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Failed to read file'));
    fr.readAsText(file);
  });
}

async function readXlsx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return { rows, sheetName };
}

// Load drug pricing from a Drugs XLSX file (expects a "Drugs" sheet)
async function loadDrugsMap(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    return buildDrugsMapFromWorkbook(wb, file && file.name ? file.name : 'uploaded Drugs.xlsx');
  } catch (e) {
    console.warn('[PRICING] Failed to load drugs file:', e);
    throw new Error(`Unable to load uploaded Drugs.xlsx: ${e && e.message ? e.message : e}`);
  }
}

async function loadBundledDrugsMap() {
  try {
    const response = await fetch('../resources/Drugs.xlsx');
    if (!response.ok) {
      throw new Error(`Unable to load bundled resources/Drugs.xlsx (HTTP ${response.status}).`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    return buildDrugsMapFromWorkbook(wb, 'resources/Drugs.xlsx');
  } catch (e) {
    console.warn('[PRICING] Failed to load bundled Drugs.xlsx:', e);
    throw new Error(`Unable to load resources/Drugs.xlsx: ${e && e.message ? e.message : e}`);
  }
}

function buildDrugsMapFromWorkbook(wb, sourceLabel) {
  const parsed = getDrugShared().parseDrugWorkbook(wb, XLSX);
  if (parsed.error) {
    throw new Error(`Unable to load drugs from ${sourceLabel}: ${parsed.error}`);
  }
  return {
    map: parsed.map,
    rows: parsed.rows
  };
}

async function loadBundledFactorRules(isMedicalMode) {
  try {
    const response = await fetch('../resources/Factors.xlsx');
    if (!response.ok) {
      if (isMedicalMode) throw new Error(`Factors.xlsx could not be loaded (HTTP ${response.status}). Medical factor pricing is unavailable.`);
      console.warn('[PRICING] Failed to load Factors.xlsx:', response.status);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    return buildFactorRulesFromWorkbook(wb);
  } catch (e) {
    if (isMedicalMode) throw e;
    console.warn('[PRICING] Failed to load bundled Factors.xlsx:', e);
    return null;
  }
}

function buildFactorRulesFromWorkbook(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Discover payer columns by extracting IDs from parentheses in column headers (e.g. "Thiqa (D001)" → D001)
  const payerColumns = [];
  if (rows.length > 0) {
    Object.keys(rows[0]).forEach(colKey => {
      const m = colKey.match(/\(([^)]+)\)/);
      if (m) {
        const payerId = m[1].trim().toUpperCase();
        if (/^[A-Z]\d{3,4}$/.test(payerId)) payerColumns.push({ colKey, payerId });
      }
    });
  }

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
      matchValues = matchValueRaw.split(',').map(v => normalizeCode(v.trim())).filter(Boolean);
    } else if (matchType === 'Starts With') {
      // Support values like "8", "97", or "1, 2, 3, 4, 5, or 6"
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

function findFactorFromRules(rules, facilityId, code, payerId) {
  if (!rules || !rules.length) return { factor: 1, rule: null };

  const normCode = normalizeCode(code);
  const normFacility = String(facilityId || '').trim().toUpperCase();
  const normPayer = String(payerId || '').toUpperCase();

  const facilityRules = rules.filter(r => r.facilityId.trim().toUpperCase() === normFacility);
  if (!facilityRules.length) return { factor: 1, rule: null };

  // Exact List has priority over Starts With
  let matchedRule = null;
  for (const rule of facilityRules) {
    if (rule.matchType === 'Exact List' && rule.matchValues.includes(normCode)) {
      matchedRule = rule;
      break;
    }
  }

  // Fallback: Starts With
  if (!matchedRule) {
    for (const rule of facilityRules) {
      if (rule.matchType === 'Starts With' && rule.matchValues.some(prefix => normCode.startsWith(prefix))) {
        matchedRule = rule;
        break;
      }
    }
  }

  if (!matchedRule) return { factor: 1, rule: null };

  const factorVal = matchedRule.factors[normPayer];
  if (factorVal === undefined || factorVal === null || isNaN(factorVal)) {
    console.warn(`[PRICING] Factor rule matched (facility=${facilityId}, code=${code}, payer=${payerId}) but factor cell is empty/invalid — defaulting to 1.`);
    return { factor: 1, rule: matchedRule };
  }

  return { factor: factorVal, rule: matchedRule };
}

function getSelectedClaimTypeMode() {
  const claimTypeDental = document.getElementById('claimTypeDental');
  const claimTypeMedical = document.getElementById('claimTypeMedical');
  if (claimTypeMedical && claimTypeMedical.checked) return 'MEDICAL';
  if (claimTypeDental && claimTypeDental.checked) return 'DENTAL';
  return null;
}

// ----------------- XML parsing & extraction -----------------
function parseXml(text) {
  const xmlContent = text.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, 'and');
  const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe) throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
  return doc;
}

function extractPricingRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));

  for (const claim of claims) {
    const claimId = textValue(claim, 'ID') || '';
    const payerId = textValue(claim, 'PayerID') || '';
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    const encounterNode = claim.getElementsByTagName('Encounter')[0];
    const facilityId = textValue(encounterNode, 'FacilityID') || '';
    const encounterDateStr = textValue(encounterNode, 'Start') || textValue(encounterNode, 'Date') || textValue(encounterNode, 'EncounterDate') || '';
    const claimPatientShare = textValue(claim, 'PatientShare').trim() || '0';
    const claimGross = textValue(claim, 'Gross').trim() || '';
    const claimNet = textValue(claim, 'Net').trim() || '';

    for (const act of activities) {
      const activityId = textValue(act, 'ID') || '';
      const cpt = firstNonEmpty([
        textValue(act, 'ActivityCode'),
        textValue(act, 'CPTCode'),
        textValue(act, 'Code')
      ]).trim();

      const net = firstNonEmpty([
        textValue(act, 'Net'),
        textValue(act, 'GrossAmount'),
        textValue(act, 'Price')
      ]).trim();

      const qty = firstNonEmpty([
        textValue(act, 'Quantity'),
        textValue(act, 'Qty')
      ]).trim() || '0';

      const clinicianLic = firstNonEmpty([
        textValue(act, 'OrderingClinician'),
        textValue(act, 'Clinician')
      ]).trim();

      // Extract CPT modifiers from Observation (ValueType = 'Modifiers')
      const modifierSet = new Set();
      const observations = Array.from(act.getElementsByTagName('Observation'));
      for (const obs of observations) {
        const valueType = textValue(obs, 'ValueType') || '';
        if (valueType.trim().toLowerCase() === 'modifiers') {
          const voiVal = (textValue(obs, 'Value') || textValue(obs, 'ValueText') || '').toUpperCase().replace(/[_\s]/g, '');
          if (voiVal === 'VOID' || voiVal === '24') modifierSet.add('24');
          if (voiVal === 'VOIEF1' || voiVal === '52') modifierSet.add('52');
          if (voiVal === '25') modifierSet.add('25');
          if (voiVal === '50') modifierSet.add('50');
        }
      }
      const modifierList = ['24', '25', '50', '52'].filter(m => modifierSet.has(m));
      const modifiers = modifierList.join(', ');
      const modifier = modifierList[0] || '';

      records.push({
        ClaimID: claimId,
        ActivityID: activityId,
        ActivityType: (textValue(act, 'Type') || '').trim(),
        CPT: cpt,
        Net: net,
        Quantity: qty,
        FacilityID: facilityId,
        ClinicianLic: clinicianLic,
        EncounterDate: encounterDateStr,
        PatientShare: claimPatientShare,
        ClaimGross: claimGross,
        ClaimNet: claimNet,
        PayerID: payerId,
        Modifiers: modifiers,
        Modifier: modifier
      });
    }
  }

  return records;
}

function parseEncounterDate(dateStr) {
  if (!dateStr) return null;
  const datePart = String(dateStr).split(' ')[0];
  const [d, m, y] = datePart.split('/').map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  return new Date(y, m - 1, d);
}

const ENDO_PRICING_CUTOFF = new Date(2026, 1, 20);

// ----------------- Normalization / Matcher -----------------
function normalizeCode(c) {
  return String(c || '').trim().replace(/^0+/, '');
}

function buildPricingMatcher(rows) {
  const index = new Map();

  rows.forEach(r => {
    const code = normalizeCode(r['Code'] || '');
    if (!code) return;

    const keys = Object.keys(r).reduce((map, k) => {
      const norm = k.replace(/\s+/g, ' ').trim().toLowerCase();
      map[norm] = k;
      return map;
    }, {});

    const primaryKey = keys['other facilities'];
    const secondaryKey = keys['alyahar, emirates, al wagan'];

    r._primaryPrice = primaryKey ? Number(String(r[primaryKey]).replace(/[^0-9.\-]/g, '')) : null;
    r._secondaryPrice = secondaryKey ? Number(String(r[secondaryKey]).replace(/[^0-9.\-]/g, '')) : null;

    if (!index.has(code)) index.set(code, []);
    index.get(code).push(r);
  });

  return {
    find(code) {
      const key = normalizeCode(code);
      const arr = index.get(key);
      return arr && arr.length ? arr[0] : null;
    },
    _index: index
  };
}

function buildJsonPricingMatcher(data) {
  const index = new Map();

  (Array.isArray(data) ? data : []).forEach(entry => {
    const code = normalizeCode(entry.code);
    if (code) index.set(code, entry);
  });

  return {
    find(code) {
      return index.get(normalizeCode(code)) || null;
    },
    _index: index
  };
}

function normalizeTariffType(value) {
  return String(value || '').trim().toUpperCase();
}

function buildMedicalPricingMatcher(data) {
  const index = new Map();

  (Array.isArray(data) ? data : []).forEach(entry => {
    const code = normalizeCode(entry.code);
    if (!code) return;
    const type = normalizeTariffType(entry.type || 'CPT');
    const key = `${type}|${code}`;
    if (!index.has(key)) index.set(key, entry);
  });

  return {
    find(activityType, code) {
      const tariffType = ACTIVITY_TYPE_TO_TARIFF_TYPE[String(activityType || '').trim()] || 'CPT';
      const key = `${tariffType}|${normalizeCode(code)}`;
      return index.get(key) || null;
    }
  };
}

function buildKnownCptCodeSet({ jsonMatcher, xlsxMatcher, medicalPricingRaw }) {
  const set = new Set();

  if (xlsxMatcher && xlsxMatcher._index instanceof Map) {
    xlsxMatcher._index.forEach((_, code) => {
      if (code) set.add(code);
    });
  }

  if (jsonMatcher && jsonMatcher._index instanceof Map) {
    jsonMatcher._index.forEach((_, code) => {
      if (code) set.add(code);
    });
  }

  (Array.isArray(medicalPricingRaw) ? medicalPricingRaw : []).forEach(entry => {
    const type = normalizeTariffType(entry.type || 'CPT');
    if (type !== 'CPT') return;
    const code = normalizeCode(entry.code);
    if (code) set.add(code);
  });

  return set;
}

// ----------------- Results table -----------------
function buildResultsTable(rows) {
  if (!rows || !rows.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.textContent = 'No results';
    return emptyDiv;
  }

  rows.forEach((r, i) => r._originalIndex = i);
  lastResults = rows.slice();

  const table = document.createElement('table');
  table.className = 'table table-striped table-bordered';
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';

  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);

  // Header row
  const headerRow = document.createElement('tr');
  const HEADERS = [
    'Claim ID', 'Activity ID', 'Code', 'Claimed Net', 'Quantity', 'Modifiers',
    'Reference Net Price', 'Applied Factor', 'Factored Reference', 'Status', 'Remarks', 'Compare'
  ];
  HEADERS.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.padding = '6px';
    th.style.border = '1px solid #ccc';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  // Helper: create a nowrap cell with standard padding/border
  function makeCell(text, wrap) {
    const td = document.createElement('td');
    if (!wrap) td.className = 'nowrap-col';
    td.style.padding = '6px';
    td.style.border = '1px solid #ccc';
    td.textContent = text == null ? '' : String(text);
    return td;
  }

  let prevClaimId = null;

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = getPricingRowClass(r);
    tr.dataset.claimId = r.ClaimID || '';

    const showClaim = r.ClaimID !== prevClaimId;

    // Claim ID
    const claimIdCell = makeCell(showClaim ? (r.ClaimID || '') : '');
    claimIdCell.className = 'nowrap-col claim-id-cell';
    tr.appendChild(claimIdCell);

    // Activity ID
    tr.appendChild(makeCell(r.ActivityID || ''));

    // Code
    tr.appendChild(makeCell(r.CPT || ''));

    // Claimed Net
    tr.appendChild(makeCell(r.ClaimedNet || ''));

    // Quantity
    tr.appendChild(makeCell(r.ClaimedQty || ''));

    // Modifiers
    tr.appendChild(makeCell(r.Modifiers || ''));

    // Reference Net Price
    const refText = r._estimatedTotal != null
      ? String(r._estimatedTotal) + ' (estimate)'
      : (r.ReferenceNetPrice || '');
    tr.appendChild(makeCell(refText));

    // Applied Factor
    tr.appendChild(makeCell(r.AppliedFactor || ''));

    // Factored Reference
    tr.appendChild(makeCell(r.FactoredReference || ''));

    // Status
    tr.appendChild(makeCell(r.status || ''));

    // Remarks (wrapping, may contain newlines)
    const remarksCell = document.createElement('td');
    remarksCell.style.padding = '6px';
    remarksCell.style.border = '1px solid #ccc';
    if (r.Remarks) {
      r.Remarks.split('\n').forEach((line, idx) => {
        if (idx > 0) remarksCell.appendChild(document.createElement('br'));
        remarksCell.appendChild(document.createTextNode(line));
      });
    } else {
      remarksCell.textContent = 'OK';
    }
    tr.appendChild(remarksCell);

    // Compare button
    const compareCell = makeCell('');
    if (r.PricingRow) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'View';
      btn.dataset.pricingIndex = String(r._originalIndex);
      // Use attribute so the handler survives table cloning during Check All
      btn.setAttribute('onclick', `window.showPricingComparison(${r._originalIndex})`);
      compareCell.appendChild(btn);
    }
    tr.appendChild(compareCell);

    tbody.appendChild(tr);
    prevClaimId = r.ClaimID;
  }

  // Hidden placeholder shown by applyFilter when no invalid rows are visible
  const noInvalidsRow = document.createElement('tr');
  noInvalidsRow.className = 'no-invalids-placeholder';
  noInvalidsRow.style.display = 'none';
  const noInvalidsCell = document.createElement('td');
  noInvalidsCell.colSpan = HEADERS.length;
  noInvalidsCell.className = 'text-center';
  noInvalidsCell.textContent = 'No invalid pricing records found.';
  noInvalidsRow.appendChild(noInvalidsCell);
  tbody.appendChild(noInvalidsRow);

  return table;
}

// ----------------- Modal comparison -----------------
function showComparisonModal(index) {
  const row = lastResults[index];

  if (!row) {
    alert('Row not found');
    return;
  }

  const xml = row.XmlRow || {};
  const pricing = row.PricingRow || {};
  const xmlNet = Number(xml.Net || 0);
  const xmlQty = Number(xml.Quantity || 0);

  const isDrug = row._drugPricingMeta != null;

  const xmlTable = isDrug
    ? `
    <h4>XML Activity</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Claim ID</th><td>${escapeHtml(String(row.ClaimID || ''))}</td></tr>
      <tr><th>Activity ID</th><td>${escapeHtml(String(row.ActivityID || ''))}</td></tr>
      <tr><th>Type</th><td>${escapeHtml(String(row.ActivityType || xml.ActivityType || '5'))}</td></tr>
      <tr><th>Drug Code</th><td>${escapeHtml(row._drugPricingMeta?.drug?.['Drug Code'] || row.CPT || '')}</td></tr>
      <tr><th>Claimed Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
      <tr><th>Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
    </table>
    `
    : `
    <h4>XML (Claim)</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Code</th><td>${escapeHtml(xml.CPT || row.CPT)}</td></tr>
      <tr><th>Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
      <tr><th>Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
      <tr><th>Net ÷ Qty</th><td>${escapeHtml(xmlQty > 0 ? String(xmlNet / xmlQty) : 'N/A')}</td></tr>
    </table>
    `;

  const pricingTable = isDrug
    ? (() => {
        const dm = row._drugPricingMeta;
        const expectedNet = row._drugExpectedNet;
        const drug = dm.drug || {};
        return `
    <h4>Drug Reference</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Package Name</th><td>${escapeHtml(String(drug['Package Name'] || ''))}</td></tr>
      <tr><th>Dosage Form</th><td>${escapeHtml(String(drug['Dosage Form'] || ''))}</td></tr>
      <tr><th>Package Size</th><td>${escapeHtml(String(drug['Package Size'] || ''))}</td></tr>
      <tr><th>Status</th><td>${escapeHtml(String(drug['Status'] || row._drugStatus || ''))}</td></tr>
      <tr><th>Effective Date</th><td>${escapeHtml(String(drug['UPP Effective Date'] || ''))}</td></tr>
      <tr><th>Delete Effective Date</th><td>${escapeHtml(String(drug['Delete Effective Date'] || ''))}</td></tr>
      <tr><th>Thiqa Formulary</th><td>${escapeHtml(String(drug['Included in Thiqa/ ABM - other than 1&7- Drug Formulary'] || ''))}</td></tr>
      <tr><th>Daman Basic Formulary</th><td>${escapeHtml(String(drug['Included In Basic Drug Formulary'] || ''))}</td></tr>
    </table>
    <h4>Quantity Analysis</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Package Price to Public</th><td>${escapeHtml(String(drug['Package Price to Public'] || ''))}</td></tr>
      <tr><th>Unit Price to Public</th><td>${escapeHtml(String(drug['Unit Price to Public'] || ''))}</td></tr>
      <tr><th>Required Quantity</th><td>${escapeHtml(row._drugRequiredQuantity != null ? String(row._drugRequiredQuantity) : 'N/A')}</td></tr>
      <tr><th>Claimed Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
      <tr><th>Quantity Result</th><td>${escapeHtml(String(row._drugQuantityResult || ''))}</td></tr>
    </table>
    <h4>Price Analysis</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Pricing Basis</th><td>${escapeHtml(dm.basis)}</td></tr>
      <tr><th>Pricing Source</th><td>${escapeHtml(dm.source)}</td></tr>
      <tr><th>Selected Price</th><td>${escapeHtml(String(dm.pricePerBasis))}</td></tr>
      <tr><th>Calculation</th><td>${escapeHtml(String(dm.pricePerBasis))} × ${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
      <tr><th>Expected Net</th><td>${escapeHtml(expectedNet != null ? String(expectedNet) : 'N/A')}</td></tr>
      <tr><th>Claimed Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
      <tr><th>Price Result</th><td>${escapeHtml(String(row._drugPriceResult || ''))}</td></tr>
    </table>
    `;
      })()
    : (() => {
        const refPrice = String(row.ReferenceNetPrice || '');
        const factoredRefPrice = String(row.FactoredReference || '');
        const factorRule = row._matchedFactorRule;
        const modMult = row._modifierMultiplier != null ? row._modifierMultiplier : 1;
        const rowAppliedFactor = row.AppliedFactor || '';
        const facilityId = (row.XmlRow || {}).FacilityID || '';

        const factorRows = factorRule
          ? `<tr><th>Facility</th><td>${escapeHtml(factorRule.facility)} (${escapeHtml(facilityId)})</td></tr>
             <tr><th>Matched Service</th><td>${escapeHtml(factorRule.serviceType || factorRule.matchType)}</td></tr>
             <tr><th>Receiver ID</th><td>${escapeHtml(row.ReceiverID || row.PayerID || '')}</td></tr>
             <tr><th>Claim Payer ID</th><td>${escapeHtml(row.ClaimPayerID || '')}</td></tr>
             <tr><th>Applied Factor</th><td>${escapeHtml(rowAppliedFactor)}</td></tr>
             <tr><th>Modifier Multiplier</th><td>${escapeHtml(String(modMult))}</td></tr>`
          : (rowAppliedFactor
              ? `<tr><th>Applied Factor</th><td>${escapeHtml(rowAppliedFactor)}</td></tr>`
              : '');

        return `
    <h4>Pricing Reference</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Code</th><td>${escapeHtml(String(firstNonEmptyKey(pricing, ['Drug Code', 'Code', 'CPT', 'code']) || ''))}</td></tr>
      <tr><th>Mandatory Tariff Base</th><td>${escapeHtml(refPrice)}</td></tr>
      ${factorRows}
      <tr><th>Factored Net Price</th><td>${escapeHtml(factoredRefPrice)}</td></tr>
    </table>
    `;
      })();

  const modalHtml = `
    <div class="modal-content">
      <button type="button" class="close" onclick="window.closePricingComparison()">×</button>
      <h3>Price Comparison</h3>
      ${xmlTable}
      ${pricingTable}
      <button type="button" onclick="window.closePricingComparison()">Close</button>
    </div>
  `;

  closeComparisonModal();

  const modal = document.createElement('div');
  modal.id = 'comparisonModal';
  modal.className = 'modal';
  modal.innerHTML = modalHtml;
  modal.addEventListener('click', e => {
    if (e.target === modal) closeComparisonModal();
  });

  document.body.appendChild(modal);
  modal.style.display = 'flex';
}

function closeComparisonModal() {
  const modal = el('comparisonModal');
  if (modal) modal.remove();
}

// ----------------- Utilities -----------------
function textValue(node, tag) {
  if (!node) return '';
  const eln = node.getElementsByTagName(tag)[0];
  return eln ? String(eln.textContent || '').trim() : '';
}

function firstNonEmpty(arr) {
  for (const s of arr) {
    if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim();
  }
  return '';
}

function firstNonEmptyKey(obj, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k]).trim() !== '') return obj[k];
  }
  return null;
}

function makeWorkbookFromJson(json, sheetName) {
  const ws = XLSX.utils.json_to_sheet(json);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return wb;
}

// ----------------- UI helpers -----------------
function el(id) {
  return document.getElementById(id);
}

function fileEl(id) {
  const f = el(id);
  return f && f.files && f.files[0] ? f.files[0] : null;
}

function resetUI() {
  const container = el('outputTableContainer');
  if (container) container.innerHTML = '';
  toggleDownload(false);
  message('', '');
  showProgress(0, '');
  lastResults = [];
  lastWorkbook = null;
}

function toggleDownload(enabled) {
  const dl = el('export-invalids-button');
  if (dl) dl.disabled = !enabled;

  const dlAll = el('export-all-button');
  if (dlAll) dlAll.disabled = !enabled;
}

function showProgress(percent, text) {
  const barContainer = el('progress-bar-container');
  const bar = el('progress-bar');
  const pText = el('progress-text');

  if (barContainer) barContainer.style.display = percent > 0 ? 'block' : 'none';
  if (bar) bar.style.width = (percent || 0) + '%';
  if (pText) pText.textContent = text ? `${percent}% — ${text}` : `${percent}%`;
}

function message(text, color) {
  const m = el('messageBox');
  if (!m) return;
  m.textContent = text || '';
  m.style.color = color || '';
}

function showError(err) {
  message(err && err.message ? err.message : String(err), 'red');
  showProgress(0, '');
  toggleDownload(false);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.runPricingCheck = async function (options = {}) {
  if (typeof handleRun === 'function') return await handleRun(options);
  console.error('handleRun function not found');
  return null;
};

window._pricingTestApi = {
  analyzeDrugActivity,
  isDrugActivityType,
  isZeroPricedActivityForPricing,
  isAllowedZeroPricedActivityForPricing,
  isValidZeroPricedConsultationCompanion,
  shouldDeferA001PricingToClaimLevel,
  getPatientShareReferenceRows,
  calculatePatientShareSummary,
  applyClaimLevelPatientShare,
  compareMoney,
  shouldAddNoPricingMatchRemark,
  shouldAddMissingEndoPriceRemark,
  shouldAddInvalidReferenceRemark,
  buildKnownCptCodeSet,
  normalizeDrugCode,
  buildMedicalPricingMatcher,
  buildJsonPricingMatcher,
  buildPricingMatcher,
  normalizeClaimTypeMode,
  buildFactorRulesFromWorkbook,
  findFactorFromRules,
  requiresNonZeroMedicalPrice,
  getZeroPricePricingDecision
};

window.showPricingComparison = showComparisonModal;
window.closePricingComparison = closeComparisonModal;

} catch (error) {
  console.error('[CHECKER-ERROR] Failed to load checker:', error);
  console.error(error.stack);
}
})();
