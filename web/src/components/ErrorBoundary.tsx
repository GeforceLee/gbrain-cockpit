import { Component, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";

// A render error in one panel must not blank the whole app (dev lesson:
// a shape mismatch whited out every panel). Keep the shell alive and name
// the offending panel; brain content is untrusted, so defensive rendering
// still rules — this is the last resort, not an excuse.

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[panel] render error:", error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <BoundaryMessage error={this.state.error} reset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function BoundaryMessage({ error, reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n();
  return (
    <section className="panel">
      <h2>{t("common.panelError")}</h2>
      <p className="error">{String(error.message || error)}</p>
      <button type="button" onClick={reset}>
        {t("common.retry")}
      </button>
    </section>
  );
}
