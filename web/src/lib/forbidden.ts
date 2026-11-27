import type { PermissionMissing } from "@gbrain-cockpit/shared";
import type { MessageKey } from "./i18n";
import { translate } from "./i18n";

// The plain-language line for a 403 that names the missing grant. A leaf
// module on purpose: both the API client (which puts the line on
// ApiError.message so every panel that shows `err.message` gets it) and
// lib/errors need it, and those two must not import each other.

export function forbiddenMessage(
  missing: PermissionMissing,
  source: string | undefined,
  t: (key: MessageKey) => string = translate,
): string {
  switch (missing) {
    case "adjudicate":
      return t("error.forbidden.adjudicate");
    case "edit":
      return source
        ? t("error.forbidden.editSource").replace("{source}", source)
        : t("error.forbidden.edit");
    case "brain":
      return t("error.forbidden.brain");
    case "owner-only":
      return t("error.forbidden.ownerOnly");
    case "admin-tier":
      // the owner's base token met a management write: the structured twin
      // of the "paste the admin token" prompt
      return t("admin.stepUp.notAdmin");
    default: {
      const exhaustive: never = missing;
      return exhaustive;
    }
  }
}
