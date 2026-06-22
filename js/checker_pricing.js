(function () { try { // checker_pricing.js
let lastResults = [];
let lastWorkbook = null;

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
async function handleRun() {
  resetUI();
  try {
    let xmlFile = fileEl('xml-file');
    let xlsxFile = fileEl('xlsx-file');

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

    if (!Array.isArray(dentalPricingRaw) || dentalPricingRaw.length === 0) throw new Error('Dental pricing data could not be loaded.\nEnsure dental_pricing.json is present in the json/ folder.');

    let xlsxMatcher = null;
    if (xlsxFile) {
      const xlsxObj = await readXlsx(xlsxFile);
      xlsxMatcher = buildPricingMatcher(xlsxObj.rows);
      console.log('[PRICING] Using uploaded XLSX for pricing override');
    }

    showProgress(25, 'Parsing XML & pricing data');

    const xmlDoc = parseXml(xmlText);
    const headerNode = xmlDoc.querySelector('Header');
    const receiverID = headerNode?.querySelector('ReceiverID')?.textContent.trim() || '';

    console.log(`[PRICING] ReceiverID: ${receiverID || '(MISSING)'}`);
    if (receiverID !== 'D001' && receiverID !== 'A001') console.log(`[PRICING] ReceiverID "${receiverID}" is non-Thiqa/non-Daman — prices will be marked Unknown; PS=0 check will still apply.`);

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
      const remarks = [];
      let status = 'Invalid';
      const facility = rec.FacilityID || '';
      const xmlNet = Number(rec.Net || 0);
      const xmlQty = Number(rec.Quantity || 0);

      if (receiverID !== 'D001' && receiverID !== 'A001') {
        const isHAAD = receiverID.toUpperCase() === 'HAAD';
        const netZeroValid = isHAAD && xmlNet === 0;
        return {
          ClaimID: rec.ClaimID || '',
          ActivityID: rec.ActivityID || '',
          CPT: rec.CPT || '',
          ClaimedNet: rec.Net || '',
          ClaimedQty: rec.Quantity || '',
          ReferenceNetPrice: '',
          PricingRow: null,
          XmlRow: rec,
          isValid: netZeroValid,
          status: netZeroValid ? 'Valid' : 'Unknown',
          Remarks: netZeroValid ? 'Claimed Net is 0 (treated as Valid).' : '',
          ComputedRef: null,
          xmlNetNum: xmlNet,
          PatientShare: rec.PatientShare || '0'
        };
      }

      if (normalizeCode(rec.CPT) === '2111' && (receiverID === 'D001' || receiverID === 'A001')) {
        const insurerLabel = receiverID === 'D001' ? 'Thiqa' : 'Daman';
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
          ReferenceNetPrice: '0',
          PricingRow: null,
          XmlRow: rec,
          isValid: status === 'Valid',
          status,
          Remarks: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join(' '),
          ComputedRef: 0,
          xmlNetNum: xmlNet,
          PatientShare: rec.PatientShare || '0'
        };
      }

      let refPrice = '';
      let matchRow = null;
      let pricingContext;

      if (xlsxMatcher) {
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
        const xlsxMatch = xlsxMatcher.find(rec.CPT);
        if (xlsxMatch) {
          const isAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
          refPrice = isAlyaharGroup ? xlsxMatch._secondaryPrice : xlsxMatch._primaryPrice;
          matchRow = xlsxMatch;
        }
      } else {
        const jsonMatch = jsonMatcher.find(rec.CPT);
        if (jsonMatch) {
          if (receiverID === 'A001') {
            const isDamanKhabisiAlyahar = facility === 'MF5020' || facility === 'MF5357';
            refPrice = isDamanKhabisiAlyahar ? jsonMatch.daman_khabisi_alyahar : jsonMatch.daman_default;
          } else {
            const isThiqaAlyaharGroup = facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232';
            refPrice = isThiqaAlyaharGroup ? jsonMatch.thiqa_alyahar : jsonMatch.thiqa_other;
          }
          matchRow = jsonMatch;
        }
      }

      let endoEntry = null;
      let nonEndoUsedEndoPrice = false;
      let nonEndoClinicianSpec = '';

      if (receiverID === 'D001') {
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
              nonEndoUsedEndoPrice = Number.isFinite(endoRef) && (xmlNet === endoRef || xmlUnit === endoRef || xmlNet * 2 === endoRef);

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
      const ref = Number(refPrice ?? NaN);
      const computedRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref) ? ref : null;

      if (xmlNet === 0) {
        status = 'Valid';
        remarks.push('Claimed Net is 0 (treated as Valid)');
      } else {
        if (xmlQty <= 0) remarks.push(xmlQty === 0 ? 'Quantity is 0 (invalid)' : 'Quantity is less than 0 (invalid)');
        if (!match && !endoEntry) remarks.push(`No pricing match was found under ${pricingContext}.`);
        if (endoEntry && refPrice === null) remarks.push(`Code ${rec.CPT} has no available price under ${pricingContext}.`);
        if ((match || endoEntry) && refPrice !== null && Number.isNaN(ref)) remarks.push(`The reference price is not a valid number under ${pricingContext}.`);

        const hasValidRef = (match || endoEntry) && refPrice !== null && !Number.isNaN(ref);
        if (hasValidRef && ref === 0) {
          status = 'Unknown';
          remarks.push(`The reference price is 0 under ${pricingContext} (status Unknown).`);
        } else if (hasValidRef && xmlQty > 0) {
          if (xmlNet === ref) {
            status = 'Valid';
          } else if ((xmlNet / xmlQty) === ref) {
            status = 'Valid';
          } else if (xmlNet * 2 === ref) {
            status = 'Valid';
          } else if (normalizeCode(rec.CPT) === '42702' && xmlNet === ref * 2) {
            status = 'Valid';
          } else if (nonEndoUsedEndoPrice) {
            remarks.push(`Pricing for ${rec.CPT} is ${ref} following ${pricingContext}.\nEndo Pricing cannot be used for ${nonEndoClinicianSpec}.`);
          } else if (receiverID === 'A001') {
            const copayPct = Math.round((ref * xmlQty - xmlNet) / (ref * xmlQty) * 10000) / 100;
            remarks.push(`Copay: ${copayPct}%.`);
          } else {
            remarks.push(`Claimed Net ${xmlNet} does not match the reference price of ${ref} under ${pricingContext}.`);
          }
        }
      }

      return {
        ClaimID: rec.ClaimID || '',
        ActivityID: rec.ActivityID || '',
        CPT: rec.CPT || '',
        ClaimedNet: rec.Net || '',
        ClaimedQty: rec.Quantity || '',
        ReferenceNetPrice: refPrice || '',
        PricingRow: endoEntry || matchRow || null,
        XmlRow: rec,
        isValid: status === 'Valid',
        status,
        Remarks: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join(' '),
        ComputedRef: computedRef,
        xmlNetNum: xmlNet,
        PatientShare: rec.PatientShare || '0'
      };
    });

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
            r.status = 'Unknown';
            r.isValid = false;
            r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
          });
        } else {
          const totalRef = actRows.reduce((sum, r) => sum + (r.ComputedRef !== null ? r.ComputedRef * Number(r.ClaimedQty || 1) : r.xmlNetNum), 0);
          const totalXmlNet = actRows.reduce((sum, r) => sum + r.xmlNetNum, 0);
          const expectedPS = Math.round((totalRef - totalXmlNet) * 100) / 100;

          if (actualPS === expectedPS) {
            actRows.forEach(r => {
              if (!r.isValid) {
                r.status = 'Valid';
                r.isValid = true;
                r.Remarks = '';
              }
            });
          } else {
            const msg = `Patient Share ${actualPS} is incorrect.\nExpected: ${expectedPS} (Total Ref: ${totalRef} − Total Net: ${totalXmlNet}).`;
            actRows.forEach(r => {
              r.status = 'Unknown';
              r.isValid = false;
              r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
            });
          }
        }
      }
    }

    if (receiverID !== 'D001' && receiverID !== 'A001') {
      const claimGroups = new Map();
      output.forEach(r => {
        if (!claimGroups.has(r.ClaimID)) claimGroups.set(r.ClaimID, []);
        claimGroups.get(r.ClaimID).push(r);
      });

      const isCash = receiverID.toUpperCase() === 'HAAD' || receiverID.toUpperCase() === 'CASH';

      for (const [, actRows] of claimGroups) {
        const actualPS = Number(actRows[0].PatientShare || 0);

        if (actualPS === 0 && !isCash) {
          const msg = 'Patient Share is 0 — this is invalid for non-Thiqa claims.';
          actRows.forEach(r => {
            r.status = 'Unknown';
            r.isValid = false;
            r.Remarks = r.Remarks ? `${r.Remarks} ${msg}` : msg;
          });
        } else if (actualPS === 0 && isCash) {
          const totalClaimedNet = actRows.reduce((sum, r) => sum + r.xmlNetNum, 0);
          if (totalClaimedNet === 0) {
            actRows.forEach(r => {
              r.status = 'Valid';
              r.isValid = true;
            });
          }
        }

        if (actualPS > 0) {
          const totalClaimedNet = actRows.reduce((sum, r) => sum + r.xmlNetNum, 0);
          const psPercentage = actualPS / (actualPS + totalClaimedNet);
          const psPercentagePct = Math.round(psPercentage * 100);

          actRows.forEach(r => {
            const net = r.xmlNetNum;
            const estimatedTotal = psPercentage < 1 ? Math.round((net / (1 - psPercentage)) * 100) / 100 : 0;
            const estimatedPS = Math.round((estimatedTotal - net) * 100) / 100;
            r._estimatedTotal = estimatedTotal;
            r._estimatedPS = estimatedPS;
            r._estimatedPayerNet = Math.round((estimatedTotal - estimatedPS) * 100) / 100;
          });

          actRows.forEach(r => {
            const netMatch = Math.abs(r.xmlNetNum - r._estimatedPayerNet) < 0.01;
            const matchOp = netMatch ? '==' : '!=';
            if (r.xmlNetNum === 0) return;
            const remark = `${psPercentagePct}% Copay estimate.\nNet ${netMatch ? 'Match' : 'Mismatch'} (${r.xmlNetNum} [xml] ${matchOp} ${r._estimatedPayerNet} [estimate]).`;
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
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    const encounterNode = claim.getElementsByTagName('Encounter')[0];
    const facilityId = textValue(encounterNode, 'FacilityID') || '';
    const encounterDateStr = textValue(encounterNode, 'Start') || textValue(encounterNode, 'Date') || textValue(encounterNode, 'EncounterDate') || '';
    const claimPatientShare = textValue(claim, 'PatientShare').trim() || '0';

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

      records.push({
        ClaimID: claimId,
        ActivityID: activityId,
        CPT: cpt,
        Net: net,
        Quantity: qty,
        FacilityID: facilityId,
        ClinicianLic: clinicianLic,
        EncounterDate: encounterDateStr,
        PatientShare: claimPatientShare
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
    }
  };
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

  const container = document.createElement('div');
  let prevClaimId = null;

  let html = `
    <table class="table table-bordered table-sm">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Code</th>
          <th>Claimed Net</th>
          <th>Quantity</th>
          <th>Reference Net Price</th>
          <th>Status</th>
          <th>Remarks</th>
          <th>Compare</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const r of rows) {
    const status = String(r.status || 'Invalid').toLowerCase();
    const cls = status === 'ok' || status === 'valid' ? 'table-success' : status === 'unknown' ? 'table-warning' : 'table-danger';
    const showClaim = r.ClaimID !== prevClaimId;

    html += `
      <tr class="${cls}">
        <td>${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
        <td>${escapeHtml(r.ActivityID)}</td>
        <td>${escapeHtml(r.CPT)}</td>
        <td>${escapeHtml(r.ClaimedNet)}</td>
        <td>${escapeHtml(r.ClaimedQty)}</td>
        <td>${r._estimatedTotal != null ? escapeHtml(String(r._estimatedTotal)) + ' (estimate)' : escapeHtml(r.ReferenceNetPrice)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.Remarks || 'OK')}</td>
        <td>${r.PricingRow ? `<button type="button" onclick="window.showPricingComparison(${r._originalIndex})">View</button>` : ''}</td>
      </tr>
    `;

    prevClaimId = r.ClaimID;
  }

  html += `
      </tbody>
    </table>
  `;

  container.innerHTML = html;
  return container;
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
  const refPrice = String(row.ReferenceNetPrice || '');
  const xmlNet = Number(xml.Net || 0);
  const xmlQty = Number(xml.Quantity || 0);
  const unitCalc = xmlQty > 0 ? (xmlNet / xmlQty) : null;
  const unitCalcText = unitCalc !== null ? String(unitCalc) : 'N/A';

  const xmlTable = `
    <h4>XML (Claim)</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Code</th><td>${escapeHtml(xml.CPT || row.CPT)}</td></tr>
      <tr><th>Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
      <tr><th>Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
      <tr><th>Net ÷ Qty</th><td>${escapeHtml(unitCalcText)}</td></tr>
    </table>
  `;

  const pricingTable = `
    <h4>Pricing Reference</h4>
    <table class="table table-bordered table-sm">
      <tr><th>Code</th><td>${escapeHtml(String(firstNonEmptyKey(pricing, ['Code', 'CPT', 'code']) || ''))}</td></tr>
      <tr><th>Net Price</th><td>${escapeHtml(refPrice)}</td></tr>
    </table>
  `;

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

window.runPricingCheck = async function () {
  if (typeof handleRun === 'function') return await handleRun();
  console.error('handleRun function not found');
  return null;
};

window.showPricingComparison = showComparisonModal;
window.closePricingComparison = closeComparisonModal;

} catch (error) {
  console.error('[CHECKER-ERROR] Failed to load checker:', error);
  console.error(error.stack);
}
})();
