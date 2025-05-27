const pages = [
  { label: "Clinician (WIP)", file: "checkers/checker_clinician.html" },
  { label: "Approvals (WIP)", file: "checkers/checker_procedure_approval.html" },
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

function buildNavbar() {
  navLeft.innerHTML = ""; // Clear existing buttons if any
  pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.textContent = page.label;
    btn.onclick = () => loadPage(page.file, i);
    navLeft.appendChild(btn);
  });
  loadPage(pages[0].file, 0);
}

// Initialize navbar on DOM ready or script load
buildNavbar();
