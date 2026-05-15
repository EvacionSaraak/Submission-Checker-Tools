# Scripts Directory

This directory contains utility scripts for maintaining the Submission Checker Tools.

## regenerate_clinician_json.js

Regenerates `json/clinician_licenses.json` from `resources/ClinicianLicenses.xlsx`.

**Purpose:** Ensures the JSON file includes all columns from the Excel file, particularly the Facility column which is required for proper clinician facility validation.

**Prerequisites:**
```bash
npm install xlsx
```

**Usage:**
```bash
node scripts/regenerate_clinician_json.js
```

**When to run:**
- After updating the ClinicianLicenses.xlsx file
- When the Excel file structure changes
- When the JSON file is missing or outdated

**Important:** The clinician checker now uses the Facility information from ClinicianLicenses (not from Clinician Licensing History) to validate facility affiliation. Ensure the Excel file has a Facility column before regenerating.
