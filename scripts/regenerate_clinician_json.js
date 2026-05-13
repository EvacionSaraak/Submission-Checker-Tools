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
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  console.log('Sheet name:', sheetName);
  
  // Convert to JSON
  const data = XLSX.utils.sheet_to_json(worksheet);
  
  console.log(`Found ${data.length} records`);
  console.log('Columns:', Object.keys(data[0] || {}));
  
  // Write JSON file
  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(data, null, 2));
  
  console.log(`✓ Successfully generated ${JSON_OUTPUT_PATH}`);
  console.log(`✓ Exported ${data.length} clinician records`);
  
  // Show sample of first record
  if (data.length > 0) {
    console.log('\nSample record:');
    console.log(JSON.stringify(data[0], null, 2));
  }
  
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
