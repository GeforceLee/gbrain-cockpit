// Shared clipboard helper for copy affordances (the command block AND the
// green "accept" stamp). Secure contexts use the async clipboard API; the
// fallback selects the command block's code node (or a scratch textarea when
// the block is absent) so manual Cmd-C still works.

export function commandHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}

/** True when the text is on the clipboard; false when the browser refused
 *  the clipboard API and the caller must tell the user to press Ctrl/⌘-C. */
export async function copyCommandText(command: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    // clipboard API unavailable (non-secure context) — select for manual copy
    const node = document.getElementById("cmd-" + commandHash(command));
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return false;
    }
    const scratch = document.createElement("textarea");
    scratch.value = command;
    scratch.setAttribute("readonly", "true");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    try {
      document.execCommand("copy");
    } catch {
      // last resort: leave the scratch textarea selected so Ctrl/Cmd-C works
    }
    scratch.remove();
    return false;
  }
}
