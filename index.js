document.addEventListener('DOMContentLoaded', () => {
  const pages = [
    { label: "Formatting", file: "checkers/checker_formatter.html" },
    { label: "Clinicians", file: "checkers/checker_clinician.html" },
    { label: "Eligs", file: "checkers/checker_elig.html" },
    { label: "Auths", file: "checkers/checker_auths.html" },
    { label: "Timings", file: "checkers/checker_timings.html" },
    { label: "Teeth", file: "checkers/checker_tooths.html" },
    { label: "Schema", file: "checkers/checker_schema.html" },
    { label: "Drugs", file: "checkers/checker_drugs.html" }
  ];

  const navLeft = document.getElementById("navLeft");
  const iframe = document.getElementById("mainIframe");

  function setActiveButton(activeIndex) {
    Array.from(navLeft.children).forEach((btn, i) => {
      btn.classList.toggle("active", i === activeIndex);
    });
  }

  function saveLastPage(index) {
    localStorage.setItem('lastOpenedPageIndex', index);
  }

  function loadPage(file, index) {
    iframe.src = file;
    setActiveButton(index);
    saveLastPage(index);
  }

  function enhanceIframeTable() {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const table = iframeDoc.querySelector("table");

    if (table) {
      table.classList.add("table", "table-striped", "table-bordered", "table-hover");
      if (typeof $(table).DataTable === 'function') {
        $(table).DataTable(); // jQuery DataTable activation
      }
    }
  }

  function buildNavbar() {
    navLeft.innerHTML = "";
    pages.forEach((page, i) => {
      const btn = document.createElement("button");
      btn.textContent = page.label;
      btn.onclick = () => {
        loadPage(page.file, i);
      };
      navLeft.appendChild(btn);
    });

    // Load last opened page if available, otherwise load first page
    const lastIndex = parseInt(localStorage.getItem('lastOpenedPageIndex'), 10);
    if (!isNaN(lastIndex) && lastIndex >= 0 && lastIndex < pages.length) {
      loadPage(pages[lastIndex].file, lastIndex);
    } else {
      loadPage(pages[0].file, 0);
    }
  }

  iframe.addEventListener("load", () => {
    setTimeout(enhanceIframeTable, 100); // Delay to ensure DOM is ready
  });

  buildNavbar();
});
