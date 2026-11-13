// Open the EXISTING workspace switcher in the app bar from a dead-end state.
//
// The control is rendered by WorkspaceSwitcher.svelte with this test id; a
// dead-end page points at it rather than growing a second picker of its own.
// `showPicker()` needs a user gesture and is unsupported in some engines, so a
// failure to open is NOT an error: focus alone leaves the switcher one
// keypress away and it stays visible in the header.
export const WORKSPACE_SWITCHER_SELECTOR = '[data-testid="workspace-switcher"]';

export function openWorkspaceSwitcher(): void {
  const el = document.querySelector<HTMLSelectElement>(WORKSPACE_SWITCHER_SELECTOR);
  if (!el) return;
  el.focus();
  try {
    el.showPicker?.();
  } catch {
    // showPicker needs a user gesture in some engines; focus is enough.
  }
}
