#!/usr/bin/env node
/**
 * Sync facility clinician licenses from resources/ClinicianLicenses.xlsx.
 *
 * Only clinicians affiliated to a facility in json/facilities.json are considered.
 * This is deliberately additive: it preserves all existing clinician rows,
 * secondments, manually approved affiliations, and locally curated specialties.
 * Duplicates in the workbook are resolved using the latest effective dates.
 *
 * Run: npm install --no-save --no-package-lock xlsx@0.18.5
 *      node scripts/regenerate_clinician_json.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'resources', 'ClinicianLicenses.xlsx');
const TARGET = path.join(ROOT, 'json', 'clinician_licenses.json');
const FACILITIES = path.join(ROOT, 'json', 'facilities.json');

const upper = value => String(value == null ? '' : value).trim().toUpperCase();
const asText = value => String(value == null ? '' : value).trim();
const normalizeHeader = value => upper(value).replace(/[^A-Z0-9]/g, '');
const fieldAliases = {
  license: ['CLINICIANLICENSE', 'PHYLIC', 'PHYSICIANLICENSE', 'LICENSE'],
  name: ['CLINICIANNAME', 'PHYSICIANNAME', 'NAME'],
  category: ['CATEGORY', 'SPECIALTY', 'SPECIALITY'],
  profession: ['PROFESSION'],
  facility: ['FACILITYLICENSE', 'FACILITY', 'FACILITYID'],
  facilityName: ['FACILITYNAME'],
  status: ['STATUS', 'LICENSESTATUS'],
  from: ['FROM', 'STARTDATE', 'VALIDFROM', 'EFFECTIVEFROM'],
  to: ['TO', 'ENDDATE', 'VALIDTO', 'EXPIRYDATE', 'EXPIRATIONDATE']
};

function findHeader(matrix) {
  for (let index = 0; index < Math.min(matrix.length, 35); index++) {
    const labels = (matrix[index] || []).map(normalizeHeader);
    const column = {};
    for (const [field, aliases] of Object.entries(fieldAliases)) {
      column[field] = labels.findIndex(label => aliases.includes(label));
    }
    if (column.license >= 0 && column.facility >= 0 && column.name >= 0) {
      return { headerRow: index, column };
    }
  }
  return null;
}

function cell(row, columnIndex) {
  return columnIndex >= 0 ? row[columnIndex] : '';
}

function sortableDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime() / 86400000 + 25569;
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed / 86400000 + 25569 : 0;
}

function isLater(candidate, existing) {
  return (
    sortableDate(candidate.From) > sortableDate(existing.From) ||
    (sortableDate(candidate.From) === sortableDate(existing.From) &&
      sortableDate(candidate.To) > sortableDate(existing.To))
  );
}

function keyFor(record) {
  return upper(record['Phy Lic']) + '|' + upper(record.Facility);
}

function sync() {
  const facilityData = JSON.parse(fs.readFileSync(FACILITIES, 'utf8'));
  const allowedFacilities = new Set(
    (facilityData.facilities || []).map(row => upper(row.license)).filter(Boolean)
  );
  if (!allowedFacilities.size) throw new Error('No configured facilities; refusing to rewrite clinician JSON.');

  const existing = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  if (!Array.isArray(existing)) throw new Error('Existing clinician JSON must be an array.');
  const existingKeys = new Set(existing.map(keyFor));

  const workbook = XLSX.readFile(SOURCE, { cellDates: false, dense: true });
  const workbookRecords = new Map();
  let matchedSheets = 0;
  let relevantRows = 0;
  let skippedMissingData = 0;

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, raw: true, defval: '', blankrows: false
    });
    const header = findHeader(rows);
    if (!header) {
      console.log('Skipping sheet without clinician/facility headers:', sheetName);
      continue;
    }
    matchedSheets++;
    const c = header.column;
    console.log('Parsing sheet:', sheetName, 'header row:', header.headerRow + 1, 'rows:', rows.length);
    for (const row of rows.slice(header.headerRow + 1)) {
      const license = upper(cell(row, c.license));
      const facility = upper(cell(row, c.facility));
      if (!allowedFacilities.has(facility)) continue;
      const name = asText(cell(row, c.name));
      if (!license || !name) {
        skippedMissingData++;
        continue;
      }

      relevantRows++;
      const record = {
        'Phy Lic': license,
        'Clinician Name': name,
        'Specialty': asText(cell(row, c.category)) || asText(cell(row, c.profession)),
        'Facility': facility,
        'Facility Name': asText(cell(row, c.facilityName)),
        'Status': asText(cell(row, c.status)),
        'From': cell(row, c.from) || '',
        'To': cell(row, c.to) || ''
      };
      const key = keyFor(record);
      const previous = workbookRecords.get(key);
      if (!previous || isLater(record, previous)) workbookRecords.set(key, record);
    }
  }

  if (!matchedSheets) {
    throw new Error('Could not find Clinician License, Clinician Name and Facility License headers in workbook.');
  }

  const additions = [];
  const byFacility = {};
  let skippedInactive = 0;
  for (const [key, record] of workbookRecords) {
    if (existingKeys.has(key)) continue;
    const status = upper(record.Status);
    if (status && status !== 'ACTIVE') {
      skippedInactive++;
      continue;
    }
    additions.push(record);
    byFacility[record.Facility] = (byFacility[record.Facility] || 0) + 1;
    existingKeys.add(key);
  }
  additions.sort((a, b) => a.Facility.localeCompare(b.Facility) || a['Phy Lic'].localeCompare(b['Phy Lic']));

  const updated = [...existing, ...additions];
  const output = JSON.stringify(updated, null, 2) + '\n';
  console.log(JSON.stringify({
    configuredFacilities: allowedFacilities.size,
    matchedSheets, relevantRows, distinctClinicianFacilities: workbookRecords.size,
    previouslyListed: existing.length, additions: additions.length,
    skippedInactive, skippedMissingData, byFacility,
    afterUpdate: updated.length,
    preservedApprovedAffiliations: existing.filter(row => row['Internal Affiliation Approved'] === true).length
  }, null, 2));
  if (!additions.length) {
    console.log('No missing active clinician-facility pairs; JSON unchanged.');
    return;
  }

  fs.writeFileSync(TARGET, output);
  console.log('Updated', TARGET);
}

sync();
