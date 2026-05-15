#!/usr/bin/env node
/**
 * Script to regenerate clinician_licenses.json from ClinicianLicenses.xlsx
 * This ensures the JSON includes the Facility column from the Excel file.
 * 
 * Usage: node scripts/regenerate_clinician_json.js
 */

const fs = require('fs');
const path = require('path');

// Note: This script requires the xlsx package to be installed
// Run: npm install xlsx
let XLSX;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.error('Error: xlsx package not found. Please run: npm install xlsx');
  process.exit(1);
}

const EXCEL_PATH = path.join(__dirname, '../resources/ClinicianLicenses.xlsx');
const JSON_OUTPUT_PATH = path.join(__dirname, '../json/clinician_licenses.json');

console.log('Reading Excel file:', EXCEL_PATH);

try {
  // Read the Excel file
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheetName = workbook.SheetNames[0]; // "Clinician Data"
  const worksheet = workbook.Sheets[sheetName];
  
  console.log('Sheet name:', sheetName);
  
  // The Excel file has:
  // - Rows 0-1: Merged metadata cells
  // - Row 2: Headers (but shows as data due to merged cells above)
  // - Row 3+: Actual data
  
  // Read raw data starting from row 2
  const rawData = XLSX.utils.sheet_to_json(worksheet, { 
    range: 2,
    defval: ''
  });
  
  console.log(`Found ${rawData.length} raw records`);
  
  // First row contains the header names as values (due to merged cells)
  const headerRow = rawData[0];
  const headers = {};
  Object.keys(headerRow).forEach(key => {
    headers[key] = String(headerRow[key]).trim();
  });
  
  console.log('Header mapping:', headers);
  
  // Process data rows (skip first row which was headers)
  const cleanedData = rawData
    .slice(1) // Skip the header row
    .filter(row => {
      // Find the "Clinician License" column
      const licenseKey = Object.keys(headers).find(k => headers[k] === 'Clinician License');
      return row[licenseKey] && String(row[licenseKey]).trim();
    })
    .map(row => {
      // Map columns based on header mapping
      const getLicenseKey = Object.keys(headers).find(k => headers[k] === 'Clinician License');
      const getNameKey = Object.keys(headers).find(k => headers[k] === 'Clinician Name');
      const getCategoryKey = Object.keys(headers).find(k => headers[k] === 'Category');
      const getProfessionKey = Object.keys(headers).find(k => headers[k] === 'Profession');
      const getFacilityKey = Object.keys(headers).find(k => headers[k] === 'Facility License');
      const getFacilityNameKey = Object.keys(headers).find(k => headers[k] === 'Facility Name');
      const getStatusKey = Object.keys(headers).find(k => headers[k] === 'Status');
      const getFromKey = Object.keys(headers).find(k => headers[k] === 'From');
      const getToKey = Object.keys(headers).find(k => headers[k] === 'To');
      
      return {
        'Phy Lic': String(row[getLicenseKey] || '').trim(),
        'Clinician Name': String(row[getNameKey] || '').trim(),
        'Specialty': String(row[getCategoryKey] || row[getProfessionKey] || '').trim(),
        'Facility': String(row[getFacilityKey] || '').trim(),
        'Facility Name': String(row[getFacilityNameKey] || '').trim(),
        'Status': String(row[getStatusKey] || '').trim(),
        'From': row[getFromKey] || '',
        'To': row[getToKey] || ''
      };
    });
  
  console.log(`Found ${cleanedData.length} valid clinician records`);
  
  // Write JSON file
  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(cleanedData, null, 2));
  
  console.log(`✓ Successfully generated ${JSON_OUTPUT_PATH}`);
  console.log(`✓ Exported ${cleanedData.length} clinician records`);
  
  // Show sample of first records
  if (cleanedData.length > 0) {
    console.log('\nSample records:');
    cleanedData.slice(0, 3).forEach((record, idx) => {
      console.log(`\nRecord ${idx + 1}:`, JSON.stringify(record, null, 2));
    });
  }
  
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
