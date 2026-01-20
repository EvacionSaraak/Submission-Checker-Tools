/**
 * Common Table Renderer
 * Provides unified table rendering functionality for all checkers
 * Supports different formats per checker while maintaining consistency
 */

const TableRenderer = {
  /**
   * Create a Bootstrap-styled table from data array
   * @param {Array} data - Array of row objects
   * @param {Array} columns - Column definitions [{key, label, className?, formatter?, render?}]
   * @param {Object} options - Rendering options
   * @returns {string} HTML string
   */
  createTable(data, columns, options = {}) {
    const {
      tableClass = 'table table-striped table-bordered',
      emptyMessage = 'No data to display',
      rowClassifier = null, // Function to determine row class based on row data
      caption = null,
      renderCustomCell = null, // Function to render custom cell HTML
      allowHTML = false // Allow HTML in cell values (use with caution)
    } = options;

    if (!data || data.length === 0) {
      return `<div class="alert alert-info">${emptyMessage}</div>`;
    }

    let html = `<table class="${tableClass}">`;
    
    if (caption) {
      html += `<caption>${caption}</caption>`;
    }

    // Header
    html += '<thead><tr>';
    columns.forEach(col => {
      const thStyle = col.style ? ` style="${col.style}"` : '';
      html += `<th class="${col.className || ''}"${thStyle}>${col.label}</th>`;
    });
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    data.forEach((row, index) => {
      const rowClass = rowClassifier ? rowClassifier(row, index) : '';
      html += `<tr class="${rowClass}">`;
      
      columns.forEach(col => {
        let cellContent = '';
        const tdStyle = col.style ? ` style="${col.style}"` : '';
        
        // Custom render function takes precedence
        if (col.render && typeof col.render === 'function') {
          cellContent = col.render(row, index);
        } else if (renderCustomCell) {
          cellContent = renderCustomCell(col.key, row, index);
        } else {
          let value = row[col.key];
          
          // Apply formatter if provided
          if (col.formatter && typeof col.formatter === 'function') {
            value = col.formatter(value, row, index);
          } else if (value === null || value === undefined) {
            value = '';
          }
          
          // Escape HTML unless explicitly allowed
          cellContent = allowHTML ? value : this._escapeHtml(value);
        }
        
        html += `<td class="${col.className || ''}"${tdStyle}>${cellContent}</td>`;
      });
      
      html += '</tr>';
    });
    html += '</tbody>';

    html += '</table>';
    return html;
  },

  /**
   * Escape HTML to prevent XSS
   */
  _escapeHtml(text) {
    if (typeof text !== 'string') return text;
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Row classifier for valid/invalid data
   * Compatible with existing checker patterns
   */
  validationRowClassifier(row) {
    if (row.Valid === true || row.valid === true || row.isValid === true) {
      return 'table-success';
    } else if (row.Valid === false || row.valid === false || row.isValid === false) {
      return 'table-danger';
    }
    return '';
  },

  /**
   * Create error display
   */
  createErrorDisplay(message) {
    return `<div class="alert alert-danger">${message}</div>`;
  },

  /**
   * Create success display
   */
  createSuccessDisplay(message) {
    return `<div class="alert alert-success">${message}</div>`;
  },

  /**
   * Create info display
   */
  createInfoDisplay(message) {
    return `<div class="alert alert-info">${message}</div>`;
  },

  /**
   * Format common data types
   */
  formatters: {
    boolean: (value) => value ? 'Yes' : 'No',
    checkmark: (value) => value ? '✓' : '✗',
    date: (value) => value ? new Date(value).toLocaleDateString() : '',
    number: (value) => value?.toLocaleString() || '',
    currency: (value) => value ? `$${parseFloat(value).toFixed(2)}` : ''
  },

  /**
   * Predefined checker-specific configurations
   * These can be used as templates for each checker
   */
  checkerConfigs: {
    schema: {
      columns: (schemaType) => [
        { key: 'ClaimID', label: schemaType === 'person' ? 'Member ID' : 'Claim ID', className: '' },
        { key: 'Remark', label: 'Remark', className: '' },
        { 
          key: 'Valid', 
          label: 'Valid', 
          formatter: (val) => val ? 'Yes' : 'No',
          className: ''
        },
        {
          key: 'ClaimXML',
          label: 'View Full Entry',
          render: (row) => `<button class="btn btn-sm btn-info" onclick="showModal(claimToHtmlTable(row.ClaimXML))">View</button>`,
          className: ''
        }
      ],
      rowClassifier: (row) => row.Valid ? 'table-success' : 'table-danger',
      tableClass: 'table table-striped table-bordered'
    },

    clinician: {
      // Clinician checker has complex table with multiple columns
      // Configuration would be defined by the checker itself
      dynamic: true
    },

    eligibility: {
      // Eligibility checker has nested data and modals
      // Configuration would be defined by the checker itself
      dynamic: true
    },

    timings: {
      // Timings checker format
      dynamic: true
    },

    teeth: {
      // Teeth checker format
      dynamic: true
    },

    authorization: {
      // Auth checker format
      dynamic: true
    },

    pricing: {
      // Pricing checker format
      dynamic: true
    },

    modifiers: {
      // Modifiers checker format
      dynamic: true
    }
  },

  /**
   * Get configuration for specific checker
   */
  getCheckerConfig(checkerName, ...args) {
    const config = this.checkerConfigs[checkerName];
    if (!config) return null;
    
    if (config.dynamic) {
      // For dynamic configs, return null to let checker handle rendering
      return null;
    }
    
    // For static configs (like schema), call columns function if needed
    if (typeof config.columns === 'function') {
      return {
        ...config,
        columns: config.columns(...args)
      };
    }
    
    return config;
  }
};

// Make available globally
if (typeof window !== 'undefined') {
  window.TableRenderer = TableRenderer;
}
