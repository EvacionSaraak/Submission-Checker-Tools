(function() {
  'use strict';

  const SUPPORTED_DIAGNOSIS_TYPES = new Set(['PRINCIPAL', 'SECONDARY']);

  function getDirectChildrenByLocalName(parent, targetName) {
    if (!parent || !parent.children) return [];
    const normalizedTarget = String(targetName || '').toUpperCase();
    const matches = [];

    for (const child of parent.children) {
      const local = (child.localName || child.nodeName || '').toUpperCase();
      const localNameOnly = local.includes(':') ? local.split(':').pop() : local;
      if (localNameOnly === normalizedTarget) {
        matches.push(child);
      }
    }

    return matches;
  }

  function getDirectChildText(parent, tagName) {
    const child = getDirectChildrenByLocalName(parent, tagName)[0];
    return child && child.textContent ? child.textContent.trim() : '';
  }

  function getClaimElements(xmlDoc) {
    let claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
    if (claims.length === 0 && typeof xmlDoc.getElementsByTagNameNS === 'function') {
      claims = Array.from(xmlDoc.getElementsByTagNameNS('*', 'Claim'));
    }
    return claims;
  }

  function extractClaimDiagnoses(claim) {
    const diagnoses = [];
    const diagnosisElements = getDirectChildrenByLocalName(claim, 'Diagnosis');

    diagnosisElements.forEach(diagnosisElement => {
      const type = getDirectChildText(diagnosisElement, 'Type');
      const normalizedType = String(type || '').toUpperCase();
      if (!SUPPORTED_DIAGNOSIS_TYPES.has(normalizedType)) {
        return;
      }

      const code = getDirectChildText(diagnosisElement, 'Code');
      if (!code) {
        return;
      }

      diagnoses.push({
        type,
        code
      });
    });

    return diagnoses;
  }

  function renderExclusionResultsTable(rows) {
    const table = document.createElement('table');
    table.className = 'table table-striped table-bordered';
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';

    const bodyRows = rows.length > 0
      ? rows.map(row => `
          <tr class="table-danger">
            <td class="claim-id-cell" style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.claimId)}</td>
            <td style="padding:6px;border:1px solid #ccc">Invalid</td>
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.diagnosis1)}</td>
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.diagnosis2)}</td>
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.ruleType)}</td>
            <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.remarks)}</td>
          </tr>
        `).join('')
      : `
          <tr class="table-success">
            <td class="claim-id-cell" style="padding:6px;border:1px solid #ccc">-</td>
            <td style="padding:6px;border:1px solid #ccc">Valid</td>
            <td style="padding:6px;border:1px solid #ccc">-</td>
            <td style="padding:6px;border:1px solid #ccc">-</td>
            <td style="padding:6px;border:1px solid #ccc">Excludes1</td>
            <td style="padding:6px;border:1px solid #ccc">No Excludes1 conflicts detected.</td>
          </tr>
        `;

    table.innerHTML = `
      <thead>
        <tr>
          <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
          <th style="padding:8px;border:1px solid #ccc">Status</th>
          <th style="padding:8px;border:1px solid #ccc">Diagnosis 1</th>
          <th style="padding:8px;border:1px solid #ccc">Diagnosis 2</th>
          <th style="padding:8px;border:1px solid #ccc">Rule Type</th>
          <th style="padding:8px;border:1px solid #ccc">Remarks</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    `;

    return table;
  }

  function sanitizeForHTML(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function runExclusionCheck() {
    const status = document.getElementById('uploadStatus');

    if (status) {
      status.textContent = '';
    }

    const fileInput = document.getElementById('xmlFile');
    let file = fileInput?.files?.[0];

    if (!file && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
      file = window.unifiedCheckerFiles.xml;
    }

    if (!file) {
      if (status) {
        status.textContent = 'Please select an XML file first.';
      }
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async function(evt) {
        try {
          const xmlContent = evt.target.result || '';
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(xmlContent, 'application/xml');

          const parseErrors = xmlDoc.getElementsByTagName('parsererror');
          if (parseErrors.length > 0) {
            if (status) {
              status.textContent = 'XML Parsing Error: The file is not well-formed.';
            }
            resolve(null);
            return;
          }

          if (!window.DxRulesEngine || typeof window.DxRulesEngine.loadExclusionRules !== 'function') {
            if (status) {
              status.textContent = 'Exclusion Checker Error: ICD rules engine is not available.';
            }
            resolve(null);
            return;
          }

          let compiledRuleSet;
          try {
            compiledRuleSet = await window.DxRulesEngine.loadExclusionRules();
          } catch (ruleError) {
            console.error('[EXCLUSION] Rules load failure:', ruleError);
            if (status) {
              status.textContent = `Exclusion Checker Error: Unable to load ICD-10-CM Excludes1 rules. ${ruleError.message}`;
            }
            resolve(null);
            return;
          }

          if (compiledRuleSet.malformedEntries && compiledRuleSet.malformedEntries.length > 0) {
            console.warn('[EXCLUSION] Skipped malformed rule entries:', compiledRuleSet.malformedEntries);
          }

          const claims = getClaimElements(xmlDoc);
          if (claims.length === 0) {
            if (status) {
              status.textContent = 'No Claim elements found in the XML file.';
            }
            resolve(null);
            return;
          }

          const resultRows = [];
          const invalidClaimIds = new Set();

          claims.forEach((claim, claimIndex) => {
            const claimId = getDirectChildText(claim, 'ID') || `Unknown-${claimIndex + 1}`;
            const diagnoses = extractClaimDiagnoses(claim);

            if (diagnoses.length < 2) {
              return;
            }

            const conflicts = window.DxRulesEngine.detectExcludes1Conflicts(diagnoses, compiledRuleSet);
            conflicts.forEach(conflict => {
              invalidClaimIds.add(claimId);
              resultRows.push({
                claimId,
                diagnosis1: conflict.diagnosis1,
                diagnosis2: conflict.diagnosis2,
                ruleType: conflict.ruleType,
                remarks: `${conflict.message}${conflict.note ? ` Note: ${conflict.note}` : ''} [${conflict.ruleId}]`
              });
            });
          });

          const claimsChecked = claims.length;
          const invalidClaims = invalidClaimIds.size;
          const exclusionConflicts = resultRows.length;

          if (status) {
            const malformedCount = compiledRuleSet.malformedEntries ? compiledRuleSet.malformedEntries.length : 0;
            const malformedMessage = malformedCount > 0 ? ` | Skipped malformed rules: ${malformedCount}` : '';
            status.textContent = `Claims checked: ${claimsChecked} | Invalid claims: ${invalidClaims} | Exclusion conflicts: ${exclusionConflicts}${malformedMessage}`;
          }

          resolve(renderExclusionResultsTable(resultRows));
        } catch (error) {
          console.error('[EXCLUSION] Checker error:', error);
          if (status) {
            status.textContent = `Exclusion Checker Error: ${error.message}`;
          }
          resolve(null);
        }
      };

      reader.onerror = function() {
        if (status) {
          status.textContent = 'Error reading the XML file.';
        }
        resolve(null);
      };

      reader.readAsText(file);
    });
  }

  if (typeof window !== 'undefined') {
    window.runExclusionCheck = runExclusionCheck;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getDirectChildrenByLocalName,
      getDirectChildText,
      extractClaimDiagnoses
    };
  }
})();
