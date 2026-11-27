// The server's token-name rules (server/src/tokens.ts), mirrored on the
// client for ONE purpose: tell the admin about a bad name before they are
// asked to paste the admin token. The server stays the only judge — this
// is a courtesy check, kept in the same order and with the same folding.

const NAME_CHARS = /^[\p{Script=Han}A-Za-z0-9 ._()·-]+$/u;
const NAME_HAS_LETTER = /[\p{Script=Han}A-Za-z]/u;
const SKELETON_CHARS = /[\p{Script=Han}A-Za-z0-9]/u;
const DIGIT_FOLD: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

export function normalizeTokenName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function nameSkeleton(name: string): string {
  return [...name.normalize("NFKC")]
    .filter((ch) => SKELETON_CHARS.test(ch))
    .map((ch) => DIGIT_FOLD[ch] ?? ch.toLowerCase())
    .map((ch) => (ch === "l" ? "i" : ch))
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");
}

const RESERVED_SKELETONS = ["owner", "admin", "root"];
const RESERVED_WORDS = ["管理员", "业主"];

/** A name that reads the same as one of the active tokens' (same skeleton). */
export function nameIsTaken(raw: string, activeNames: readonly string[]): boolean {
  const skeleton = nameSkeleton(normalizeTokenName(raw));
  return activeNames.some((other) => nameSkeleton(other) === skeleton);
}

/** Null when the name is acceptable; otherwise why it is not. */
export function checkTokenName(raw: string): "shape" | "reserved" | null {
  const name = normalizeTokenName(raw);
  const length = [...name].length;
  if (length < 1 || length > 40) return "shape";
  if (!NAME_CHARS.test(name) || !NAME_HAS_LETTER.test(name)) return "shape";
  const skeleton = nameSkeleton(name);
  if (
    RESERVED_SKELETONS.some((word) => skeleton.includes(word)) ||
    RESERVED_WORDS.some((word) => name.includes(word))
  ) {
    return "reserved";
  }
  return null;
}
