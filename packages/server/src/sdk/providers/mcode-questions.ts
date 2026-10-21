/**
 * Translate MiniMax Code questionnaires (ACP `elicitation/create`, form mode)
 * into Yep's provider-neutral AskUserQuestion input, and Yep's answers back
 * into the elicitation `content` object mcode expects.
 *
 * mcode builds one schema property per questionnaire step (see
 * references/minimax/pretty/run-acp-command.js `Hx`/`Vx`/`Jx`):
 * - single select: `{type:"string", title, oneOf:[{const, title, description}]}`
 * - multi select:  `{type:"array",  title, items:{anyOf:[{const, title}]}}`
 * - free text:     `{type:"string", title}`
 * - "Other" input: an extra string property `<stepId>__other` next to a
 *   select step that allows a custom answer.
 * Answers are option ids (`const`), arrays of ids, or free text.
 */

export interface McodeQuestionOption {
  label: string;
  value: string;
  description: string;
}

export interface McodeQuestion {
  id: string;
  question: string;
  header: string;
  options: McodeQuestionOption[];
  multiSelect: boolean;
  custom: boolean;
  required: boolean;
}

interface StepPlan {
  id: string;
  kind: "single" | "multi" | "text";
  optionIds: Set<string>;
  otherKey?: string;
}

export interface McodeQuestionnairePlan {
  questions: McodeQuestion[];
  steps: StepPlan[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptions(list: unknown): McodeQuestionOption[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.const !== "string") return [];
    return [
      {
        label:
          typeof entry.title === "string" && entry.title.trim()
            ? entry.title
            : entry.const,
        value: entry.const,
        description:
          typeof entry.description === "string" ? entry.description : "",
      },
    ];
  });
}

/**
 * Build the question list from an elicitation `requestedSchema`.
 * Returns null when the schema is not a shape this adapter understands, so
 * the caller can decline instead of submitting a malformed answer.
 */
export function planMcodeQuestionnaire(
  requestedSchema: unknown,
  message: string | undefined,
): McodeQuestionnairePlan | null {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) {
    return null;
  }
  const properties = requestedSchema.properties;
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
  );
  const keys = Object.keys(properties);
  const otherKeys = new Set<string>();
  const steps: StepPlan[] = [];
  const questions: McodeQuestion[] = [];

  const findOtherKey = (stepId: string): string | undefined => {
    let candidate = `${stepId}__other`;
    while (candidate in properties) {
      const prop = properties[candidate];
      if (
        isRecord(prop) &&
        prop.type === "string" &&
        !("oneOf" in prop) &&
        typeof prop.title === "string" &&
        /\u2014 Other$/.test(prop.title)
      ) {
        return candidate;
      }
      candidate += "_";
    }
    return undefined;
  };

  for (const key of keys) {
    const prop = properties[key];
    if (!isRecord(prop)) return null;
    let kind: StepPlan["kind"];
    let options: McodeQuestionOption[] = [];
    if (prop.type === "array") {
      kind = "multi";
      options = readOptions(isRecord(prop.items) ? prop.items.anyOf : null);
    } else if (prop.type === "string" && Array.isArray(prop.oneOf)) {
      kind = "single";
      options = readOptions(prop.oneOf);
    } else if (prop.type === "string") {
      kind = "text";
    } else {
      return null;
    }
    const otherKey = kind === "text" ? undefined : findOtherKey(key);
    if (otherKey) otherKeys.add(otherKey);
    steps.push({
      id: key,
      kind,
      optionIds: new Set(options.map((option) => option.value)),
      ...(otherKey ? { otherKey } : {}),
    });
    questions.push({
      id: key,
      question:
        typeof prop.title === "string" && prop.title.trim()
          ? prop.title
          : (message ?? key),
      header:
        typeof prop.description === "string" && prop.description.trim()
          ? prop.description.trim().slice(0, 60)
          : "Question",
      options,
      multiSelect: kind === "multi",
      custom: kind === "text" || Boolean(otherKey),
      required: required.has(key),
    });
  }

  // Drop the companion "Other" properties: they are answered through the
  // select question's custom input, not as separate questions.
  const filteredSteps = steps.filter((step) => !otherKeys.has(step.id));
  const filteredQuestions = questions.filter(
    (question) => !otherKeys.has(question.id),
  );
  if (filteredQuestions.length === 0) return null;
  return { questions: filteredQuestions, steps: filteredSteps };
}

/** Convert Yep answers (keyed by question id) into elicitation content. */
export function buildMcodeElicitationContent(
  plan: McodeQuestionnairePlan,
  answers: Record<string, unknown>,
): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {};
  for (const step of plan.steps) {
    const raw = answers[step.id];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (values.length === 0) continue;
    if (step.kind === "text") {
      content[step.id] = values.join("\n");
      continue;
    }
    const selected = values.filter((value) => step.optionIds.has(value));
    const others = values.filter((value) => !step.optionIds.has(value));
    if (step.kind === "multi") {
      if (selected.length > 0) content[step.id] = selected;
    } else if (selected[0]) {
      content[step.id] = selected[0];
    }
    if (others.length > 0 && step.otherKey) {
      content[step.otherKey] = others.join("\n");
    } else if (others.length > 0 && step.kind === "single" && !selected[0]) {
      // mcode treats an unknown single-select value as "Other" text when the
      // step allows it; otherwise it is ignored there, never mis-selected.
      content[step.id] = others[0] ?? "";
    }
  }
  return content;
}
