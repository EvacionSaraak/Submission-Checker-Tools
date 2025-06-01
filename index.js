document.addEventListener('DOMContentLoaded', () => {
  const pages = [
    { label: "Clinician and Eligibility", file: "checkers/checker_clinician.html" },
    { label: "Authorizations", file: "checkers/checker_auths.html" },
    { label: "Timings", file: "checkers/checker_timings.html" },
    { label: "Tooths", file: "checkers/checker_tooths.html" }
  ];

  const navLeft = document.getElementById("navLeft");
  const iframe = document.getElementById("mainIframe");

  function setActiveButton(activeIndex) {
    Array.from(navLeft.children).forEach((btn, i) => {
      btn.classList.toggle("active", i === activeIndex);
    });
  }

  function loadPage(file, index) {
    iframe.src = file;
    setActiveButton(index);
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
    loadPage(pages[0].file, 0);
  }

  iframe.addEventListener("load", () => {
    setTimeout(enhanceIframeTable, 100); // Delay to ensure DOM is ready
  });

  buildNavbar();
});
