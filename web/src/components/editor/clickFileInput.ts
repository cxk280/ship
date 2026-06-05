/**
 * Reliably open the native file picker for a programmatic <input type="file">.
 *
 * Clicking an input that is NOT attached to the DOM is unreliable in some
 * environments — notably headless Chromium on Linux (our CI machine executor),
 * where the OS dialog (and Playwright's `filechooser` event) never fires, so
 * file/image upload flows hang. Attaching the input (hidden) before clicking
 * makes the dialog deterministic everywhere; we remove it once a file is chosen
 * or the dialog is dismissed.
 *
 * Callers keep their own `input.onchange` handler — they capture `input.files`
 * synchronously, so removing the element afterwards is safe.
 */
export function clickFileInput(input: HTMLInputElement): void {
  input.style.display = 'none';
  document.body.appendChild(input);

  const cleanup = () => {
    try {
      input.remove();
    } catch {
      /* already removed */
    }
  };
  // `change` fires on selection; `cancel` fires when the dialog is dismissed
  // (supported in modern Chromium). Either way, detach the input.
  input.addEventListener('change', cleanup, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });

  input.click();
}
