import { useI18n, type MessageKey } from "../lib/i18n";

// Placeholder for the four panels that land in V1.0. Every panel already
// carries its one-line self-description — copy is part of the feature
// (FEATURES §4.0), so the descriptions below are the real product strings.

export type PlaceholderPanelId = "inbox" | "nebula" | "pages" | "search";

export function Placeholder({ panelId }: { panelId: PlaceholderPanelId }) {
  const { t } = useI18n();
  return (
    <section className="panel">
      <h2>{t(`panel.${panelId}.title` as MessageKey)}</h2>
      <p className="panel-desc">{t(`panel.${panelId}.desc` as MessageKey)}</p>
      <p className="panel-note">{t("panel.placeholder")}</p>
    </section>
  );
}
