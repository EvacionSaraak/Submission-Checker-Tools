(function() {
  try {
    ':contentReference[oaicite:1]{index=1} with modal table view, Person schema support,
    // medical consistency rules, pregnancy diagnosis validation,
    // global Activity ID validation, and Mandatory Tariff occurrence limits.
    //
    // Expected resources:
    // ../json/clinician_licenses.json
    // ../json/pregnancy_diagnosis_codes.json
    //
    // Expected globals:
    // XLSX
    // window.MandatoryTariffShared

    const AMPERSAND_REPLACEMENT_ERROR =
      "Please replace `&` in the observations to `and` because this will cause error.";

    const CLAIM_NOT_MERGED = "CLAIM_NOT_MERGED";

    const NOT_MERGED_RECEIVER_IDS =
      new Set(['D001', 'A001', 'D004']);

    const CONSULTATION_CODE_REGEX =
      /^(92|992)/;

    const GP_992_REQUIRED_CODES =
      new Set(['99202', '99212']);

    const GP_992_FORBIDDEN_CODES =
      new Set(['99203', '99213']);

    const GP_992_CODES =
      new Set(['99202', '99203', '99212', '99213']);

    const MUTUALLY_EXCLUSIVE_INFUSION_CODES =
      new Set(['96360', '96365', '96374']);

    const INVALID_ACTIVITY_CODES =
      new Set(['36591']);

    const OLD_DUPLICATE_ORDERING_PATTERN =
      /^Duplicate code\s+.+?\s+with Ordering Clinician\s+.+?\.?$/i;

    const OK_REMARK_PATTERN =
      /^OK\.?$/i;

    let clinicianSpecialtyMapPromise = null;
    let pregnancyDiagnosisDataPromise = null;

    // =====================================================================
    // DISPLAY AND EXPORT
    // =====================================================================

    function sanitizeForHTML(value) {
      if (value == null) return '';

      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function ensureModal() {
      if (document.getElementById('modalOverlay')) {
        return;
      }

      const modalHTML = `
        <div
          id="modalOverlay"
          style="
            display:none;
            position:fixed;
            z-index:9999;
            left:0;
            top:0;
            width:100vw;
            height:100vh;
            background:rgba(0,0,0,0.35);
          "
        >
          <div
            id="modalContent"
            style="
              background:#fff;
              width:90%;
              max-width:1000px;
              max-height:95vh;
              overflow:auto;
              position:absolute;
              left:50%;
              top:50%;
              transform:translate(-50%,-50%);
              padding:20px;
              border-radius:8px;
              box-shadow:0 6px 18px rgba(0,0,0,0.2);
            "
          >
            <button
              id="modalCloseBtn"
              style="
                float:right;
                font-size:18px;
                padding:2px 10px;
                cursor:pointer;
              "
              aria-label="Close"
            >
              &times;
            </button>

            <div id="modalTable"></div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML(
        'beforeend',
        modalHTML
      );

      const closeButton =
        document.getElementById('modalCloseBtn');

      const overlay =
        document.getElementById('modalOverlay');

      if (closeButton) {
        closeButton.onclick = hideModal;
      }

      if (overlay) {
        overlay.onclick = event => {
          if (event.target === overlay) {
            hideModal();
          }
        };
      }
    }

    function showModal(html) {
      ensureModal();

      const modalTable =
        document.getElementById('modalTable');

      const overlay =
        document.getElementById('modalOverlay');

      if (modalTable) {
        modalTable.innerHTML = html;
      }

      if (overlay) {
        overlay.style.display = 'block';
      }
    }

    function hideModal() {
      const overlay =
        document.getElementById('modalOverlay');

      if (overlay) {
        overlay.style.display = 'none';
      }
    }

    function claimToHtmlTable(xmlString) {
      const parser =
        new DOMParser();

      const documentXML =
        parser.parseFromString(
          xmlString,
          'application/xml'
        );

      let root =
        documentXML.documentElement;

      if (
        root.nodeName !== 'Claim' &&
        root.nodeName !== 'Person'
      ) {
        root =
          documentXML.getElementsByTagName('Claim')[0] ||
          documentXML.getElementsByTagName('Person')[0];
      }

      if (!root) {
        return '<b>Entry not found!</b>';
      }

      function renderNode(node, level = 0) {
        let html = '';

        Array.from(node.children || []).forEach(child => {
          const padding =
            level * 20;

          if (!child.children.length) {
            html += `
              <tr>
                <td style="padding-left:${padding}px">
                  <b>${sanitizeForHTML(child.nodeName)}</b>
                </td>
                <td>${sanitizeForHTML(child.textContent)}</td>
              </tr>
            `;
          } else {
            html += `
              <tr>
                <td style="padding-left:${padding}px">
                  <b>${sanitizeForHTML(child.nodeName)}</b>
                </td>
                <td></td>
              </tr>
            `;

            html += renderNode(
              child,
              level + 1
            );
          }
        });

        return html;
      }

      return `
        <table
          border="1"
          cellpadding="4"
          style="
            border-collapse:collapse;
            font-family:sans-serif;
            font-size:14px;
          "
        >
          <tr>
            <th style="background:#f0f0f0">Field</th>
            <th style="background:#f0f0f0">Value</th>
          </tr>

          ${renderNode(root)}
        </table>
      `;
    }

    function exportErrorsToXLSX(data, schemaType) {
      const rows =
        Array.isArray(data)
          ? data
          : (
              Array.isArray(window._lastValidationResults)
                ? window._lastValidationResults
                : []
            );

      const schema =
        schemaType ||
        window._lastValidationSchema ||
        'claim';

      if (!rows.length) {
        alert('No results available to export.');
        return;
      }

      if (typeof XLSX === 'undefined') {
        console.error(
          'SheetJS (XLSX) is not loaded.'
        );

        alert(
          'Export failed: XLSX library not loaded.'
        );

        return;
      }

      const errorRows =
        rows.filter(row =>
          !OK_REMARK_PATTERN.test(
            String(row?.Remark || '').trim()
          )
        );

      if (!errorRows.length) {
        alert('No errors to export.');
        return;
      }

      const identifierHeader =
        schema === 'person'
          ? 'UnifiedNumber'
          : 'ClaimID';

      const exportData =
        errorRows.map(row => ({
          [identifierHeader]: row.ClaimID,
          Remark: row.Remark
        }));

      const storedFileName =
        window._lastValidationFileName || '';

      const fileInput =
        document.getElementById('xmlFile');

      let fileName;

      if (storedFileName) {
        fileName =
          storedFileName.replace(/\.[^/.]+$/, '') +
          '_errors.xlsx';
      } else if (
        fileInput?.files?.[0]?.name
      ) {
        fileName =
          fileInput.files[0].name
            .replace(/\.[^/.]+$/, '') +
          '_errors.xlsx';
      } else {
        const timestamp =
          new Date()
            .toISOString()
            .replace(/[:.]/g, '-');

        fileName =
          `${schema}_errors_${timestamp}.xlsx`;
      }

      try {
        const worksheet =
          XLSX.utils.json_to_sheet(exportData);

        const workbook =
          XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(
          workbook,
          worksheet,
          'Errors'
        );

        XLSX.writeFile(
          workbook,
          fileName
        );
      } catch (error) {
        console.error(
          'Export failed:',
          error
        );

        alert(
          'Export failed. See the console for details.'
        );
      }
    }

    // =====================================================================
    // GENERAL HELPERS
    // =====================================================================

    function normalizeSpecialty(value) {
      return String(value || '')
        .trim()
        .toUpperCase();
    }

    function normalizeDiagnosisCode(value) {
      return String(value == null ? '' : value)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
    }

    function formatNaturalList(values) {
      const items =
        Array.from(values || [])
          .filter(Boolean);

      if (!items.length) {
        return '';
      }

      if (items.length === 1) {
        return items[0];
      }

      if (items.length === 2) {
        return `${items[0]} and ${items[1]}`;
      }

      return (
        `${items.slice(0, -1).join(', ')}, ` +
        `and ${items[items.length - 1]}`
      );
    }

    function getScopedElement(
      container,
      selector
    ) {
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
        typeof document !== 'undefined' &&
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
      const element =
        document.createElement('div');

      element.className =
        className;

      element.textContent =
        message;

      return element;
    }

    function safeTextByTag(
      parent,
      tagName
    ) {
      if (!parent) {
        return '';
      }

      const element =
        parent.getElementsByTagName(tagName)[0];

      return element?.textContent
        ? element.textContent.trim()
        : '';
    }

    function getDirectChildElement(
      parent,
      tagName
    ) {
      return (
        Array.from(parent?.children || [])
          .find(child =>
            String(
              child?.nodeName ||
              child?.tagName ||
              ''
            ).trim() === tagName
          ) ||
        null
      );
    }

    function getDirectChildText(
      parent,
      tagName
    ) {
      const child =
        getDirectChildElement(
          parent,
          tagName
        );

      return String(
        child?.textContent || ''
      ).trim();
    }

    function getSelectedClaimTypeMode() {
      const medical =
        document.getElementById(
          'claimTypeMedical'
        );

      const dental =
        document.getElementById(
          'claimTypeDental'
        );

      if (medical?.checked) {
        return 'MEDICAL';
      }

      if (dental?.checked) {
        return 'DENTAL';
      }

      return null;
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
        Number.parseInt(match[1], 10);

      const month =
        Number.parseInt(match[2], 10);

      const year =
        Number.parseInt(match[3], 10);

      const hour =
        Number.parseInt(match[4], 10);

      const minute =
        Number.parseInt(match[5], 10);

      if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
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
          `${String(year).padStart(4, '0')}-` +
          `${String(month).padStart(2, '0')}-` +
          `${String(day).padStart(2, '0')}`,

        timestamp:
          date.getTime()
      };
    }

    // =====================================================================
    // CLINICIAN SPECIALTIES
    // =====================================================================

    function loadClinicianSpecialtyMap() {
      if (clinicianSpecialtyMapPromise) {
        return clinicianSpecialtyMapPromise;
      }

      clinicianSpecialtyMapPromise =
        fetch(
          '../json/clinician_licenses.json',
          { cache: 'no-store' }
        )
          .then(response => {
            if (!response.ok) {
              throw new Error(
                `Failed to load clinician specialties ` +
                `(HTTP ${response.status}).`
              );
            }

            return response.json();
          })
          .then(rows => {
            const map =
              new Map();

            (
              Array.isArray(rows)
                ? rows
                : []
            ).forEach(row => {
              const license =
                String(
                  row?.['Phy Lic'] || ''
                )
                  .trim()
                  .toUpperCase();

              if (!license) {
                return;
              }

              const specialty =
                String(
                  row?.Specialty || ''
                ).trim();

              if (
                !map.has(license) ||
                specialty
              ) {
                map.set(
                  license,
                  specialty
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

    // =====================================================================
    // PREGNANCY DIAGNOSIS JSON
    // =====================================================================

    async function fetchFirstAvailableJSON(paths) {
      const failures = [];

      for (const path of paths) {
        try {
          const response =
            await fetch(
              path,
              { cache: 'no-store' }
            );

          if (!response.ok) {
            failures.push(
              `${path}: HTTP ${response.status}`
            );

            continue;
          }

          return {
            path,
            data:
              await response.json()
          };
        } catch (error) {
          failures.push(
            `${path}: ` +
            `${error?.message || String(error)}`
          );
        }
      }

      throw new Error(
        'Pregnancy diagnosis code data could not be loaded. ' +
        failures.join(' | ')
      );
    }

    function loadPregnancyDiagnosisData() {
      if (pregnancyDiagnosisDataPromise) {
        return pregnancyDiagnosisDataPromise;
      }

      const paths = [
        '../json/pregnancy_diagnosis_codes.json',
        './json/pregnancy_diagnosis_codes.json',
        'json/pregnancy_diagnosis_codes.json'
      ];

      pregnancyDiagnosisDataPromise =
        fetchFirstAvailableJSON(paths)
          .then(({ path, data }) => {
            if (
              !data ||
              typeof data !== 'object'
            ) {
              throw new Error(
                'Pregnancy diagnosis JSON must contain an object.'
              );
            }

            if (
              !Array.isArray(data.zCodes) ||
              !Array.isArray(data.oCodes)
            ) {
              throw new Error(
                'Pregnancy diagnosis JSON must contain ' +
                'zCodes and oCodes arrays.'
              );
            }

            function buildCodeMap(
              rows,
              listName
            ) {
              const map =
                new Map();

              rows.forEach(
                (row, index) => {
                  const code =
                    normalizeDiagnosisCode(
                      row?.code
                    );

                  const trimester =
                    Number(row?.trimester);

                  const description =
                    String(
                      row?.description || ''
                    ).trim();

                  if (!code) {
                    throw new Error(
                      `${listName}[${index}] has no code.`
                    );
                  }

                  if (
                    ![0, 1, 2, 3]
                      .includes(trimester)
                  ) {
                    throw new Error(
                      `${listName}[${index}] ` +
                      `(${row?.code || code}) ` +
                      `has invalid trimester ` +
                      `${row?.trimester}.`
                    );
                  }

                  if (map.has(code)) {
                    throw new Error(
                      `${listName} contains duplicate code ` +
                      `${row?.code || code}.`
                    );
                  }

                  map.set(code, {
                    code:
                      String(
                        row?.code || code
                      )
                        .trim()
                        .toUpperCase(),

                    normalizedCode:
                      code,

                    description,

                    trimester
                  });
                }
              );

              return map;
            }

            const trimesterLabels =
              new Map([
                [0, 'Unspecified trimester'],
                [1, 'First trimester'],
                [2, 'Second trimester'],
                [3, 'Third trimester']
              ]);

            if (
              data.trimesterValues &&
              typeof data.trimesterValues === 'object'
            ) {
              Object.entries(
                data.trimesterValues
              ).forEach(
                ([key, value]) => {
                  const trimester =
                    Number(key);

                  const label =
                    String(value || '')
                      .trim();

                  if (
                    [0, 1, 2, 3]
                      .includes(trimester) &&
                    label
                  ) {
                    trimesterLabels.set(
                      trimester,
                      label
                    );
                  }
                }
              );
            }

            const parsed = {
              sourcePath:
                path,

              zCodes:
                buildCodeMap(
                  data.zCodes,
                  'zCodes'
                ),

              oCodes:
                buildCodeMap(
                  data.oCodes,
                  'oCodes'
                ),

              trimesterLabels
            };

            console.log(
              `[SCHEMA][PREGNANCY] Loaded ` +
              `${parsed.zCodes.size} Z-codes and ` +
              `${parsed.oCodes.size} O-codes from ` +
              `${path}.`
            );

            return parsed;
          })
          .catch(error => {
            pregnancyDiagnosisDataPromise =
              null;

            throw error;
          });

      return pregnancyDiagnosisDataPromise;
    }

    function formatPregnancyEntry(
      entry,
      trimesterLabels
    ) {
      const label =
        trimesterLabels.get(
          entry.trimester
        ) ||
        `Trimester ${entry.trimester}`;

      return `${entry.code} (${label})`;
    }

    function checkPregnancyDiagnosisTrimesterConsistency(
      diagnoses,
      getText,
      invalidFields,
      pregnancyData
    ) {
      if (!pregnancyData) {
        return;
      }

      try {
        const normalizedCodes =
          Array.from(diagnoses || [])
            .map(diagnosis =>
              normalizeDiagnosisCode(
                getText(
                  'Code',
                  diagnosis
                )
              )
            )
            .filter(Boolean);

        const uniqueCodes =
          Array.from(
            new Set(normalizedCodes)
          );

        const pregnancyZCodes =
          uniqueCodes
            .map(code =>
              pregnancyData.zCodes.get(code)
            )
            .filter(Boolean);

        if (!pregnancyZCodes.length) {
          return;
        }

        const pregnancyOCodes =
          uniqueCodes
            .map(code =>
              pregnancyData.oCodes.get(code)
            )
            .filter(Boolean);

        const zTrimesters =
          Array.from(
            new Set(
              pregnancyZCodes.map(
                entry => entry.trimester
              )
            )
          );

        if (zTrimesters.length > 1) {
          invalidFields.push(
            'Pregnancy Z-codes indicate conflicting trimesters: ' +
            formatNaturalList(
              pregnancyZCodes.map(entry =>
                formatPregnancyEntry(
                  entry,
                  pregnancyData.trimesterLabels
                )
              )
            )
          );

          return;
        }

        const requiredTrimester =
          zTrimesters[0];

        const requiredLabel =
          pregnancyData.trimesterLabels.get(
            requiredTrimester
          ) ||
          `Trimester ${requiredTrimester}`;

        const zCodeDisplay =
          formatNaturalList(
            pregnancyZCodes.map(
              entry => entry.code
            )
          );

        pregnancyOCodes.forEach(entry => {
          if (
            entry.trimester ===
            requiredTrimester
          ) {
            return;
          }

          const actualLabel =
            pregnancyData.trimesterLabels.get(
              entry.trimester
            ) ||
            `Trimester ${entry.trimester}`;

          invalidFields.push(
            `Pregnancy trimester mismatch: ` +
            `${zCodeDisplay} indicates ${requiredLabel}, ` +
            `but ${entry.code} indicates ${actualLabel}.`
          );
        });
      } catch (error) {
        console.error(
          '[SCHEMA][PREGNANCY] Validation failed:',
          error
        );

        invalidFields.push(
          `Pregnancy diagnosis validation failed: ` +
          `${error?.message || String(error)}`
        );
      }
    }

    // =====================================================================
    // GLOBAL ACTIVITY ID UNIQUENESS
    // =====================================================================

    function buildDuplicateActivityReferenceRemarksByClaim(
      claims
    ) {
      const occurrencesByID =
        new Map();

      Array.from(claims || [])
        .forEach(claim => {
          const claimID =
            getDirectChildText(
              claim,
              'ID'
            ) ||
            'Unknown';

          const activities =
            Array.from(
              claim?.children || []
            ).filter(child =>
              String(
                child?.nodeName ||
                child?.tagName ||
                ''
              ).trim() === 'Activity'
            );

          activities.forEach(activity => {
            const activityID =
              getDirectChildText(
                activity,
                'ID'
              )
                .trim()
                .toUpperCase();

            if (!activityID) {
              return;
            }

            if (
              !occurrencesByID.has(
                activityID
              )
            ) {
              occurrencesByID.set(
                activityID,
                []
              );
            }

            occurrencesByID
              .get(activityID)
              .push({
                claim,
                claimID,
                activityID
              });
          });
        });

      const remarksByClaim =
        new Map();

      occurrencesByID.forEach(
        (occurrences, activityID) => {
          if (occurrences.length < 2) {
            return;
          }

          occurrences.forEach(current => {
            const otherClaimIDs =
              Array.from(
                new Set(
                  occurrences
                    .filter(item =>
                      item !== current
                    )
                    .map(item =>
                      item.claimID
                    )
                    .filter(Boolean)
                )
              ).sort();

            if (!otherClaimIDs.length) {
              return;
            }

            if (
              !remarksByClaim.has(
                current.claim
              )
            ) {
              remarksByClaim.set(
                current.claim,
                []
              );
            }

            const remark =
              `Activity reference ${activityID} ` +
              `already exists in ` +
              `${formatNaturalList(otherClaimIDs)}.`;

            const remarks =
              remarksByClaim.get(
                current.claim
              );

            if (!remarks.includes(remark)) {
              remarks.push(remark);
            }
          });
        }
      );

      return remarksByClaim;
    }

    // =====================================================================
    // MANDATORY TARIFF OCCURRENCE LIMITS
    // =====================================================================

    function cleanSchemaRemarkLines(remark) {
      return String(
        remark == null ? '' : remark
      )
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line =>
          !OLD_DUPLICATE_ORDERING_PATTERN
            .test(line)
        );
    }

    function groupTariffFindingsByClaim(
      findings
    ) {
      const grouped =
        new Map();

      Array.from(findings || [])
        .forEach(finding => {
          const claimID =
            String(
              finding?.claimID ||
              'Unknown'
            ).trim();

          if (!grouped.has(claimID)) {
            grouped.set(claimID, []);
          }

          grouped
            .get(claimID)
            .push(finding);
        });

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
        originalLines.some(line =>
          OLD_DUPLICATE_ORDERING_PATTERN
            .test(line)
        );

      let lines =
        cleanSchemaRemarkLines(
          result?.Remark
        ).filter(line =>
          !OK_REMARK_PATTERN.test(line)
        );

      Array.from(findings || [])
        .forEach(finding => {
          const remark =
            String(
              finding?.remark || ''
            ).trim();

          if (
            remark &&
            !lines.includes(remark)
          ) {
            lines.push(remark);
          }
        });

      if (findings?.length) {
        result.Valid = false;
        result.Unknown = false;
      } else if (
        removedLegacyDuplicate &&
        !lines.length
      ) {
        result.Valid = true;
        result.Unknown = false;
      }

      result.Remark =
        lines.length
          ? lines.join('\n')
          : 'OK';

      result.TariffOccurrenceFindings =
        Array.from(findings || []);

      return result;
    }

    async function applyTariffOccurrenceLimits(
      xmlDocument,
      results,
      options = {}
    ) {
      const claimTypeMode =
        String(
          options.claimTypeMode ||
          getSelectedClaimTypeMode() ||
          ''
        )
          .trim()
          .toUpperCase();

      // Dental and Medical can share identical numeric codes.
      // Medical MUE limits must therefore not run on Dental claims.
      if (claimTypeMode === 'DENTAL') {
        window._lastTariffOccurrenceFindings =
          [];

        console.log(
          '[SCHEMA][TARIFF] Skipped occurrence limits because Dental is selected.'
        );

        return results;
      }

      if (!window.MandatoryTariffShared) {
        throw new Error(
          'MandatoryTariffShared is unavailable. ' +
          'Load mandatory_tariff_shared.js before checker_schema.js.'
        );
      }

      const tariffData =
        await window.MandatoryTariffShared
          .loadBundledMandatoryTariff();

      Array.from(
        tariffData.warnings || []
      ).forEach(warning =>
        console.warn(
          '[SCHEMA][TARIFF]',
          warning
        )
      );

      const findings =
        window.MandatoryTariffShared
          .validateSubmissionOccurrenceLimits(
            xmlDocument,
            tariffData.map
          );

      const findingsByClaim =
        groupTariffFindingsByClaim(
          findings
        );

      Array.from(results || [])
        .forEach(result => {
          const claimID =
            String(
              result?.ClaimID ||
              'Unknown'
            ).trim();

          applyTariffFindingsToResult(
            result,
            findingsByClaim.get(claimID) || []
          );
        });

      window._lastTariffOccurrenceFindings =
        findings;

      console.log(
        `[SCHEMA][TARIFF] Applied MUE limits from ` +
        `${tariffData.sheetName}. ` +
        `Findings: ${findings.length}; ` +
        `rows: ${tariffData.rows.length}; ` +
        `source: ${tariffData.path}`
      );

      return results;
    }

    // =====================================================================
    // CROSS-CLAIM MERGE DETECTION
    // =====================================================================

    function collectNotMergedClaimContext(
      claim,
      receiverID = ''
    ) {
      const encounter =
        claim.getElementsByTagName(
          'Encounter'
        )[0] ||
        null;

      const startRaw =
        safeTextByTag(
          encounter,
          'Start'
        );

      const endRaw =
        safeTextByTag(
          encounter,
          'End'
        );

      const parsedStart =
        parseEncounterDateTime(startRaw);

      const parsedEnd =
        parseEncounterDateTime(endRaw);

      const clinicians =
        new Set();

      Array.from(
        claim.getElementsByTagName(
          'Activity'
        )
      ).forEach(activity => {
        const clinician =
          safeTextByTag(
            activity,
            'OrderingClinician'
          ).toUpperCase();

        if (clinician) {
          clinicians.add(clinician);
        }
      });

      const diagnoses =
        new Set();

      Array.from(
        claim.getElementsByTagName(
          'Diagnosis'
        )
      ).forEach(diagnosis => {
        const code =
          normalizeDiagnosisCode(
            safeTextByTag(
              diagnosis,
              'Code'
            )
          );

        if (code) {
          diagnoses.add(code);
        }
      });

      return {
        receiverID:
          String(receiverID || '')
            .trim()
            .toUpperCase(),

        claimID:
          safeTextByTag(
            claim,
            'ID'
          ),

        memberID:
          safeTextByTag(
            claim,
            'MemberID'
          ).toUpperCase(),

        providerID:
          safeTextByTag(
            claim,
            'ProviderID'
          ).toUpperCase(),

        facilityID:
          safeTextByTag(
            encounter,
            'FacilityID'
          ).toUpperCase(),

        encounterDate:
          parsedStart?.dateKey ||
          parsedEnd?.dateKey ||
          null,

        startRaw,
        endRaw,
        parsedStart,
        parsedEnd,
        clinicians,
        diagnoses
      };
    }

    function buildNotMergedRemarksFromContexts(
      contexts
    ) {
      const grouped =
        new Map();

      Array.from(contexts || [])
        .forEach(context => {
          if (
            !context.memberID ||
            !context.providerID ||
            !context.facilityID ||
            !context.encounterDate
          ) {
            return;
          }

          if (
            !NOT_MERGED_RECEIVER_IDS.has(
              context.receiverID
            )
          ) {
            return;
          }

          const groupKey = [
            context.receiverID,
            context.memberID,
            context.providerID,
            context.facilityID,
            context.encounterDate
          ].join('|');

          if (!grouped.has(groupKey)) {
            grouped.set(groupKey, []);
          }

          grouped
            .get(groupKey)
            .push(context);
        });

      const remarksByClaimID =
        new Map();

      const processedPairs =
        new Set();

      grouped.forEach(groupClaims => {
        for (
          let firstIndex = 0;
          firstIndex < groupClaims.length;
          firstIndex += 1
        ) {
          for (
            let secondIndex = firstIndex + 1;
            secondIndex < groupClaims.length;
            secondIndex += 1
          ) {
            const first =
              groupClaims[firstIndex];

            const second =
              groupClaims[secondIndex];

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

            const overlaps =
              first.parsedStart.timestamp <=
                second.parsedEnd.timestamp &&
              second.parsedStart.timestamp <=
                first.parsedEnd.timestamp;

            if (!overlaps) {
              continue;
            }

            const sharedClinicians =
              Array.from(first.clinicians)
                .filter(clinician =>
                  second.clinicians.has(clinician)
                );

            if (!sharedClinicians.length) {
              continue;
            }

            const sharedDiagnoses =
              Array.from(first.diagnoses)
                .filter(code =>
                  second.diagnoses.has(code)
                );

            if (!sharedDiagnoses.length) {
              continue;
            }

            const pairKey =
              [first.claimID, second.claimID]
                .sort()
                .join('|');

            if (
              processedPairs.has(pairKey)
            ) {
              continue;
            }

            processedPairs.add(pairKey);

            if (
              !remarksByClaimID.has(
                first.claimID
              )
            ) {
              remarksByClaimID.set(
                first.claimID,
                []
              );
            }

            if (
              !remarksByClaimID.has(
                second.claimID
              )
            ) {
              remarksByClaimID.set(
                second.claimID,
                []
              );
            }

            remarksByClaimID
              .get(first.claimID)
              .push(
                `${first.claimID} must be merged with ` +
                `${second.claimID}.`
              );

            remarksByClaimID
              .get(second.claimID)
              .push(
                `${second.claimID} must be merged with ` +
                `${first.claimID}.`
              );
          }
        }
      });

      return remarksByClaimID;
    }

    function detectNotMergedRemarksByClaim(
      claims,
      receiverID = ''
    ) {
      const contexts =
        Array.from(claims || [])
          .map((claim, index) => {
            try {
              return collectNotMergedClaimContext(
                claim,
                receiverID
              );
            } catch (error) {
              console.warn(
                '[SCHEMA][NOT_MERGED]',
                `Claim index ${index}: ${error.message}`
              );

              return null;
            }
          })
          .filter(Boolean);

      return buildNotMergedRemarksFromContexts(
        contexts
      );
    }

    // =====================================================================
    // FALSE VALUE VALIDATION
    // =====================================================================

    function checkForFalseValues(
      parent,
      invalidFields,
      prefix = '',
      activityContext = null,
      falseValueErrors = null
    ) {
      const errors =
        falseValueErrors || {
          activity: new Map(),
          nonActivity: []
        };

      function normalizeFieldPath(
        currentPrefix,
        nodeName,
        removeActivityPrefix = false
      ) {
        let fieldPath =
          (
            currentPrefix
              ? `${currentPrefix} → ${nodeName}`
              : nodeName
          )
            .replace(
              /^Claim(?:[.\s→]*)/,
              ''
            )
            .replace(
              /^Person(?:[.\s→]*)/,
              ''
            );

        if (removeActivityPrefix) {
          fieldPath =
            fieldPath.replace(
              /Activity\s*→\s*/g,
              ''
            );
        }

        return fieldPath;
      }

      Array.from(parent?.children || [])
        .forEach(element => {
          const value =
            String(
              element.textContent || ''
            )
              .trim()
              .toLowerCase();

          let currentActivity =
            activityContext;

          if (
            element.nodeName === 'Activity'
          ) {
            currentActivity =
              safeTextByTag(
                element,
                'Code'
              ) ||
              '(unknown)';
          }

          if (
            !element.children.length &&
            value === 'false' &&
            element.nodeName !== 'MiddleNameEn'
          ) {
            if (currentActivity) {
              const field =
                normalizeFieldPath(
                  prefix,
                  element.nodeName,
                  true
                )
                  .split(/\s*→\s*/)
                  .join(' ');

              if (
                !errors.activity.has(field)
              ) {
                errors.activity.set(
                  field,
                  []
                );
              }

              errors.activity
                .get(field)
                .push(currentActivity);
            } else {
              const field =
                normalizeFieldPath(
                  prefix,
                  element.nodeName,
                  false
                ).replace(
                  /\s*→\s*/g,
                  ' '
                );

              errors.nonActivity.push(
                `${field} has invalid value of \`false\`.`
              );
            }
          }

          if (element.children.length) {
            checkForFalseValues(
              element,
              invalidFields,
              prefix
                ? `${prefix} → ${element.nodeName}`
                : element.nodeName,
              currentActivity,
              errors
            );
          }
        });

      if (
        prefix === 'Claim.' &&
        activityContext === null
      ) {
        errors.nonActivity.forEach(
          message =>
            invalidFields.push(message)
        );

        errors.activity.forEach(
          (activities, field) => {
            const uniqueActivities =
              Array.from(
                new Set(activities)
              );

            invalidFields.push(
              `${uniqueActivities.length === 1 ? 'Activity' : 'Activities'} ` +
              `${formatNaturalList(uniqueActivities)} ` +
              `${uniqueActivities.length === 1 ? 'has' : 'have'} ` +
              `${field} as \`false\`.`
            );
          }
        );
      }
    }

    // =====================================================================
    // DIAGNOSIS-DEPENDENT ACTIVITY RULES
    // =====================================================================

    function checkSpecialActivityDiagnosis(
      activities,
      diagnoses,
      getText,
      invalidFields
    ) {
      const specialCodes =
        new Set([
          '11111',
          '11119',
          '11101',
          '11109'
        ]);

      const foundCodes =
        Array.from(activities || [])
          .map(activity =>
            String(
              getText(
                'Code',
                activity
              ) || ''
            ).trim()
          )
          .filter(code =>
            specialCodes.has(code)
          );

      if (!foundCodes.length) {
        return;
      }

      const diagnosisCodes =
        Array.from(diagnoses || [])
          .map(diagnosis =>
            String(
              getText(
                'Code',
                diagnosis
              ) || ''
            )
              .trim()
              .toUpperCase()
          )
          .filter(Boolean);

      const validPrefixes = [
        'K05.0',
        'K05.1',
        'K03.6'
      ];

      const hasRequiredDiagnosis =
        diagnosisCodes.some(code =>
          validPrefixes.some(prefix =>
            code.startsWith(prefix)
          )
        );

      if (!hasRequiredDiagnosis) {
        invalidFields.push(
          `Activity code(s) ` +
          `${formatNaturalList(new Set(foundCodes))} ` +
          `require Diagnosis code K05.0, K05.1, or K03.6.`
        );
      }
    }

    function checkImplantActivityDiagnosis(
      activities,
      diagnoses,
      getText,
      invalidFields
    ) {
      const implantCodes =
        new Set([
          '79931',
          '79932',
          '79933',
          '79934'
        ]);

      const foundCodes =
        Array.from(activities || [])
          .map(activity =>
            String(
              getText(
                'Code',
                activity
              ) || ''
            ).trim()
          )
          .filter(code =>
            implantCodes.has(code)
          );

      if (!foundCodes.length) {
        return;
      }

      const diagnosisCodes =
        Array.from(diagnoses || [])
          .map(diagnosis =>
            normalizeDiagnosisCode(
              getText(
                'Code',
                diagnosis
              )
            )
          )
          .filter(Boolean);

      const hasValidDiagnosis =
        diagnosisCodes.some(code =>
          code.startsWith('K081') ||
          code.startsWith('K084')
        );

      if (!hasValidDiagnosis) {
        invalidFields.push(
          `Activity code(s) ` +
          `${formatNaturalList(new Set(foundCodes))} ` +
          `require at least one Diagnosis code from K08.1 or K08.4.`
        );
      }
    }

    function checkGTLicenseValidation(
      activities,
      getText,
      invalidFields
    ) {
      const hasGTLicense =
        Array.from(activities || [])
          .some(activity =>
            String(
              getText(
                'OrderingClinician',
                activity
              ) || ''
            )
              .trim()
              .toUpperCase()
              .startsWith('GT')
          );

      if (
        hasGTLicense &&
        !invalidFields.includes(
          'Ordering Clinician is under Physiotherapist.'
        )
      ) {
        invalidFields.push(
          'Ordering Clinician is under Physiotherapist.'
        );
      }
    }

    // =====================================================================
    // MEDICAL-ONLY ACTIVITY RULES
    // =====================================================================

    function isConsultationCode(code) {
      return CONSULTATION_CODE_REGEX.test(
        String(code || '').trim()
      );
    }

    function specialtyContains(
      specialty,
      searchText
    ) {
      return normalizeSpecialty(
        specialty
      ).includes(
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

    function validateMedicalOrderingConsistency(
      activities,
      getText,
      invalidFields,
      options = {}
    ) {
      if (!options.isMedicalClaim) {
        return;
      }

      const orderingClinicians =
        new Set();

      const missingOrderingCodes =
        [];

      const duplicatePairs =
        new Map();

      Array.from(activities || [])
        .forEach(activity => {
          const code =
            String(
              getText(
                'Code',
                activity
              ) || ''
            ).trim();

          const orderingClinician =
            String(
              getText(
                'OrderingClinician',
                activity
              ) || ''
            )
              .trim()
              .toUpperCase();

          const normalizedCode =
            code
              .toUpperCase()
              .replace(
                /[^A-Z0-9\-]/g,
                ''
              );

          if (!orderingClinician) {
            if (code) {
              missingOrderingCodes.push(code);
            }

            return;
          }

          orderingClinicians.add(
            orderingClinician
          );

          if (!normalizedCode) {
            return;
          }

          const pairKey =
            `${normalizedCode}|${orderingClinician}`;

          duplicatePairs.set(
            pairKey,
            (
              duplicatePairs.get(pairKey) ||
              0
            ) + 1
          );
        });

      if (orderingClinicians.size > 1) {
        invalidFields.push(
          `Claim has multiple Ordering Clinicians: ` +
          `${Array.from(orderingClinicians).join(', ')}.`
        );
      }

      if (missingOrderingCodes.length) {
        invalidFields.push(
          `Missing OrderingClinician for activities: ` +
          `${formatNaturalList(new Set(missingOrderingCodes))}.`
        );
      }

      duplicatePairs.forEach(
        (count, pairKey) => {
          if (count < 2) {
            return;
          }

          const [
            code,
            orderingClinician
          ] = pairKey.split('|');

          invalidFields.push(
            `Duplicate code ${code} with Ordering Clinician ` +
            `${orderingClinician}.`
          );
        }
      );
    }

    function validateConsultationAndSpecialtyRules(
      activities,
      getText,
      invalidFields,
      clinicianSpecialtyMap,
      options = {}
    ) {
      if (!options.isMedicalClaim) {
        return;
      }

      const contexts =
        Array.from(activities || [])
          .map(activity => {
            const code =
              String(
                getText(
                  'Code',
                  activity
                ) || ''
              ).trim();

            const quantityRaw =
              String(
                getText(
                  'Quantity',
                  activity
                ) || ''
              ).trim();

            const quantity =
              Number(quantityRaw || 0);

            const net =
              Number(
                getText(
                  'Net',
                  activity
                ) || 0
              );

            const clinician =
              String(
                getText(
                  'Clinician',
                  activity
                ) || ''
              )
                .trim()
                .toUpperCase();

            const orderingClinician =
              String(
                getText(
                  'OrderingClinician',
                  activity
                ) || ''
              )
                .trim()
                .toUpperCase();

            return {
              code,
              quantityRaw,
              quantity,
              net,

              clinicianSpecialty:
                clinicianSpecialtyMap.get(
                  clinician
                ) || '',

              orderingSpecialty:
                clinicianSpecialtyMap.get(
                  orderingClinician
                ) || ''
            };
          });

      const requires992SpecialtyCheck =
        contexts.length > 1;

      const infusionCodes =
        new Set();

      const consultationCodes =
        new Set();

      contexts.forEach(context => {
        const code =
          context.code;

        if (!code) {
          return;
        }

        if (
          MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(
            code
          )
        ) {
          infusionCodes.add(code);
        }

        if (
          GP_992_CODES.has(code)
        ) {
          consultationCodes.add(code);
        }

        if (
          INVALID_ACTIVITY_CODES.has(code)
        ) {
          invalidFields.push(
            `Activity ${code} is invalid and cannot be used.`
          );
        }

        if (
          /^8/.test(code) &&
          code !== '82948' &&
          !specialtyContains(
            context.clinicianSpecialty,
            'Pathology'
          )
        ) {
          invalidFields.push(
            `Activity ${code} requires Clinician specialty ` +
            `containing Pathology (Currently ` +
            `\`${context.clinicianSpecialty || 'Unknown'}\`).`
          );
        }

        if (
          (
            code === '97802' ||
            code === '97803'
          ) &&
          !specialtyContains(
            context.clinicianSpecialty,
            'Dietician'
          )
        ) {
          invalidFields.push(
            `Activity ${code} requires Clinician specialty ` +
            `containing Dietician (Currently ` +
            `\`${context.clinicianSpecialty || 'Unknown'}\`).`
          );
        }

        if (
          requires992SpecialtyCheck &&
          GP_992_REQUIRED_CODES.has(code) &&
          !specialtyContains(
            context.orderingSpecialty,
            'General Practitioner'
          )
        ) {
          invalidFields.push(
            `Activity ${code} requires OrderingClinician specialty ` +
            `as General Practitioner (Currently ` +
            `\`${context.orderingSpecialty || 'Unknown'}\`).`
          );
        }

        if (
          GP_992_FORBIDDEN_CODES.has(code)
        ) {
          if (
            context.net !== 0 &&
            specialtyContains(
              context.orderingSpecialty,
              'General Practitioner'
            )
          ) {
            invalidFields.push(
              `Activity ${code} requires OrderingClinician specialty ` +
              `to NOT be General Practitioner (Currently ` +
              `\`${context.orderingSpecialty || 'Unknown'}\`).`
            );
          }

          if (
            isOphthalmologyOrPsychiatrySpecialty(
              context.orderingSpecialty
            )
          ) {
            invalidFields.push(
              `${context.orderingSpecialty || 'OrderingClinician Specialty'} ` +
              `cannot be used for ${code}.`
            );
          }
        }

        if (
          (
            specialtyContains(
              context.orderingSpecialty,
              'Opthalmology'
            ) ||
            specialtyContains(
              context.orderingSpecialty,
              'Ophthalmology'
            )
          ) &&
          isConsultationCode(code) &&
          code.startsWith('992')
        ) {
          invalidFields.push(
            `Ophthalmology consultation codes must start with 92, ` +
            `not ${code}.`
          );
        }

        if (
          MUTUALLY_EXCLUSIVE_INFUSION_CODES.has(code) &&
          context.quantityRaw &&
          context.quantity !== 1
        ) {
          invalidFields.push(
            `Activity ${code} must have Quantity of 1.`
          );
        }
      });

      const hasNewPatientCode =
        consultationCodes.has('99202') ||
        consultationCodes.has('99203');

      const hasEstablishedPatientCode =
        consultationCodes.has('99212') ||
        consultationCodes.has('99213');

      if (
        hasNewPatientCode &&
        hasEstablishedPatientCode
      ) {
        invalidFields.push(
          '99202/99203 cannot be combined with ' +
          '99212/99213 in the same claim.'
        );
      }

      if (infusionCodes.size > 1) {
        invalidFields.push(
          `Codes ${Array.from(infusionCodes).join(', ')} ` +
          `cannot coexist in the same claim.`
        );
      }
    }

    // =====================================================================
    // PERSON VALIDATION
    // =====================================================================

    function validatePersonSchema(
      xmlDocument,
      originalXMLContent = ''
    ) {
      const results = [];

      const persons =
        xmlDocument.getElementsByTagName(
          'Person'
        );

      Array.from(persons)
        .forEach(person => {
          const missingFields = [];
          const invalidFields = [];
          const remarks = [];

          let isUnknown = false;

          const text = (
            tagName,
            parent = person
          ) =>
            safeTextByTag(
              parent,
              tagName
            );

          const invalidIfEmpty = (
            tagName,
            parent = person,
            prefix = ''
          ) => {
            if (!text(tagName, parent)) {
              invalidFields.push(
                `${prefix}${tagName} (null/empty)`
              );
            }
          };

          const unifiedNumber =
            text('UnifiedNumber');

          let hadAmpersand =
            false;

          if (
            originalXMLContent &&
            unifiedNumber
          ) {
            const tag =
              `<UnifiedNumber>${unifiedNumber}</UnifiedNumber>`;

            const position =
              originalXMLContent.indexOf(tag);

            if (position !== -1) {
              let start =
                originalXMLContent.lastIndexOf(
                  '<Person>',
                  position
                );

              if (start === -1) {
                start =
                  originalXMLContent.lastIndexOf(
                    '<Person ',
                    position
                  );
              }

              const end =
                originalXMLContent.indexOf(
                  '</Person>',
                  position
                );

              if (
                start !== -1 &&
                end !== -1
              ) {
                const originalPerson =
                  originalXMLContent.substring(
                    start,
                    end + '</Person>'.length
                  );

                hadAmpersand =
                  /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/
                    .test(originalPerson);
              }
            }
          }

          [
            'UnifiedNumber',
            'FirstName',
            'FirstNameEn',
            'LastNameEn',
            'ContactNumber',
            'BirthDate',
            'Gender',
            'Nationality',
            'City',
            'CountryOfResidence',
            'EmirateOfResidence',
            'EmiratesIDNumber'
          ].forEach(field =>
            invalidIfEmpty(field)
          );

          const emiratesID =
            text('EmiratesIDNumber');

          if (emiratesID) {
            const parts =
              emiratesID.split('-');

            const digits =
              emiratesID.replace(
                /-/g,
                ''
              );

            const allZeros =
              /^0+$/.test(digits);

            const allOnes =
              /^1+$/.test(digits);

            const allTwos =
              /^2+$/.test(digits);

            const allNines =
              /^9+$/.test(digits);

            const placeholder =
              allZeros ||
              allOnes ||
              allTwos ||
              allNines;

            if (parts.length !== 4) {
              invalidFields.push(
                `EmiratesIDNumber '${emiratesID}' must have ` +
                `4 parts separated by dashes.`
              );
            } else {
              if (
                !placeholder &&
                parts[0] !== '784'
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' first part ` +
                  `must be 784.`
                );
              }

              if (
                !/^\d{4}$/.test(parts[1])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' second part ` +
                  `must be 4 digits.`
                );
              }

              if (
                !/^\d{7}$/.test(parts[2])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' third part ` +
                  `must be 7 digits.`
                );
              }

              if (
                !/^\d$/.test(parts[3])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' fourth part ` +
                  `must be 1 digit.`
                );
              }
            }

            if (allZeros) {
              remarks.push(
                'Kindly confirm if the PT is a national resident.'
              );
            } else if (allOnes) {
              remarks.push(
                'Kindly confirm if the PT is a non-national resident.'
              );
            } else if (allTwos) {
              remarks.push(
                'Kindly confirm if the PT is a non-national and non-resident.'
              );

              isUnknown = true;
            } else if (allNines) {
              remarks.push(
                'Kindly confirm if the PT has an unknown status.'
              );

              isUnknown = true;
            }
          }

          const member =
            person.getElementsByTagName(
              'Member'
            )[0];

          const memberID =
            member
              ? text('ID', member)
              : '';

          if (!memberID) {
            invalidFields.push(
              'Member.ID (null/empty)'
            );
          }

          checkForFalseValues(
            person,
            invalidFields
          );

          if (hadAmpersand) {
            invalidFields.push(
              AMPERSAND_REPLACEMENT_ERROR
            );
          }

          if (missingFields.length) {
            remarks.push(
              `Missing: ${missingFields.join(', ')}`
            );
          }

          invalidFields.forEach(error =>
            remarks.push(error)
          );

          if (!remarks.length) {
            remarks.push('OK');
          }

          results.push({
            ClaimID:
              memberID ||
              unifiedNumber ||
              'Unknown',

            Valid:
              !missingFields.length &&
              !invalidFields.length,

            Unknown:
              isUnknown,

            Remark:
              remarks
                .map(message =>
                  message &&
                  !message.endsWith('.')
                    ? `${message}.`
                    : message
                )
                .join('\n'),

            ClaimXML:
              person.outerHTML,

            SchemaType:
              'person'
          });
        });

      return results;
    }

    // =====================================================================
    // CLAIM VALIDATION
    // =====================================================================

    function validateClaimSchema(
      xmlDocument,
      originalXMLContent = '',
      options = {}
    ) {
      const results = [];

      const claims =
        xmlDocument.getElementsByTagName(
          'Claim'
        );

      const clinicianSpecialtyMap =
        options.clinicianSpecialtyMap instanceof Map
          ? options.clinicianSpecialtyMap
          : new Map();

      const pregnancyData =
        options.pregnancyDiagnosisData ||
        null;

      const claimTypeMode =
        String(
          options.claimTypeMode || ''
        )
          .trim()
          .toUpperCase();

      const claimIDCounts =
        new Map();

      Array.from(claims)
        .forEach(claim => {
          const claimID =
            getDirectChildText(
              claim,
              'ID'
            );

          if (claimID) {
            claimIDCounts.set(
              claimID,
              (
                claimIDCounts.get(claimID) ||
                0
              ) + 1
            );
          }
        });

      const duplicateClaimIDs =
        new Set(
          Array.from(
            claimIDCounts.entries()
          )
            .filter(
              ([, count]) =>
                count > 1
            )
            .map(
              ([claimID]) =>
                claimID
            )
        );

      const receiverID =
        safeTextByTag(
          xmlDocument.querySelector(
            'Header'
          ),
          'ReceiverID'
        );

      const mergeRemarks =
        detectNotMergedRemarksByClaim(
          claims,
          receiverID
        );

      const duplicateActivityRemarks =
        buildDuplicateActivityReferenceRemarksByClaim(
          claims
        );

      Array.from(claims)
        .forEach(claim => {
          const missingFields = [];
          const invalidFields = [];
          const remarks = [];

          let isUnknown = false;

          const text = (
            tagName,
            parent = claim
          ) =>
            safeTextByTag(
              parent,
              tagName
            );

          const invalidIfEmpty = (
            tagName,
            parent = claim,
            prefix = ''
          ) => {
            if (!text(tagName, parent)) {
              invalidFields.push(
                `${prefix}${tagName} (null/empty)`
              );
            }
          };

          if (!receiverID) {
            invalidFields.push(
              'CRITICAL ERROR: ReceiverID is missing from XML Header. ' +
              'This file cannot be processed.'
            );
          }

          const claimID =
            getDirectChildText(
              claim,
              'ID'
            );

          if (
            claimID &&
            duplicateClaimIDs.has(claimID)
          ) {
            invalidFields.push(
              `Duplicate Claim ID '${claimID}' found within this submission.`
            );
          }

          (
            duplicateActivityRemarks.get(
              claim
            ) || []
          ).forEach(message =>
            invalidFields.push(message)
          );

          let claimHadAmpersand =
            false;

          if (
            originalXMLContent &&
            claimID
          ) {
            const idTag =
              `<ID>${claimID}</ID>`;

            const idPosition =
              originalXMLContent.indexOf(
                idTag
              );

            if (idPosition !== -1) {
              let claimStart =
                originalXMLContent.lastIndexOf(
                  '<Claim>',
                  idPosition
                );

              if (claimStart === -1) {
                claimStart =
                  originalXMLContent.lastIndexOf(
                    '<Claim ',
                    idPosition
                  );
              }

              const claimEnd =
                originalXMLContent.indexOf(
                  '</Claim>',
                  idPosition
                );

              if (
                claimStart !== -1 &&
                claimEnd !== -1
              ) {
                const originalClaim =
                  originalXMLContent.substring(
                    claimStart,
                    claimEnd + '</Claim>'.length
                  );

                claimHadAmpersand =
                  /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/
                    .test(originalClaim);
              }
            }
          }

          [
            'ID',
            'MemberID',
            'PayerID',
            'ProviderID',
            'EmiratesIDNumber',
            'Gross',
            'PatientShare',
            'Net'
          ].forEach(field =>
            invalidIfEmpty(field)
          );

          const payerID =
            text('PayerID');

          const claimNet =
            Number.parseFloat(
              text('Net')
            );

          if (
            payerID === 'A02' &&
            Number.isFinite(claimNet) &&
            claimNet < 500
          ) {
            invalidFields.push(
              'ADNIC (A02) claim is auto-rejected because ' +
              'total sponsor price is under 500.'
            );
          }

          const patientShareRaw =
            text('PatientShare');

          if (
            patientShareRaw.includes('.')
          ) {
            const decimalPlaces =
              patientShareRaw.length -
              patientShareRaw.indexOf('.') -
              1;

            if (decimalPlaces > 2) {
              const parsed =
                Number.parseFloat(
                  patientShareRaw
                );

              const rounded =
                Number.isFinite(parsed)
                  ? parsed.toFixed(2)
                  : 'Invalid number';

              invalidFields.push(
                `PatientShare has invalid precision: ` +
                `\`${patientShareRaw}\`. ` +
                `Should be \`${rounded}\`.`
              );
            }
          }

          const emiratesID =
            text('EmiratesIDNumber');

          let medicalTourismEID =
            false;

          let residentPlaceholderEID =
            false;

          let allNinesEID =
            false;

          if (emiratesID) {
            const parts =
              emiratesID.split('-');

            const digits =
              emiratesID.replace(
                /-/g,
                ''
              );

            const allZeros =
              /^0+$/.test(digits);

            const allOnes =
              /^1+$/.test(digits);

            const allTwos =
              /^2+$/.test(digits);

            const allNines =
              /^9+$/.test(digits);

            const placeholder =
              allZeros ||
              allOnes ||
              allTwos ||
              allNines;

            medicalTourismEID =
              allTwos;

            residentPlaceholderEID =
              allZeros ||
              allOnes;

            allNinesEID =
              allNines;

            if (parts.length !== 4) {
              invalidFields.push(
                `EmiratesIDNumber '${emiratesID}' must have ` +
                `4 parts separated by dashes.`
              );
            } else {
              if (
                !placeholder &&
                parts[0] !== '784'
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' first part ` +
                  `must be 784.`
                );
              }

              if (
                !/^\d{4}$/.test(parts[1])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' second part ` +
                  `must be 4 digits.`
                );
              }

              if (
                !/^\d{7}$/.test(parts[2])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' third part ` +
                  `must be 7 digits.`
                );
              }

              if (
                !/^\d$/.test(parts[3])
              ) {
                invalidFields.push(
                  `EmiratesIDNumber '${emiratesID}' fourth part ` +
                  `must be 1 digit.`
                );
              }
            }

            if (allZeros) {
              remarks.push(
                'Kindly confirm if the PT is a national resident.'
              );
            } else if (allOnes) {
              remarks.push(
                'Kindly confirm if the PT is a non-national resident.'
              );
            } else if (allTwos) {
              remarks.push(
                'Kindly confirm if the PT is a non-national and non-resident.'
              );

              isUnknown = true;
            } else if (allNines) {
              remarks.push(
                'Kindly confirm if the PT has an unknown status.'
              );

              isUnknown = true;
            }
          }

          const encounter =
            claim.getElementsByTagName(
              'Encounter'
            )[0];

          if (!encounter) {
            missingFields.push(
              'Encounter'
            );
          } else {
            [
              'FacilityID',
              'Type',
              'PatientID',
              'Start',
              'End',
              'StartType',
              'EndType'
            ].forEach(field =>
              invalidIfEmpty(
                field,
                encounter,
                'Encounter.'
              )
            );
          }

          const diagnoses =
            claim.getElementsByTagName(
              'Diagnosis'
            );

          if (!diagnoses.length) {
            missingFields.push(
              'Diagnosis'
            );
          } else {
            let principalCode =
              null;

            const codesByType =
              new Map();

            Array.from(diagnoses)
              .forEach(
                (diagnosis, index) => {
                  const type =
                    text(
                      'Type',
                      diagnosis
                    );

                  const code =
                    text(
                      'Code',
                      diagnosis
                    );

                  if (!type) {
                    missingFields.push(
                      `Diagnosis[${index}].Type`
                    );
                  }

                  if (!code) {
                    missingFields.push(
                      `Diagnosis[${index}].Code`
                    );
                  }

                  if (type === 'Principal') {
                    if (principalCode) {
                      invalidFields.push(
                        'Principal Diagnosis (multiple found)'
                      );
                    } else {
                      principalCode = code;
                    }
                  } else if (code) {
                    if (!codesByType.has(type)) {
                      codesByType.set(
                        type,
                        new Set()
                      );
                    }

                    const set =
                      codesByType.get(type);

                    if (set.has(code)) {
                      invalidFields.push(
                        `Duplicate Diagnosis Code within Type ` +
                        `'${type}': ${code}`
                      );
                    } else {
                      set.add(code);
                    }

                    if (
                      principalCode &&
                      code === principalCode
                    ) {
                      invalidFields.push(
                        `Diagnosis Code ${code} duplicates Principal.`
                      );
                    }
                  }
                }
              );

            if (!principalCode) {
              invalidFields.push(
                'Principal Diagnosis (none found)'
              );
            }
          }

          checkPregnancyDiagnosisTrimesterConsistency(
            diagnoses,
            text,
            invalidFields,
            pregnancyData
          );

          const activities =
            claim.getElementsByTagName(
              'Activity'
            );

          const invalidQuantityCodes =
            [];

          const specialMedicalCodes =
            new Set([
              '17999',
              '96999',
              '0232T',
              'J3490',
              '81479',
              '41899'
            ]);

          if (!activities.length) {
            invalidFields.push(
              'Kindly verify activities as there are no codes ' +
              'showing in the XML for this claim.'
            );
          }

          Array.from(activities)
            .forEach(
              (activity, index) => {
                const code =
                  text(
                    'Code',
                    activity
                  );

                const quantity =
                  text(
                    'Quantity',
                    activity
                  );

                [
                  'Start',
                  'Type',
                  'Code',
                  'Quantity',
                  'Net',
                  'Clinician'
                ].forEach(field =>
                  invalidIfEmpty(
                    field,
                    activity,
                    `Activity[${index}].`
                  )
                );

                if (quantity === '0') {
                  invalidQuantityCodes.push(
                    code || '(unknown)'
                  );
                }

                Array.from(
                  activity.getElementsByTagName(
                    'Observation'
                  )
                ).forEach(
                  (
                    observation,
                    observationIndex
                  ) => {
                    [
                      'Type',
                      'Code'
                    ].forEach(field =>
                      invalidIfEmpty(
                        field,
                        observation,
                        `Activity[${index}].` +
                        `Observation[${observationIndex}].`
                      )
                    );
                  }
                );

                if (
                  code &&
                  specialMedicalCodes.has(code)
                ) {
                  Array.from(
                    activity.getElementsByTagName(
                      'Observation'
                    )
                  ).forEach(observation => {
                    const type =
                      text(
                        'Type',
                        observation
                      );

                    const valueType =
                      text(
                        'ValueType',
                        observation
                      );

                    if (
                      type &&
                      type.toUpperCase() !== 'TEXT'
                    ) {
                      invalidFields.push(
                        `Activity ${code} has invalid Observation Type ` +
                        `of \`${type}\` but must be \`Text\`.`
                      );
                    }

                    if (
                      valueType &&
                      valueType.toUpperCase() !== 'TEXT'
                    ) {
                      invalidFields.push(
                        `Activity ${code} has invalid Observation ValueType ` +
                        `of \`${valueType}\` but must be \`Text\`.`
                      );
                    }
                  });
                }
              }
            );

          if (invalidQuantityCodes.length) {
            invalidFields.push(
              `${invalidQuantityCodes.length === 1 ? 'Activity' : 'Activities'} ` +
              `${formatNaturalList(invalidQuantityCodes)} ` +
              `${invalidQuantityCodes.length === 1 ? 'has' : 'have'} ` +
              `invalid quantity of 0.`
            );
          }

          if (emiratesID) {
            let hasMedicalTourismObservation =
              false;

            activityLoop:
            for (
              const activity of
              Array.from(activities)
            ) {
              const observations =
                activity.getElementsByTagName(
                  'Observation'
                );

              for (
                const observation of
                Array.from(observations)
              ) {
                const observationText = (
                  text(
                    'Description',
                    observation
                  ) +
                  text(
                    'Code',
                    observation
                  ) +
                  text(
                    'Value',
                    observation
                  )
                ).toUpperCase();

                if (
                  observationText.includes(
                    'MEDICALTOURISM'
                  )
                ) {
                  hasMedicalTourismObservation =
                    true;

                  break activityLoop;
                }
              }
            }

            if (
              residentPlaceholderEID &&
              hasMedicalTourismObservation
            ) {
              invalidFields.push(
                'EID indicates a resident patient (000/111); ' +
                'claim can only be Self-Pay. Kindly remove the ' +
                'Medical Tourism observation.'
              );
            } else if (
              medicalTourismEID &&
              !hasMedicalTourismObservation
            ) {
              invalidFields.push(
                'EID indicates a non-national non-resident (222); ' +
                'claim can only be Medical Tourism. Kindly add a ' +
                'Medical Tourism observation.'
              );
            } else if (
              !allNinesEID &&
              !residentPlaceholderEID &&
              !medicalTourismEID &&
              hasMedicalTourismObservation
            ) {
              invalidFields.push(
                'Kindly clarify if patient is Medical Tourism ' +
                'as EID does not reflect this.'
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

          checkGTLicenseValidation(
            activities,
            text,
            invalidFields
          );

          const encounterType =
            encounter
              ? text(
                  'Type',
                  encounter
                )
              : '';

          const isMedicalClaim =
            claimTypeMode
              ? claimTypeMode === 'MEDICAL'
              : String(encounterType).trim() === '3';

          validateConsultationAndSpecialtyRules(
            activities,
            text,
            invalidFields,
            clinicianSpecialtyMap,
            { isMedicalClaim }
          );

          validateMedicalOrderingConsistency(
            activities,
            text,
            invalidFields,
            { isMedicalClaim }
          );

          const contract =
            claim.getElementsByTagName(
              'Contract'
            )[0];

          if (
            contract &&
            !text(
              'PackageName',
              contract
            )
          ) {
            invalidFields.push(
              'Contract.PackageName (null/empty)'
            );
          }

          checkForFalseValues(
            claim,
            invalidFields,
            'Claim.'
          );

          if (claimHadAmpersand) {
            invalidFields.push(
              AMPERSAND_REPLACEMENT_ERROR
            );
          }

          if (
            claimID &&
            mergeRemarks.has(claimID)
          ) {
            mergeRemarks
              .get(claimID)
              .forEach(message =>
                invalidFields.push(message)
              );
          }

          if (missingFields.length) {
            remarks.push(
              `Missing: ${missingFields.join(', ')}`
            );
          }

          invalidFields.forEach(error =>
            remarks.push(error)
          );

          if (!remarks.length) {
            remarks.push('OK');
          }

          results.push({
            ClaimID:
              claimID ||
              'Unknown',

            Valid:
              !missingFields.length &&
              !invalidFields.length,

            Unknown:
              isUnknown,

            Remark:
              remarks
                .map(message =>
                  message &&
                  !message.endsWith('.')
                    ? `${message}.`
                    : message
                )
                .join('\n'),

            ClaimXML:
              claim.outerHTML,

            SchemaType:
              'claim'
          });
        });

      return results;
    }

    // =====================================================================
    // RESULT TABLE
    // =====================================================================

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
        schemaType ||
        'claim';

      window._lastValidationFileName =
        options.fileName ||
        '';

      const identifierLabel =
        schemaType === 'person'
          ? 'Member ID'
          : 'Claim ID';

      const table =
        document.createElement('table');

      table.className =
        'table table-striped table-bordered';

      table.style.borderCollapse =
        'collapse';

      table.style.width =
        '100%';

      table.dataset.schemaType =
        schemaType ||
        'claim';

      table.dataset.sourceFileName =
        options.fileName ||
        '';

      table.innerHTML = `
        <thead>
          <tr>
            <th style="padding:8px;border:1px solid #ccc">
              ${identifierLabel}
            </th>

            <th style="padding:8px;border:1px solid #ccc">
              Remark
            </th>

            <th style="padding:8px;border:1px solid #ccc">
              Valid
            </th>

            <th style="padding:8px;border:1px solid #ccc">
              View Full Entry
            </th>
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
                <td style="padding:6px;border:1px solid #ccc">
                  ${sanitizeForHTML(row.ClaimID)}
                </td>

                <td
                  style="
                    padding:6px;
                    border:1px solid #ccc;
                    white-space:pre-line;
                  "
                >
                  ${sanitizeForHTML(row.Remark)}
                </td>

                <td style="padding:6px;border:1px solid #ccc">
                  ${row.Valid ? 'Yes' : 'No'}
                </td>

                <td style="padding:6px;border:1px solid #ccc">
                  <button
                    type="button"
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

      safeResults.forEach(
        (row, index) => {
          const button =
            table.querySelector(
              `.view-claim-btn[data-index="${index}"]`
            );

          if (button) {
            button.onclick = () => {
              showModal(
                claimToHtmlTable(
                  row.ClaimXML
                )
              );
            };
          }
        }
      );

      return table;
    }

    // =====================================================================
    // MAIN ENTRY POINT
    // =====================================================================

    function validateXmlSchema(options = {}) {
      const container =
        options.container ||
        null;

      const status =
        getScopedElement(
          container,
          '[data-role="schema-status"], #uploadStatus'
        );

      if (status) {
        status.textContent = '';
      }

      const fileInput =
        getScopedElement(
          container,
          '[data-role="schema-xml-file"], #xmlFile'
        );

      let file =
        options.file ||
        fileInput?.files?.[0] ||
        window.unifiedCheckerFiles?.xml ||
        null;

      if (!file) {
        if (status) {
          status.textContent =
            'Please select an XML file first.';
        }

        return buildSchemaMessageElement(
          'Schema Checker failed: Please select an XML file first.'
        );
      }

      return new Promise(resolve => {
        const reader =
          new FileReader();

        reader.onload =
          async event => {
            try {
              const originalXMLContent =
                String(
                  event.target?.result || ''
                );

              const sanitizedXMLContent =
                originalXMLContent.replace(
                  /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
                  'and'
                );

              const parser =
                new DOMParser();

              const xmlDocument =
                parser.parseFromString(
                  sanitizedXMLContent,
                  'application/xml'
                );

              const parserError =
                xmlDocument.getElementsByTagName(
                  'parsererror'
                )[0];

              if (parserError) {
                const message =
                  `XML Parsing Error: ` +
                  `${parserError.textContent}`;

                if (status) {
                  status.textContent =
                    message;
                }

                resolve(
                  buildSchemaMessageElement(
                    `Schema Checker failed: ${message}`
                  )
                );

                return;
              }

              let results;
              let schemaType;

              if (
                xmlDocument.documentElement.nodeName ===
                'Claim.Submission'
              ) {
                schemaType =
                  'claim';

                const [
                  clinicianSpecialtyMap,
                  pregnancyDiagnosisData
                ] = await Promise.all([
                  loadClinicianSpecialtyMap(),
                  loadPregnancyDiagnosisData()
                ]);

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
                    xmlDocument,
                    originalXMLContent,
                    {
                      clinicianSpecialtyMap,
                      pregnancyDiagnosisData,
                      claimTypeMode
                    }
                  );

                results =
                  await applyTariffOccurrenceLimits(
                    xmlDocument,
                    results,
                    { claimTypeMode }
                  );
              } else if (
                xmlDocument.documentElement.nodeName ===
                'Person.Register'
              ) {
                schemaType =
                  'person';

                results =
                  validatePersonSchema(
                    xmlDocument,
                    originalXMLContent
                  );
              } else {
                const message =
                  `Unknown schema: ` +
                  `${xmlDocument.documentElement.nodeName}`;

                if (status) {
                  status.textContent =
                    message;
                }

                resolve(
                  buildSchemaMessageElement(
                    `Schema Checker failed: ${message}`
                  )
                );

                return;
              }

              const table =
                renderResults(
                  results,
                  schemaType,
                  {
                    fileName:
                      file.name || ''
                  }
                );

              const total =
                results.length;

              const valid =
                results.filter(
                  result =>
                    result.Valid
                ).length;

              const percentage =
                total
                  ? (
                      valid /
                      total *
                      100
                    ).toFixed(1)
                  : '0.0';

              if (status) {
                status.textContent =
                  `Valid ` +
                  `${schemaType === 'claim' ? 'claims' : 'persons'}: ` +
                  `${valid} / ${total} (${percentage}%)`;
              }

              resolve(table);
            } catch (error) {
              console.error(
                '[SCHEMA] Error during validation:',
                error
              );

              if (status) {
                status.textContent =
                  `Error: ${error.message}`;
              }

              resolve(
                buildSchemaMessageElement(
                  `Schema Checker failed: ${error.message}`
                )
              );
            }
          };

        reader.onerror = () => {
          const message =
            'Error reading the XML file.';

          if (status) {
            status.textContent =
              message;
          }

          resolve(
            buildSchemaMessageElement(
              `Schema Checker failed: ${message}`
            )
          );
        };

        reader.readAsText(file);
      });
    }

    // =====================================================================
    // GLOBAL EXPORTS
    // =====================================================================

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
      validateClaimSchema,
      validatePersonSchema,
      renderResults,
      validateMedicalOrderingConsistency,
      validateConsultationAndSpecialtyRules,
      applyTariffOccurrenceLimits,
      loadPregnancyDiagnosisData,
      checkPregnancyDiagnosisTrimesterConsistency,
      normalizeDiagnosisCode,
      buildDuplicateActivityReferenceRemarksByClaim
    };

    console.log(
      '[SCHEMA] checker_schema.js loaded successfully.'
    );

  } catch (error) {
    console.error(
      '[CHECKER-ERROR] Failed to load checker_schema.js:',
      error
    );

    console.error(
      error?.stack || error
    );
  }
})();
