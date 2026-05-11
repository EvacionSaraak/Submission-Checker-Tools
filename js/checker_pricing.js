(function() {
  try {
    // checker_pricing.js

    let lastResults = [];
    let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  try {
    const runBtn = el('run-button'), dlBtn = el('export-invalids-button'), dlAllBtn = el('export-all-button');
    if (runBtn) runBtn.addEventListener('click', handleRun);
    if (dlBtn) dlBtn.addEventListener('click', handleDownload);
    if (dlAllBtn) dlAllBtn.addEventListener('click', handleDownloadAll);
    resetUI();
  } catch (error) {
    console.error('[PRICING] DOMContentLoaded initialization error:', error);
  }
});

// ----------------- Main run handler -----------------
async function handleRun() {
  resetUI();
  try {
    let xmlFile = fileEl('xml-file'), xlsxFile = fileEl('xlsx-file');
    
    // Fallback to unified checker files cache
    if (!xmlFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
      xmlFile = window.unifiedCheckerFiles.xml;
      console.log('[PRICING] Using XML file from unified cache:', xmlFile.name);
    }
    if (!xlsxFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.pricing) {
      xlsxFile = window.unifiedCheckerFiles.pricing;
      console.log('[PRICING] Using pricing file from unified cache:', xlsxFile.name);
    }

    if (!xmlFile) throw new Error('Please select an XML file.');

    showProgress(5, 'Reading files');

    const [xmlText, dentalPricingRaw, clinicianData, endoPricingRaw] = await Promise.all([
      readFileText(xmlFile),
      fetch('../json/dental_pricing.json').then(r => r.json()).catch(e => { console.warn('[PRICING] Failed to load dental_pricing.json:', e); return []; }),
      fetch('../json/clinician_licenses.json').then(r => r.json()).catch(() => []),
      fetch('../json/endo_pricing.json').then(r => r.json()).catch(() => [])
    ]);

    if (!Array.isArray(dentalPricingRaw) || dentalPricingRaw.length === 0) {
      throw new Error('Dental pricing data could not be loaded. Ensure dental_pricing.json is present in the json/ folder.');
    }

    // If an XLSX was manually uploaded, build an XLSX-based matcher for override pricing
    let xlsxMatcher = null;
    if (xlsxFile) {
      const xlsxObj = await readXlsx(xlsxFile);
      xlsxMatcher = buildPricingMatcher(xlsxObj.rows);
      console.log('[PRICING] Using uploaded XLSX for pricing override');
    }

    showProgress(25, 'Parsing XML & pricing data');

    const xmlDoc = parseXml(xmlText);

    // ReceiverID D001 (Thiqa) and A001 (Daman) get full price-matching.
    // All other ReceiverIDs are processed as non-Thiqa: activities are marked Unknown,
    // with Patient Share = 0 being the only check that forces rows to Invalid.
    const headerNode = xmlDoc.querySelector('Header');
    const receiverID = headerNode?.querySelector('ReceiverID')?.textContent.trim() || '';
    console.log(`[PRICING] ReceiverID: ${receiverID || '(MISSING)'}`);
    if (receiverID !== 'D001' && receiverID !== 'A001') {
      console.log(`[PRICING] ReceiverID "${receiverID}" is non-Thiqa/non-Daman — prices will be marked Unknown; PS=0 check will still apply.`);
    }

    const extracted = extractPricingRecords(xmlDoc);
    const jsonMatcher = buildJsonPricingMatcher(dentalPricingRaw);

    const clinicianSpecialtyMap = new Map();
    (Array.isArray(clinicianData) ? clinicianData : []).forEach(e => {
      const lic = String(e['Phy Lic'] || '').trim();
      if (lic) clinicianSpecialtyMap.set(lic, String(e['Specialty'] || '').trim());
    });
    const endoPricingMap = new Map();
    (Array.isArray(endoPricingRaw) ? endoPricingRaw : []).forEach(e => {
      if (e.code) endoPricingMap.set(normalizeCode(e.code), e);
    });

    showProgress(50, 'Comparing records');

    const output = extracted.map(rec => {
    const remarks = []; let status = 'Invalid';
    const facility = rec.FacilityID || '';
    const xmlNet = Number(rec.Net || 0), xmlQty = Number(rec.Quantity || 0);

    // Non-Thiqa, non-Daman: no reference pricing available — mark all as Unknown.
    // PS=0 → Invalid is enforced in a later pass over claim groups.
    if (receiverID !== 'D001' && receiverID !== 'A001') {
      return {
        ClaimID: rec.ClaimID || '',
        ActivityID: rec.ActivityID || '',
        CPT: rec.CPT || '',
        ClaimedNet: rec.Net || '',
        ClaimedQty: rec.Quantity || '',
        ReferenceNetPrice: '',
        PricingRow: null,
        XmlRow: rec,
        isValid: false,
        status: 'Unknown',
        Remarks: '',
        ComputedRef: null,
        xmlNetNum: xmlNet,
        PatientShare: rec.PatientShare || '0'
      };
    }

    // Special rule: code 02111 must always have a net price of 0 for Thiqa (D001) and Daman (A001)
    if (normalizeCode(rec.CPT) === '2111' && (receiverID === 'D001' || receiverID === 'A001')) {
      const insurerLabel = receiverID === 'D001' ? 'Thiqa' : 'Daman';
      if (xmlNet === 0) {
        status = 'Valid';
        remarks.push(`Code 02111 is correctly priced at 0 for ${insurerLabel}.`);
      } else {
        status = 'Invalid';
        remarks.push(`Code 02111 must always have a net price of 0 for ${insurerLabel}. Claimed Net: ${xmlNet}.`);
      }
      return {
        ClaimID: rec.ClaimID || '',
        ActivityID: rec.ActivityID || '',
        CPT: rec.CPT || '',
        ClaimedNet: rec.Net || '',
        ClaimedQty: rec.Quantity || '',
        ReferenceNetPrice: '0',
        PricingRow: null,
        XmlRow: rec,
        isValid: status === 'Valid',
        status,
        Remarks: remarks.join(' '),
        ComputedRef: 0,
        xmlNetNum: xmlNet,
        PatientShare: rec.PatientShare || '0'
      };
    }

    // Determine reference price and the matched pricing row
    let refPrice = '';
    let matchRow = null;

    // Compute a human-readable context string for whichever pricing schedule applies.
    // This initial value may be overridden by the endo-pricing block below (which runs
    // after the regular match attempt) when the code falls under Endodontist Pricing.
    // Every remark message ends with "under ${pricingContext}" so they share the same structure.
    let pricingContext;
    if (xlsxMatcher) {
      // XLSX is a Thiqa-style manual override; use the same Thiqa labels so the source
      // file format does not leak into user-facing messages.
      const isAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
      pricingContext = isAlyaharGroup ? 'Alyahar/Emirates/Al Wagan Thiqa Pricing' : 'Standard Thiqa Pricing';
    } else if (receiverID === 'A001') {
      const isDamanKhabisiAlyahar = facility === 'MF5020' || facility === 'MF5357';
      pricingContext = isDamanKhabisiAlyahar ? 'Daman – Khabisi/Al Yahar pricing' : 'Daman – Standard pricing';
    } else {
      const isThiqaAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
      pricingContext = isThiqaAlyaharGroup ? 'Alyahar/Emirates/Al Wagan Thiqa Pricing' : 'Standard Thiqa Pricing';
    }

    if (xlsxMatcher) {
      // Manual XLSX override: expects Thiqa-style two-column layout with
      // "Other Facilities" (primary) and "Alyahar, Emirates, Al Wagan" (secondary) columns.
      const xlsxMatch = xlsxMatcher.find(rec.CPT);
      if (xlsxMatch) {
        const isAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
        refPrice = isAlyaharGroup ? xlsxMatch._secondaryPrice : xlsxMatch._primaryPrice;
        matchRow = xlsxMatch;
      }
    } else {
      // Default: JSON-based pricing, routed by ReceiverID and FacilityID
      const jsonMatch = jsonMatcher.find(rec.CPT);
      if (jsonMatch) {
        if (receiverID === 'A001') {
          // Daman: 2025 prices for Khabisi (MF5020) and Al Yahar (MF5357); default otherwise
          const isDamanKhabisiAlyahar = facility === 'MF5020' || facility === 'MF5357';
          refPrice = isDamanKhabisiAlyahar ? jsonMatch.daman_khabisi_alyahar : jsonMatch.daman_default;
        } else {
          // Thiqa (D001): Alyahar/Emirates/Al Wagan group gets thiqa_alyahar; others get thiqa_other
          const isThiqaAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
          refPrice = isThiqaAlyaharGroup ? jsonMatch.thiqa_alyahar : jsonMatch.thiqa_other;
        }
        matchRow = jsonMatch;
      }
    }

    const match = matchRow; // kept for downstream 'no pricing match found' checks

    // Override with endo pricing for applicable codes (only for Thiqa/D001, and only for dates on or after Feb 20, 2026)
    const endoEntry = receiverID === 'D001' ? endoPricingMap.get(normalizeCode(rec.CPT)) : undefined;
    let nonEndoEndoCase = false;
    let nonEndoClinicianSpec = '';
    if (endoEntry) {
      const encounterDate = parseEncounterDate(rec.EncounterDate);
      const isAfterCutoff = encounterDate !== null && encounterDate >= ENDO_PRICING_CUTOFF;
      if (isAfterCutoff) {
        const clinicianSpec = clinicianSpecialtyMap.get(rec.ClinicianLic || '') || '';
        const isEndo = clinicianSpec === 'Endodontics';
        refPrice = isEndo ? endoEntry.endo_price : endoEntry.gp_price;
        if (isEndo) {
          pricingContext = 'Endodontist Pricing';
        } else {
          nonEndoEndoCase = true;
          nonEndoClinicianSpec = clinicianSpec;
        }
      }
    }

    const ref = Number(refPrice ?? NaN);
    // ComputedRef is used for per-claim patient share validation
    const computedRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref) ? ref : null;

    // Claimed net 0 -> Valid (changed from Unknown)
    if (xmlNet === 0) {
      status = 'Valid';
      remarks.push('Claimed Net is 0 (treated as Valid)');
    } else {
      if (xmlQty <= 0) remarks.push(xmlQty === 0 ? 'Quantity is 0 (invalid)' : 'Quantity is less than 0 (invalid)');
      if (!match && !endoEntry) remarks.push(`No pricing match was found under ${pricingContext}.`);
      if (endoEntry && refPrice === null) remarks.push(`Code ${rec.CPT} has no available price under ${pricingContext}.`);
      if ((match || endoEntry) && refPrice !== null && Number.isNaN(ref)) {
        remarks.push(`The reference price is not a valid number under ${pricingContext}.`);
      }

      const hasValidRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref);
      if (hasValidRef && ref === 0) {
        status = 'Unknown';
        remarks.push(`The reference price is 0 under ${pricingContext} (status Unknown).`);
      } else if (hasValidRef && xmlQty > 0) {
        if (xmlNet === ref) status = 'Valid';
        else if ((xmlNet / xmlQty) === ref) status = 'Valid';
        else if (xmlNet * 2 === ref) status = 'Valid';
        // Special case for code 42702: allow if XML price is exactly double the reference
        // This code requires special handling where double the reference price is also valid
        else if (normalizeCode(rec.CPT) === '42702' && xmlNet === ref * 2) status = 'Valid';
        else if (nonEndoEndoCase) {
          remarks.push(`Pricing for ${rec.CPT} is ${ref} following ${pricingContext}. Endo Pricing cannot be used for ${nonEndoClinicianSpec}.`);
        } else remarks.push(`Claimed Net ${xmlNet} does not match the reference price of ${ref} under ${pricingContext}.`);
      }
    }
  
    return {
      ClaimID: rec.ClaimID || '',
      ActivityID: rec.ActivityID || '',
      CPT: rec.CPT || '',
      ClaimedNet: rec.Net || '',
      ClaimedQty: rec.Quantity || '',
      ReferenceNetPrice: refPrice || '',
      PricingRow: matchRow || null,
      XmlRow: rec,
      isValid: status === 'Valid',
      status,
      Remarks: remarks.join(' '),
      ComputedRef: computedRef,
      xmlNetNum: xmlNet,
      PatientShare: rec.PatientShare || '0'
    };
  });

    // ---- Patient share validation (Daman A001 only) ----
    // For Daman: expectedPS = Σ(ref × qty) − Σ(activity net); PS = 0 is always an error.
    // Errors are surfaced directly in the activity rows' Remarks — no separate summary row is added.
    if (receiverID === 'A001') {
      const claimGroups = new Map();
      output.forEach(r => {
        if (!claimGroups.has(r.ClaimID)) claimGroups.set(r.ClaimID, []);
        claimGroups.get(r.ClaimID).push(r);
      });

      for (const [, actRows] of claimGroups) {
        const actualPS = Number(actRows[0].PatientShare || 0);

        if (actualPS === 0) {
          const msg = 'Patient Share is 0 — this is invalid for Daman (non-Thiqa) claims.';
          actRows.forEach(r => {
            r.status = 'Invalid';
            r.isValid = false;
            r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
          });
        } else {
          // For activities with no pricing match, treat their net as correct (ref = net, contributes 0 to PS).
          const totalRef = actRows.reduce((sum, r) => {
            return sum + (r.ComputedRef !== null ? r.ComputedRef * Number(r.ClaimedQty || 1) : r.xmlNetNum);
          }, 0);
          const totalXmlNet = actRows.reduce((sum, r) => sum + r.xmlNetNum, 0);
          const expectedPS = Math.round((totalRef - totalXmlNet) * 100) / 100;

          if (actualPS === expectedPS) {
            // Promote all non-Valid activity rows — the correct patient share confirms total pricing is accurate.
            // Also clear any misleading "does not match" remarks: the claimed net is the payer's portion only.
            actRows.forEach(r => {
              if (!r.isValid) {
                r.status = 'Valid';
                r.isValid = true;
                r.Remarks = '';
              }
            });
          } else {
            const msg = `Patient Share ${actualPS} is incorrect. Expected: ${expectedPS} (Total Ref: ${totalRef} − Total Net: ${totalXmlNet}).`;
            actRows.forEach(r => {
              r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
            });
          }
        }
      }
    }

    // ---- Patient share validation (non-Thiqa, non-Daman) ----
    // PS=0 → all rows for that claim are Invalid, EXCEPT for Cash (HAAD) claims where PS=0 is valid.
    if (receiverID !== 'D001' && receiverID !== 'A001') {
      const claimGroups = new Map();
      output.forEach(r => {
        if (!claimGroups.has(r.ClaimID)) claimGroups.set(r.ClaimID, []);
        claimGroups.get(r.ClaimID).push(r);
      });

      const isCash = receiverID.toUpperCase() === 'HAAD';
      for (const [, actRows] of claimGroups) {
        const actualPS = Number(actRows[0].PatientShare || 0);
        if (actualPS === 0 && !isCash) {
          const msg = 'Patient Share is 0 — this is invalid for non-Thiqa claims.';
          actRows.forEach(r => {
            r.status = 'Invalid';
            r.isValid = false;
            r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
          });
        }
        // PS ≠ 0: rows remain Unknown — compute estimated patient-share split and add to Remarks
        if (actualPS > 0) {
          const totalClaimedNet = actRows.reduce((sum, r) => sum + r.xmlNetNum, 0);
          const psPercentage = actualPS / (actualPS + totalClaimedNet);
          const psPercentagePct = Math.round(psPercentage * 100);

          let estimatedPSSum = 0;
          actRows.forEach(r => {
            const net = r.xmlNetNum;
            const estimatedTotal = psPercentage < 1 ? Math.round((net / (1 - psPercentage)) * 100) / 100 : 0;
            const estimatedPS = Math.round((estimatedTotal - net) * 100) / 100;
            estimatedPSSum = Math.round((estimatedPSSum + estimatedPS) * 100) / 100;
            r._estimatedTotal = estimatedTotal;
            r._estimatedPS = estimatedPS;
            r._estimatedPayerNet = Math.round((estimatedTotal - estimatedPS) * 100) / 100;
          });

          actRows.forEach(r => {
            const netMatch = Math.abs(r.xmlNetNum - r._estimatedPayerNet) < 0.01;
            const matchOp = netMatch ? '==' : '!=';
            if (r.xmlNetNum === 0) return;
            const remark = `${psPercentagePct}% Copay estimate. Net ${netMatch ? 'Match' : 'Mismatch'} (${r.xmlNetNum} [xml] ${matchOp} ${r._estimatedPayerNet} [estimate]).`;
            r.Remarks = r.Remarks ? `${r.Remarks} ${remark}` : remark;
          });
        }
      }
    }

    const mergedOutput = output;

    lastResults = mergedOutput;
    const tableElement = buildResultsTable(mergedOutput);
    lastWorkbook = makeWorkbookFromJson(mergedOutput, 'checker_pricing_results');
    toggleDownload(mergedOutput.length > 0);

   // Count valid rows and show percentage with 2 decimals
  const validCount = mergedOutput.filter(r => r.isValid).length;
  const totalCount = mergedOutput.length;
  const numericPercent = totalCount ? (validCount / totalCount) * 100 : 0;
  const percentText = totalCount ? numericPercent.toFixed(2) : '0.00';
  const color = numericPercent === 100 ? 'green' : 'orange';
  message(`Completed — ${validCount}/${totalCount} rows correct (${percentText}%)`, color);
  return tableElement;
  } catch (err) { showError(err); return null; }
}

// ----------------- Download -----------------
function handleDownload() {
  if (!lastResults.length) { showError(new Error('Nothing to download')); return; }
  const invalids = lastResults.filter(r => !r.isValid);
  if (!invalids.length) { showError(new Error('No invalid rows to export')); return; }
  try { XLSX.writeFile(makeWorkbookFromJson(invalids, 'checker_pricing_invalids'), 'checker_pricing_invalids.xlsx'); }
  catch(err) { showError(err); }
}

function handleDownloadAll() {
  if (!lastWorkbook || !lastResults.length) { showError(new Error('Nothing to download')); return; }
  try { XLSX.writeFile(lastWorkbook, 'checker_pricing_results.xlsx'); }
  catch(err) { try { XLSX.writeFile(makeWorkbookFromJson(lastResults, 'checker_pricing_results'), 'checker_pricing_results.xlsx'); } catch(e) { showError(e); } }
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
  // Header on row 1 for your sample -> no range
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return { rows, sheetName };
}

// ----------------- XML parsing & extraction -----------------
function parseXml(text) {
  // Preprocess XML to replace unescaped & with "and" for parseability
  const xmlContent = text.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
  const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe) throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
  return doc;
}

// Extract pricing-related records (ActivityCode / Code) and Net/Quantity
function extractPricingRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  for (const claim of claims) {
    const claimId = textValue(claim, 'ID') || '';
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    const encounterNode = claim.getElementsByTagName('Encounter')[0];
    const facilityId = textValue(encounterNode, 'FacilityID') || '';
    const encounterDateStr = textValue(encounterNode, 'Start') || textValue(encounterNode, 'Date') || textValue(encounterNode, 'EncounterDate') || '';
    const claimPatientShare = textValue(claim, 'PatientShare').trim() || '0';
    for (const act of activities) {
      const activityId = textValue(act, 'ID') || '';
      const cpt = firstNonEmpty([ textValue(act,'ActivityCode'), textValue(act,'CPTCode'), textValue(act,'Code') ]).trim();
      const net = firstNonEmpty([ textValue(act,'Net'), textValue(act,'GrossAmount'), textValue(act,'Price') ]).trim();
      const qty = firstNonEmpty([ textValue(act,'Quantity'), textValue(act,'Qty') ]).trim() || '0';
      const clinicianLic = firstNonEmpty([textValue(act, 'OrderingClinician'), textValue(act, 'Clinician')]).trim();
      records.push({ ClaimID: claimId, ActivityID: activityId, CPT: cpt, Net: net, Quantity: qty, FacilityID: facilityId, ClinicianLic: clinicianLic, EncounterDate: encounterDateStr, PatientShare: claimPatientShare });
    }
  }
  return records;
}

// Parse encounter date from "DD/MM/YYYY" or "DD/MM/YYYY HH:MM" format
function parseEncounterDate(dateStr) {
  if (!dateStr) return null;
  const datePart = dateStr.split(' ')[0];
  const [d, m, y] = datePart.split('/').map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  return new Date(y, m - 1, d);
}

// Endo pricing cutoff date: February 20, 2026
const ENDO_PRICING_CUTOFF = new Date(2026, 1, 20); // Month is 0-indexed


// ----------------- Normalization / Matcher -----------------
function normalizeCode(c) { return String(c || '').trim().replace(/^0+/, ''); }

// ----------------- Facility-aware matcher -----------------
function buildPricingMatcher(rows) {
  const index = new Map();
  rows.forEach(r => {
    const code = normalizeCode(r["Code"] || ""); if (!code) return;

    // Normalize headers: trim, collapse whitespace/newlines
    const keys = Object.keys(r).reduce((map, k) => {
      const norm = k.replace(/\s+/g, " ").trim().toLowerCase();
      map[norm] = k;
      return map;
    }, {});

    const primaryKey = keys["other facilities"];
    const secondaryKey = keys["alyahar, emirates, al wagan"];

    r._primaryPrice = primaryKey ? Number(String(r[primaryKey]).replace(/[^0-9.\-]/g,'')) : null;
    r._secondaryPrice = secondaryKey ? Number(String(r[secondaryKey]).replace(/[^0-9.\-]/g,'')) : null;

    if (!index.has(code)) index.set(code, []); index.get(code).push(r);
  });

  return {
    find(code) { const key = normalizeCode(code); const arr = index.get(key); return arr && arr.length ? arr[0] : null; },
    _index: index
  };
}

// ----------------- JSON-based pricing matcher (Thiqa + Daman) -----------------
function buildJsonPricingMatcher(data) {
  const index = new Map();
  (Array.isArray(data) ? data : []).forEach(entry => {
    const code = normalizeCode(entry.code);
    if (code) index.set(code, entry);
  });
  return {
    find(code) { return index.get(normalizeCode(code)) || null; }
  };
}

// ----------------- Modified: renderResults (hide repeated Claim ID) -----------------
function buildResultsTable(rows) {
  if (!rows || !rows.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.textContent = 'No results';
    return emptyDiv;
  }

  // Map rows to index for modal linking
  rows.forEach((r, i) => r._originalIndex = i);
  lastResults = rows.slice(); // ensure modal access

  const container = document.createElement('div');
  let prevClaimId = null;
  let html = `<table class="table table-bordered" style="width:100%;border-collapse:collapse"><thead><tr>
    <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
    <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
    <th style="padding:8px;border:1px solid #ccc">Code</th>
    <th style="padding:8px;border:1px solid #ccc">Claimed Net</th>
    <th style="padding:8px;border:1px solid #ccc">Quantity</th>
    <th style="padding:8px;border:1px solid #ccc">Reference Net Price</th>
    <th style="padding:8px;border:1px solid #ccc">Status</th>
    <th style="padding:8px;border:1px solid #ccc">Remarks</th>
    <th style="padding:8px;border:1px solid #ccc">Compare</th>
  </tr></thead><tbody>`;

  for (const r of rows) {
    const status = String(r.status || 'Invalid').toLowerCase();
    // Map status to Bootstrap/custom classes
    const cls = status === 'ok' || status === 'valid' ? 'table-success' : status === 'unknown' ? 'table-warning' : 'table-danger';
    const showClaim = r.ClaimID !== prevClaimId;
    html += `<tr class="${cls}" data-claim-id="${escapeHtml(r.ClaimID || '')}">
      <td style="padding:6px;border:1px solid #ccc" class="claim-id-cell">${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ActivityID)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.CPT)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ClaimedNet)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ClaimedQty)}</td>
      <td style="padding:6px;border:1px solid #ccc">${r._estimatedTotal != null ? escapeHtml(String(r._estimatedTotal)) + ' (estimate)' : escapeHtml(r.ReferenceNetPrice)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.status)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.Remarks || 'OK')}</td>
      <td style="padding:6px;border:1px solid #ccc">${r.PricingRow ? `<button type="button" class="details-btn" onclick="showComparisonModal(${r._originalIndex})">View</button>` : ''}</td>
    </tr>`;
    prevClaimId = r.ClaimID;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
  return container;
}

// ----------------- Modal comparison -----------------
function showComparisonModal(index) {
  const row = lastResults[index];
  if (!row) { alert('Row not found'); return; }
  const xml = row.XmlRow || {};
  const xlsx = row.PricingRow || {};
  const refPrice = String(row.ReferenceNetPrice || '');
  const xmlNet = Number(xml.Net || 0), xmlQty = Number(xml.Quantity || 0);
  const unitCalc = xmlQty > 0 ? (xmlNet / xmlQty) : null;
  const unitCalcText = unitCalc !== null ? String(unitCalc) : 'N/A';

  const xmlTable = `<table class="compare-table">
    <tr><th colspan="2">XML (Claim)</th></tr>
    <tr><th>Code</th><td>${escapeHtml(xml.CPT || row.CPT)}</td></tr>
    <tr><th>Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
    <tr><th>Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
    <tr><th>Net ÷ Qty</th><td>${escapeHtml(unitCalcText)}</td></tr>
  </table>`;

  const pricingTable = `<table class="compare-table">
    <tr><th colspan="2">Pricing Reference</th></tr>
    <tr><th>Code</th><td>${escapeHtml(String(firstNonEmptyKey(xlsx, ['Code','CPT','code']) || ''))}</td></tr>
    <tr><th>Net Price</th><td>${escapeHtml(refPrice)}</td></tr>
  </table>`;

  const modalHtml = `<div class="modal-content pricing-modal modal-scrollable">
    <span class="close" onclick="closeComparisonModal()">&times;</span>
    <h3>Price Comparison</h3>
    <div style="display:flex;gap:20px;align-items:flex-start;">${xmlTable}${pricingTable}</div>
    <div style="text-align:right;margin-top:10px;">
      <button class="details-btn" onclick="closeComparisonModal()">Close</button>
    </div>
  </div>`;

  closeComparisonModal();
  const modal = document.createElement('div');
  modal.id = "comparisonModal";
  modal.className = "modal";
  modal.innerHTML = modalHtml;
  modal.addEventListener('click', e => { if (e.target === modal) closeComparisonModal(); });
  document.body.appendChild(modal);
  modal.style.display = "flex";
}

function closeComparisonModal() { const modal = el('comparisonModal'); if (modal) modal.remove(); }

// ----------------- Utilities -----------------
function textValue(node, tag) { if (!node) return ''; const eln = node.getElementsByTagName(tag)[0]; return eln ? String(eln.textContent || '').trim() : ''; }
function firstNonEmpty(arr) { for (const s of arr) if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim(); return ''; }
function firstNonEmptyKey(obj, keys) { for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k]).trim() !== '') return obj[k]; return null; }
function makeWorkbookFromJson(json, sheetName) { const ws = XLSX.utils.json_to_sheet(json); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results'); return wb; }

// ----------------- UI helpers -----------------
function el(id) { return document.getElementById(id); }
function fileEl(id) { const f = el(id); return f && f.files && f.files[0] ? f.files[0] : null; }

function resetUI() {
  const container = el('outputTableContainer'); if (container) container.innerHTML = '';
  toggleDownload(false); message('', ''); showProgress(0, ''); lastResults = []; lastWorkbook = null;
}

function toggleDownload(enabled) {
  const dl = el('export-invalids-button'); if (dl) dl.disabled = !enabled;
  const dlAll = el('export-all-button'); if (dlAll) dlAll.disabled = !enabled;
}

function showProgress(percent, text) {
  const barContainer = el('progress-bar-container'), bar = el('progress-bar'), pText = el('progress-text');
  if (barContainer) barContainer.style.display = percent > 0 ? 'block' : 'none';
  if (bar) bar.style.width = (percent || 0) + '%';
  if (pText) pText.textContent = text ? `${percent}% — ${text}` : `${percent}%`;
}

function message(text, color) { const m = el('messageBox'); if (!m) return; m.textContent = text || ''; m.style.color = color || ''; }

function showError(err) { message(err && err.message ? err.message : String(err), 'red'); showProgress(0, ''); toggleDownload(false); }

// ----------------- Helpers: escaping -----------------
function escapeHtml(str) { return String(str == null ? '' : str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

// Unified checker entry point
window.runPricingCheck = async function() {
  if (typeof handleRun === 'function') {
    return await handleRun();
  } else {
    console.error('handleRun function not found');
    return null;
  }
};

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
