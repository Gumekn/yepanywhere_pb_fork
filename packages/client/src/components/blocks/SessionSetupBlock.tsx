import { memo } from "react";
import type { ContentBlock } from "../../types";

interface Props {
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

function getPromptText(prompt: string | ContentBlock[]): string {
  if (typeof prompt === "string") {
    return prompt;
  }

  return prompt
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function getPromptKey(prompt: string | ContentBlock[]): string {
  const text = getPromptText(prompt);

  return `a:${prompt.length}:${text.length}:${text.slice(0, 80)}`;
}

export const SessionSetupBlock = memo(function SessionSetupBlock({
  title,
  prompts,
}: Props) {
  const promptKeyCounts = new Map<string, number>();

  return (
    <details className="session-setup-block collapsible">
      <summary className="collapsible__summary">
        <span className="collapsible__icon">▸</span>
        <span>{title}</span>
        {prompts.length > 1 && (
          <span className="session-setup-count">{prompts.length}</span>
        )}
      </summary>
      <div className="collapsible__content">
        {prompts.map((prompt) => {
          const baseKey = getPromptKey(prompt);
          const count = (promptKeyCounts.get(baseKey) ?? 0) + 1;
          promptKeyCounts.set(baseKey, count);
          return (
            <div className="session-setup-entry" key={`${baseKey}:${count}`}>
              <pre className="session-setup-text">{getPromptText(prompt)}</pre>
            </div>
          );
        })}
      </div>
    </details>
  );
});
