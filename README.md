# Submission Checker Tools

A browser-based healthcare claims validation, formatting, allocation, and audit toolkit focused on UAE claim workflows.

The project runs primarily in the browser and combines several independent tools behind one navigation page. It can normalize reporting and eligibility exports, combine XML files, validate healthcare claim submissions, check pricing and clinician data, validate drug and modifier rules, and allocate claim workloads across coders.

Live site:
https://evacionsaraak.github.io/Submission-Checker-Tools/


## Navigation

The site currently has five top-level tabs:

| Tab | Purpose |
| --- | --- |
| Formatting | Combine and normalize eligibility, reporting, full reporting, and XML files; format audit logs |
| Checkers | Unified claim-validation interface for XML and supporting files |
| Drug Quantities | Validate drug quantities and perform individual drug-code lookups |
| Modifiers | Standalone CPT modifier validation against eligibility data |
| Allocator | Deduplicate All Claims reports, filter eligible claims, balance them across coders, preview the allocation, and export facility workbooks |

The main navigation remembers the last tab opened and restores it on the next visit.


# Formatting

The Formatting page (`html/checker_formatter.html`) is used to prepare source files before validation or allocation.

## Eligibility

Accepts one or more XLSX eligibility exports and combines them into one standardized workbook.

The formatter recognizes supported source layouts and normalizes their fields into a consistent output structure so the result can be used by the eligibility and modifier checks.

Supported reporting ecosystems include the layouts used by systems such as ClinicPro, InstaHMS, and Odoo.

## Reporting

Accepts multiple XLS, XLSX, or CSV reporting files.

The standard Reporting mode:

- normalizes supported source layouts into a common reporting structure;
- detects the relevant source format from the uploaded report;
- combines reports into one result;
- deduplicates claims according to the reporting-combiner rules;
- excludes rows whose Codification Status is `Not Seen`;
- for multi-row activity-style reports, sums `Total Amount` across rows sharing the same Claim ID before emitting the deduplicated claim row;
- uses the repository clinician-license resource where clinician enrichment is required.

The result can be downloaded as an Excel workbook.

## Reporting (full)

Reporting (full) is intended for cases where the original rows need to be retained rather than collapsed into the normalized one-row-per-claim reporting output.

It:

- accepts XLS, XLSX, and CSV reports;
- reads the first sheet from each workbook;
- ignores rows that participate in merged spreadsheet ranges;
- uses the first non-empty, non-merged row as the header;
- appends the remaining non-empty, non-merged rows;
- preserves raw Excel numeric date serials instead of converting them to formatted date strings.

This is useful when downstream work requires the source-level rows and their original Excel date values.

## XML

Accepts multiple claim XML files and combines them into a single XML submission.

The combined output updates the relevant record structure/counts so that the resulting XML can be passed into the checker suite or another submission workflow.

## Errors / Audit Log Formatter

Accepts pasted audit-log text and restructures matching lines into:

`Type | Date | Payer | Claim ID | Visit ID | Description`

Behavior includes:

- `Dental` as the fallback Type when none is provided;
- Claim ID and Visit ID detection based on their identifier type rather than relying only on their position in the input;
- unmatched input preserved separately;
- DEBT sections excluded from normal audit-row parsing and retained with unmatched text;
- formatted and unmatched output can be copied independently;
- multiline remarks are normalized when copied so a single logical remark does not become several clipboard rows.


# Unified Checkers

The Checkers page (`html/unified_checker.html`) provides one interface for the validation tools.

Supporting files are uploaded once and then shared with the relevant checker modules. The unified controller manages XML, clinician, eligibility, authorization, status, and optional pricing inputs.

## Shared behavior

The unified checker provides:

- Dental / Medical claim-type selection;
- checker buttons that are enabled only when their required inputs are available;
- centralized uploaded-file handling;
- XML text caching so repeated checks do not repeatedly reread the same uploaded XML file;
- Valid / Unknown / Invalid visibility controls;
- individual checker execution;
- Check All execution;
- result export;
- invalid-result export;
- multi-checker invalid export with a separate worksheet per checker;
- Claim ID propagation in exported tables where visually grouped rows omit repeated Claim IDs;
- clear/reset controls;
- debug logging for the combined workflow.

Some validators are mode-specific. For example, the ICD-10-CM Exclusion Checker and unified Modifier Checker are Medical-only in the current unified interface.


## 1. Authorization Validator

Files:
- `js/checker_auths.js`
- `json/checker_auths.json`

Validates authorization-related claim information against the configured insurer/reference data.

Checks include, depending on the claim and configured rules:

- Emirates ID;
- PayerID / ReceiverID;
- PackageName;
- activity codes;
- insurer-specific authorization requirements;
- Ordering Clinician and performing Clinician information;
- authorization category compatibility.

Results identify invalid or mismatched authorization information and can be exported.


## 2. Clinician License & Privilege Validator

Files/resources include:
- `js/checker_clinician.js`
- `json/clinician_licenses.json`
- `json/facilities.json`

Validates clinician assignments, licensing, facility affiliation, status, and privileges.

The checker can evaluate:

- presence of Clinician and OrderingClinician;
- clinician license/category information;
- activity privilege compatibility;
- active license status;
- facility affiliation;
- whether the affiliation is valid for the encounter date;
- license history/details used to explain a result.

The repository clinician-license snapshot contains recognized-facility clinician records used by downstream checks.


## 3. Drug Code Lookup & Claim Analysis

Files:
- `js/checker_drugs.js`

Supports both direct drug lookup and XML claim analysis.

Lookup mode can search the uploaded drug master list and display fields such as:

- drug code;
- package name;
- dosage form;
- package size;
- public/unit price;
- status;
- THIQA inclusion;
- Basic inclusion;
- applicable dates/metadata when present in the source.

XML Analysis mode extracts drug/activity codes from claims and evaluates them against the loaded drug list, including THIQA / Basic coverage information and price information.


## 4. Eligibility Data Validator

Files/resources include:
- `js/checker_elig.js`
- `json/insurance_licenses.json`

Cross-validates XML claim data against uploaded eligibility reports and configured insurance-license information.

Checks include:

- member identifiers;
- payer information;
- eligibility status;
- insurance/package information;
- relevant dates;
- clinician matches;
- service/category compatibility;
- payer/license matching.

The checker provides detailed matching information and explicit error remarks.


## 5. XML Schema Validator

File:
- `js/checker_schema.js`

Validates claim XML structure and claim-level business rules for supported claim/person schemas.

Core checks include required-field presence, format validation, diagnosis rules, and other structural checks.

Examples of current schema/business logic include:

- exactly one Principal diagnosis where required;
- duplicate diagnosis detection;
- invalid placeholder/format scenarios;
- detection of special Emirates ID placeholder categories;
- Medical Tourism consistency checks for resident/non-resident placeholder cases;
- configured cross-claim likely-not-merged detection (`CLAIM_NOT_MERGED`).

### Likely-not-merged detection

The schema checker can compare claims in the configured payer scope and flag separate Claim IDs that appear likely to belong to the same encounter.

The comparison uses a grouping context including payer, member, provider, facility, and encounter date, then looks for conditions such as:

- different Claim IDs;
- overlapping encounter windows;
- shared Ordering Clinician / clinician context;
- shared diagnosis.

This is additive: it does not replace the ordinary schema checks.


## 6. ICD-10-CM Exclusion Checker

Files:
- `js/checker_exclusions.js`
- `js/dx_rules.js`
- `json/icd10cm_exclusions_2026.json`

Checks claim-local ICD-10-CM Excludes1 conflicts.

It evaluates direct claim Diagnosis elements for supported diagnosis types such as:

- Principal;
- Secondary;
- ReasonForVisit.

The rule engine supports:

- exact codes;
- category-level matching;
- prefix patterns;
- category ranges.

Comparison is normalized for matching while preserving useful display text.

Symmetric/reverse duplicate diagnosis-pair findings are deduplicated per claim.

Important limitation: the current `icd10cm_exclusions_2026.json` is a seed ruleset and is not a complete ICD-10-CM Excludes1 database.


## 7. Observation / Tooth / Region Checker

Files/resources include:
- `js/checker_observations.js`
- `js/checker_tooths.js`
- `json/checker_tooths.json`

Validates activity types and required observations, especially for dental procedures.

Depending on mode/code, it checks areas such as:

- dental activity Type requirements;
- medical activity Type requirements;
- tooth observations;
- anterior / bicuspid / posterior compatibility;
- sextant and quadrant observations;
- duplicate region/tooth assignments;
- inappropriate observation codes;
- special medical-code handling;
- root-canal/subcode logic.

For applicable root-canal procedures after the configured cutoff, clinician/endodontist information and required Subcode observations can be validated using the clinician-license resource.


## 8. Pricing Checker

Files/resources include:
- `js/checker_pricing.js`
- `json/dental_pricing.json`
- `json/endo_pricing.json`
- `json/medical_pricing.json`
- `resources/THIQA DENTAL PRICING.xlsx`

Validates claim activity Net amounts against the applicable reference pricing.

The checker supports facility/payer-specific dental pricing behavior for THIQA and DAMAN and also contains Medical-mode pricing logic.

Dental behavior includes facility-specific contexts such as:

- DAMAN standard pricing;
- DAMAN Khabisi / Al Yahar pricing;
- THIQA standard pricing;
- the Al Yahar / Emirates / Al Wagan THIQA group.

Endodontic pricing is date-gated and can use clinician specialty when the applicable rule requires it.

When an external pricing XLSX is not supplied, the checker can fall back to the repository pricing resource where applicable.

Results identify the claimed Net, expected/reference price, pricing context, and validity/remarks.


## 9. Timing Validity Checker

File:
- `js/checker_timings.js`

Validates encounter/activity timing logic for Dental and Medical claims.

Checks include chronological consistency and configured duration rules.

Dental timing logic includes the encounter-duration maximum rule used by the checker.

Results summarize valid/invalid rows and can be exported.


## 10. Modifier Checker in the Unified Interface

File:
- `js/checker_modifiers.js`

The same modifier-validation logic is also available from the unified Medical checker workflow when the required XML and eligibility inputs are present.

See the standalone Modifiers section below for the validation behavior.


# Drug Quantities

The Drug Quantities tab (`checker_drugquantities`) is separate from the general drug lookup/analyzer.

It supports:

## Single Code Lookup

After loading the Drugs XLSX, a user can enter a drug code and retrieve package/price information such as:

- package name;
- package size;
- unit price;
- package price;
- markup-related values available to the tool.

## Bulk XML Analysis

Accepts:

- a Claim Submissions XML;
- a Drugs List XLSX containing the expected `Drugs` sheet.

The tool matches claim activity codes to drug entries, calculates expected quantities, validates activity/type information, and flags discrepancies.

Invalid results can be exported.


# Modifiers

The standalone Modifiers tab validates CPT modifier observations in claim XML against eligibility data.

It looks for supported modifier observations such as:

- Observation Code: `CPT modifier`;
- modifier values such as `24` and `52`.

Matching uses the relevant member/card number, date, clinician, and eligibility data.

The tool validates:

- that the observation code is correctly written;
- the modifier value;
- the associated VOI number/type;
- payer scope.

Current VOI logic includes:

- Modifier `52` -> expected `VOI_EF1`;
- Modifier `24` -> expected `VOI_D`.

The output focuses on applicable THIQA / DAMAN modifier claims and provides a completion/correctness summary plus Excel export.


# Allocator

The Allocator (`html/checker_allocator.html`, `js/checker_allocator.js`) converts one or more All Claims reports into a filtered, deduplicated, balanced coder allocation.

It is designed for multi-facility reporting where claims from several XLS/XLSX files need to be treated as one allocation pool.

The allocation is computed from the current uploads and the current on-page configuration. Allocator-specific local-storage persistence is intentionally disabled, so edits to filters/coder configuration do not silently carry into a later browser session.


## Input and report detection

The allocator accepts multiple XLS/XLSX files at once by file picker or drag-and-drop.

It can detect relevant headers near the top of a sheet instead of requiring every report to begin on exactly the same row.

It recognizes multiple candidate names for important fields, including variations of:

- Claim ID / Pri. Claim ID / Pri. Claim No;
- Encounter Date / Claim Date / Report Date / Adm/Reg. Date;
- Department / Admitting Department / Clinic;
- Facility / Center / Centre / Facility ID / Facility Name;
- Codification Status;
- Payment Mode;
- Codified By / Coded By / Opened By / Username;
- Codification Remarks.

Dates support normal text dates and Excel serial values. Where a Claim Date cannot be parsed, the source text can still be retained for display/filter fallback.


## Facility detection

Facilities are resolved from the uploaded report using the configured facility presets, licenses, names, and recognized aliases.

The allocator can use a recognized facility/license from the row and has fallback behavior for report/facility identification when needed.

Coder presets come from:

`json/allocator_presets.json`

The preset file contains facility licenses, eligible coder names, and soft preferred departments.


## Deduplication

Uploaded reports are normalized into a combined claim pool.

The allocator deduplicates by:

`Facility + Claim ID`

This prevents the same claim from receiving multiple assignments merely because it appeared in more than one uploaded report.

Duplicate versions are aggregated for relevant filtering information, including Codified By values.

If any version in a duplicate group has a terminal codification status, the full claim group is treated as terminal/excluded.


## Automatic terminal-status exclusion

The following normalized exact statuses are always excluded:

- Closed
- Submitted
- Audited
- Verified and Closed
- Merged

The summary explains this explicitly rather than showing only the ambiguous phrase `Terminal Status`.


## Filter hierarchy

The Filters & Exclusions panel is applied before allocation.

The current hierarchy includes:

1. Payment Mode
2. Department
3. Additional Codification Status
4. Already Codified / Codified By exclusion
5. No Bill exclusion
6. Claim Date

Claim Date is the final filter in the hierarchy.


### Payment Mode

Detected payment modes can be included/excluded.

For allocation summaries, payment modes are also grouped as Insurance or Self-Pay.


### Departments

Departments can be selected/deselected.

The following are deselected by default:

- Dental
- Orthodontic / Orthodontics
- Slimming
- Cupping

They can still be manually re-enabled from the filter panel.


### Additional Codification Status

Non-terminal codification statuses can be included/excluded interactively.

Terminal statuses remain excluded automatically regardless of the optional status filter.


### Already Codified

Normally, any claim with a nonblank Codified By value is excluded because it has already been assigned/codified.

There is one deliberate reassignment exception:

- Rednie
- Farsana
- Abhilash

If every nonblank Codified By value on the deduplicated claim belongs only to those reassignment-source names, the claim remains eligible for reassignment.

When reassigning such a claim, the original source coder is removed from that claim's eligible destination pool so the claim is not simply assigned back to the same person.

If another/non-reassignment coder appears in Codified By, the claim remains blocked as already codified.


### No Bill

Claims whose codification remarks match the configured no-billing/no-submission patterns are excluded by default.

The user can explicitly enable `Include No Bills`.


### Claim Date

Claim Dates are detected after the preceding filters and can be selected/deselected.

The values are ordered chronologically when parseable, with blank/unparseable fallback values handled separately.


## Coder Assignment & Presets

Each detected facility has an editable coder configuration.

The facility preset supplies the default coder list and any preferred departments.

Department chips use two modes:

### P - Preferred

A Preferred (`P`) department is a soft preference.

It does not make the coder ineligible for other departments.

Preferred departments provide a small assignment bias only after workload balancing is considered.

### A - Assigned

An Assigned (`A`) department is a hard manual override.

If a department is explicitly Assigned to one or more coders at a facility, only those assigned coders are eligible for claims from that department.

If the department is assigned to several coders, workload balancing still operates within that eligible subset.

Manually added department chips start as Assigned (`A`).

Coder and department edits apply to the current session/allocation only because allocator local-storage persistence is disabled.


## Allocation algorithm

The allocator is designed to prioritize fair workload distribution over department preference.

The current workflow:

- builds the complete eligible claim set first;
- determines each claim's eligible coder pool;
- respects hard department assignments;
- excludes the source coder for Rednie/Farsana/Abhilash reassignment claims;
- groups overlapping/identical eligibility pools;
- computes coder target loads globally rather than relying on upload order;
- realizes assignments in a deterministic manner, using older claims first where relevant;
- uses preferred departments as a soft bias rather than an eligibility rule;
- marks a claim `(Unassigned)` when no coder is actually eligible.

The balancing weight is intentionally much stronger than the preference bias, so a preferred department cannot cause a materially unfair workload distribution.

Because the allocation is generated from the full pool, changing the order of uploaded reports should not be used as a way to influence who receives more claims.


## Preview

`Generate / Update Preview` computes the current allocation.

The browser preview is summary-oriented rather than a large claim-by-claim table.

It includes operational views such as:

- coder allocation totals;
- facility/date assignment detail;
- facility summary;
- coder claims per facility;
- department status summary;
- allocated/unassigned counts;
- filter/exclusion reconciliation.

The Facility Summary explains why loaded claims did not become eligible, including categories such as:

- Terminal Status (Closed / Submitted / Audited / Verified and Closed / Merged);
- Payment Mode Filter;
- Department Filter;
- Codification Status Filter;
- Already Codified;
- No Bill;
- Claim Date Filter.


## Excel export

`Download Facility Allocation` produces a styled Excel workbook using the exact allocation result shown in the preview.

The workbook is summary-first but retains claim-level facility sheets.


### Sheet: Coder Allocation Details

This sheet contains only the wide coder-allocation view.

It is structured as:

`Coder | Total Assigned Claims | Facility > Claim Date > Assigned Total / Detailed`

The hierarchy is built from dates that actually have assigned claims.

Each Facility header spans its claim dates.

Each Claim Date spans:

- Assigned Total
- Detailed

`Detailed` shows the payment-mode mix on one line and the department mix on the next line.

Example:

`51 Insurance and 3 Self-Pay.`

`2 Allergy And Immunology, 5 Cardiology, 4 Gastroenterology, 21 General, 6 General Surgery, 5 Laboratory, 1 Pulmonologist, 1 Radiology, and 9 Urology.`

Department names in Detailed are sorted alphabetically.

Zero-value payment modes are omitted. For example, a date with only Insurance claims shows `51 Insurance.` rather than `51 Insurance and 0 Self-Pay.`

The sheet:

- has no empty spacer row below the title;
- freezes the first two columns;
- freezes the five heading rows so the title and Facility/Date hierarchy remain visible;
- uses content-based column widths and row heights;
- wraps Detailed text as required.

Important values are emphasized:

- Total Assigned Claims
- Assigned Total

Supporting Detail text is visually de-emphasized.


### Sheet: Detailed Summaries

The other operational summaries are moved to a separate sheet called `Detailed Summaries`.

It contains:

#### Facility Summary

Columns include:

- Facility
- Claims Loaded
- Excluded / Why
- Eligible
- Allocated
- Unassigned

`Eligible` and `Allocated` are emphasized as the key values.

#### Department Status Summary

Summarizes allocation/status totals by department.

`Total` is emphasized.

#### Coder Claims per Facility

This is the renamed former Coder x Facility Matrix.

It shows coder claim counts by facility plus the overall `Total`.

`Total` is emphasized.


### Facility allocation sheets

The workbook also creates separate facility-level allocation worksheets.

Claim-level output includes fields such as:

- Facility
- Claim ID
- Claim Date
- Department
- Codification Status
- Payment Mode
- Coder
- Date Assigned
- Query
- Status
- Notes

This allows the summary sheets to remain management-oriented while the facility sheets retain the actual claim assignments needed for operational work.


# Key Data Resources

The application uses repository JSON/resources as local rule/reference data.

Important files include:

| Resource | Purpose |
| --- | --- |
| `json/allocator_presets.json` | Facility licenses, coder lists, and preferred departments for Allocator |
| `json/checker_auths.json` | Authorization-related reference data |
| `json/checker_tooths.json` | Tooth/region/procedure metadata |
| `json/clinician_licenses.json` | Clinician specialty/status/facility-affiliation resource |
| `json/facilities.json` | Recognized facility information |
| `json/insurance_licenses.json` | Insurance license/payer reference |
| `json/dental_pricing.json` | Dental pricing reference |
| `json/endo_pricing.json` | Endodontic/GP pricing overrides |
| `json/medical_pricing.json` | Medical pricing reference |
| `json/medical_validation_rules.json` | Medical validation configuration |
| `json/minor_procedures.json` | Minor-procedure reference data |
| `json/pregnancy_diagnosis_codes.json` | Pregnancy diagnosis-code reference |
| `json/icd10cm_exclusions_2026.json` | Current seed ICD-10-CM Excludes1 ruleset |


# Main File Reference

| File | Purpose |
| --- | --- |
| `index.html` | Main application shell |
| `js/index.js` | Top-level navigation and last-tab persistence |
| `html/checker_formatter.html` | Formatting interface |
| `js/checker_formatter.js` | Formatting controller |
| `js/checker_formatter_worker.js` | Eligibility/report/XML/full-report processing |
| `html/unified_checker.html` | Unified checker interface |
| `js/unified_checker.js` | Shared input, checker execution, filtering, and export controller |
| `js/checker_auths.js` | Authorization validation |
| `js/checker_clinician.js` | Clinician license/privilege validation |
| `js/checker_drugs.js` | Drug lookup and XML drug analysis |
| `js/checker_elig.js` | Eligibility cross-validation |
| `js/checker_schema.js` | XML/business-rule validation and likely-not-merged logic |
| `js/checker_exclusions.js` | ICD-10-CM Excludes1 checker |
| `js/dx_rules.js` | Reusable diagnosis-rule matching engine |
| `js/checker_observations.js` | Observation-oriented validation |
| `js/checker_tooths.js` | Tooth/region/activity validation logic |
| `js/checker_pricing.js` | Dental/medical pricing validation |
| `js/checker_timings.js` | Encounter/activity timing validation |
| `html/checker_drugquantities.html` / `js/checker_drugquantities.js` | Drug quantity tool |
| `html/checker_modifiers.html` / `js/checker_modifiers.js` | Standalone/unified modifier validation |
| `html/checker_allocator.html` | Allocator interface |
| `js/checker_allocator.js` | Claim normalization, filtering, balancing, preview, and workbook export |
| `css/checker_allocator.css` | Allocator layout and responsive styling |
| `json/allocator_presets.json` | Allocator facility/coder presets |
| `js/common_table_renderer.js` | Shared result-table utilities |
| `js/file_cache.js` | Shared checker file/cache utilities |
| `js/table_clipboard.js` | Table clipboard support |


# Typical Workflows

## Validation workflow

1. Use Formatting if the source eligibility/reporting/XML data needs combining.
2. Open Checkers.
3. Select Dental or Medical mode.
4. Upload the XML and any supporting files required by the checks you intend to run.
5. Run one checker or Check All.
6. Use Valid / Unknown / Invalid controls to inspect the results.
7. Export the complete output or invalid findings.

## Allocation workflow

1. Open Allocator.
2. Upload all relevant All Claims XLS/XLSX reports together.
3. Review the Import Summary and detected facilities.
4. Expand Filters & Exclusions if any default filters need changing.
5. Review/edit facility coder presets.
6. Use `P` for soft department preferences and `A` for hard department assignments.
7. Generate the preview.
8. Review coder/facility/department reconciliation.
9. Download the facility allocation workbook.
10. Use `Coder Allocation Details` for the date/facility/coder workload view, `Detailed Summaries` for management totals, and the individual facility sheets for claim-level assignments.


# Browser Storage Behavior

The application shell stores the last top-level tab so the site can reopen where the user left off.

The Allocator itself does not persist its editable allocation configuration to localStorage. Filters, facility configuration changes, department assignments/preferences, and similar allocator-session edits are therefore rebuilt from the current upload/presets after a refresh rather than silently restored from an older session.


# Notes and Limitations

- This project is browser-based and depends on the uploaded source files having recognizable columns/structures.
- Unknown/unrecognized facilities or claims with no eligible configured coder may remain unassigned.
- `json/allocator_presets.json` is operational preset data, not historical workload data.
- Preferred departments in allocator presets are preferences only; they are not department eligibility restrictions.
- Hard department restrictions come from manual Assigned (`A`) department configuration.
- The current ICD-10-CM exclusion JSON is a seed subset, not a complete official ICD-10-CM exclusion database.
- Repository reference datasets should be refreshed when licenses, pricing, facilities, payer rules, or clinical coding rules change.


# Support

For issues, questions, or feature requests, use the repository issue tracker:

https://github.com/EvacionSaraak/Submission-Checker-Tools/issues
