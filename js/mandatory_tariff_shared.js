(function (root) {
  'use strict';

  if (!root || root.__schemaOccurrenceLimitsPatchInstalled) return;

  const OLD_DUPLICATE_PATTERN =
    /^Duplicate code\s+.+?\s+with Ordering Clinician\s+.+?\.?$/i;

  const OK_PATTERN = /^OK\.?$/i;

  const SELF_PAY_PAYER_IDS = new Set([
    'SELFPAY',
    'SELF PAY',
    'CASH'
  ]);

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .trim()
      .toUpperCase();
  }

  function getSchemaContainer() {
    return (
      document.getElementById(
        'checker-container-schema'
      ) || null
    );
  }

  function getScopedElement(id) {
    const container = getSchemaContainer();

    return (
      container?.querySelector(`#${id}`) ||
      document.getElementById(id)
    );
  }

  function resolveXmlFile() {
    const possibleInputs = [
      'xmlFile',
      'xml-file',
      'xmlFileInput'
    ];

    for (const id of possibleInputs) {
      const input = getScopedElement(id);

      if (input?.files?.[0]) {
        return input.files[0];
      }
    }

    return root.unifiedCheckerFiles?.xml || null;
  }

  function parseXml(xmlText) {
    const safeText =
      String(xmlText || '').replace(
        /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
        'and'
      );

    const xmlDocument =
      new DOMParser().parseFromString(
        safeText,
        'application/xml'
      );

    const parserError =
      xmlDocument.getElementsByTagName(
        'parsererror'
      )[0];

    if (parserError) {
      throw new Error(
        'The XML is not well-formed.'
      );
    }

    return xmlDocument;
  }

  function getDirectChildText(
    parent,
    tagName
  ) {
    if (!parent) return '';

    const child =
      Array.from(parent.children || [])
        .find(
          element =>
            element.tagName === tagName
        );

    return String(
      child?.textContent || ''
    ).trim();
  }

  function getSelfPayClaimIDs(
    xmlDocument
  ) {
    const selfPayClaimIDs = new Set();

    const claims =
      Array.from(
        xmlDocument
          ?.getElementsByTagName('Claim') ||
        []
      );

    for (const claim of claims) {
      const claimID =
        getDirectChildText(
          claim,
          'ID'
        );

      const payerID =
        normalizeCode(
          getDirectChildText(
            claim,
            'PayerID'
          )
        );

      if (
        !claimID ||
        !SELF_PAY_PAYER_IDS.has(payerID)
      ) {
        continue;
      }

      selfPayClaimIDs.add(claimID);
    }

    return selfPayClaimIDs;
  }

  function getFindingCode(finding) {
    const directCode =
      normalizeCode(
        finding?.code ??
        finding?.cptCode ??
        finding?.activityCode ??
        finding?.serviceCode ??
        finding?.activity?.code ??
        ''
      );

    if (directCode) {
      return directCode;
    }

    const remark =
      String(
        finding?.remark || ''
      ).trim();

    const match =
      remark.match(
        /^([^\s]+)\s+can only be coded\b/i
      );

    return normalizeCode(
      match?.[1] || ''
    );
  }

  function filterSelfPay17999Findings(
    findings,
    selfPayClaimIDs
  ) {
    const keptFindings = [];
    const exemptedFindings = [];

    for (const finding of findings || []) {
      const claimID =
        String(
          finding?.claimID || ''
        ).trim();

      const code =
        getFindingCode(finding);

      /*
       * 17999 is an unlisted procedure code.
       *
       * Multiple occurrences are accepted for
       * SelfPay/Cash claims because the XML cannot
       * establish whether the activities represent
       * the same procedure or separate procedures.
       */
      if (
        code === '17999' &&
        claimID &&
        selfPayClaimIDs.has(claimID)
      ) {
        exemptedFindings.push(finding);
        continue;
      }

      keptFindings.push(finding);
    }

    return {
      findings: keptFindings,
      exemptedFindings
    };
  }

  function cleanRemarkLines(remark) {
    return String(
      remark == null ? '' : remark
    )
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(
        line =>
          !OLD_DUPLICATE_PATTERN.test(
            line
          )
      );
  }

  function groupFindingsByClaim(
    findings
  ) {
    const grouped = new Map();

    for (const finding of findings || []) {
      const claimID =
        String(
          finding?.claimID || 'Unknown'
        ).trim();

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

  function applyFindingsToResult(
    result,
    findings
  ) {
    const originalLines =
      String(result?.Remark || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const removedOldDuplicate =
      originalLines.some(
        line =>
          OLD_DUPLICATE_PATTERN.test(
            line
          )
      );

    let lines =
      cleanRemarkLines(
        result?.Remark
      );

    lines =
      lines.filter(
        line =>
          !OK_PATTERN.test(line)
      );

    for (const finding of findings || []) {
      if (
        finding?.remark &&
        !lines.includes(finding.remark)
      ) {
        lines.push(finding.remark);
      }
    }

    if ((findings || []).length) {
      result.Valid = false;
      result.Unknown = false;
    } else if (
      removedOldDuplicate &&
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

  function updateLastResults(
    findingsByClaim
  ) {
    const results =
      root._lastValidationResults;

    if (!Array.isArray(results)) {
      return null;
    }

    for (const result of results) {
      const claimID =
        String(
          result?.ClaimID || 'Unknown'
        ).trim();

      applyFindingsToResult(
        result,
        findingsByClaim.get(claimID) ||
        []
      );
    }

    return results;
  }

  function findColumnIndexes(table) {
    const headers =
      Array.from(
        table
          ?.querySelectorAll('thead th') ||
        []
      );

    const normalized =
      headers.map(
        cell =>
          normalizeHeader(
            cell.textContent
          )
      );

    function findIndex(names) {
      return normalized.findIndex(
        header =>
          names.some(
            name =>
              header === name ||
              header.includes(name)
          )
      );
    }

    return {
      claim: findIndex([
        'claimid',
        'claim'
      ]),

      status: findIndex([
        'status',
        'validity',
        'valid'
      ]),

      remark: findIndex([
        'remarks',
        'remark',
        'errors',
        'error'
      ])
    };
  }

  function statusForResult(result) {
    if (!result?.Valid) {
      return 'Invalid';
    }

    if (result?.Unknown) {
      return 'Unknown';
    }

    return 'Valid';
  }

  function applyRowStyle(
    row,
    status
  ) {
    row.classList.remove(
      'valid',
      'invalid',
      'unknown',
      'valid-row',
      'invalid-row',
      'unknown-row',
      'table-success',
      'table-danger',
      'table-warning'
    );

    if (status === 'Invalid') {
      row.classList.add(
        'invalid-row',
        'table-danger'
      );
    } else if (status === 'Unknown') {
      row.classList.add(
        'unknown-row',
        'table-warning'
      );
    } else {
      row.classList.add(
        'valid-row',
        'table-success'
      );
    }
  }

  function cleanDomRemark(
    text,
    findings
  ) {
    const lines =
      cleanRemarkLines(text)
        .filter(
          line =>
            !OK_PATTERN.test(line)
        );

    for (const finding of findings || []) {
      if (
        finding?.remark &&
        !lines.includes(finding.remark)
      ) {
        lines.push(finding.remark);
      }
    }

    return lines.length
      ? lines.join('\n')
      : 'OK';
  }

  function updateRenderedTable(
    resultElement,
    results,
    findingsByClaim
  ) {
    const table =
      resultElement?.tagName === 'TABLE'
        ? resultElement
        : resultElement
            ?.querySelector?.('table');

    if (!table) return;

    const indexes =
      findColumnIndexes(table);

    const rows =
      Array.from(
        table.querySelectorAll(
          'tbody tr'
        )
      );

    let lastClaimID = '';

    rows.forEach(
      (row, rowIndex) => {
        const cells =
          Array.from(
            row.cells || []
          );

        const visibleClaimID =
          indexes.claim >= 0
            ? String(
                cells[indexes.claim]
                  ?.textContent ||
                ''
              ).trim()
            : '';

        const claimID =
          visibleClaimID ||
          lastClaimID;

        if (visibleClaimID) {
          lastClaimID =
            visibleClaimID;
        }

        const result =
          Array.isArray(results)
            ? (
              results.find(
                entry =>
                  String(
                    entry?.ClaimID ||
                    ''
                  ).trim() === claimID
              ) ||
              results[rowIndex]
            )
            : null;

        if (result) {
          const status =
            statusForResult(result);

          if (
            indexes.status >= 0 &&
            cells[indexes.status]
          ) {
            cells[indexes.status]
              .textContent =
                status;

            cells[indexes.status]
              .dataset.status =
                status.toLowerCase();
          }

          if (
            indexes.remark >= 0 &&
            cells[indexes.remark]
          ) {
            cells[indexes.remark]
              .textContent =
                result.Remark ||
                'OK';

            cells[indexes.remark]
              .style.whiteSpace =
                'pre-line';
          }

          applyRowStyle(
            row,
            status
          );

          return;
        }

        const findings =
          findingsByClaim.get(claimID) ||
          [];

        if (
          indexes.remark >= 0 &&
          cells[indexes.remark]
        ) {
          const cleaned =
            cleanDomRemark(
              cells[indexes.remark]
                .textContent,
              findings
            );

          cells[indexes.remark]
            .textContent =
              cleaned;

          cells[indexes.remark]
            .style.whiteSpace =
              'pre-line';

          const status =
            findings.length
              ? 'Invalid'
              : (
                cleaned === 'OK'
                  ? 'Valid'
                  : String(
                      cells[indexes.status]
                        ?.textContent ||
                      'Invalid'
                    )
              );

          if (
            indexes.status >= 0 &&
            cells[indexes.status]
          ) {
            cells[indexes.status]
              .textContent =
                status;

            cells[indexes.status]
              .dataset.status =
                status.toLowerCase();
          }

          applyRowStyle(
            row,
            status
          );
        }
      }
    );
  }

  function updateSummary(results) {
    if (!Array.isArray(results)) {
      return;
    }

    const status =
      getScopedElement(
        'uploadStatus'
      );

    if (!status) return;

    const total =
      results.length;

    const valid =
      results.filter(
        result =>
          result?.Valid
      ).length;

    const percentage =
      total > 0
        ? (
          (
            valid /
            total
          ) *
          100
        ).toFixed(1)
        : '0.0';

    status.textContent =
      `Valid claims: ${valid} / ${total} (${percentage}%)`;
  }

  function createErrorResult(message) {
    const wrapper =
      document.createElement('div');

    wrapper.className =
      'alert alert-danger';

    wrapper.setAttribute(
      'role',
      'alert'
    );

    wrapper.textContent =
      `Schema Checker failed: ${message}`;

    return wrapper;
  }

  function installPatch() {
    const originalValidateXmlSchema =
      root.validateXmlSchema;

    if (
      typeof originalValidateXmlSchema !==
      'function'
    ) {
      console.error(
        '[SCHEMA][TARIFF] validateXmlSchema is unavailable. ' +
        'Load checker_schema_occurrence_limits.js after checker_schema.js.'
      );

      return false;
    }

    if (!root.MandatoryTariffShared) {
      console.error(
        '[SCHEMA][TARIFF] MandatoryTariffShared is unavailable. ' +
        'Load mandatory_tariff_shared.js before checker_schema.js.'
      );

      return false;
    }

    root.validateXmlSchema =
      async function patchedValidateXmlSchema() {
        const args = arguments;

        const xmlFile =
          resolveXmlFile();

        const statusElement =
          getScopedElement(
            'uploadStatus'
          );

        if (!xmlFile) {
          return originalValidateXmlSchema
            .apply(
              this,
              args
            );
        }

        let tariffData;
        let xmlDocument;

        try {
          const [
            loadedTariff,
            xmlText
          ] = await Promise.all([
            root.MandatoryTariffShared
              .loadBundledMandatoryTariff(),

            xmlFile.text()
          ]);

          tariffData =
            loadedTariff;

          xmlDocument =
            parseXml(xmlText);
        } catch (error) {
          const message =
            error?.message ||
            String(error);

          console.error(
            '[SCHEMA][TARIFF] Failed before Schema validation:',
            error
          );

          if (statusElement) {
            statusElement.textContent =
              `Schema Checker failed: ${message}`;
          }

          return createErrorResult(
            message
          );
        }

        const resultElement =
          await originalValidateXmlSchema
            .apply(
              this,
              args
            );

        if (
          !resultElement ||
          xmlDocument
            .documentElement
            .nodeName !==
              'Claim.Submission'
        ) {
          return resultElement;
        }

        try {
          for (
            const warning
            of tariffData.warnings ||
            []
          ) {
            console.warn(
              '[SCHEMA][TARIFF]',
              warning
            );
          }

          const rawFindings =
            root.MandatoryTariffShared
              .validateSubmissionOccurrenceLimits(
                xmlDocument,
                tariffData.map
              );

          const selfPayClaimIDs =
            getSelfPayClaimIDs(
              xmlDocument
            );

          const {
            findings,
            exemptedFindings
          } =
            filterSelfPay17999Findings(
              rawFindings,
              selfPayClaimIDs
            );

          const findingsByClaim =
            groupFindingsByClaim(
              findings
            );

          const results =
            updateLastResults(
              findingsByClaim
            );

          updateRenderedTable(
            resultElement,
            results,
            findingsByClaim
          );

          updateSummary(results);

          root._lastTariffOccurrenceFindings =
            findings;

          root._lastTariffOccurrenceExemptions =
            exemptedFindings;

          console.log(
            `[SCHEMA][TARIFF] Applied CPT MUE occurrence limits from ${tariffData.sheetName}. ` +
            `Findings: ${findings.length}; ` +
            `SelfPay 17999 exemptions: ${exemptedFindings.length}; ` +
            `tariff rows: ${tariffData.rows.length}; ` +
            `source: ${tariffData.path}`
          );
        } catch (error) {
          const message =
            error?.message ||
            String(error);

          console.error(
            '[SCHEMA][TARIFF] Failed to apply occurrence limits:',
            error
          );

          if (statusElement) {
            statusElement.textContent =
              `Schema Checker failed: ${message}`;
          }

          return createErrorResult(
            message
          );
        }

        return resultElement;
      };

    root.__schemaOccurrenceLimitsPatchInstalled =
      true;

    root.SchemaOccurrenceLimitsPatch =
      Object.freeze({
        cleanRemarkLines,
        applyFindingsToResult,
        groupFindingsByClaim,
        getSelfPayClaimIDs,
        filterSelfPay17999Findings
      });

    console.log(
      '[SCHEMA][TARIFF] CPT MUE occurrence-limit patch installed.'
    );

    return true;
  }

  installPatch();
})(
  typeof window !== 'undefined'
    ? window
    : globalThis
);
