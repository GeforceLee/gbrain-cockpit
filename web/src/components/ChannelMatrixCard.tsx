import { useI18n } from "../lib/i18n";

// 通道核查卡 (channel-check card): renders, for the currently selected item,
// which adjudication channel each action family travels — one-key / terminal /
// MCP / never. Rows are derived from ADJUDICATION_CHANNELS at the call site,
// so the card can never disagree with the real matrix.

export interface ChannelRow {
  label: string;
  /** channel note (mono), e.g. "cli-whitelist" */
  channel: string;
  verdict: "yes" | "no" | "na";
  note: string;
}

export function ChannelMatrixCard({ rows }: { rows: ChannelRow[] }) {
  const { t } = useI18n();
  return (
    <div className="check">
      <p className="cap">{t("channel.title")}</p>
      {rows.map((row) => (
        <div className="row" key={row.label}>
          <span>
            {row.label}
            <span className="ch"> · {row.channel}</span>
          </span>
          <b className={row.verdict}>{row.note}</b>
        </div>
      ))}
    </div>
  );
}
