// mandatory_tariff_shared.js
// Shared loader and validator for the bundled Mandatory Tariff workbook.
// Used by checker_schema.js and checker_pricing.js so both read the same
// parsed map and cannot drift apart.

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  // The exact filename as it exists in the repository (double-space intended)
  const MANDATORY_TARIFF_PATH = '../resources/Mandatory Tariff  Updated.xlsx';

  // Workbook sheet to use for occurrence limits
  const TARIFF_SHEET_NAME = 'Mandatory Tariff 2021 ';

  // Column names in the workbook
  const COL_TYPE    = 'Type';
  const COL_CODE    = 'Code';
  const COL_PRICE   = 'Price \r\n(AED)';
  const COL_MUE     = 'CPT \r\nMUE Values';

  // Maps XML Activity Type numbers to workbook Type values
  const ACTIVITY_TYPE_TO_TARIFF_TYPE = {
    '3': 'CPT',
    '6': 'USCLS',
    '8': 'SERVICE'
  };

  // -----------------------------------------------------------------------
  // Cache
  // -----------------------------------------------------------------------

  let mandatoryTariffPromise = null;

  // -----------------------------------------------------------------------
  // Pure helpers
  // -----------------------------------------------------------------------

  /**
   * Normalise an activity type to the uppercase string used in the tariff.
   * Accepts both the XML numeric code ('3', '6', '8') and the tariff string
   * ('CPT', 'USCLS', 'SERVICE').
   * Returns the tariff string or the uppercased input if no mapping is found.
   */
  function normalizeActivityType(value) {
    const s = String(value || '').trim();
    return ACTIVITY_TYPE_TO_TARIFF_TYPE[s] || s.toUpperCase();
  }

  /**
   * Normalise a tariff code: strip leading zeros, uppercase, trim whitespace.
   */
  function normalizeTariffCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\.0+$/g, '')
      .replace(/^0+(?=\w)/, '');
  }

  /**
   * Build the map key used to look up a tariff row.
   */
  function makeTariffKey(activityType, code) {
    return normalizeActivityType(activityType) + '|' + normalizeTariffCode(code);
  }

  /**
   * Parse the raw `CPT MUE Values` cell value into a structured result.
   *
   * Returns:
   *   { limit: null,    error: null }   — blank; unlimited
   *   { limit: number,  error: null }   — valid positive integer limit
   *   { limit: null,    error: string } — present but invalid
   */
  function parseMaxOccurrences(rawValue) {
    const text = String(rawValue == null ? '' : rawValue).trim();

    if (!text) {
      return { limit: null, error: null };
    }

    const number = Number(text);

    if (!Number.isInteger(number) || number < 1) {
      return {
        limit: null,
        error: 'Invalid CPT Modifier limit: ' + text
      };
    }

    return { limit: number, error: null };
  }

  /**
   * Build the tariff Map from an array of raw workbook rows.
   *
   * Returns { map: Map<string, TariffRecord>, warnings: string[] }
   *
   * TariffRecord:
   *   { activityType, code, price, maxOccurrencesPerClaim, rawRow }
   */
  function buildMandatoryTariffMap(rows) {
    const map = new Map();
    const warnings = [];

    (Array.isArray(rows) ? rows : []).forEach(row => {
      const rawType = String(row[COL_TYPE] || '').trim();
      const rawCode = String(row[COL_CODE] || '').trim();

      if (!rawType || !rawCode) return;

      const activityType = rawType.toUpperCase();
      const code = normalizeTariffCode(rawCode);
      if (!code) return;

      const rawPrice = row[COL_PRICE];
      const priceText = String(rawPrice == null ? '' : rawPrice).trim();
      const price = (priceText === '' || priceText === 'N/A')
        ? null
        : Number(priceText);

      const rawMue = row[COL_MUE];
      const mueResult = parseMaxOccurrences(rawMue);

      if (mueResult.error) {
        warnings.push(
          'Tariff row ' + rawType + '/' + rawCode + ': ' + mueResult.error
        );
      }

      const key = activityType + '|' + code;

      // First row wins (do not overwrite an already-parsed entry)
      if (!map.has(key)) {
        map.set(key, {
          activityType,
          code,
          price: Number.isFinite(price) ? price : null,
          maxOccurrencesPerClaim: mueResult.limit,
          rawRow: row
        });
      }
    });

    return { map, warnings };
  }

  /**
   * Parse the XLSX workbook (already loaded as an ArrayBuffer or SheetJS workbook)
   * and return { map, warnings }.
   */
  function parseMandatoryTariffWorkbook(wb) {
    const ws = wb.Sheets[TARIFF_SHEET_NAME];
    if (!ws) {
      throw new Error(
        'Mandatory Tariff workbook does not contain the expected sheet "' +
        TARIFF_SHEET_NAME + '".'
      );
    }
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: 0 });
    return buildMandatoryTariffMap(rows);
  }

  /**
   * Load and parse the bundled Mandatory Tariff workbook once; cache the
   * promise so subsequent calls reuse the same result.
   *
   * Resolves with { map: Map, warnings: string[] }.
   * Rejects with an Error if the workbook cannot be fetched or parsed.
   */
  function loadBundledMandatoryTariff() {
    if (mandatoryTariffPromise) {
      return mandatoryTariffPromise;
    }

    mandatoryTariffPromise = fetch(MANDATORY_TARIFF_PATH)
      .then(response => {
        if (!response.ok) {
          throw new Error(
            'Mandatory Tariff workbook could not be loaded (HTTP ' +
            response.status + ').'
          );
        }
        return response.arrayBuffer();
      })
      .then(buffer => {
        const wb = XLSX.read(buffer, { type: 'array' });
        return parseMandatoryTariffWorkbook(wb);
      })
      .catch(err => {
        // Reset cache so a retry is possible
        mandatoryTariffPromise = null;
        throw err;
      });

    return mandatoryTariffPromise;
  }

  // -----------------------------------------------------------------------
  // Lookup helpers
  // -----------------------------------------------------------------------

  /**
   * Return the tariff record for a given activity type + code, or null.
   */
  function getTariffRow(tariffMap, activityType, code) {
    if (!tariffMap) return null;
    return tariffMap.get(makeTariffKey(activityType, code)) || null;
  }

  /**
   * Return the maximum allowed occurrences per claim for a code, or null if
   * unlimited / not found.
   */
  function getMaxOccurrencesPerClaim(tariffMap, activityType, code) {
    const row = getTariffRow(tariffMap, activityType, code);
    return row ? row.maxOccurrencesPerClaim : null;
  }

  // -----------------------------------------------------------------------
  // Claim occurrence validator
  // -----------------------------------------------------------------------

  /**
   * Validate that no tariff code exceeds its maximum occurrence limit in a
   * single claim.
   *
   * Parameters:
   *   claim      — DOM Element for the Claim
   *   tariffMap  — Map returned by loadBundledMandatoryTariff / buildMandatoryTariffMap
   *   getText    — function(tagName, parentElement?) → string
   *
   * Returns an array of finding objects:
   *   {
   *     ruleId, status, activityType, code,
   *     actualCount, allowedCount, remark
   *   }
   *
   * Rules:
   *   - Count Activity elements by (ActivityType, Code) key.
   *   - Quantity is irrelevant; only the number of Activity elements matters.
   *   - Blank tariff MUE → unlimited → no finding.
   *   - Code not in tariff → no finding.
   *   - One finding per (Claim, ActivityType, Code) — not one per extra activity.
   */
  function validateClaimOccurrenceLimits(options) {
    const claim     = options.claim;
    const tariffMap = options.tariffMap;
    const getText   = options.getText;

    const findings = [];
    if (!claim || !tariffMap) return findings;

    const occurrences = new Map();

    const activities = Array.from(claim.getElementsByTagName('Activity'));

    for (const activity of activities) {
      const type = getText ? getText('Type', activity) : _defaultGetText('Type', activity);
      const code = getText ? getText('Code', activity) : _defaultGetText('Code', activity);

      if (!code) continue;

      const key = makeTariffKey(type, code);

      if (!occurrences.has(key)) {
        occurrences.set(key, { type, code, count: 0 });
      }
      occurrences.get(key).count += 1;
    }

    for (const [, occurrence] of occurrences) {
      const tariffRow = getTariffRow(tariffMap, occurrence.type, occurrence.code);
      if (!tariffRow) continue;

      const limit = tariffRow.maxOccurrencesPerClaim;
      if (limit === null) continue; // unlimited

      if (occurrence.count > limit) {
        findings.push({
          ruleId: 'TARIFF_MAX_OCCURRENCES',
          status: 'Invalid',
          activityType: occurrence.type,
          code: occurrence.code,
          actualCount: occurrence.count,
          allowedCount: limit,
          remark:
            occurrence.code +
            ' can only be coded ' +
            limit +
            (limit === 1 ? ' time' : ' times') +
            ' in one claim.'
        });
      }
    }

    return findings;
  }

  function _defaultGetText(tagName, parent) {
    if (!parent) return '';
    const el = parent.getElementsByTagName(tagName)[0];
    return el && el.textContent ? el.textContent.trim() : '';
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const api = {
    MANDATORY_TARIFF_PATH,
    ACTIVITY_TYPE_TO_TARIFF_TYPE,
    normalizeActivityType,
    normalizeTariffCode,
    makeTariffKey,
    parseMaxOccurrences,
    buildMandatoryTariffMap,
    parseMandatoryTariffWorkbook,
    loadBundledMandatoryTariff,
    getTariffRow,
    getMaxOccurrencesPerClaim,
    validateClaimOccurrenceLimits
  };

  if (typeof window !== 'undefined') {
    window.MandatoryTariffShared = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
