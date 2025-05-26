// List of pages to load from checkers/ folder (relative paths)
const pages = [
  { label: "Clinician", file: "checkers/checker_clinician.html" },
  { label: "Approvals", file: "checkers/checker_procedure_approval.html" },
  { label: "Timings", file: "checkers/checker_start_end_timing.html" },
  { label: "Tooths", file: "checkers/checker_tooths.html" }
];

const navbar = document.getElementById("navbar");
const mainContent = document.getElementById("mainContent");

function setActiveButton(activeIndex) {
  Array.from(navbar.children).forEach((btn, i) => {
    btn.classList.toggle("active", i === activeIndex);
  });
}

async function loadPage(file, index) {
  try {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const html = await response.text();
    mainContent.innerHTML = html;
    setActiveButton(index);
  } catch (error) {
    mainContent.innerHTML = `<h2>Error loading page: ${error.message}</h2>`;
    console.error(error);
  }
}

function buildNavbar() {
  navbar.innerHTML = "";
  pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.textContent = page.label;
    btn.onclick = () => loadPage(page.file, i);
    navbar.appendChild(btn);
  });
  // Load the first page by default
  loadPage(pages[0].file, 0);
}

// Build nav and load first page on startup
buildNavbar();
