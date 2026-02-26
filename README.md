# Submission Checker Tools

---

## 🦷 Healthcare XML Validation Tool Suite

A comprehensive collection of browser-based JavaScript tools to format, validate, audit, and analyze healthcare XML claim data for compliance, consistency, and domain-specific logic. No installation is required—everything runs directly in your browser.

**Live Site:** [https://evacionsaraak.github.io/Submission-Checker-Tools/](https://evacionsaraak.github.io/Submission-Checker-Tools/)

---

## 🧭 Navigation

The site has four top-level tabs in the navigation bar:

| Tab | Description |
|-----|-------------|
| **Formatting** | Combine and standardize eligibility, reporting, and XML files; format audit logs |
| **Checkers** | Unified interface to run all claim validation tools from one page |
| **Drug Quantities** | Validate drug quantities and check individual drug codes |
| **Modifiers** | Validate CPT modifier observations against eligibility data |

The browser remembers which tab you last had open and restores it on the next visit.

---

## 📋 Formatting Tab

The **Formatting** tab (`checker_formatter`) provides four modes for preparing and combining input files before running checks.

### Mode: Eligibility
- Upload one or more eligibility **XLSX** files.
- Combines them into a single, standardized output table with consistent columns.
- Supports multiple source formats (ClinicPro V1/V2, InstaHMS, Odoo) and normalizes them automatically.
- Download the merged result as an Excel file.

### Mode: Reporting
- Upload one or more reporting **XLS, XLSX, or CSV** files.
- Merges reporting exports from different HMS systems into a unified table.
- Normalizes column headers across ClinicPro, InstaHMS, Odoo, and similar formats.
- Download the combined result as an Excel file.

### Mode: XML
- Upload one or more **XML** claim files.
- Merges multiple XML submissions into a single combined XML file.
- Download the combined XML for use in other tools.

### Mode: Errors (Audit Log Formatter)
- Paste raw audit log text into the input box and click **Format**.
- Realigns encounter IDs into correct columns: Type | Date | Payer | Claim ID | Visit ID | Description.
- Type defaults to "Dental" if not specified; only rows with valid claim IDs are included.
- Copy formatted output or unmatched lines to clipboard.

---

## ✅ Checkers Tab (Unified Interface)

The **Checkers** tab (`unified_checker`) provides a single page where you upload your files once and run any of the available validators with a single click.

### Shared Features
- **Centralized File Management** – Upload XML, eligibility, pricing, and other files once; they are shared across all checkers automatically.
- **Smart Button Controls** – Each checker button is enabled only when its required files are available.
- **Filter Invalid Rows** – A checkbox option filters results to show only rows with errors.
- **Export Results** – Download validation results as Excel files.
- **Check All** – Sequentially runs all available checkers and combines results.

### Included Checkers

#### 1. Authorization Validator (`checker_auths`)
Validates authorization details in claims against uploaded insurer data.
- Ensures valid Emirates ID, PayerID, ReceiverID, and PackageName.
- Verifies activity codes and insurer-specific requirements from Excel/JSON.
- Checks for presence and compatibility of Ordering and Performing clinicians.
- Flags missing, mismatched, or differing authorization categories.
- Renders detailed tables with expandable modals; export invalid entries as Excel.

#### 2. Clinician License & Privilege Validator (`checker_clinician`)
Validates clinician assignments and license privileges for each claim activity.
- Checks that both `Clinician` and `OrderingClinician` are present.
- Compares categories from Shafafiya license and Open Jet Excel exports.
- Verifies privilege compatibility for the assigned activity code.
- Validates license status at affiliated facilities for encounter dates.
- Grouping, summary view, modals for full license history, and CSV export.

#### 3. Drug Code Lookup & Claim Analysis (`checker_drugs`)
Looks up drug codes and validates formulary eligibility (THIQA/DAMAN) within claims.
- **Lookup Mode** – Search for any drug by code or name; view price, inclusion status, and package details.
- **Analysis Mode** – Parses XML claims, matches activity codes to the drug master list, and checks formulary restrictions.
- Highlights invalid or ineligible drugs per claim; export invalid activities as Excel.
- Interactive claim and activity modals with summary tables.

#### 4. Eligibility Data Validator (`checker_elig`)
Cross-validates XML claims against eligibility Excel exports and insurance license lists.
- Loads insurance licenses and matches payer IDs and plan names.
- Validates member IDs, payer info, eligibility status, and clinician matches.
- Detailed eligibility data shown in expandable modals.
- Matching summary tables with precise error remarks.

#### 5. XML Schema Validator (`checker_schema`)
Validates the overall XML structure for `Claim.Submission` and `Person.Register` schemas.
- Checks presence and correctness of all required fields.
- Flags format errors, missing/duplicate diagnosis codes.
- Detects medical tourism and national-without-EID scenarios.
- Results displayed in tables with per-entry modals; supports XLSX export.

#### 6. Dental Code & Tooth Number Validator (`checker_tooths`)
Validates dental procedure codes for correct tooth and region assignments.
- Cross-references activity codes with metadata for tooth, sextant, or quadrant requirements.
- Detects region duplication and inappropriate observation codes.
- Provides anatomical context (anterior, bicuspid, posterior) per tooth.
- Color-coded compliance report; export invalid entries as Excel.

#### 7. Dental Pricing Checker (`checker_pricing`)
Compares claimed prices against the THIQA Dental Pricing reference list.
- Upload an XML claim file; a pricing XLSX is optional (defaults to built-in THIQA Dental Pricing resource).
- Extracts claim line items, compares against the reference price per CPT code.
- Applies facility-specific pricing and special rules (e.g., endodontic pricing by specialty, code 42702 handling).
- Marks each activity as **Valid** or **Invalid** with a remarks column.
- Progress bar during processing; download results as Excel.

#### 8. Timing Validity Checker (`checker_timings`)
Validates timing-related elements in XML claim submissions.
- Supports both **Dental** and **Medical** claim types.
- Checks that service dates, encounter times, and activity durations follow the required logic and ordering rules.
- Displays a summary (valid/total count and percentage).
- Export invalid timing entries as Excel.

---

## 💊 Drug Quantities Tab

The **Drug Quantities** tab (`checker_drugquantities`) validates drug quantity claims and supports single-code lookups.

### Single Code Lookup
- Enter any drug code into the lookup box (requires the Drugs XLSX to be uploaded first).
- Returns package name, package size, unit price, package price, and markup values for the code.

### Bulk XML Analysis
- Upload a **Claim Submissions XML** file and a **Drugs List XLSX** (must contain a sheet named `Drugs`).
- Matches activity codes in the claims against drug codes in the spreadsheet.
- Calculates expected quantities, checks types, and flags discrepancies.
- Results are color-coded by validity; invalid entries can be exported as Excel.

---

## 🔧 Modifiers Tab

The **Modifiers** tab (`checker_modifiers`) validates CPT modifier observations in claim XML against eligibility data.

- Looks for `<Observation>` entries where `<Code>` is `CPT modifier` and `<Value>` is `24` or `52`.
- Matches each record by Member (Card Number), Ordered On (date), and Clinician to the eligibility spreadsheet.
- Validates that the observation code is exactly `CPT modifier`.
- Validates VOI (Verification of Insurance) number against modifier type: Modifier `52` expects `VOI_EF1`; Modifier `24` expects `VOI_D`.
- Only displays claims from THIQA/DAMAN with CPT modifiers.
- Completion summary shows percentage of correct rows; download results as Excel.

---

## 🛠 General Usage

All tools are browser-based—no installation, server, or login required.

1. Open the [live site](https://evacionsaraak.github.io/Submission-Checker-Tools/) or run locally by opening `index.html`.
2. Click the relevant tab in the navigation bar.
3. Upload your files (XML, XLSX, CSV) as prompted.
4. Click **Process**, **Run Check**, **Combine**, or **Format** to execute.
5. Review results in the output table; use modals for per-row detail where available.
6. Export invalid or combined results using the **Download** / **Export** button.

> For best results, ensure input files match expected formats (e.g., XML element names, required sheet names like `Drugs` in the Drugs XLSX).

---

## 📁 File Reference

| File | Description |
|------|-------------|
| `js/checker_formatter.js` + `checker_formatter_worker.js` | File combining and audit log formatting |
| `js/unified_checker.js` | Unified checker interface and shared file management |
| `js/checker_auths.js` | Authorization validations |
| `js/checker_clinician.js` | Clinician license/privilege validations |
| `js/checker_drugs.js` | Drug list lookup and XML match analysis |
| `js/checker_elig.js` | Eligibility cross-validation with Excel and insurance licenses |
| `js/checker_schema.js` | XML schema and structure validation |
| `js/checker_tooths.js` | Dental code and tooth-region validation |
| `js/checker_pricing.js` | Dental pricing comparison against THIQA reference list |
| `js/checker_timings.js` | Timing/date validity checks for claim submissions |
| `js/checker_drugquantities.js` | Drug quantity validation and single-code lookup |
| `js/checker_modifiers.js` | CPT modifier observation validation |
| `js/common_table_renderer.js` | Shared table rendering utilities |
| `js/file_cache.js` | Shared file cache for unified checker |
| `js/table_clipboard.js` | Table clipboard copy support |

---

## 🙋 Support

For issues, questions, or feature requests, please use the [repository issue tracker](https://github.com/EvacionSaraak/Submission-Checker-Tools/issues).
