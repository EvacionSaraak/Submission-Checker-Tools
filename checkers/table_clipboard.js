// table_clipboard.js — global clipboard handler for all table cells using tables.css
// Add this to borrom: <script src="clipboard.js"></script>

document.addEventListener('click', e => {
  const cell = e.target;

  // Must be a TD, and not inside or containing a button/input
  if (
    cell.tagName === 'TD' &&
    !cell.closest('button') &&
    !cell.querySelector('button') &&
    !cell.closest('input') &&
    !cell.querySelector('input')
  ) {
    const text = cell.textContent.trim();
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        cell.classList.add('copied');
        setTimeout(() => cell.classList.remove('copied'), 800);
      }).catch(err => {
        console.error('Clipboard copy failed:', err);
      });
    }
  }
});
