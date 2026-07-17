(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DrugAnalysisShared = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DRUG_FORMULARY_CONFIG = {
    D001: {
      name: 'Thiqa',
      column: 'Included in Thiqa/ ABM - other than 1&7- Drug Formulary'
    },
    D004: {
      name: 'Daman Basic',
      column: 'Included In Basic Drug Formulary'
    }
  };

  const DEFAULT_QUANTITY_AUDITOR_RECEIVERS = new Set(['D001', 'A001', 'D004']);

  function normalizeDrugCode(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeLoose(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeBooleanLike(value) {
    const normalized = normalizeLoose(value);
    if (['YES', 'TRUE', '1', 'Y'].includes(normalized)) return true;
    if (['NO', 'FALSE', '0', 'N'].includes(normalized)) return false;
    return null;
  }

  function roundMoney(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.round((number + Number.EPSILON) * 100) / 100
      : null;
  }

  function moneyToCents(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.round((number + Number.EPSILON) * 100)
      : null;
  }

  function moneyEqual(a, b) {
    const centsA = moneyToCents(a);
    const centsB = moneyToCents(b);
    return centsA !== null && centsB !== null && centsA === centsB;
  }

  function parseDrugWorkbook(workbook, xlsx) {
    const sheetName = (workbook && workbook.SheetNames || []).find(name =>
      String(name || '').trim().toLowerCase() === 'drugs'
    );

    if (!sheetName) {
      return {
        map: null,
        rows: [],
        sheetName: '',
        error: "Missing worksheet 'Drugs'."
      };
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    const map = new Map();

    rows.forEach(row => {
      const code = normalizeDrugCode(row['Drug Code']);
      if (code) map.set(code, row);
    });

    return { map, rows, sheetName, error: null };
  }

  function getNumericDrugColumn(drug, primaryColumn, fallbackColumn) {
    const primaryRaw = drug ? drug[primaryColumn] : null;
    const primary = Number(primaryRaw);
    if (
      primaryRaw !== '' && primaryRaw !== undefined && primaryRaw !== null &&
      Number.isFinite(primary) && primary > 0
    ) {
      return { value: primary, source: primaryColumn };
    }

    const fallbackRaw = drug ? drug[fallbackColumn] : null;
    const fallback = Number(fallbackRaw);
    if (
      fallbackRaw !== '' && fallbackRaw !== undefined && fallbackRaw !== null &&
      Number.isFinite(fallback) && fallback > 0
    ) {
      return { value: fallback, source: fallbackColumn };
    }

    return { value: null, source: '' };
  }

  function calculateRequiredDrugQuantity(drug) {
    const packagePriceToPublic = Number(drug ? drug['Package Price to Public'] : NaN);
    const unitPriceToPublic = Number(drug ? drug['Unit Price to Public'] : NaN);

    if (!Number.isFinite(packagePriceToPublic) || !Number.isFinite(unitPriceToPublic) || packagePriceToPublic <= 0 || unitPriceToPublic <= 0) {
      return null;
    }

    return roundMoney(unitPriceToPublic / packagePriceToPublic);
  }

  function selectDrugPricing(drug, quantity) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { value: null, source: '', basis: '' };
    }

    if (qty < 1) {
      const selected = getNumericDrugColumn(drug, 'Package Markup', 'Package Price to Public');
      return { ...selected, basis: 'Package' };
    }

    const selected = getNumericDrugColumn(drug, 'Unit Markup', 'Unit Price to Public');
    return { ...selected, basis: 'Unit' };
  }

  function validateDrugStatus(drug, code) {
    const statusRaw = String((drug && drug['Status']) || '').trim();
    const normalized = statusRaw.toLowerCase();

    if (normalized === 'active' || normalized === 'grace') {
      return { ruleId: 'DRUG_STATUS', status: 'Valid', remark: '', value: statusRaw || 'Active' };
    }

    if (!statusRaw) {
      return {
        ruleId: 'DRUG_STATUS',
        status: 'Unknown',
        remark: `Drug ${code} has no status in the drug reference.`,
        value: ''
      };
    }

    return {
      ruleId: 'DRUG_STATUS',
      status: 'Invalid',
      remark: `Drug ${code} is not active (Current status: ${statusRaw}).`,
      value: statusRaw
    };
  }

  function validateDrugFormulary(drug, receiverID, code) {
    const config = DRUG_FORMULARY_CONFIG[normalizeLoose(receiverID)] || null;
    if (!config) {
      return {
        ruleId: 'DRUG_FORMULARY',
        status: 'Valid',
        remark: '',
        formularyName: '',
        valueRaw: '',
        applies: false,
        included: null
      };
    }

    const valueRaw = String((drug && drug[config.column]) || '').trim();
    const normalized = normalizeBooleanLike(valueRaw);

    if (normalized === true) {
      return {
        ruleId: 'DRUG_FORMULARY',
        status: 'Valid',
        remark: '',
        formularyName: config.name,
        valueRaw,
        applies: true,
        included: true
      };
    }

    if (normalized === false) {
      return {
        ruleId: 'DRUG_FORMULARY',
        status: 'Invalid',
        remark: `Drug ${code} cannot be submitted with a nonzero price under the ${config.name} formulary.`,
        formularyName: config.name,
        valueRaw,
        applies: true,
        included: false
      };
    }

    return {
      ruleId: 'DRUG_FORMULARY',
      status: 'Unknown',
      remark: `Unable to determine whether drug ${code} is included in the ${config.name} formulary because the Drugs.xlsx formulary value is blank or unrecognized.`,
      formularyName: config.name,
      valueRaw,
      applies: true,
      included: null
    };
  }

  function validateDrugQuantity(params) {
    const code = params.code;
    const quantity = Number(params.quantity);
    const requiredQuantity = params.requiredQuantity;
    const receiverID = normalizeLoose(params.receiverID);
    const auditorReceivers = params.quantityAuditorReceivers || DEFAULT_QUANTITY_AUDITOR_RECEIVERS;
    const findings = [];

    if (!Number.isFinite(quantity) || quantity <= 0) {
      findings.push({
        ruleId: 'DRUG_QUANTITY',
        status: 'Invalid',
        remark: 'Quantity is missing or invalid for this activity.'
      });
      return findings;
    }

    if (requiredQuantity === null || !Number.isFinite(requiredQuantity)) {
      findings.push({
        ruleId: 'DRUG_QUANTITY',
        status: 'Unknown',
        remark: `Unable to compute required quantity for drug ${code}; manual verification is required.`
      });
    } else if (quantity < requiredQuantity && !moneyEqual(quantity, requiredQuantity)) {
      findings.push({
        ruleId: 'DRUG_QUANTITY',
        status: 'Invalid',
        remark: `Claimed quantity ${quantity} is less than the required quantity ${requiredQuantity} for drug ${code}.`
      });
    } else if (!moneyEqual(quantity, requiredQuantity)) {
      findings.push({
        ruleId: 'DRUG_QUANTITY',
        status: 'Unknown',
        remark: `Drug quantity ${quantity} does not match the expected package quantity ${requiredQuantity}; manual verification is required.`
      });
    }

    if (auditorReceivers.has(receiverID) && quantity > 1) {
      findings.push({
        ruleId: 'DRUG_QUANTITY_AUDIT',
        status: 'Unknown',
        remark: 'Drug quantity above 1 requires auditor confirmation.'
      });
    }

    return findings;
  }

  function calculateExpectedDrugNet(selectedPrice, quantity) {
    const price = Number(selectedPrice);
    const qty = Number(quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) return null;
    return roundMoney(price * qty);
  }

  function mergeDrugFindings(findings) {
    const deduped = [];
    const seen = new Set();
    (Array.isArray(findings) ? findings : []).forEach(f => {
      if (!f || !f.ruleId || !f.status) return;
      const key = `${f.ruleId}|${f.status}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(f);
    });
    return deduped;
  }

  function getFinalStatusFromFindings(findings) {
    const list = Array.isArray(findings) ? findings : [];
    if (list.some(f => f.status === 'Invalid')) return 'Invalid';
    if (list.some(f => f.status === 'Unknown')) return 'Unknown';
    return 'Valid';
  }

  return {
    DRUG_FORMULARY_CONFIG,
    DEFAULT_QUANTITY_AUDITOR_RECEIVERS,
    normalizeDrugCode,
    normalizeBooleanLike,
    parseDrugWorkbook,
    calculateRequiredDrugQuantity,
    selectDrugPricing,
    validateDrugStatus,
    validateDrugFormulary,
    validateDrugQuantity,
    calculateExpectedDrugNet,
    moneyEqual,
    roundMoney,
    mergeDrugFindings,
    getFinalStatusFromFindings
  };
});
