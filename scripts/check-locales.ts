// CI gate (FEATURES §4.0): the zh-CN and en locale packs must carry the exact
// same key set — a missing translation is a build failure, not a follow-up.
// TypeScript already enforces this at compile time via the Record type in
// web/src/lib/i18n.tsx; this script makes it a visible, named CI step.
import { en } from "../web/src/locales/en";
import { zhCN } from "../web/src/locales/zh-CN";

const zhKeys = new Set(Object.keys(zhCN));
const enKeys = new Set(Object.keys(en));

const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

if (missingInEn.length > 0 || missingInZh.length > 0) {
  console.error("locale key drift detected:");
  for (const key of missingInEn) console.error(`  missing in en:    ${key}`);
  for (const key of missingInZh) console.error(`  missing in zh-CN: ${key}`);
  process.exit(1);
}

console.log(`locale key sets match: ${zhKeys.size} keys in zh-CN and en`);
