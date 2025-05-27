const pages = [
  { label: "Clinician (WIP)", file: "checkers/checker_clinician.html" },
  { label: "Approvals (WIP)", file: "checkers/checker_procedure_approval.html" },
  { label: "Timings", file: "checkers/checker_timings.html" },
  { label: "Tooths", file: "checkers/checker_tooths.html" }
];

const navbar = document.getElementById("navbar");
const iframe = document.getElementById("mainIframe");

function setActiveButton(activeIndex) {
  Array.from(navbar.children).forEach((btn, i) => {
    // Only toggle active class for buttons, not the report link div
    if (btn.tagName === 'BUTTON') {
      btn.classList.toggle("active", i === activeIndex);
    }
  });
}

function loadPage(file, index) {
  iframe.src = file;
  setActiveButton(index);
}

function buildNavbar() {
  navbar.innerHTML = "";

  // Create buttons for each page
  pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.textContent = page.label;
    btn.onclick = () => loadPage(page.file, i);
    navbar.appendChild(btn);
  });

  // Add the report issue link below buttons
  const reportDiv = document.createElement("div");
  reportDiv.className = "form-link";
  reportDiv.innerHTML = `
    Found an issue? Please report it to the
    <a href="https://github.com/EvacionSaraak/Submission-Checker-Tools" target="_blank" rel="noopener">developer</a>.
  `;
  navbar.appendChild(reportDiv);

  // Load first page by default
  loadPage(pages[0].file, 0);
}

buildNavbar();
