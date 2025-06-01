# Submission Tools
Here’s a reformatted version suitable for inclusion in a `README.md`:

---

# 🦷 Checker Tools Suite

A collection of JavaScript tools designed to validate and audit healthcare XML claim data, particularly for compliance, consistency, and domain-specific logic.

---

## 🔍 Tools Overview

### `checker_auths.js`

**Purpose:**
Validates authorization details in XML claims.

**Key Features:**

* Ensures valid Emirates ID format, PayerID, ReceiverID, and PackageName.
* Verifies activity codes against insurer-specific rules (from JSON/Excel).
* Confirms presence and compatibility of Ordering and Performing clinicians.
* Flags missing, mismatched, or differing categories.

---

### `checker_clinicians.js`

**Purpose:**
Validates clinician assignments and license privileges.

**Key Features:**

* Checks presence of both `Clinician` and `OrderingClinician`.
* Compares clinician categories using Shafafiya license and Open Jet Excel exports.
* Verifies privilege compatibility for the assigned activity.
* Flags category mismatches and missing clinicians.

---

### `checker_timings.js`

**Purpose:**
Checks time consistency between encounters and activity entries.

**Key Features:**

* Validates that activity starts occur within encounter periods.
* Calculates **Encounter Duration** and **Excess Time** between activity start and encounter end.
* Flags:

  * Duration < 10 minutes or > 4 hours.
  * Activity starting outside encounter time.
  * Start time after end time.
* Outputs detailed results and allows export of invalid entries.

---

### `checker_tooths.js`

**Purpose:**
Validates dental procedure codes against associated tooth numbers.

**Key Features:**

* Verifies tooth-procedure compatibility based on anterior, premolar, and molar zones.
* Flags mismatches between tooth numbers and treatment codes.
* Outputs categorized compliance reports.

---

## 🛠 Usage

Each tool runs in-browser and processes XML (and Excel where applicable). Open the HTML interface for each tool and upload the required files to start validation.
