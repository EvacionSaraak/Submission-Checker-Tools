# Submission Checker Tools

---

## 🦷 Healthcare XML Validation Tool Suite

A comprehensive collection of JavaScript tools to validate, audit, and analyze healthcare XML claim data for compliance, consistency, and domain-specific logic. Each tool is browser-based and designed for non-technical users.

**Live Demo:** [https://evacionsaraak.github.io/Submission-Checker-Tools/](https://evacionsaraak.github.io/Submission-Checker-Tools/)

---

## 🚦 Tool Overview

### 1. `checker_auths.js` – Authorization Validator

**Purpose:**  
Validates authorization details in claims against uploaded insurer data.

**Features:**
- Ensures valid Emirates ID, PayerID, ReceiverID, and PackageName.
- Verifies activity codes and insurer-specific requirements from Excel/JSON.
- Checks for presence and compatibility of Ordering and Performing clinicians.
- Flags missing, mismatched, or differing categories.
- Renders detailed tables with modals and allows export of invalid entries.

---

### 2. `checker_clinician.js` – Clinician License & Privilege Validator

**Purpose:**  
Validates clinician assignments and license privileges for each claim activity.

**Features:**
- Checks both `Clinician` and `OrderingClinician` are present.
- Compares categories from Shafafiya license and Open Jet Excel exports.
- Verifies privilege compatibility for assigned activity.
- Validates the license status at affiliated facilities for encounter dates.
- Provides grouping, summary, modals for full license history, and CSV export.

---

### 3. `checker_drugs.js` – Drug Code List Lookup & Claim Drug Analysis

**Purpose:**  
Lookup and analyze drug codes, packages, and formulary inclusion (THIQA/DAMAN) within claims.

**Features:**
- **Lookup Mode:** Search and inspect drug details by code or name, including prices, inclusion, and status.
- **Analysis Mode:** Parse XML claims, match activities to drug master list, and check against formulary restrictions.
- Highlights invalid/ineligible drugs per claim and allows export of invalid activities.
- Interactive claim and activity modals, and summary tables.

---

### 4. `checker_elig.js` – Eligibility Data Validator

**Purpose:**  
Cross-validates XML claims against eligibility Excel exports and insurance license lists.

**Features:**
- Loads insurance licenses and matches payer IDs and plan names.
- Validates member IDs, payer info, status, and clinician matches.
- Shows detailed eligibility data in modals.
- Renders matching summary tables and remarks, with precise error reporting.

---

### 5. `checker_schema.js` – XML Schema Validator

**Purpose:**  
Validates overall XML structure for both `Claim.Submission` and `Person.Register` schemas.

**Features:**
- Checks presence and correctness of required fields.
- Flags format errors, missing/duplicate diagnosis codes, and detects medical tourism/national-without-EID scenarios.
- Renders results in tables with per-entry modals.
- Supports XLSX export of validation results.

---

### 6. `checker_tooths.js` – Dental Code and Tooth Number Validator

**Purpose:**  
Validates dental procedure codes in claims for correct tooth/region assignments.

**Features:**
- Cross-references activities with metadata for tooth, sextant, or quadrant requirements.
- Detects mismatches, region duplication, and inappropriate observation codes.
- Provides region and tooth context (anterior, bicuspid, posterior).
- Renders categorized, color-coded compliance reports and allows export of invalid entries.

---

## 🛠 Usage

Each tool is standalone and browser-based—no installation required.

1. **Open the corresponding HTML interface** (see the live demo or run locally).
2. **Upload your XML claims file** (and Excel/JSON where requested).
3. **Click "Process" or "Analyze"** to run validations.
4. **Review results in summary tables**; click "View" for details.
5. **Export invalid entries** as Excel for further review or correction.

> For best results, ensure your input files match the expected naming (e.g., XML tags, required Excel sheets).

---

## 📁 File Reference (Included Tools)

- `checkers/checker_auths.js` – Authorization validations
- `checkers/checker_clinician.js` – Clinician license/privilege validations
- `checkers/checker_drugs.js` – Drug list lookup and XML match analysis
- `checkers/checker_elig.js` – Eligibility cross-validation with Excel and insurance licenses
- `checkers/checker_schema.js` – XML schema and structure validation
- `checkers/checker_tooths.js` – Dental code and tooth-region/tooth validation

---

## 🙋 Support

For issues, questions, or feature requests, please use the repository issue tracker.
