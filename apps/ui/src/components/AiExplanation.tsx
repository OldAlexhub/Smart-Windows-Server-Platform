import { Sparkles } from "lucide-react";
import { BRAND } from "@nexus/shared/brand";

export interface AiExplanation {
  explanation: string;
  steps: string[];
}

/** The assistant's explanation of a problem. It only recommends; nothing was changed. */
export function AiExplanationCard({ ai }: { ai: AiExplanation }) {
  return (
    <div className="ai-explanation" role="note">
      <span className="ai-explanation-head"><Sparkles size={14} /> {BRAND.assistantName} explains</span>
      <p>{ai.explanation}</p>
      {ai.steps.length > 0 && (
        <ol className="small">
          {ai.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      <small className="muted">A suggestion only — nothing has been changed.</small>
    </div>
  );
}
