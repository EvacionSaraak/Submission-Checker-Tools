(function() {
  try {
    'use strict';

    // checker_schema.js with modal table view, Person schema support,
    // medical consistency rules, and integrated Mandatory Tariff occurrence limits.
    // Requires SheetJS for Excel export and mandatory_tariff_shared.js for tariff loading.

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

    // ========================================================================
    // LOW-PRIORITY DISPLAY, MODAL, AND EXPORT HELPERS
    // ========================================================================

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
  if (document.getElementById("modalOverlay")) return;

  const modalHtml = `
    <div id="modalOverlay" style="display:none;position:fixed;z-index:9999;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.35);">
      <div id="modalContent" style="background:#fff;width:90%;max-width:1000px;max-height:95vh;overflow:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:20px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.2);">
        <button id="modalCloseBtn" style="float:right;font-size:18px;padding:2px 10px;cursor:pointer;" aria-label="Close">&times;</button>
        <div id="modalTable"></div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  document.getElementById("modalCloseBtn").onclick = hideModal;

  document.getElementById("modalOverlay").onclick = function(e) {
    if (e.target.id === "modalOverlay") {
      hideModal();
    }
  };
}

function showModal(html) {
  ensureModal();
  document.getElementById("modalTable").innerHTML = html;
  document.getElementById("modalOverlay").style.display = "block";
}

function hideModal() {
  document.getElementById("modalOverlay").style.display = "none";
}

function claimToHtmlTable(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");

  let root = doc.documentElement;

  if (root.nodeName !== "Claim" && root.nodeName !== "Person") {
    root =
      doc.getElementsByTagName("Claim")[0] ||
      doc.getElementsByTagName("Person")[0];
  }

  if (!root) {
    return "<b>Entry not found!</b>";
  }

  function renderNode(node, level = 0) {
    let html = "";

    for (let i = 0; i < node.children.length; ++i) {
      const child = node.children[i];

      if (child.children.length === 0) {
        html += `
          <tr>
            <td style="padding-left:${level * 20}px">
              <b>${child.nodeName}</b>
            </td>
            <td>${child.textContent}</td>
          </tr>
        `;
      } else {
        html += `
          <tr>
            <td style="padding-left:${level * 20}px">
              <b>${child.nodeName}</b>
            </td>
            <td></td>
          </tr>
        `;

        html += renderNode(child, level + 1);
      }
    }

    return html;
  }

  let html = `
    <table border="1" cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  `;

  html += `
    <tr>
      <th style="background:#f0f0f0">Field</th>
      <th style="background:#f0f0f0">Value</th>
    </tr>
  `;

  html += renderNode(root, 0);
  html += `</table>`;

  return html;
}

function exportErrorsToXLSX(data, schemaType) {
  const rows = Array.isArray(data)
    ? data
    : (
      Array.isArray(window._lastValidationResults)
        ? window._lastValidationResults
        : []
    );

  const schema =
    schemaType ||
    window._lastValidationSchema ||
    "claim";

  if (!rows.length) {
    alert("No results available to export.");
    return;
  }

  if (typeof XLSX === "undefined") {
    console.error("SheetJS (XLSX) is not loaded.");

    alert(
      "Export failed: XLSX library not loaded. " +
      "Include xlsx.full.min.js before this script."
    );

    return;
  }

  const errorRows =
    rows.filter(row => row.Remark !== "OK");

  if (!errorRows.length) {
    alert("No errors to export.");
    return;
  }

  const exportData =
    errorRows.map(row => ({
      [schema === "person" ? "UnifiedNumber" : "ClaimID"]:
        row.ClaimID,
      Remark: row.Remark
    }));

  let fileName = null;

  const lastValidationFileName =
    window._lastValidationFileName || '';

  const fileInput =
    document.getElementById("xmlFile");

  if (lastValidationFileName) {
    fileName =
      lastValidationFileName.replace(/\.[^/.]+$/, "") +
      "_errors.xlsx";
  } else if (
    fileInput &&
    fileInput.files &&
    fileInput.files[0] &&
    fileInput.files[0].name
  ) {
    fileName =
      fileInput.files[0].name.replace(/\.[^/.]+$/, "") +
      "_errors.xlsx";
  } else {
    const ts =
      new Date()
        .toISOString()
        .replace(/[:.]/g, "-");

    fileName =
      (schema === "person" ? "person" : "claim") +
      "_errors_" +
      ts +
      ".xlsx";
  }

  try {
    const ws =
      XLSX.utils.json_to_sheet(exportData);

    const wb =
      XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      wb,
      ws,
      "Errors"
    );

    XLSX.writeFile(
      wb,
      fileName
    );
  } catch (err) {
    console.error("Export failed:", err);
    alert("Export failed. See console for details.");
  }
}

    // ========================================================================
    // GENERAL LOOKUP, NORMALIZATION, AND DATE HELPERS
    // ========================================================================

function normalizeSpecialty(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function loadClinicianSpecialtyMap() {
  if (clinicianSpecialtyMapPromise) {
    return clinicianSpecialtyMapPromise;
  }

  clinicianSpecialtyMapPromise =
    fetch('../json/clinician_licenses.json')
      .then(res => {
        if (!res.ok) {
          throw new Error(
            `Failed to load clinician specialties (${res.status})`
          );
        }

        return res.json();
      })
      .then(rows => {
        const map = new Map();

        (Array.isArray(rows) ? rows : [])
          .forEach(row => {
            const license =
              String(row['Phy Lic'] || '')
                .trim()
                .toUpperCase();

            if (!license) {
              return;
            }

            const newSpec =
              String(row['Specialty'] || '')
                .trim();

            if (!map.has(license) || newSpec) {
              map.set(
                license,
                newSpec
              );
            }
          });

        return map;
      })
      .catch(error => {
        console.warn(
          '[SCHEMA] Failed to load clinician specialties:',
          error.message
        );

        return new Map();
      });

  return clinicianSpecialtyMapPromise;
}

function getSelectedClaimTypeMode() {
  const claimTypeDental =
    document.getElementById('claimTypeDental');

  const claimTypeMedical =
    document.getElementById('claimTypeMedical');

  if (
    claimTypeMedical &&
    claimTypeMedical.checked
  ) {
    return 'MEDICAL';
  }

  if (
    claimTypeDental &&
    claimTypeDental.checked
  ) {
    return 'DENTAL';
  }

  return null;
}

function getScopedElement(container, selector) {
  if (
    container &&
    typeof container.querySelector === 'function'
  ) {
    const scoped =
      container.querySelector(selector);

    if (scoped) {
      return scoped;
    }
  }

  if (
    document &&
    typeof document.querySelector === 'function'
  ) {
    return document.querySelector(selector);
  }

  return null;
}

function buildSchemaMessageElement(
  message,
  className = 'checker-error'
) {
  const el =
    document.createElement('div');

  el.className = className;
  el.textContent = message;

  return el;
}

function safeTextByTag(parent, tag) {
  if (!parent) {
    return "";
  }

  const el =
    parent.getElementsByTagName(tag)[0];

  return (
    el &&
    el.textContent
      ? el.textContent.trim()
      : ""
  );
}

function parseEncounterDateTime(value) {
  const raw =
    String(value || '').trim();

  if (!raw) {
    return null;
  }

  const match =
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/
      .exec(raw);

  if (!match) {
    return null;
  }

  const day =
    parseInt(match[1], 10);

  const month =
    parseInt(match[2], 10);

  const year =
    parseInt(match[3], 10);

  const hour =
    parseInt(match[4], 10);

  const minute =
    parseInt(match[5], 10);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute
      )
    );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    raw,
    dateKey:
      `${year.toString().padStart(4, '0')}-` +
      `${month.toString().padStart(2, '0')}-` +
      `${day.toString().padStart(2, '0')}`,
    timestamp: date.getTime()
  };
}

    // ========================================================================
    // INTEGRATED MANDATORY TARIFF OCCURRENCE-LIMIT HELPERS
    // ========================================================================

function cleanSchemaRemarkLines(remark) {
  return String(remark == null ? '' : remark)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(
      line =>
        !OLD_DUPLICATE_ORDERING_PATTERN.test(line)
    );
}

function groupTariffFindingsByClaim(findings) {
  const grouped = new Map();

  for (const finding of findings || []) {
    const claimID =
      String(finding?.claimID || 'Unknown')
        .trim();

    if (!grouped.has(claimID)) {
      grouped.set(
        claimID,
        []
      );
    }

    grouped
      .get(claimID)
      .push(finding);
  }

  return grouped;
}

function applyTariffFindingsToResult(
  result,
  findings
) {
  const originalLines =
    String(result?.Remark || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

  const removedLegacyDuplicate =
    originalLines.some(
      line =>
        OLD_DUPLICATE_ORDERING_PATTERN.test(line)
    );

  let lines =
    cleanSchemaRemarkLines(result?.Remark)
      .filter(
        line =>
          !OK_REMARK_PATTERN.test(line)
      );

  for (const finding of findings || []) {
    if (
      finding?.remark &&
      !lines.includes(finding.remark)
    ) {
      lines.push(finding.remark);
    }
  }

  if ((findings || []).length > 0) {
    result.Valid = false;
    result.Unknown = false;
  } else if (
    removedLegacyDuplicate &&
    lines.length === 0
  ) {
    result.Valid = true;
    result.Unknown = false;
  }

  if (lines.length === 0) {
    lines = ['OK'];
  }

  result.Remark =
    lines.join('\n');

  result.TariffOccurrenceFindings =
    (findings || []).slice();

  return result;
}

async function applyTariffOccurrenceLimits(
  xmlDoc,
  results
) {
  if (!window.MandatoryTariffShared) {
    throw new Error(
      'MandatoryTariffShared is unavailable. ' +
      'Load mandatory_tariff_shared.js before checker_schema.js.'
    );
  }

  const tariffData =
    await window.MandatoryTariffShared
      .loadBundledMandatoryTariff();

  for (const warning of tariffData.warnings || []) {
    console.warn(
      '[SCHEMA][TARIFF]',
      warning
    );
  }

  const findings =
    window.MandatoryTariffShared
      .validateSubmissionOccurrenceLimits(
        xmlDoc,
        tariffData.map
      );

  const findingsByClaim =
    groupTariffFindingsByClaim(findings);

  for (const result of results || []) {
    const claimID =
      String(result?.ClaimID || 'Unknown')
        .trim();

    applyTariffFindingsToResult(
      result,
      findingsByClaim.get(claimID) || []
    );
  }

  window._lastTariffOccurrenceFindings =
    findings;

  console.log(
    `[SCHEMA][TARIFF] Applied CPT MUE occurrence limits from ${tariffData.sheetName}. ` +
    `Findings: ${findings.length}; ` +
    `tariff rows: ${tariffData.rows.length}; ` +
    `source: ${tariffData.path}`
  );

  return results;
}

    // ========================================================================
    // CROSS-CLAIM MERGE DETECTION
    // ========================================================================

function collectNotMergedClaimContext(
  claim,
  receiverID = ''
) {
  const claimID =
    safeTextByTag(
      claim,
      'ID'
    );

  const memberID =
    safeTextByTag(
      claim,
      'MemberID'
    ).toUpperCase();

  const payerID =
    safeTextByTag(
      claim,
      'PayerID'
    ).toUpperCase();

  const providerID =
    safeTextByTag(
      claim,
      'ProviderID'
    ).toUpperCase();

  const encounter =
    claim.getElementsByTagName('Encounter')[0] ||
    null;

  const facilityID =
    safeTextByTag(
      encounter,
      'FacilityID'
    ).toUpperCase();

  const encounterStartRaw =
    safeTextByTag(
      encounter,
      'Start'
    );

  const encounterEndRaw =
    safeTextByTag(
      encounter,
      'End'
    );

  const parsedStart =
    parseEncounterDateTime(
      encounterStartRaw
    );

  const parsedEnd =
    parseEncounterDateTime(
      encounterEndRaw
    );

  const encounterDate =
    parsedStart
      ? parsedStart.dateKey
      : (
        parsedEnd
          ? parsedEnd.dateKey
          : null
      );

  const activities =
    claim.getElementsByTagName('Activity');

  const clinicians =
    new Set();

  Array.from(activities)
    .forEach(activity => {
      const orderingClinician =
        safeTextByTag(
          activity,
          'OrderingClinician'
        ).toUpperCase();

      if (orderingClinician) {
        clinicians.add(
          orderingClinician
        );
      }
    });

  const diagnosisCodes =
    new Set();

  const diagnoses =
    claim.getElementsByTagName('Diagnosis');

  Array.from(diagnoses)
    .forEach(diagnosis => {
      const code =
        safeTextByTag(
          diagnosis,
          'Code'
        )
          .toUpperCase()
          .replace(/\./g, '');

      if (code) {
        diagnosisCodes.add(code);
      }
    });

  return {
    receiverID:
      String(receiverID || '')
        .trim()
        .toUpperCase(),
    claimID,
    memberID,
    payerID,
    providerID,
    facilityID,
    encounterDate,
    encounterStartRaw,
    encounterEndRaw,
    parsedStart,
    parsedEnd,
    clinicians,
    diagnosisCodes
  };
}

function buildNotMergedRemarksFromContexts(contexts) {
  const grouped =
    new Map();

  (contexts || [])
    .forEach(ctx => {
      if (
        !ctx.memberID ||
        !ctx.providerID ||
        !ctx.facilityID ||
        !ctx.encounterDate
      ) {
        return;
      }

      if (
        !NOT_MERGED_RECEIVER_IDS.has(
          String(ctx.receiverID || '')
            .toUpperCase()
        )
      ) {
        return;
      }

      const groupKey = [
        ctx.receiverID,
        ctx.memberID,
        ctx.providerID,
        ctx.facilityID,
        ctx.encounterDate
      ].join('|');

      if (!grouped.has(groupKey)) {
        grouped.set(
          groupKey,
          []
        );
      }

      grouped
        .get(groupKey)
        .push(ctx);
    });

  const remarksByClaimId =
    new Map();

  const pairKeys =
    new Set();

  grouped.forEach(groupClaims => {
    for (
      let i = 0;
      i < groupClaims.length;
      i += 1
    ) {
      for (
        let j = i + 1;
        j < groupClaims.length;
        j += 1
      ) {
        const first =
          groupClaims[i];

        const second =
          groupClaims[j];

        if (
          !first.claimID ||
          !second.claimID ||
          first.claimID === second.claimID
        ) {
          continue;
        }

        if (
          !first.parsedStart ||
          !first.parsedEnd ||
          !second.parsedStart ||
          !second.parsedEnd
        ) {
          continue;
        }

        const hasEncounterOverlap =
          first.parsedStart.timestamp <=
            second.parsedEnd.timestamp &&
          second.parsedStart.timestamp <=
            first.parsedEnd.timestamp;

        if (!hasEncounterOverlap) {
          continue;
        }

        const sharedClinicians =
          Array.from(first.clinicians)
            .filter(
              clinician =>
                second.clinicians.has(clinician)
            );

        if (sharedClinicians.length === 0) {
          continue;
        }

        const sharedDiagnoses =
          Array.from(first.diagnosisCodes)
            .filter(
              code =>
                second.diagnosisCodes.has(code)
            );

        if (sharedDiagnoses.length === 0) {
          continue;
        }

        const pairKey = [
          first.claimID,
          second.claimID
        ]
          .sort()
          .join('|');

        if (pairKeys.has(pairKey)) {
          continue;
        }

        pairKeys.add(pairKey);

        const baseRemark =
          `${first.claimID} must be merged with ${second.claimID}.`;

        const reverseRemark =
          `${second.claimID} must be merged with ${first.claimID}.`;

        console.debug(
          '[SCHEMA][NOT_MERGED][PAIR]',
          {
            firstClaimID:
              first.claimID,
            secondClaimID:
              second.claimID,
            encounterDate:
              first.encounterDate,
            firstEncounter:
              `${first.encounterStartRaw} - ${first.encounterEndRaw}`,
            secondEncounter:
              `${second.encounterStartRaw} - ${second.encounterEndRaw}`,
            sharedClinicians,
            sharedDiagnoses
          }
        );

        if (
          !remarksByClaimId.has(
            first.claimID
          )
        ) {
          remarksByClaimId.set(
            first.claimID,
            []
          );
        }

        if (
          !remarksByClaimId.has(
            second.claimID
          )
        ) {
          remarksByClaimId.set(
            second.claimID,
            []
          );
        }

        remarksByClaimId
          .get(first.claimID)
          .push(baseRemark);

        remarksByClaimId
          .get(second.claimID)
          .push(reverseRemark);
      }
    }
  });

  return remarksByClaimId;
}

function detectNotMergedRemarksByClaim(
  claims,
  receiverID = ''
) {
  const warnings = [];

  const contexts =
    Array.from(claims || [])
      .map((claim, index) => {
        try {
          return collectNotMergedClaimContext(
            claim,
            receiverID
          );
        } catch (error) {
          warnings.push(
            `Claim index ${index}: ${error.message}`
          );

          return null;
        }
      })
      .filter(Boolean);

  warnings.forEach(msg => {
    console.warn(
      '[SCHEMA][NOT_MERGED]',
      msg
    );
  });

  return buildNotMergedRemarksFromContexts(
    contexts
  );
}

    // ========================================================================
    // SUPPLEMENTAL CLAIM-RULE HELPERS
    // ========================================================================

function isConsultationCode(code) {
  return CONSULATION_CODE_REGEX.test(
    String(code || '').trim()
  );
}

function specialtyContains(
  specialty,
  searchText
) {
  return normalizeSpecialty(specialty)
    .includes(
      normalizeSpecialty(searchText)
    );
}

function isOphthalmologyOrPsychiatrySpecialty(
  specialty
) {
  const normalized =
    normalizeSpecialty(specialty);

  return (
    normalized.includes('OPTHALMOLOGY') ||
    normalized.includes('OPHTHALMOLOGY') ||
    normalized.includes('PSYCHIATRY')
  );
}

function checkForFalseValues(
  parent,
  invalidFields,
  prefix = "",
  activityContext = null,
  falseValueErrors = null
) {
  if (falseValueErrors === null) {
    falseValueErrors = {
      activity: new Map(),
      nonActivity: []
    };
  }

  const normalizeFieldPath = (
    currentPrefix,
    nodeName,
    removeActivityPrefix = false
  ) => {
    let fieldPath =
      (
        currentPrefix
          ? `${currentPrefix} → ${nodeName}`
          : nodeName
      )
        .replace(
          /^Claim(?:[.\s→]*)/,
          ""
        )
        .replace(
          /^Person(?:[.\s→]*)/,
          ""
        );

    if (removeActivityPrefix) {
      fieldPath =
        fieldPath.replace(
          /Activity\s*→\s*/g,
          ""
        );
    }

    return fieldPath;
  };

  for (const el of parent.children) {
    const val =
      (el.textContent || "")
        .trim()
        .toLowerCase();

    let currentActivityContext =
      activityContext;

    if (el.nodeName === "Activity") {
      const codeEl =
        el.getElementsByTagName("Code")[0];

      const activityCode =
        codeEl
          ? (codeEl.textContent || "").trim()
          : null;

      currentActivityContext =
        activityCode || "(unknown)";
    }

    if (
      !el.children.length &&
      val === "false" &&
      el.nodeName !== "MiddleNameEn"
    ) {
      if (currentActivityContext) {
        const fieldPath =
          normalizeFieldPath(
            prefix,
            el.nodeName,
            true
          );

        const readableField =
          fieldPath
            .split(/\s*→\s*/)
            .join(" ");

        if (
          !falseValueErrors.activity.has(
            readableField
          )
        ) {
          falseValueErrors.activity.set(
            readableField,
            []
          );
        }

        falseValueErrors.activity
          .get(readableField)
          .push(currentActivityContext);
      } else {
        const fieldPath =
          normalizeFieldPath(
            prefix,
            el.nodeName,
            false
          );

        const formattedPath =
          fieldPath.replace(
            /\s*→\s*/g,
            ' '
          );

        falseValueErrors.nonActivity.push(
          `${formattedPath} has invalid value of \`false\`.`
        );
      }
    }

    if (el.children.length) {
      checkForFalseValues(
        el,
        invalidFields,
        prefix
          ? `${prefix} → ${el.nodeName}`
          : el.nodeName,
        currentActivityContext,
        falseValueErrors
      );
    }
  }

  if (
    prefix === "Claim." &&
    activityContext === null
  ) {
    falseValueErrors.nonActivity
      .forEach(msg => {
        invalidFields.push(msg);
      });

    for (
      const [field, activities]
      of falseValueErrors.activity
    ) {
      if (activities.length === 1) {
        invalidFields.push(
          `Activity ${activities[0]} has ${field} of \`false\``
        );
      } else if (activities.length === 2) {
        invalidFields.push(
          `Activities ${activities[0]} and ${activities[1]} have ${field} as \`false\`.`
        );
      } else {
        const lastActivity =
          activities[activities.length - 1];

        const otherActivities =
          activities
            .slice(0, -1)
            .join(" ");

        invalidFields.push(
          `Activities ${otherActivities} and ${lastActivity} have ${field} as \`false\`.`
        );
      }
    }
  }
}

function checkSpecialActivityDiagnosis(
  activities,
  diagnoses,
  getText,
  invalidFields
) {
  try {
    const specialActivityCodes =
      new Set([
        "11111",
        "11119",
        "11101",
        "11109"
      ]);

    const requiredDiagnosisPatterns = [
      {
        pattern: "K05.0",
        displayCode: "K05.0"
      },
      {
        pattern: "K05.1",
        displayCode: "K05.1"
      },
      {
        pattern: "K03.6",
        displayCode: "K03.6"
      }
    ];

    function matchesDiagnosisPattern(
      code,
      pattern
    ) {
      if (code.length < pattern.length) {
        return false;
      }

      return (
        code.substring(
          0,
          pattern.length
        ) === pattern
      );
    }

    const foundSpecialActivityCodes =
      Array.from(activities || [])
        .map(
          activity =>
            (
              getText(
                "Code",
                activity
              ) || ""
            ).trim()
        )
        .filter(
          code =>
            code &&
            specialActivityCodes.has(code)
        );

    if (
      foundSpecialActivityCodes.length > 0
    ) {
      const diagnosisCodes =
        Array.from(diagnoses || [])
          .map(
            diagnosis =>
              (
                getText(
                  "Code",
                  diagnosis
                ) || ""
              )
                .toUpperCase()
                .trim()
          )
          .filter(Boolean);

      const hasAnyMatch =
        requiredDiagnosisPatterns.some(
          ({ pattern }) => {
            return diagnosisCodes.some(
              code =>
                matchesDiagnosisPattern(
                  code,
                  pattern
                )
            );
          }
        );

      if (!hasAnyMatch) {
        const requiredCodes =
          requiredDiagnosisPatterns
            .map(
              item =>
                item.displayCode
            )
            .join(" or ");

        invalidFields.push(
          `Activity code(s) ${Array.from(new Set(foundSpecialActivityCodes)).join(" ")} require Diagnosis code(s): ${requiredCodes}`
        );
      }
    }
  } catch (err) {
    console.error(
      "Special activity -> diagnosis check error:",
      err
    );
  }
}

function checkImplantActivityDiagnosis(
  activities,
  diagnoses,
  getText,
  invalidFields
) {
  try {
    const implantActivityCodes =
      new Set([
        "79931",
        "79932",
        "79933",
        "79934"
      ]);

    const foundImplantCodes =
      Array.from(activities || [])
        .map(
          activity =>
            (
              getText(
                "Code",
                activity
              ) || ""
            ).trim()
        )
        .filter(
          code =>
            code &&
            implantActivityCodes.has(code)
        );

    if (
      foundImplantCodes.length > 0
    ) {
      const diagnosisCodes =
        Array.from(diagnoses || [])
          .map(
            diagnosis =>
              (
                getText(
                  "Code",
                  diagnosis
                ) || ""
              )
                .replace(/\./g, "")
                .toUpperCase()
                .trim()
          )
          .filter(Boolean);

      const hasValidDiagnosis =
        diagnosisCodes.some(code => {
          return (
            (
              code.startsWith("K081") &&
              code.length >= 5
            ) ||
            (
              code.startsWith("K084") &&
              code.length >= 5
            )
          );
        });

      if (!hasValidDiagnosis) {
        invalidFields.push(
          `Activity code(s) ${Array.from(new Set(foundImplantCodes)).join(" ")} require at least one Diagnosis code from: K08.1 or K08.4`
        );
      }
    }
  } catch (err) {
    console.error(
      "Implant activity -> diagnosis check error:",
      err
    );
  }
}

function checkGTLicenseValidation(
  activities,
  facilityID,
  getText,
  invalidFields
) {
  try {
    let hasGTLicense = false;

    Array.from(activities || [])
      .forEach(activity => {
        const orderingClinician =
          (
            getText(
              "OrderingClinician",
              activity
            ) || ""
          )
            .trim()
            .toUpperCase();

        if (
          orderingClinician.startsWith("GT")
        ) {
          hasGTLicense = true;
        }
      });

    if (hasGTLicense) {
      const message =
        "Ordering Clinician is under Physiotherapist.";

      if (!invalidFields.includes(message)) {
        invalidFields.push(message);
      }
    }
  } catch (err) {
    console.error(
      "GT license validation check error:",
      err
    );
  }
}

    // ========================================================================
    // MEDICAL CONSISTENCY AND SPECIALTY VALIDATION
    // ========================================================================

function validateMedicalOrderingConsistency(
  activities,
  text,
  invalidFields,
  options = {}
) {
  if (!options.isMedicalClaim) {
    return;
  }

  const nonBlankOrdering =
    new Set();

  const missingOrderingCodes =
    [];

  const duplicatePairs =
    new Map();

  Array.from(activities || [])
    .forEach(activity => {
      const code =
        text(
          'Code',
          activity
        );

      const ordering =
        String(
          text(
            'OrderingClinician',
            activity
          ) || ''
        )
          .trim()
          .toUpperCase();

      const normalizedCode =
        String(code || '')
          .trim()
          .toUpperCase()
          .replace(
            /[^A-Z0-9\-]/g,
            ''
          );

      if (!ordering) {
        if (code) {
          missingOrderingCodes.push(code);
        }

        return;
      }

      nonBlankOrdering.add(ordering);

      if (!normalizedCode) {
        return;
      }

      const pairKey =
        `${normalizedCode}|${ordering}`;

      duplicatePairs.set(
        pairKey,
        (
          duplicatePairs.get(pairKey) ||
          0
        ) + 1
      );
    });

  if (nonBlankOrdering.size > 1) {
    invalidFields.push(
      `Claim ${text('ID')} has multiple Ordering Clinicians: ` +
      `${Array.from(nonBlankOrdering).join(', ')}.`
    );
  }

  if (missingOrderingCodes.length > 0) {
    const uniqueCodes =
      Array.from(
        new Set(missingOrderingCodes)
      );

    invalidFields.push(
      `Missing OrderingClinician for activities: ` +
      `${uniqueCodes.join(', ')}.`
    );
  }

  duplicatePairs.forEach(
    (count, pairKey) => {
      if (count < 2) {
        return;
      }

      const [code, ordering] =
        pairKey.split('|');

      invalidFields.push(
        `Duplicate code ${code} with Ordering Clinician ${ordering}.`
      );
    }
  );
}

function validateConsultationAndSpecialtyRules(
  activities,
  text,
  invalidFields,
  clinicianSpecialtyMap,
  options = {}
) {
  const isMedicalClaim =
    options.isMedicalClaim === true;

  if (!isMedicalClaim) {
    return;
  }

  const activityContexts =
    Array.from(activities || [])
      .map((act, index) => {
        const code =
          text(
            'Code',
            act
          );

        const quantityRaw =
          text(
            'Quantity',
            act
          );

        const quantity =
          Number(quantityRaw || 0);

        const net =
          Number(
            text(
              'Net',
              act
            ) || 0
          );

        const clinician =
          (
            text(
              'Clinician',
              act
            ) || ''
          )
            .trim()
            .toUpperCase();

        const orderingClinician =
          (
            text(
              'OrderingClinician',
              act
            ) || ''
          )
            .trim()
            .toUpperCase();

        const clinicianSpecialty =
          clinicianSpecialtyMap.get(clinician) ||
          '';

        const orderingSpecialty =
          clinicianSpecialtyMap.get(orderingClinician) ||
          '';

        return {
          act,
          index,
          code,
          quantity,
          quantityRaw,
          net,
          clinician,
          orderingClinician,
          clinicianSpecialty,
          orderingSpecialty
        };
      });

  const requires992SpecialtyCheck =
    activityContexts.length > 1;

  const infusionCodesInClaim =
    new Set();

  const code992Found =
    new Set();

  activityContexts.forEach(ctx => {
    if (!ctx.code) {
      return;
    }

    if (
      MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(
        ctx.code
      )
    ) {
      infusionCodesInClaim.add(
        ctx.code
      );
    }

    if (GP_992_CODES.has(ctx.code)) {
      code992Found.add(ctx.code);
    }

    if (
      INVALID_ACTIVITY_CODES.has(ctx.code)
    ) {
      invalidFields.push(
        `Activity ${ctx.code} is invalid and cannot be used`
      );
    }

    if (
      /^8/.test(ctx.code) &&
      ctx.code !== '82948' &&
      !specialtyContains(
        ctx.clinicianSpecialty,
        'Pathology'
      )
    ) {
      const spec =
        ctx.clinicianSpecialty ||
        'Unknown';

      invalidFields.push(
        `Activity ${ctx.code} requires Clinician specialty containing Pathology (Currently \`${spec}\`)`
      );
    }

    if (
      (
        ctx.code === '97802' ||
        ctx.code === '97803'
      ) &&
      !specialtyContains(
        ctx.clinicianSpecialty,
        'Dietician'
      )
    ) {
      const spec =
        ctx.clinicianSpecialty ||
        'Unknown';

      invalidFields.push(
        `Activity ${ctx.code} requires Clinician specialty containing Dietician (Currently \`${spec}\`)`
      );
    }

    if (
      requires992SpecialtyCheck &&
      GP_992_REQUIRED_CODES.has(ctx.code) &&
      !specialtyContains(
        ctx.orderingSpecialty,
        'General Practitioner'
      )
    ) {
      const spec =
        ctx.orderingSpecialty ||
        'Unknown';

      invalidFields.push(
        `Activity ${ctx.code} requires OrderingClinician specialty as General Practitioner (Currently \`${spec}\`)`
      );
    }

    if (
      GP_992_FORBIDDEN_CODES.has(ctx.code)
    ) {
      if (
        ctx.net !== 0 &&
        specialtyContains(
          ctx.orderingSpecialty,
          'General Practitioner'
        )
      ) {
        const spec =
          ctx.orderingSpecialty ||
          'Unknown';

        invalidFields.push(
          `Activity ${ctx.code} requires OrderingClinician specialty to NOT be General Practitioner (Currently \`${spec}\`)`
        );
      }

      if (
        isOphthalmologyOrPsychiatrySpecialty(
          ctx.orderingSpecialty
        )
      ) {
        invalidFields.push(
          `${ctx.orderingSpecialty || 'OrderingClinician Specialty'} cannot be used for ${ctx.code}`
        );
      }
    }

    if (
      specialtyContains(
        ctx.orderingSpecialty,
        'Opthalmology'
      ) ||
      specialtyContains(
        ctx.orderingSpecialty,
        'Ophthalmology'
      )
    ) {
      if (
        isConsultationCode(ctx.code) &&
        ctx.code.startsWith('992')
      ) {
        invalidFields.push(
          `Ophthalmology consultation codes must start with 92, not ${ctx.code}`
        );
      }
    }

    if (
      MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(
        ctx.code
      )
    ) {
      if (
        ctx.quantityRaw &&
        ctx.quantity !== 1
      ) {
        invalidFields.push(
          `Activity ${ctx.code} must have Quantity of 1`
        );
      }
    }
  });

  const hasNewPatientCombo =
    code992Found.has('99202') ||
    code992Found.has('99203');

  const hasEstablishedCombo =
    code992Found.has('99212') ||
    code992Found.has('99213');

  if (
    hasNewPatientCombo &&
    hasEstablishedCombo
  ) {
    invalidFields.push(
      '99202/99203 cannot be combined with 99212/99213 in the same claim'
    );
  }

  if (infusionCodesInClaim.size > 1) {
    invalidFields.push(
      `Codes ${Array.from(infusionCodesInClaim).join(', ')} cannot coexist in the same claim`
    );
  }
}

function buildDuplicateActivityReferenceRemarksByClaim(claims) {
  const occurrencesByActivityID = new Map();
  const groupedErrorsByClaim = new Map();
  const remarksByClaim = new Map();

  function formatList(values) {
    const uniqueValues = Array.from(
      new Set(
        values
          .map(value => String(value || "").trim())
          .filter(Boolean)
      )
    );

    if (uniqueValues.length === 0) {
      return "another claim";
    }

    if (uniqueValues.length === 1) {
      return uniqueValues[0];
    }

    if (uniqueValues.length === 2) {
      return `${uniqueValues[0]} and ${uniqueValues[1]}`;
    }

    return (
      uniqueValues.slice(0, -1).join(", ") +
      `, and ${uniqueValues[uniqueValues.length - 1]}`
    );
  }

  /*
   * First pass:
   * Collect every occurrence of every Activity ID across the submission.
   */
  Array.from(claims || []).forEach((claim, claimIndex) => {
    const claimID =
      safeTextByTag(claim, "ID") ||
      `Unknown claim ${claimIndex + 1}`;

    const activities =
      claim.getElementsByTagName("Activity");

    Array.from(activities).forEach(activity => {
      const activityID =
        safeTextByTag(activity, "ID").trim();

      if (!activityID) {
        return;
      }

      const normalizedActivityID =
        activityID.toUpperCase();

      if (
        !occurrencesByActivityID.has(
          normalizedActivityID
        )
      ) {
        occurrencesByActivityID.set(
          normalizedActivityID,
          []
        );
      }

      occurrencesByActivityID
        .get(normalizedActivityID)
        .push({
          claim,
          claimID,
          activityID
        });
    });
  });

  /*
   * Second pass:
   * For every duplicated Activity ID, add it to each affected claim.
   *
   * Activity IDs that duplicate against the same claim or same group of
   * claims are grouped into one final error message.
   */
  occurrencesByActivityID.forEach(occurrences => {
    if (occurrences.length < 2) {
      return;
    }

    const affectedClaims = new Map();

    occurrences.forEach(occurrence => {
      if (!affectedClaims.has(occurrence.claim)) {
        affectedClaims.set(
          occurrence.claim,
          {
            claimID: occurrence.claimID,
            activityID: occurrence.activityID
          }
        );
      }
    });

    affectedClaims.forEach(
      (currentClaimData, currentClaim) => {
        let duplicateClaimIDs =
          occurrences
            .filter(
              occurrence =>
                occurrence.claim !== currentClaim
            )
            .map(
              occurrence =>
                occurrence.claimID
            );

        /*
         * The Activity ID may be repeated more than once inside the same
         * claim without occurring in another claim. It is still invalid.
         */
        if (duplicateClaimIDs.length === 0) {
          duplicateClaimIDs = [
            currentClaimData.claimID
          ];
        }

        duplicateClaimIDs = Array.from(
          new Set(duplicateClaimIDs)
        );

        /*
         * Create a stable grouping key so references duplicated against
         * the same claims are rendered together.
         */
        const duplicateGroupKey =
          duplicateClaimIDs
            .map(value =>
              String(value || "")
                .trim()
                .toUpperCase()
            )
            .sort()
            .join("|");

        if (
          !groupedErrorsByClaim.has(
            currentClaim
          )
        ) {
          groupedErrorsByClaim.set(
            currentClaim,
            new Map()
          );
        }

        const claimGroups =
          groupedErrorsByClaim.get(
            currentClaim
          );

        if (
          !claimGroups.has(
            duplicateGroupKey
          )
        ) {
          claimGroups.set(
            duplicateGroupKey,
            {
              activityIDs: [],
              duplicateClaimIDs
            }
          );
        }

        const group =
          claimGroups.get(
            duplicateGroupKey
          );

        if (
          !group.activityIDs.some(
            existingID =>
              existingID.toUpperCase() ===
              currentClaimData.activityID.toUpperCase()
          )
        ) {
          group.activityIDs.push(
            currentClaimData.activityID
          );
        }
      }
    );
  });

  /*
   * Third pass:
   * Render one combined remark per duplicate-claim grouping.
   */
  groupedErrorsByClaim.forEach(
    (claimGroups, claim) => {
      const claimRemarks = [];

      claimGroups.forEach(group => {
        const activityReferenceList =
          formatList(group.activityIDs);

        const duplicateClaimList =
          formatList(
            group.duplicateClaimIDs
          );

        claimRemarks.push(
          `Activity reference(s) ${activityReferenceList} ` +
          `already exists in ${duplicateClaimList}. ` +
          `Kindly contact IT for this issue.`
        );
      });

      if (claimRemarks.length > 0) {
        remarksByClaim.set(
          claim,
          claimRemarks
        );
      }
    }
  );

  return remarksByClaim;
}

    // ========================================================================
    // PRIMARY PERSON AND CLAIM SCHEMA VALIDATORS
    // ========================================================================

function validatePersonSchema(
  xmlDoc,
  originalXmlContent = ""
) {
  const results = [];

  const persons =
    xmlDoc.getElementsByTagName("Person");

  for (const person of persons) {
    let missingFields = [];
    let invalidFields = [];
    let remarks = [];

    let isUnknown = false;

    const present = (
      tag,
      parent = person
    ) => {
      return (
        parent
          .getElementsByTagName(tag)
          .length > 0
      );
    };

    const text = (
      tag,
      parent = person
    ) => {
      const el =
        parent.getElementsByTagName(tag)[0];

      return (
        el &&
        el.textContent
          ? el.textContent.trim()
          : ""
      );
    };

    const invalidIfNull = (
      tag,
      parent = person,
      prefix = ""
    ) => {
      if (!text(tag, parent)) {
        invalidFields.push(
          prefix +
          tag +
          " (null/empty)"
        );
      }
    };

    const unifiedNumber =
      text("UnifiedNumber");

    let personHadAmpersand = false;

    if (
      originalXmlContent &&
      unifiedNumber
    ) {
      const unTag =
        `<UnifiedNumber>${unifiedNumber}</UnifiedNumber>`;

      const unPos =
        originalXmlContent.indexOf(unTag);

      if (unPos !== -1) {
        let personStartPos =
          originalXmlContent.lastIndexOf(
            '<Person>',
            unPos
          );

        if (personStartPos === -1) {
          personStartPos =
            originalXmlContent.lastIndexOf(
              '<Person ',
              unPos
            );
        }

        const personEndPos =
          originalXmlContent.indexOf(
            '</Person>',
            unPos
          );

        if (
          personStartPos !== -1 &&
          personEndPos !== -1
        ) {
          const originalPersonContent =
            originalXmlContent.substring(
              personStartPos,
              personEndPos +
                '</Person>'.length
            );

          personHadAmpersand =
            /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/
              .test(
                originalPersonContent
              );
        }
      }
    }

    [
      "UnifiedNumber",
      "FirstName",
      "FirstNameEn",
      "LastNameEn",
      "ContactNumber",
      "BirthDate",
      "Gender",
      "Nationality",
      "City",
      "CountryOfResidence",
      "EmirateOfResidence",
      "EmiratesIDNumber"
    ].forEach(tag => {
      invalidIfNull(
        tag,
        person
      );
    });

    if (present("EmiratesIDNumber")) {
      const eid =
        text("EmiratesIDNumber");

      const p =
        eid.split("-");

      const eidDigits =
        eid.replace(/-/g, "");

      const isAllZeros =
        /^0+$/.test(eidDigits);

      const isAllOnes =
        /^1+$/.test(eidDigits);

      const isAllTwos =
        /^2+$/.test(eidDigits);

      const isAllNines =
        /^9+$/.test(eidDigits);

      const isPlaceholderEID =
        isAllZeros ||
        isAllOnes ||
        isAllTwos ||
        isAllNines;

      if (p.length !== 4) {
        invalidFields.push(
          `EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`
        );
      } else {
        if (
          !isPlaceholderEID &&
          p[0] !== "784"
        ) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (first part must be 784)`
          );
        }

        if (!/^\d{4}$/.test(p[1])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`
          );
        }

        if (!/^\d{7}$/.test(p[2])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (third part must be 7 digits)`
          );
        }

        if (!/^\d{1}$/.test(p[3])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`
          );
        }
      }

      if (isAllZeros) {
        remarks.push(
          "Kindly confirm if the PT is a national resident."
        );
      } else if (isAllOnes) {
        remarks.push(
          "Kindly confirm if the PT is a non-national resident."
        );
      } else if (isAllTwos) {
        remarks.push(
          "Kindly confirm if the PT is a non-national and non-resident."
        );

        isUnknown = true;
      } else if (isAllNines) {
        remarks.push(
          "Kindly confirm if the PT has an unknown status."
        );

        isUnknown = true;
      }
    }

    const member =
      person.getElementsByTagName("Member")[0];

    const memberID =
      member
        ? text(
          "ID",
          member
        )
        : "Unknown";

    if (!member || !memberID) {
      invalidFields.push(
        "Member.ID (null/empty)"
      );
    }

    checkForFalseValues(
      person,
      invalidFields
    );

    if (personHadAmpersand) {
      invalidFields.push(
        AMPERSAND_REPLACEMENT_ERROR
      );
    }

    if (missingFields.length) {
      remarks.push(
        "Missing: " +
        missingFields.join(", ")
      );
    }

    if (invalidFields.length) {
      invalidFields.forEach(field => {
        remarks.push(field);
      });
    }

    if (!remarks.length) {
      remarks.push("OK");
    }

    results.push({
      ClaimID: memberID,
      Valid:
        !missingFields.length &&
        !invalidFields.length,
      Unknown: isUnknown,
      Remark:
        remarks
          .map(
            value =>
              value &&
              !value.endsWith('.')
                ? value + '.'
                : value
          )
          .join("\n"),
      ClaimXML: person.outerHTML,
      SchemaType: "person"
    });
  }

  return results;
}

function validateClaimSchema(
  xmlDoc,
  originalXmlContent = "",
  options = {}
) {
  const results = [];

  const claims =
    xmlDoc.getElementsByTagName("Claim");

  const clinicianSpecialtyMap =
    options.clinicianSpecialtyMap instanceof Map
      ? options.clinicianSpecialtyMap
      : new Map();

  const claimIdCounts =
    new Map();

  Array.from(claims)
    .forEach(claim => {
      const idEl =
        claim.getElementsByTagName("ID")[0];

      const id =
        idEl &&
        idEl.textContent
          ? idEl.textContent.trim()
          : "";

      if (id) {
        claimIdCounts.set(
          id,
          (
            claimIdCounts.get(id) ||
            0
          ) + 1
        );
      }
    });

  const duplicateClaimIds =
    new Set(
      Array.from(
        claimIdCounts.entries()
      )
        .filter(
          ([, count]) =>
            count > 1
        )
        .map(
          ([id]) =>
            id
        )
    );

  const duplicateActivityRemarksByClaim =
    buildDuplicateActivityReferenceRemarksByClaim(
      claims
    );

  const header =
    xmlDoc.querySelector("Header");

  const receiverID =
    header
      ?.querySelector("ReceiverID")
      ?.textContent
      .trim() || '';

  const missingReceiverID =
    !receiverID;

  console.log(
    `[SCHEMA] ReceiverID: ${receiverID || '(MISSING)'}`
  );

  const notMergedRemarksByClaim =
    detectNotMergedRemarksByClaim(
      claims,
      receiverID
    );

  for (const claim of claims) {
    let missingFields = [];
    let invalidFields = [];
    let remarks = [];

    let isUnknown = false;

    const present = (
      tag,
      parent = claim
    ) => {
      return (
        parent
          .getElementsByTagName(tag)
          .length > 0
      );
    };

    const text = (
      tag,
      parent = claim
    ) => {
      const el =
        parent.getElementsByTagName(tag)[0];

      return (
        el &&
        el.textContent
          ? el.textContent.trim()
          : ""
      );
    };

    const invalidIfNull = (
      tag,
      parent = claim,
      prefix = ""
    ) => {
      if (!text(tag, parent)) {
        invalidFields.push(
          prefix +
          tag +
          " (null/empty)"
        );
      }
    };

    if (missingReceiverID) {
      invalidFields.push(
        "CRITICAL ERROR: ReceiverID is missing from XML Header. This file cannot be processed."
      );
    }

    const claimID =
      text("ID");

    if (
      claimID &&
      duplicateClaimIds.has(claimID)
    ) {
      invalidFields.push(
        `Duplicate Claim ID '${claimID}' found within this submission.`
      );
    }

    const duplicateActivityRemarks =
      duplicateActivityRemarksByClaim.get(claim) ||
      [];

    duplicateActivityRemarks.forEach(remark => {
      invalidFields.push(remark);
    });

    let claimHadAmpersand = false;

    if (
      originalXmlContent &&
      claimID
    ) {
      const idTag =
        `<ID>${claimID}</ID>`;

      const idPos =
        originalXmlContent.indexOf(idTag);

      if (idPos !== -1) {
        let claimStartPos =
          originalXmlContent.lastIndexOf(
            '<Claim>',
            idPos
          );

        if (claimStartPos === -1) {
          claimStartPos =
            originalXmlContent.lastIndexOf(
              '<Claim ',
              idPos
            );
        }

        const claimEndPos =
          originalXmlContent.indexOf(
            '</Claim>',
            idPos
          );

        if (
          claimStartPos !== -1 &&
          claimEndPos !== -1
        ) {
          const originalClaimContent =
            originalXmlContent.substring(
              claimStartPos,
              claimEndPos +
                '</Claim>'.length
            );

          claimHadAmpersand =
            /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/
              .test(
                originalClaimContent
              );
        }
      }
    }

    [
      "ID",
      "MemberID",
      "PayerID",
      "ProviderID",
      "EmiratesIDNumber",
      "Gross",
      "PatientShare",
      "Net"
    ].forEach(tag => {
      invalidIfNull(
        tag,
        claim
      );
    });

    const payerID =
      text("PayerID");

    const claimNet =
      parseFloat(
        text("Net")
      );

    if (
      payerID === "A02" &&
      !Number.isNaN(claimNet) &&
      claimNet < 500
    ) {
      invalidFields.push(
        "ADNIC (A02) claim is auto-rejected because total sponsor price is under 500."
      );
    }

    const patientShareRaw =
      text("PatientShare");

    if (patientShareRaw) {
      const dotIndex =
        patientShareRaw.indexOf('.');

      if (
        dotIndex !== -1 &&
        patientShareRaw.length -
          dotIndex -
          1 >
          2
      ) {
        const rounded =
          parseFloat(
            patientShareRaw
          ).toFixed(2);

        invalidFields.push(
          `PatientShare has invalid precision: \`${patientShareRaw}\`. Should be \`${rounded}\`.`
        );
      }
    }

    let hasMedicalTourismEID = false;
    let hasResidentPlaceholderEID = false;
    let hasAllNinesEID = false;

    if (present("EmiratesIDNumber")) {
      const eid =
        text("EmiratesIDNumber");

      const p =
        eid.split("-");

      const eidDigits =
        eid.replace(/-/g, "");

      const isAllZeros =
        /^0+$/.test(eidDigits);

      const isAllOnes =
        /^1+$/.test(eidDigits);

      const isAllTwos =
        /^2+$/.test(eidDigits);

      const isAllNines =
        /^9+$/.test(eidDigits);

      const isPlaceholderEID =
        isAllZeros ||
        isAllOnes ||
        isAllTwos ||
        isAllNines;

      hasMedicalTourismEID =
        isAllTwos;

      hasResidentPlaceholderEID =
        isAllZeros ||
        isAllOnes;

      hasAllNinesEID =
        isAllNines;

      if (p.length !== 4) {
        invalidFields.push(
          `EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`
        );
      } else {
        if (
          !isPlaceholderEID &&
          p[0] !== "784"
        ) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (first part must be 784)`
          );
        }

        if (!/^\d{4}$/.test(p[1])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`
          );
        }

        if (!/^\d{7}$/.test(p[2])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (third part must be 7 digits)`
          );
        }

        if (!/^\d{1}$/.test(p[3])) {
          invalidFields.push(
            `EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`
          );
        }
      }

      if (isAllZeros) {
        remarks.push(
          "Kindly confirm if the PT is a national resident."
        );
      } else if (isAllOnes) {
        remarks.push(
          "Kindly confirm if the PT is a non-national resident."
        );
      } else if (isAllTwos) {
        remarks.push(
          "Kindly confirm if the PT is a non-national and non-resident."
        );

        isUnknown = true;
      } else if (isAllNines) {
        remarks.push(
          "Kindly confirm if the PT has an unknown status."
        );

        isUnknown = true;
      }
    }

    const encounter =
      claim.getElementsByTagName("Encounter")[0];

    if (!encounter) {
      missingFields.push("Encounter");
    } else {
      [
        "FacilityID",
        "Type",
        "PatientID",
        "Start",
        "End",
        "StartType",
        "EndType"
      ].forEach(tag => {
        invalidIfNull(
          tag,
          encounter,
          "Encounter."
        );
      });
    }

    const diagnoses =
      claim.getElementsByTagName("Diagnosis");

    if (!diagnoses.length) {
      missingFields.push("Diagnosis");
    } else {
      let principalCode = null;
      const typeCodeMap = {};

      Array.from(diagnoses)
        .forEach((diag, i) => {
          const typeVal =
            text(
              "Type",
              diag
            );

          const codeVal =
            text(
              "Code",
              diag
            );

          const prefix =
            `Diagnosis[${i}].`;

          if (!typeVal) {
            missingFields.push(
              prefix + "Type"
            );
          }

          if (!codeVal) {
            missingFields.push(
              prefix + "Code"
            );
          }

          if (typeVal === "Principal") {
            if (principalCode) {
              invalidFields.push(
                "Principal Diagnosis (multiple found)"
              );
            } else {
              principalCode = codeVal;
            }
          }

          if (
            typeVal !== "Principal" &&
            codeVal
          ) {
            if (!typeCodeMap[typeVal]) {
              typeCodeMap[typeVal] =
                new Set();
            }

            if (
              typeCodeMap[typeVal]
                .has(codeVal)
            ) {
              invalidFields.push(
                `Duplicate Diagnosis Code within Type '${typeVal}': ${codeVal}`
              );
            } else {
              typeCodeMap[typeVal]
                .add(codeVal);
            }

            if (
              principalCode &&
              codeVal === principalCode
            ) {
              invalidFields.push(
                `Diagnosis Code ${codeVal} duplicates Principal`
              );
            }
          }
        });

      if (!principalCode) {
        invalidFields.push(
          "Principal Diagnosis (none found)"
        );
      }
    }

    const activities =
      claim.getElementsByTagName("Activity");

    const specialMedicalCodes =
      new Set([
        "17999",
        "96999",
        "0232T",
        "J3490",
        "81479",
        "41899"
      ]);

    const invalidQuantityErrors =
      new Map();

    if (!activities.length) {
      invalidFields.push(
        "Kindly verify activities as there are no codes showing in the XML for this claim."
      );
    } else {
      Array.from(activities)
        .forEach((act, i) => {
          const prefix =
            `Activity[${i}].`;

          const code =
            text(
              "Code",
              act
            );

          const qty =
            text(
              "Quantity",
              act
            );

          [
            "Start",
            "Type",
            "Code",
            "Quantity",
            "Net",
            "Clinician"
          ].forEach(tag => {
            invalidIfNull(
              tag,
              act,
              prefix
            );
          });

          if (qty === "0") {
            if (
              !invalidQuantityErrors.has(qty)
            ) {
              invalidQuantityErrors.set(
                qty,
                []
              );
            }

            invalidQuantityErrors
              .get(qty)
              .push(
                code || "(unknown)"
              );
          }

          Array.from(
            act.getElementsByTagName("Observation")
          ).forEach((obs, j) => {
            [
              "Type",
              "Code"
            ].forEach(tag => {
              invalidIfNull(
                tag,
                obs,
                `${prefix}Observation[${j}].`
              );
            });
          });

          if (
            code &&
            specialMedicalCodes.has(code)
          ) {
            const observations =
              act.getElementsByTagName(
                "Observation"
              );

            Array.from(observations)
              .forEach(obs => {
                const obsType =
                  text(
                    "Type",
                    obs
                  );

                const obsValueType =
                  text(
                    "ValueType",
                    obs
                  );

                if (
                  obsType &&
                  obsType.toUpperCase() !==
                    "TEXT"
                ) {
                  invalidFields.push(
                    `Activity ${code} has invalid Observation Type of \`${obsType}\` but must be \`Text\`.`
                  );
                }

                if (
                  obsValueType &&
                  obsValueType.toUpperCase() !==
                    "TEXT"
                ) {
                  invalidFields.push(
                    `Activity ${code} has invalid Observation ValueType. Found \`${obsValueType}\` but must be \`Text\`.`
                  );
                }
              });
          }
        });
    }

    if (present("EmiratesIDNumber")) {
      let hasMedicalTourismObservation =
        false;

      activityLoop:
      for (const act of activities) {
        const observations =
          act.getElementsByTagName(
            "Observation"
          );

        for (const obs of observations) {
          const obsDescription =
            text(
              "Description",
              obs
            ) || "";

          const obsCode =
            text(
              "Code",
              obs
            ) || "";

          const obsValue =
            text(
              "Value",
              obs
            ) || "";

          const observationText =
            (
              obsDescription +
              obsCode +
              obsValue
            ).toUpperCase();

          if (
            observationText.includes(
              "MEDICALTOURISM"
            )
          ) {
            hasMedicalTourismObservation =
              true;

            break activityLoop;
          }
        }
      }

      if (hasResidentPlaceholderEID) {
        if (
          hasMedicalTourismObservation
        ) {
          invalidFields.push(
            "EID indicates a resident patient (000/111); claim can only be Self-Pay. Kindly remove the Medical Tourism observation."
          );
        }
      } else if (hasMedicalTourismEID) {
        if (
          !hasMedicalTourismObservation
        ) {
          invalidFields.push(
            "EID indicates a non-national non-resident (222); claim can only be Medical Tourism. Kindly add a Medical Tourism observation."
          );
        }
      } else if (!hasAllNinesEID) {
        if (
          hasMedicalTourismObservation
        ) {
          invalidFields.push(
            "Kindly clarify if patient is Medical Tourism as EID does not reflect this."
          );
        }
      }
    }

    for (
      const [quantity, codes]
      of invalidQuantityErrors
    ) {
      if (codes.length === 1) {
        invalidFields.push(
          `Activity ${codes[0]} has invalid quantity of ${quantity}.`
        );
      } else if (codes.length === 2) {
        invalidFields.push(
          `Activities ${codes[0]} and ${codes[1]} have invalid quantities of ${quantity}.`
        );
      } else {
        const lastCode =
          codes[codes.length - 1];

        const otherCodes =
          codes
            .slice(0, -1)
            .join(" ");

        invalidFields.push(
          `Activities ${otherCodes} and ${lastCode} have invalid quantities of ${quantity}.`
        );
      }
    }

    checkSpecialActivityDiagnosis(
      activities,
      diagnoses,
      text,
      invalidFields
    );

    checkImplantActivityDiagnosis(
      activities,
      diagnoses,
      text,
      invalidFields
    );

    const facilityID =
      encounter
        ? text(
          "FacilityID",
          encounter
        )
        : "";

    checkGTLicenseValidation(
      activities,
      facilityID,
      text,
      invalidFields
    );

    const encounterType =
      encounter
        ? text(
          "Type",
          encounter
        )
        : "";

    const selectedClaimTypeMode =
      String(
        options.claimTypeMode || ''
      )
        .trim()
        .toUpperCase();

    const isMedicalClaim =
      selectedClaimTypeMode
        ? selectedClaimTypeMode ===
          'MEDICAL'
        : String(
          encounterType || ''
        ).trim() === '3';

    validateConsultationAndSpecialtyRules(
      activities,
      text,
      invalidFields,
      clinicianSpecialtyMap,
      {
        isMedicalClaim
      }
    );

    validateMedicalOrderingConsistency(
      activities,
      text,
      invalidFields,
      {
        isMedicalClaim
      }
    );

    const contract =
      claim.getElementsByTagName(
        "Contract"
      )[0];

    if (
      contract &&
      !text(
        "PackageName",
        contract
      )
    ) {
      invalidFields.push(
        "Contract.PackageName (null/empty)"
      );
    }

    checkForFalseValues(
      claim,
      invalidFields,
      "Claim."
    );

    if (claimHadAmpersand) {
      invalidFields.push(
        AMPERSAND_REPLACEMENT_ERROR
      );
    }

    if (
      claimID &&
      notMergedRemarksByClaim.has(claimID)
    ) {
      const notMergedRemarks =
        notMergedRemarksByClaim.get(claimID) ||
        [];

      notMergedRemarks.forEach(remark => {
        invalidFields.push(remark);
      });
    }

    if (missingFields.length) {
      remarks.push(
        "Missing: " +
        missingFields.join(", ")
      );
    }

    if (invalidFields.length) {
      invalidFields.forEach(field => {
        remarks.push(field);
      });
    }

    if (!remarks.length) {
      remarks.push("OK");
    }

    results.push({
      ClaimID:
        text("ID") || "Unknown",
      Valid:
        !missingFields.length &&
        !invalidFields.length,
      Unknown: isUnknown,
      Remark:
        remarks
          .map(
            value =>
              value &&
              !value.endsWith('.')
                ? value + '.'
                : value
          )
          .join("\n"),
      ClaimXML: claim.outerHTML,
      SchemaType: "claim"
    });
  }

  return results;
}

    // ========================================================================
    // RESULT RENDERING
    // ========================================================================

function renderResults(
  results,
  schemaType,
  options = {}
) {
  const safeResults =
    Array.isArray(results)
      ? results.slice()
      : [];

  window._lastValidationResults =
    safeResults;

  window._lastValidationSchema =
    schemaType || "claim";

  window._lastValidationFileName =
    options.fileName || '';

  const idLabel =
    schemaType === "person"
      ? "Member ID"
      : "Claim ID";

  const table =
    document.createElement('table');

  table.className =
    'table table-striped table-bordered';

  table.style.borderCollapse =
    'collapse';

  table.style.width =
    '100%';

  table.dataset.schemaType =
    schemaType || 'claim';

  table.dataset.sourceFileName =
    options.fileName || '';

  const tableHTML = `
    <thead>
      <tr>
        <th style="padding:8px;border:1px solid #ccc">${idLabel}</th>
        <th style="padding:8px;border:1px solid #ccc">Remark</th>
        <th style="padding:8px;border:1px solid #ccc">Valid</th>
        <th style="padding:8px;border:1px solid #ccc">View Full Entry</th>
      </tr>
    </thead>
    <tbody>
      ${safeResults.map((row, index) => {
        const rowClass =
          row.Unknown
            ? 'table-warning'
            : (
              row.Valid
                ? 'table-success'
                : 'table-danger'
            );

        return `
          <tr class="${rowClass}">
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.ClaimID)}</td>
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.Remark)}</td>
            <td style="padding:6px;border:1px solid #ccc">${row.Valid ? "Yes" : "No"}</td>
            <td style="padding:6px;border:1px solid #ccc">
              <button
                class="view-claim-btn"
                data-index="${index}"
                data-claim-xml="${encodeURIComponent(row.ClaimXML || '')}"
              >
                View
              </button>
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;

  table.innerHTML =
    tableHTML;

  safeResults.forEach((row, index) => {
    const btn =
      table.querySelector(
        `.view-claim-btn[data-index="${index}"]`
      );

    if (btn) {
      btn.onclick = () => {
        showModal(
          claimToHtmlTable(
            row.ClaimXML
          )
        );
      };
    }
  });

  return table;
}

    // ========================================================================
    // MAIN SCHEMA CHECKER ENTRY POINT
    // ========================================================================

function validateXmlSchema(options = {}) {
  const container =
    options.container || null;

  const status =
    getScopedElement(
      container,
      '[data-role="schema-status"], #uploadStatus'
    );

  if (status) {
    status.textContent = "";
  }

  const fileInput =
    getScopedElement(
      container,
      '[data-role="schema-xml-file"], #xmlFile'
    );

  let file =
    options.file ||
    fileInput?.files?.[0];

  if (
    !file &&
    window.unifiedCheckerFiles &&
    window.unifiedCheckerFiles.xml
  ) {
    file =
      window.unifiedCheckerFiles.xml;

    console.log(
      '[SCHEMA] Using XML file from unified cache:',
      file.name
    );
  }

  if (!file) {
    if (status) {
      status.textContent =
        "Please select an XML file first.";
    }

    return buildSchemaMessageElement(
      'Schema Checker failed: Please select an XML file first.'
    );
  }

  return new Promise(resolve => {
    const reader =
      new FileReader();

    reader.onload =
      async function(e) {
        try {
          const originalXmlContent =
            e.target.result;

          const xmlContent =
            originalXmlContent.replace(
              /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
              "and"
            );

          const parser =
            new DOMParser();

          const xmlDoc =
            parser.parseFromString(
              xmlContent,
              "application/xml"
            );

          const parseErrors =
            xmlDoc.getElementsByTagName(
              "parsererror"
            );

          if (parseErrors.length > 0) {
            console.log(
              '[SCHEMA] XML parsing error detected'
            );

            if (status) {
              status.textContent =
                "XML Parsing Error: The file is not well-formed.";
            }

            const errorDiv =
              buildSchemaMessageElement(
                `Schema Checker failed: XML Parsing Error: ${parseErrors[0].textContent}`
              );

            resolve(errorDiv);
            return;
          }

          let results = [];
          let schemaType = "";

          if (
            xmlDoc.documentElement.nodeName ===
            "Claim.Submission"
          ) {
            schemaType = "claim";

            console.log(
              '[SCHEMA] Validating Claim schema'
            );

            const clinicianSpecialtyMap =
              await loadClinicianSpecialtyMap();

            const claimTypeMode =
              String(
                options.claimTypeMode ||
                getSelectedClaimTypeMode() ||
                ''
              )
                .trim()
                .toUpperCase();

            results =
              validateClaimSchema(
                xmlDoc,
                originalXmlContent,
                {
                  clinicianSpecialtyMap,
                  claimTypeMode
                }
              );

            results =
              await applyTariffOccurrenceLimits(
                xmlDoc,
                results
              );

            console.log(
              '[SCHEMA] Claim validation complete, results count:',
              results.length
            );
          } else if (
            xmlDoc.documentElement.nodeName ===
            "Person.Register"
          ) {
            schemaType = "person";

            console.log(
              '[SCHEMA] Validating Person schema'
            );

            results =
              validatePersonSchema(
                xmlDoc,
                originalXmlContent
              );

            console.log(
              '[SCHEMA] Person validation complete, results count:',
              results.length
            );
          } else {
            console.log(
              '[SCHEMA] Unknown schema type:',
              xmlDoc.documentElement.nodeName
            );

            if (status) {
              status.textContent =
                "Unknown schema: " +
                xmlDoc.documentElement.nodeName;
            }

            resolve(
              buildSchemaMessageElement(
                `Schema Checker failed: Unknown schema: ${xmlDoc.documentElement.nodeName}`
              )
            );

            return;
          }

          console.log(
            '[SCHEMA] Rendering results table...'
          );

          const tableElement =
            renderResults(
              results,
              schemaType,
              {
                fileName:
                  file.name || ''
              }
            );

          console.log(
            '[SCHEMA] Table element created:',
            tableElement
              ? 'success'
              : 'failed'
          );

          const total =
            results.length;

          const valid =
            results.filter(
              row =>
                row.Valid
            ).length;

          const percent =
            total > 0
              ? (
                (
                  valid /
                  total
                ) *
                100
              ).toFixed(1)
              : "0.0";

          if (status) {
            status.textContent =
              `Valid ${schemaType === "claim" ? "claims" : "persons"}: ` +
              `${valid} / ${total} (${percent}%)`;
          }

          console.log(
            '[SCHEMA] Resolving with table element'
          );

          resolve(tableElement);
        } catch (error) {
          console.error(
            '[SCHEMA] Error during validation:',
            error
          );

          if (status) {
            status.textContent =
              "Error: " +
              error.message;
          }

          resolve(
            buildSchemaMessageElement(
              `Schema Checker failed: ${error.message}`
            )
          );
        }
      };

    reader.onerror =
      function() {
        console.error(
          '[SCHEMA] FileReader error'
        );

        if (status) {
          status.textContent =
            "Error reading the file.";
        }

        resolve(
          buildSchemaMessageElement(
            'Schema Checker failed: Error reading the file.'
          )
        );
      };

    reader.readAsText(file);
  });
}

    // ========================================================================
    // PUBLIC API EXPORTS
    // ========================================================================

    window.validateXmlSchema =
      validateXmlSchema;

    window.showModal =
      showModal;

    window.hideModal =
      hideModal;

    window.claimToHtmlTable =
      claimToHtmlTable;

    window.ensureModal =
      ensureModal;

    window.exportErrorsToXLSX =
      exportErrorsToXLSX;

    window.NOT_MERGED_RECEIVER_IDS =
      Array.from(
        NOT_MERGED_RECEIVER_IDS
      );

    window._schemaNotMergedUtils = {
      CLAIM_NOT_MERGED,
      parseEncounterDateTime,
      buildNotMergedRemarksFromContexts
    };

    window._schemaTestApi = {
      validateXmlSchema,
      renderResults,
      validateMedicalOrderingConsistency,
      validateConsultationAndSpecialtyRules,
      applyTariffOccurrenceLimits,
      buildDuplicateActivityReferenceRemarksByClaim
    };
  } catch (error) {
    console.error(
      '[CHECKER-ERROR] Failed to load checker:',
      error
    );

    console.error(error.stack);
  }
})();
