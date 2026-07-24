(function() {
  'use strict';

  // checker_schema.js – compact, readable, combined V1+V2 features
  // Requires SheetJS and mandatory_tariff_shared.js.

  const AMPERSAND_REPLACEMENT_ERROR = "Please replace `&` in the observations to `and` because this will cause error.";
  const CLAIM_NOT_MERGED = "CLAIM_NOT_MERGED";
  const NOT_MERGED_RECEIVER_IDS = new Set(['D001', 'A001', 'D004']);
  const CONSULATION_CODE_REGEX = /^(92|992)/;
  const GP_992_REQUIRED_CODES = new Set(['99202', '99212']);
  const GP_992_FORBIDDEN_CODES = new Set(['99203', '99213']);
  const GP_992_CODES = new Set(['99202', '99203', '99212', '99213']);
  const MUTUALLY_EXCLUSIVE_INFUSION_CODES = new Set(['96360', '96365', '96374']);
  const INVALID_ACTIVITY_CODES = new Set(['36591']);
  const OLD_DUPLICATE_ORDERING_PATTERN = /^Duplicate code\s+.+?\s+with Ordering Clinician\s+.+?\.?$/i;
  const OK_REMARK_PATTERN = /^OK\.?$/i;

  let clinicianSpecialtyMapPromise = null;
  let pregnancyDiagnosisDataPromise = null;

  // ----- Display / Modal / Export helpers --------------------------------------
  function sanitizeForHTML(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  
  function ensureModal() {
    if (document.getElementById('modalOverlay')) return;
    const html = `<div id="modalOverlay" style="display:none;position:fixed;z-index:9999;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.35);"><div id="modalContent" style="background:#fff;width:90%;max-width:1000px;max-height:95vh;overflow:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:20px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.2);"><button id="modalCloseBtn" style="float:right;font-size:18px;padding:2px 10px;cursor:pointer;">&times;</button><div id="modalTable"></div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    document.getElementById('modalCloseBtn').onclick = hideModal;
    document.getElementById('modalOverlay').onclick = e => { if (e.target.id === 'modalOverlay') hideModal(); };
  }
  function showModal(html) { ensureModal(); document.getElementById('modalTable').innerHTML = html; document.getElementById('modalOverlay').style.display = 'block'; }
  function hideModal() { document.getElementById('modalOverlay').style.display = 'none'; }

  function claimToHtmlTable(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    let root = doc.documentElement;
    if (root.nodeName !== 'Claim' && root.nodeName !== 'Person') root = doc.getElementsByTagName('Claim')[0] || doc.getElementsByTagName('Person')[0];
    if (!root) return '<b>Entry not found!</b>';
    function renderNode(node, level) {
      let html = '';
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.children.length === 0) html += `<tr><td style="padding-left:${level*20}px"><b>${child.nodeName}</b></td><td>${child.textContent}</td></tr>`;
        else html += `<tr><td style="padding-left:${level*20}px"><b>${child.nodeName}</b></td><td></td></tr>` + renderNode(child, level + 1);
      }
      return html;
    }
    let html = `<table border="1" cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;"><tr><th style="background:#f0f0f0">Field</th><th style="background:#f0f0f0">Value</th></tr>`;
    html += renderNode(root, 0);
    html += '</table>';
    return html;
  }

  function exportErrorsToXLSX(data, schemaType) {
    const rows = Array.isArray(data) ? data : (Array.isArray(window._lastValidationResults) ? window._lastValidationResults : []);
    const schema = schemaType || window._lastValidationSchema || 'claim';
    if (!rows.length) { alert('No results available to export.'); return; }
    if (typeof XLSX === 'undefined') { console.error('SheetJS not loaded.'); alert('Export failed: XLSX library not loaded.'); return; }
    const errorRows = rows.filter(r => r.Remark !== 'OK');
    if (!errorRows.length) { alert('No errors to export.'); return; }
    const exportData = errorRows.map(row => ({ [schema === 'person' ? 'UnifiedNumber' : 'ClaimID']: row.ClaimID, Remark: row.Remark }));
    let fileName = window._lastValidationFileName ? window._lastValidationFileName.replace(/\.[^/.]+$/, '') + '_errors.xlsx' : null;
    if (!fileName) {
      const fi = document.getElementById('xmlFile');
      if (fi && fi.files && fi.files[0]) fileName = fi.files[0].name.replace(/\.[^/.]+$/, '') + '_errors.xlsx';
      else fileName = (schema === 'person' ? 'person' : 'claim') + '_errors_' + new Date().toISOString().replace(/[:.]/g, '-') + '.xlsx';
    }
    try {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportData), 'Errors');
      XLSX.writeFile(wb, fileName);
    } catch (err) { console.error('Export failed:', err); alert('Export failed. See console.'); }
  }

  // ----- General helpers --------------------------------------------------------
  function normalizeSpecialty(v) { return String(v || '').trim().toUpperCase(); }

  function loadClinicianSpecialtyMap() {
    if (clinicianSpecialtyMapPromise) return clinicianSpecialtyMapPromise;
    return clinicianSpecialtyMapPromise = fetch('../json/clinician_licenses.json')
      .then(res => { if (!res.ok) throw new Error(`Failed to load clinician specialties (${res.status})`); return res.json(); })
      .then(rows => {
        const map = new Map();
        (Array.isArray(rows) ? rows : []).forEach(row => {
          const lic = String(row['Phy Lic'] || '').trim().toUpperCase();
          if (!lic) return;
          const spec = String(row['Specialty'] || '').trim();
          if (!map.has(lic) || spec) map.set(lic, spec);
        });
        return map;
      })
      .catch(err => { console.warn('[SCHEMA] Failed to load clinician specialties:', err.message); return new Map(); });
  }

  function normalizeDiagnosisCode(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  async function fetchFirstAvailableJson(paths) {
    const failures = [];
    for (const p of paths) {
      try {
        const resp = await fetch(p, { cache: 'no-store' });
        if (!resp.ok) { failures.push(`${p}: HTTP ${resp.status}`); continue; }
        return { path: p, data: await resp.json() };
      } catch (e) { failures.push(`${p}: ${e.message || String(e)}`); }
    }
    throw new Error('Pregnancy diagnosis data could not be loaded. ' + failures.join(' | '));
  }

  function loadPregnancyDiagnosisData() {
    if (pregnancyDiagnosisDataPromise) return pregnancyDiagnosisDataPromise;
    const paths = ['../json/pregnancy_diagnosis_codes.json', 'json/pregnancy_diagnosis_codes.json', './json/pregnancy_diagnosis_codes.json'];
    return pregnancyDiagnosisDataPromise = fetchFirstAvailableJson(paths)
      .then(({path, data}) => {
        if (!data || typeof data !== 'object') throw new Error('Pregnancy JSON must be an object.');
        if (!Array.isArray(data.zCodes) || !Array.isArray(data.oCodes)) throw new Error('Pregnancy JSON must contain zCodes and oCodes arrays.');
        const buildMap = (rows, name) => {
          const map = new Map();
          rows.forEach((row, idx) => {
            const code = normalizeDiagnosisCode(row?.code);
            const trim = Number(row?.trimester);
            if (!code) throw new Error(`${name}[${idx}] has no code.`);
            if (![0,1,2,3].includes(trim)) throw new Error(`${name}[${idx}] (${row?.code||code}) invalid trimester ${row?.trimester}.`);
            if (map.has(code)) throw new Error(`${name} duplicate code ${row?.code||code}.`);
            map.set(code, { code: String(row?.code||code).trim().toUpperCase(), normalizedCode: code, description: String(row?.description||'').trim(), trimester: trim });
          });
          return map;
        };
        const labels = new Map([[0,'Unspecified trimester'],[1,'First trimester'],[2,'Second trimester'],[3,'Third trimester']]);
        if (data.trimesterValues && typeof data.trimesterValues === 'object') {
          Object.entries(data.trimesterValues).forEach(([k,v]) => { const t=Number(k); if ([0,1,2,3].includes(t) && String(v||'').trim()) labels.set(t, String(v).trim()); });
        }
        const parsed = Object.freeze({ sourcePath: path, zCodes: buildMap(data.zCodes,'zCodes'), oCodes: buildMap(data.oCodes,'oCodes'), trimesterLabels: labels });
        console.log(`[SCHEMA][PREGNANCY] Loaded ${parsed.zCodes.size} Z-codes and ${parsed.oCodes.size} O-codes from ${path}.`);
        return parsed;
      })
      .catch(err => { pregnancyDiagnosisDataPromise = null; throw err; });
  }

  function formatNaturalList(values) {
    const items = Array.from(values || []).filter(Boolean);
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0,-1).join(', ')}, and ${items[items.length-1]}`;
  }

  function formatPregnancyDiagnosisEntry(entry, labels) {
    const label = labels.get(entry.trimester) || `Trimester ${entry.trimester}`;
    return `${entry.code} (${label})`;
  }

  function checkPregnancyDiagnosisTrimesterConsistency(diagnoses, getText, invalidFields, pregnancyData) {
    try {
      if (!pregnancyData) return;
      const codes = Array.from(diagnoses||[]).map(d => normalizeDiagnosisCode(getText('Code', d))).filter(Boolean);
      const unique = Array.from(new Set(codes));
      const zEntries = unique.map(c => pregnancyData.zCodes.get(c)).filter(Boolean);
      if (!zEntries.length) return;
      const oEntries = unique.map(c => pregnancyData.oCodes.get(c)).filter(Boolean);
      const trimesters = Array.from(new Set(zEntries.map(e => e.trimester)));
      if (trimesters.length > 1) {
        const conflicting = zEntries.map(e => formatPregnancyDiagnosisEntry(e, pregnancyData.trimesterLabels));
        invalidFields.push('Pregnancy Z-codes indicate conflicting trimesters: ' + formatNaturalList(conflicting));
        return;
      }
      const required = trimesters[0];
      const label = pregnancyData.trimesterLabels.get(required) || `Trimester ${required}`;
      const zDisplay = formatNaturalList(zEntries.map(e => e.code));
      oEntries.forEach(e => {
        if (e.trimester !== required) {
          const actual = pregnancyData.trimesterLabels.get(e.trimester) || `Trimester ${e.trimester}`;
          invalidFields.push(`Pregnancy trimester mismatch: ${zDisplay} indicates ${label}, but ${e.code} indicates ${actual}`);
        }
      });
    } catch (err) {
      console.error('[SCHEMA][PREGNANCY] Trimester validation failed:', err);
      invalidFields.push('Pregnancy diagnosis validation failed: ' + (err.message || String(err)));
    }
  }

  function getDirectChildElement(parent, tag) {
    return Array.from(parent?.children || []).find(c => String(c?.nodeName||c?.tagName||'').trim() === tag) || null;
  }
  function getDirectChildText(parent, tag) {
    const c = getDirectChildElement(parent, tag);
    return String(c?.textContent||'').trim();
  }

  function getSelectedClaimTypeMode() {
    const dent = document.getElementById('claimTypeDental');
    const med = document.getElementById('claimTypeMedical');
    if (med && med.checked) return 'MEDICAL';
    if (dent && dent.checked) return 'DENTAL';
    return null;
  }

  function getScopedElement(container, selector) {
    if (container && typeof container.querySelector === 'function') {
      const s = container.querySelector(selector);
      if (s) return s;
    }
    return document?.querySelector(selector) || null;
  }

  function buildSchemaMessageElement(msg, className = 'checker-error') {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = msg;
    return el;
  }

  function safeTextByTag(parent, tag) {
    if (!parent) return '';
    const el = parent.getElementsByTagName(tag)[0];
    return el?.textContent?.trim() || '';
  }

  function parseEncounterDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(raw);
    if (!match) return null;
    const [_, day, month, year, hour, minute] = match.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const date = new Date(Date.UTC(year, month-1, day, hour, minute));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) return null;
    return { raw, dateKey: `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, timestamp: date.getTime() };
  }

  // ----- Mandatory Tariff Occurrence Limits (streamlined) -----------------------
  function cleanSchemaRemarkLines(remark) {
    return String(remark == null ? '' : remark).split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !OLD_DUPLICATE_ORDERING_PATTERN.test(l));
  }
  function groupTariffFindingsByClaim(findings) {
    const grouped = new Map();
    (findings||[]).forEach(f => { const id = String(f?.claimID||'Unknown').trim(); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(f); });
    return grouped;
  }
  function applyTariffFindingsToResult(result, findings) {
    const original = String(result?.Remark||'').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const removed = original.some(l => OLD_DUPLICATE_ORDERING_PATTERN.test(l));
    let lines = cleanSchemaRemarkLines(result?.Remark).filter(l => !OK_REMARK_PATTERN.test(l));
    (findings||[]).forEach(f => { if (f?.remark && !lines.includes(f.remark)) lines.push(f.remark); });
    if (findings?.length) { result.Valid = false; result.Unknown = false; }
    else if (removed && !lines.length) { result.Valid = true; result.Unknown = false; }
    if (!lines.length) lines = ['OK'];
    result.Remark = lines.join('\n');
    result.TariffOccurrenceFindings = (findings||[]).slice();
    return result;
  }

  async function applyTariffOccurrenceLimits(xmlDoc, results, options = {}) {
    const mode = String(options.claimTypeMode || getSelectedClaimTypeMode() || '').trim().toUpperCase();
    if (mode === 'DENTAL') { window._lastTariffOccurrenceFindings = []; console.log('[SCHEMA][TARIFF] Skipped CPT MUE (Dental).'); return results; }
    if (!window.MandatoryTariffShared) throw new Error('MandatoryTariffShared unavailable.');
    const data = await window.MandatoryTariffShared.loadBundledMandatoryTariff();
    data.warnings?.forEach(w => console.warn('[SCHEMA][TARIFF]', w));
    const findings = window.MandatoryTariffShared.validateSubmissionOccurrenceLimits(xmlDoc, data.map);
    const byClaim = groupTariffFindingsByClaim(findings);
    (results||[]).forEach(r => applyTariffFindingsToResult(r, byClaim.get(String(r?.ClaimID||'Unknown').trim()) || []));
    window._lastTariffOccurrenceFindings = findings;
    console.log(`[SCHEMA][TARIFF] Applied CPT MUE from ${data.sheetName}. Findings: ${findings.length}; rows: ${data.rows.length}; source: ${data.path}`);
    return results;
  }

  // ----- Cross‑claim merge detection --------------------------------------------
  function collectNotMergedClaimContext(claim, receiverID = '') {
    const claimID = safeTextByTag(claim, 'ID');
    const memberID = safeTextByTag(claim, 'MemberID').toUpperCase();
    const payerID = safeTextByTag(claim, 'PayerID').toUpperCase();
    const providerID = safeTextByTag(claim, 'ProviderID').toUpperCase();
    const enc = claim.getElementsByTagName('Encounter')[0] || null;
    const facilityID = safeTextByTag(enc, 'FacilityID').toUpperCase();
    const startRaw = safeTextByTag(enc, 'Start'), endRaw = safeTextByTag(enc, 'End');
    const pStart = parseEncounterDateTime(startRaw), pEnd = parseEncounterDateTime(endRaw);
    const encDate = pStart ? pStart.dateKey : (pEnd ? pEnd.dateKey : null);
    const activities = claim.getElementsByTagName('Activity');
    const clinicians = new Set();
    Array.from(activities).forEach(a => { const oc = safeTextByTag(a, 'OrderingClinician').toUpperCase(); if (oc) clinicians.add(oc); });
    const diagCodes = new Set();
    Array.from(claim.getElementsByTagName('Diagnosis')).forEach(d => { const c = safeTextByTag(d, 'Code').toUpperCase().replace(/\./g,''); if (c) diagCodes.add(c); });
    return { receiverID: String(receiverID||'').trim().toUpperCase(), claimID, memberID, payerID, providerID, facilityID, encounterDate: encDate, encounterStartRaw: startRaw, encounterEndRaw: endRaw, parsedStart: pStart, parsedEnd: pEnd, clinicians, diagnosisCodes: diagCodes };
  }

  function buildNotMergedRemarksFromContexts(contexts) {
    const grouped = new Map();
    (contexts||[]).forEach(ctx => {
      if (!ctx.memberID || !ctx.providerID || !ctx.facilityID || !ctx.encounterDate) return;
      if (!NOT_MERGED_RECEIVER_IDS.has(String(ctx.receiverID||'').toUpperCase())) return;
      const key = [ctx.receiverID, ctx.memberID, ctx.providerID, ctx.facilityID, ctx.encounterDate].join('|');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(ctx);
    });
    const remarks = new Map(), pairs = new Set();
    grouped.forEach(group => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i+1; j < group.length; j++) {
          const a = group[i], b = group[j];
          if (!a.claimID || !b.claimID || a.claimID === b.claimID) continue;
          if (!a.parsedStart || !a.parsedEnd || !b.parsedStart || !b.parsedEnd) continue;
          if (!(a.parsedStart.timestamp <= b.parsedEnd.timestamp && b.parsedStart.timestamp <= a.parsedEnd.timestamp)) continue;
          const sharedClin = Array.from(a.clinicians).filter(c => b.clinicians.has(c));
          if (!sharedClin.length) continue;
          const sharedDiag = Array.from(a.diagnosisCodes).filter(c => b.diagnosisCodes.has(c));
          if (!sharedDiag.length) continue;
          const pair = [a.claimID, b.claimID].sort().join('|');
          if (pairs.has(pair)) continue;
          pairs.add(pair);
          const msgA = `${a.claimID} must be merged with ${b.claimID}.`;
          const msgB = `${b.claimID} must be merged with ${a.claimID}.`;
          if (!remarks.has(a.claimID)) remarks.set(a.claimID, []);
          if (!remarks.has(b.claimID)) remarks.set(b.claimID, []);
          remarks.get(a.claimID).push(msgA);
          remarks.get(b.claimID).push(msgB);
        }
      }
    });
    return remarks;
  }

  function detectNotMergedRemarksByClaim(claims, receiverID = '') {
    const warnings = [];
    const contexts = Array.from(claims||[]).map((c,i) => { try { return collectNotMergedClaimContext(c, receiverID); } catch(e) { warnings.push(`Claim index ${i}: ${e.message}`); return null; } }).filter(Boolean);
    warnings.forEach(w => console.warn('[SCHEMA][NOT_MERGED]', w));
    return buildNotMergedRemarksFromContexts(contexts);
  }

  // ----- Supplemental claim‑rule helpers ----------------------------------------
  function isConsultationCode(c) { return CONSULATION_CODE_REGEX.test(String(c||'').trim()); }
  function specialtyContains(spec, text) { return normalizeSpecialty(spec).includes(normalizeSpecialty(text)); }
  function isOphthalmologyOrPsychiatrySpecialty(spec) {
    const n = normalizeSpecialty(spec);
    return n.includes('OPTHALMOLOGY') || n.includes('OPHTHALMOLOGY') || n.includes('PSYCHIATRY');
  }

  function checkForFalseValues(parent, invalidFields, prefix = "", activityContext = null, errors = null) {
    if (!errors) errors = { activity: new Map(), nonActivity: [] };
    const normalizePath = (pfx, node, removeAct) => {
      let path = (pfx ? `${pfx} → ${node}` : node).replace(/^Claim(?:[.\s→]*)/, '').replace(/^Person(?:[.\s→]*)/, '');
      if (removeAct) path = path.replace(/Activity\s*→\s*/g, '');
      return path;
    };
    for (const el of parent.children) {
      const val = (el.textContent||'').trim().toLowerCase();
      let actCtx = activityContext;
      if (el.nodeName === 'Activity') {
        const codeEl = el.getElementsByTagName('Code')[0];
        actCtx = codeEl ? (codeEl.textContent||'').trim() : '(unknown)';
      }
      if (!el.children.length && val === 'false' && el.nodeName !== 'MiddleNameEn') {
        if (actCtx) {
          const field = normalizePath(prefix, el.nodeName, true).split(/\s*→\s*/).join(' ');
          if (!errors.activity.has(field)) errors.activity.set(field, []);
          errors.activity.get(field).push(actCtx);
        } else {
          errors.nonActivity.push(normalizePath(prefix, el.nodeName, false).replace(/\s*→\s*/g, ' ') + ' has invalid value of `false`.');
        }
      }
      if (el.children.length) checkForFalseValues(el, invalidFields, prefix ? `${prefix} → ${el.nodeName}` : el.nodeName, actCtx, errors);
    }
    if (prefix === 'Claim.' && !activityContext) {
      errors.nonActivity.forEach(m => invalidFields.push(m));
      errors.activity.forEach((acts, field) => {
        if (acts.length === 1) invalidFields.push(`Activity ${acts[0]} has ${field} of \`false\``);
        else if (acts.length === 2) invalidFields.push(`Activities ${acts[0]} and ${acts[1]} have ${field} as \`false\`.`);
        else invalidFields.push(`Activities ${acts.slice(0,-1).join(' ')} and ${acts[acts.length-1]} have ${field} as \`false\`.`);
      });
    }
  }

  function checkSpecialActivityDiagnosis(activities, diagnoses, getText, invalidFields) {
    try {
      const specialCodes = new Set(['11111','11119','11101','11109']);
      const patterns = [{p:'K05.0',d:'K05.0'},{p:'K05.1',d:'K05.1'},{p:'K03.6',d:'K03.6'}];
      const found = Array.from(activities||[]).map(a => (getText('Code',a)||'').trim()).filter(c => c && specialCodes.has(c));
      if (!found.length) return;
      const diagCodes = Array.from(diagnoses||[]).map(d => (getText('Code',d)||'').toUpperCase().trim()).filter(Boolean);
      const match = patterns.some(({p}) => diagCodes.some(code => code.length >= p.length && code.substring(0,p.length) === p));
      if (!match) invalidFields.push(`Activity code(s) ${Array.from(new Set(found)).join(' ')} require Diagnosis code(s): ${patterns.map(p=>p.d).join(' or ')}`);
    } catch(err) { console.error('Special activity diagnosis check error:', err); }
  }

  function checkImplantActivityDiagnosis(activities, diagnoses, getText, invalidFields) {
    try {
      const implantCodes = new Set(['79931','79932','79933','79934']);
      const found = Array.from(activities||[]).map(a => (getText('Code',a)||'').trim()).filter(c => c && implantCodes.has(c));
      if (!found.length) return;
      const diagCodes = Array.from(diagnoses||[]).map(d => (getText('Code',d)||'').replace(/\./g,'').toUpperCase().trim()).filter(Boolean);
      const valid = diagCodes.some(c => (c.startsWith('K081') && c.length >= 5) || (c.startsWith('K084') && c.length >= 5));
      if (!valid) invalidFields.push(`Activity code(s) ${Array.from(new Set(found)).join(' ')} require at least one Diagnosis code from: K08.1 or K08.4`);
    } catch(err) { console.error('Implant activity diagnosis check error:', err); }
  }

  function checkGTLicenseValidation(activities, facilityID, getText, invalidFields) {
    try {
      let hasGT = false;
      Array.from(activities||[]).forEach(a => { if ((getText('OrderingClinician',a)||'').trim().toUpperCase().startsWith('GT')) hasGT = true; });
      if (hasGT) { const msg = 'Ordering Clinician is under Physiotherapist.'; if (!invalidFields.includes(msg)) invalidFields.push(msg); }
    } catch(err) { console.error('GT license validation check error:', err); }
  }

  // ----- Medical consistency and specialty validation ----------------------------
  function validateMedicalOrderingConsistency(activities, text, invalidFields, options = {}) {
    if (!options.isMedicalClaim) return;
    const orderings = new Set(), missing = [], duplicates = new Map();
    Array.from(activities||[]).forEach(a => {
      const code = text('Code', a);
      const ord = String(text('OrderingClinician', a)||'').trim().toUpperCase();
      const norm = String(code||'').trim().toUpperCase().replace(/[^A-Z0-9\-]/g,'');
      if (!ord) { if (code) missing.push(code); return; }
      orderings.add(ord);
      if (!norm) return;
      const key = `${norm}|${ord}`;
      duplicates.set(key, (duplicates.get(key)||0) + 1);
    });
    if (orderings.size > 1) invalidFields.push(`Claim ${text('ID')} has multiple Ordering Clinicians: ${Array.from(orderings).join(', ')}.`);
    if (missing.length) invalidFields.push(`Missing OrderingClinician for activities: ${Array.from(new Set(missing)).join(', ')}.`);
    duplicates.forEach((count, key) => {
      if (count < 2) return;
      const [code, ord] = key.split('|');
      invalidFields.push(`Duplicate code ${code} with Ordering Clinician ${ord}.`);
    });
  }

  function validateConsultationAndSpecialtyRules(activities, text, invalidFields, clinicianSpecialtyMap, options = {}) {
    if (!options.isMedicalClaim) return;
    const ctxs = Array.from(activities||[]).map(a => {
      const code = text('Code', a);
      const qty = Number(text('Quantity', a) || 0);
      const net = Number(text('Net', a) || 0);
      const clin = (text('Clinician', a)||'').trim().toUpperCase();
      const ord = (text('OrderingClinician', a)||'').trim().toUpperCase();
      return { code, qty, net, clin, ord, clinSpec: clinicianSpecialtyMap.get(clin)||'', ordSpec: clinicianSpecialtyMap.get(ord)||'' };
    });
    const require992Check = ctxs.length > 1;
    const infusionSet = new Set(), found992 = new Set();
    ctxs.forEach(c => {
      if (!c.code) return;
      if (MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(c.code)) infusionSet.add(c.code);
      if (GP_992_CODES.has(c.code)) found992.add(c.code);
      if (INVALID_ACTIVITY_CODES.has(c.code)) invalidFields.push(`Activity ${c.code} is invalid and cannot be used`);
      if (/^8/.test(c.code) && c.code !== '82948' && !specialtyContains(c.clinSpec, 'Pathology')) invalidFields.push(`Activity ${c.code} requires Clinician specialty containing Pathology (Currently \`${c.clinSpec||'Unknown'}\`)`);
      if ((c.code === '97802' || c.code === '97803') && !specialtyContains(c.clinSpec, 'Dietician')) invalidFields.push(`Activity ${c.code} requires Clinician specialty containing Dietician (Currently \`${c.clinSpec||'Unknown'}\`)`);
      if (require992Check && GP_992_REQUIRED_CODES.has(c.code) && !specialtyContains(c.ordSpec, 'General Practitioner')) invalidFields.push(`Activity ${c.code} requires OrderingClinician specialty as General Practitioner (Currently \`${c.ordSpec||'Unknown'}\`)`);
      if (GP_992_FORBIDDEN_CODES.has(c.code)) {
        if (c.net !== 0 && specialtyContains(c.ordSpec, 'General Practitioner')) invalidFields.push(`Activity ${c.code} requires OrderingClinician specialty to NOT be General Practitioner (Currently \`${c.ordSpec||'Unknown'}\`)`);
        if (isOphthalmologyOrPsychiatrySpecialty(c.ordSpec)) invalidFields.push(`${c.ordSpec||'OrderingClinician Specialty'} cannot be used for ${c.code}`);
      }
      if ((specialtyContains(c.ordSpec, 'Opthalmology') || specialtyContains(c.ordSpec, 'Ophthalmology')) && isConsultationCode(c.code) && c.code.startsWith('992')) invalidFields.push(`Ophthalmology consultation codes must start with 92, not ${c.code}`);
      if (MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(c.code) && c.qty !== 1) invalidFields.push(`Activity ${c.code} must have Quantity of 1`);
    });
    if ((found992.has('99202') || found992.has('99203')) && (found992.has('99212') || found992.has('99213'))) invalidFields.push('99202/99203 cannot be combined with 99212/99213 in the same claim');
    if (infusionSet.size > 1) invalidFields.push(`Codes ${Array.from(infusionSet).join(', ')} cannot coexist in the same claim`);
  }

  // ----- Primary validators -----------------------------------------------------
  function validatePersonSchema(xmlDoc, originalXmlContent = '') {
    const results = [];
    Array.from(xmlDoc.getElementsByTagName('Person')).forEach(person => {
      let missing = [], invalid = [], remarks = [], unknown = false;
      const present = (tag, parent=person) => parent.getElementsByTagName(tag).length > 0;
      const text = (tag, parent=person) => { const el = parent.getElementsByTagName(tag)[0]; return el?.textContent?.trim() || ''; };
      const invalidIfNull = (tag, parent=person, prefix='') => { if (!text(tag, parent)) invalid.push(prefix + tag + ' (null/empty)'); };
      const unified = text('UnifiedNumber');
      let hadAmp = false;
      if (originalXmlContent && unified) {
        const pos = originalXmlContent.indexOf(`<UnifiedNumber>${unified}</UnifiedNumber>`);
        if (pos !== -1) {
          let start = originalXmlContent.lastIndexOf('<Person>', pos);
          if (start === -1) start = originalXmlContent.lastIndexOf('<Person ', pos);
          const end = originalXmlContent.indexOf('</Person>', pos);
          if (start !== -1 && end !== -1) {
            const content = originalXmlContent.substring(start, end + '</Person>'.length);
            hadAmp = /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/.test(content);
          }
        }
      }
      ['UnifiedNumber','FirstName','FirstNameEn','LastNameEn','ContactNumber','BirthDate','Gender','Nationality','City','CountryOfResidence','EmirateOfResidence','EmiratesIDNumber'].forEach(t => invalidIfNull(t, person));
      if (present('EmiratesIDNumber')) {
        const eid = text('EmiratesIDNumber'), parts = eid.split('-'), digits = eid.replace(/-/g,'');
        const all0 = /^0+$/.test(digits), all1 = /^1+$/.test(digits), all2 = /^2+$/.test(digits), all9 = /^9+$/.test(digits);
        const placeholder = all0 || all1 || all2 || all9;
        if (parts.length !== 4) invalid.push(`EmiratesIDNumber '${eid}' (must have 4 parts)`);
        else {
          if (!placeholder && parts[0] !== '784') invalid.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
          if (!/^\d{4}$/.test(parts[1])) invalid.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits)`);
          if (!/^\d{7}$/.test(parts[2])) invalid.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
          if (!/^\d{1}$/.test(parts[3])) invalid.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
        }
        if (all0) remarks.push('Kindly confirm if the PT is a national resident.');
        else if (all1) remarks.push('Kindly confirm if the PT is a non-national resident.');
        else if (all2) { remarks.push('Kindly confirm if the PT is a non-national and non-resident.'); unknown = true; }
        else if (all9) { remarks.push('Kindly confirm if the PT has an unknown status.'); unknown = true; }
      }
      const member = person.getElementsByTagName('Member')[0];
      const memberID = member ? text('ID', member) : 'Unknown';
      if (!member || !memberID) invalid.push('Member.ID (null/empty)');
      checkForFalseValues(person, invalid);
      if (hadAmp) invalid.push(AMPERSAND_REPLACEMENT_ERROR);
      if (missing.length) remarks.push('Missing: ' + missing.join(', '));
      invalid.forEach(f => remarks.push(f));
      if (!remarks.length) remarks.push('OK');
      results.push({ ClaimID: memberID, Valid: !missing.length && !invalid.length, Unknown: unknown, Remark: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join('\n'), ClaimXML: person.outerHTML, SchemaType: 'person' });
    });
    return results;
  }

  function validateClaimSchema(xmlDoc, originalXmlContent = '', options = {}) {
    const results = [];
    const claims = xmlDoc.getElementsByTagName('Claim');
    const clinicianSpecialtyMap = options.clinicianSpecialtyMap instanceof Map ? options.clinicianSpecialtyMap : new Map();
    const pregnancyData = options.pregnancyDiagnosisData || null;

    // Duplicate Claim ID detection
    const idCounts = new Map();
    Array.from(claims).forEach(c => { const id = c.getElementsByTagName('ID')[0]?.textContent?.trim() || ''; if (id) idCounts.set(id, (idCounts.get(id)||0) + 1); });
    const dupIds = new Set(Array.from(idCounts.entries()).filter(([,cnt]) => cnt > 1).map(([id]) => id));

    // ReceiverID and cross‑claim merge
    const header = xmlDoc.querySelector('Header');
    const receiverID = header?.querySelector('ReceiverID')?.textContent?.trim() || '';
    const missingReceiverID = !receiverID;
    console.log(`[SCHEMA] ReceiverID: ${receiverID || '(MISSING)'}`);
    const notMergedRemarks = detectNotMergedRemarksByClaim(claims, receiverID);

    for (const claim of claims) {
      let missing = [], invalid = [], remarks = [], unknown = false;
      const present = (tag, parent=claim) => parent.getElementsByTagName(tag).length > 0;
      const text = (tag, parent=claim) => { const el = parent.getElementsByTagName(tag)[0]; return el?.textContent?.trim() || ''; };
      const invalidIfNull = (tag, parent=claim, prefix='') => { if (!text(tag, parent)) invalid.push(prefix + tag + ' (null/empty)'); };
      if (missingReceiverID) invalid.push('CRITICAL ERROR: ReceiverID is missing from XML Header. This file cannot be processed.');
      const claimID = text('ID');
      if (claimID && dupIds.has(claimID)) invalid.push(`Duplicate Claim ID '${claimID}' found within this submission.`);
      // No duplicate activity detection – removed
      let hadAmp = false;
      if (originalXmlContent && claimID) {
        const pos = originalXmlContent.indexOf(`<ID>${claimID}</ID>`);
        if (pos !== -1) {
          let start = originalXmlContent.lastIndexOf('<Claim>', pos);
          if (start === -1) start = originalXmlContent.lastIndexOf('<Claim ', pos);
          const end = originalXmlContent.indexOf('</Claim>', pos);
          if (start !== -1 && end !== -1) {
            const content = originalXmlContent.substring(start, end + '</Claim>'.length);
            hadAmp = /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/.test(content);
          }
        }
      }
      ['ID','MemberID','PayerID','ProviderID','EmiratesIDNumber','Gross','PatientShare','Net'].forEach(t => invalidIfNull(t, claim));
      const payerID = text('PayerID');
      const net = parseFloat(text('Net'));
      if (payerID === 'A02' && !isNaN(net) && net < 500) invalid.push('ADNIC (A02) claim is auto-rejected because total sponsor price is under 500.');
      const psRaw = text('PatientShare');
      if (psRaw) { const idx = psRaw.indexOf('.'); if (idx !== -1 && psRaw.length - idx - 1 > 2) invalid.push(`PatientShare has invalid precision: \`${psRaw}\`. Should be \`${parseFloat(psRaw).toFixed(2)}\`.`); }
      let hasMedTourEID = false, hasResidentEID = false, hasAll9EID = false;
      if (present('EmiratesIDNumber')) {
        const eid = text('EmiratesIDNumber'), parts = eid.split('-'), digits = eid.replace(/-/g,'');
        const all0 = /^0+$/.test(digits), all1 = /^1+$/.test(digits), all2 = /^2+$/.test(digits), all9 = /^9+$/.test(digits);
        const placeholder = all0 || all1 || all2 || all9;
        hasMedTourEID = all2; hasResidentEID = all0 || all1; hasAll9EID = all9;
        if (parts.length !== 4) invalid.push(`EmiratesIDNumber '${eid}' (must have 4 parts)`);
        else {
          if (!placeholder && parts[0] !== '784') invalid.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
          if (!/^\d{4}$/.test(parts[1])) invalid.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits)`);
          if (!/^\d{7}$/.test(parts[2])) invalid.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
          if (!/^\d{1}$/.test(parts[3])) invalid.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
        }
        if (all0) remarks.push('Kindly confirm if the PT is a national resident.');
        else if (all1) remarks.push('Kindly confirm if the PT is a non-national resident.');
        else if (all2) { remarks.push('Kindly confirm if the PT is a non-national and non-resident.'); unknown = true; }
        else if (all9) { remarks.push('Kindly confirm if the PT has an unknown status.'); unknown = true; }
      }
      const encounter = claim.getElementsByTagName('Encounter')[0];
      if (!encounter) missing.push('Encounter');
      else ['FacilityID','Type','PatientID','Start','End','StartType','EndType'].forEach(t => invalidIfNull(t, encounter, 'Encounter.'));
      const diagnoses = claim.getElementsByTagName('Diagnosis');
      if (!diagnoses.length) missing.push('Diagnosis');
      else {
        let principal = null, typeMap = {};
        Array.from(diagnoses).forEach((d,i) => {
          const type = text('Type', d), code = text('Code', d), prefix = `Diagnosis[${i}].`;
          if (!type) missing.push(prefix + 'Type');
          if (!code) missing.push(prefix + 'Code');
          if (type === 'Principal') { if (principal) invalid.push('Principal Diagnosis (multiple found)'); else principal = code; }
          else if (code) {
            if (!typeMap[type]) typeMap[type] = new Set();
            if (typeMap[type].has(code)) invalid.push(`Duplicate Diagnosis Code within Type '${type}': ${code}`);
            else typeMap[type].add(code);
            if (principal && code === principal) invalid.push(`Diagnosis Code ${code} duplicates Principal`);
          }
        });
        if (!principal) invalid.push('Principal Diagnosis (none found)');
      }
      checkPregnancyDiagnosisTrimesterConsistency(diagnoses, text, invalid, pregnancyData);

      const activities = claim.getElementsByTagName('Activity');
      const specialMedCodes = new Set(['17999','96999','0232T','J3490','81479','41899']);
      const invalidQtyErrors = new Map();
      if (!activities.length) invalid.push('Kindly verify activities as there are no codes showing in the XML for this claim.');
      else Array.from(activities).forEach((a,i) => {
        const prefix = `Activity[${i}].`, code = text('Code', a), qty = text('Quantity', a);
        ['Start','Type','Code','Quantity','Net','Clinician'].forEach(t => invalidIfNull(t, a, prefix));
        if (qty === '0') { if (!invalidQtyErrors.has(qty)) invalidQtyErrors.set(qty, []); invalidQtyErrors.get(qty).push(code || '(unknown)'); }
        Array.from(a.getElementsByTagName('Observation')).forEach((obs,j) => ['Type','Code'].forEach(t => invalidIfNull(t, obs, `${prefix}Observation[${j}].`)));
        if (code && specialMedCodes.has(code)) {
          Array.from(a.getElementsByTagName('Observation')).forEach(obs => {
            const ot = text('Type', obs), vt = text('ValueType', obs);
            if (ot && ot.toUpperCase() !== 'TEXT') invalid.push(`Activity ${code} has invalid Observation Type of \`${ot}\` but must be \`Text\`.`);
            if (vt && vt.toUpperCase() !== 'TEXT') invalid.push(`Activity ${code} has invalid Observation ValueType. Found \`${vt}\` but must be \`Text\`.`);
          });
        }
      });
      // EID vs Medical Tourism
      if (present('EmiratesIDNumber')) {
        let hasMedTourObs = false;
        outer: for (const act of activities) {
          for (const obs of act.getElementsByTagName('Observation')) {
            const desc = text('Description', obs) || '', code = text('Code', obs) || '', val = text('Value', obs) || '';
            if ((desc + code + val).toUpperCase().includes('MEDICALTOURISM')) { hasMedTourObs = true; break outer; }
          }
        }
        if (hasResidentEID && hasMedTourObs) invalid.push('EID indicates a resident patient (000/111); claim can only be Self-Pay. Kindly remove the Medical Tourism observation.');
        else if (hasMedTourEID && !hasMedTourObs) invalid.push('EID indicates a non-national non-resident (222); claim can only be Medical Tourism. Kindly add a Medical Tourism observation.');
        else if (!hasAll9EID && hasMedTourObs) invalid.push('Kindly clarify if patient is Medical Tourism as EID does not reflect this.');
      }
      invalidQtyErrors.forEach((codes, qty) => {
        if (codes.length === 1) invalid.push(`Activity ${codes[0]} has invalid quantity of ${qty}.`);
        else if (codes.length === 2) invalid.push(`Activities ${codes[0]} and ${codes[1]} have invalid quantities of ${qty}.`);
        else invalid.push(`Activities ${codes.slice(0,-1).join(' ')} and ${codes[codes.length-1]} have invalid quantities of ${qty}.`);
      });
      checkSpecialActivityDiagnosis(activities, diagnoses, text, invalid);
      checkImplantActivityDiagnosis(activities, diagnoses, text, invalid);
      const facilityID = encounter ? text('FacilityID', encounter) : '';
      checkGTLicenseValidation(activities, facilityID, text, invalid);
      const encType = encounter ? text('Type', encounter) : '';
      const claimMode = String(options.claimTypeMode || '').trim().toUpperCase();
      const isMed = claimMode ? claimMode === 'MEDICAL' : String(encType||'').trim() === '3';
      validateConsultationAndSpecialtyRules(activities, text, invalid, clinicianSpecialtyMap, { isMedicalClaim: isMed });
      validateMedicalOrderingConsistency(activities, text, invalid, { isMedicalClaim: isMed });
      const contract = claim.getElementsByTagName('Contract')[0];
      if (contract && !text('PackageName', contract)) invalid.push('Contract.PackageName (null/empty)');
      checkForFalseValues(claim, invalid, 'Claim.');
      if (hadAmp) invalid.push(AMPERSAND_REPLACEMENT_ERROR);
      if (claimID && notMergedRemarks.has(claimID)) notMergedRemarks.get(claimID).forEach(r => invalid.push(r));
      if (missing.length) remarks.push('Missing: ' + missing.join(', '));
      invalid.forEach(r => remarks.push(r));
      if (!remarks.length) remarks.push('OK');
      results.push({ ClaimID: text('ID') || 'Unknown', Valid: !missing.length && !invalid.length, Unknown: unknown, Remark: remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join('\n'), ClaimXML: claim.outerHTML, SchemaType: 'claim' });
    }
    return results;
  }

  // ----- Result rendering ------------------------------------------------------
  function renderResults(results, schemaType, options = {}) {
    const safe = Array.isArray(results) ? results.slice() : [];
    window._lastValidationResults = safe;
    window._lastValidationSchema = schemaType || 'claim';
    window._lastValidationFileName = options.fileName || '';
    const idLabel = schemaType === 'person' ? 'Member ID' : 'Claim ID';
    const table = document.createElement('table');
    table.className = 'table table-striped table-bordered';
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    table.dataset.schemaType = schemaType || 'claim';
    table.dataset.sourceFileName = options.fileName || '';
    let html = `<thead><tr><th style="padding:8px;border:1px solid #ccc">${idLabel}</th><th style="padding:8px;border:1px solid #ccc">Remark</th><th style="padding:8px;border:1px solid #ccc">Valid</th><th style="padding:8px;border:1px solid #ccc">View Full Entry</th></tr></thead><tbody>`;
    safe.forEach((row, idx) => {
      const cls = row.Unknown ? 'table-warning' : (row.Valid ? 'table-success' : 'table-danger');
      html += `<tr class="${cls}"><td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.ClaimID)}</td><td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.Remark)}</td><td style="padding:6px;border:1px solid #ccc">${row.Valid ? 'Yes' : 'No'}</td><td style="padding:6px;border:1px solid #ccc"><button class="view-claim-btn" data-index="${idx}" data-claim-xml="${encodeURIComponent(row.ClaimXML||'')}">View</button></td></tr>`;
    });
    html += '</tbody>';
    table.innerHTML = html;
    safe.forEach((row, idx) => {
      const btn = table.querySelector(`.view-claim-btn[data-index="${idx}"]`);
      if (btn) btn.onclick = () => showModal(claimToHtmlTable(row.ClaimXML));
    });
    return table;
  }

  // ----- Main entry point ------------------------------------------------------
  function validateXmlSchema(options = {}) {
    const container = options.container || null;
    const status = getScopedElement(container, '[data-role="schema-status"], #uploadStatus');
    if (status) status.textContent = '';
    const fileInput = getScopedElement(container, '[data-role="schema-xml-file"], #xmlFile');
    let file = options.file || fileInput?.files?.[0];
    if (!file && window.unifiedCheckerFiles?.xml) { file = window.unifiedCheckerFiles.xml; console.log('[SCHEMA] Using XML from unified cache:', file.name); }
    if (!file) {
      if (status) status.textContent = 'Please select an XML file first.';
      return buildSchemaMessageElement('Schema Checker failed: Please select an XML file first.');
    }
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = async function(e) {
        try {
          const original = e.target.result;
          const xml = original.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, 'and');
          const doc = new DOMParser().parseFromString(xml, 'application/xml');
          const errors = doc.getElementsByTagName('parsererror');
          if (errors.length) {
            console.log('[SCHEMA] XML parsing error detected');
            if (status) status.textContent = 'XML Parsing Error: The file is not well-formed.';
            resolve(buildSchemaMessageElement(`Schema Checker failed: XML Parsing Error: ${errors[0].textContent}`));
            return;
          }
          let results = [], schemaType = '';
          const root = doc.documentElement;
          if (root.nodeName === 'Claim.Submission') {
            schemaType = 'claim';
            console.log('[SCHEMA] Validating Claim schema');
            const [specMap, pregData] = await Promise.all([loadClinicianSpecialtyMap(), loadPregnancyDiagnosisData()]);
            const mode = String(options.claimTypeMode || getSelectedClaimTypeMode() || '').trim().toUpperCase();
            results = validateClaimSchema(doc, original, { clinicianSpecialtyMap: specMap, claimTypeMode: mode, pregnancyDiagnosisData: pregData });
            results = await applyTariffOccurrenceLimits(doc, results, { claimTypeMode: mode });
            console.log('[SCHEMA] Claim validation complete, results count:', results.length);
          } else if (root.nodeName === 'Person.Register') {
            schemaType = 'person';
            console.log('[SCHEMA] Validating Person schema');
            results = validatePersonSchema(doc, original);
            console.log('[SCHEMA] Person validation complete, results count:', results.length);
          } else {
            console.log('[SCHEMA] Unknown schema type:', root.nodeName);
            if (status) status.textContent = 'Unknown schema: ' + root.nodeName;
            resolve(buildSchemaMessageElement(`Schema Checker failed: Unknown schema: ${root.nodeName}`));
            return;
          }
          const tableEl = renderResults(results, schemaType, { fileName: file.name || '' });
          const total = results.length, valid = results.filter(r => r.Valid).length;
          const pct = total ? ((valid/total)*100).toFixed(1) : '0.0';
          if (status) status.textContent = `Valid ${schemaType === 'claim' ? 'claims' : 'persons'}: ${valid} / ${total} (${pct}%)`;
          resolve(tableEl);
        } catch (err) {
          console.error('[SCHEMA] Error during validation:', err);
          if (status) status.textContent = 'Error: ' + err.message;
          resolve(buildSchemaMessageElement(`Schema Checker failed: ${err.message}`));
        }
      };
      reader.onerror = function() {
        console.error('[SCHEMA] FileReader error');
        if (status) status.textContent = 'Error reading the file.';
        resolve(buildSchemaMessageElement('Schema Checker failed: Error reading the file.'));
      };
      reader.readAsText(file);
    });
  }

  // ----- Public API ------------------------------------------------------------
  window.validateXmlSchema = validateXmlSchema;
  window.showModal = showModal;
  window.hideModal = hideModal;
  window.claimToHtmlTable = claimToHtmlTable;
  window.ensureModal = ensureModal;
  window.exportErrorsToXLSX = exportErrorsToXLSX;
  window.NOT_MERGED_RECEIVER_IDS = Array.from(NOT_MERGED_RECEIVER_IDS);
  window._schemaNotMergedUtils = { CLAIM_NOT_MERGED, parseEncounterDateTime, buildNotMergedRemarksFromContexts };
  window._schemaTestApi = {
    validateXmlSchema,
    renderResults,
    validateMedicalOrderingConsistency,
    validateConsultationAndSpecialtyRules,
    applyTariffOccurrenceLimits,
    loadPregnancyDiagnosisData,
    checkPregnancyDiagnosisTrimesterConsistency,
    normalizeDiagnosisCode
  };

} catch (e) {
  console.error('[CHECKER-ERROR] Failed to load checker:', e);
  console.error(e.stack);
}
})();
