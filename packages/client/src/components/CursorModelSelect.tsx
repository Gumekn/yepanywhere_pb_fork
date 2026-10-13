import type { CursorModelConfigOption, ModelInfo } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import {
  buildCursorModelValue,
  getCursorModelSelection,
} from "../lib/cursorModels";
import { FilterDropdown } from "./FilterDropdown";

interface Props {
  models: ModelInfo[];
  value: string | null;
  onChange: (value: string) => void;
  accentColor: string;
  disabled?: boolean;
}

export function CursorModelSelect({
  models,
  value,
  onChange,
  accentColor,
  disabled,
}: Props) {
  const { t } = useI18n();
  const { model, parameters, raw } = getCursorModelSelection(models, value);
  const options = models.map((model) => ({
    value: model.id,
    label: model.name,
  }));
  if (raw && !model) options.unshift({ value: raw, label: raw });
  const configs = model?.cursorConfigOptions ?? [];
  const fast = configs.find(
    (config) =>
      config.id === "fast" &&
      config.options.some((option) => option.value === "true") &&
      config.options.some((option) => option.value === "false"),
  );
  const setParameter = (id: string, selected: string) => {
    if (model)
      onChange(buildCursorModelValue(model, { ...parameters, [id]: selected }));
  };
  const configLabel = (config: CursorModelConfigOption) => {
    if (config.id === "context") return t("cursorModelContext");
    if (config.id === "thinking") return t("newSessionThinkingControlTitle");
    if (config.category === "thought_level") return t("newSessionEffortTitle");
    return config.name;
  };
  const valueLabel = (
    config: CursorModelConfigOption,
    option: { value: string; name: string },
  ) => {
    if (config.id === "thinking")
      return option.value === "true"
        ? t("cursorModelThinkingOn")
        : t("newSessionThinkingOff");
    switch (option.value) {
      case "none":
        return t("newSessionThinkingOff");
      case "minimal":
        return t("cursorModelEffortMinimal");
      case "low":
        return t("newSessionEffortLow");
      case "medium":
        return t("newSessionEffortMedium");
      case "high":
        return t("newSessionEffortHigh");
      case "xhigh":
      case "extra-high":
        return t("newSessionEffortXHigh");
      case "max":
        return t("newSessionEffortMax");
      default:
        return option.name;
    }
  };
  return (
    <div className="new-session-model-section">
      <div className="new-session-model-controls">
        <div className="new-session-config-field">
          <h3>{t("newSessionModelTitle")}</h3>
          <div className="new-session-model-picker">
            <FilterDropdown
              label={t("newSessionModelTitle")}
              options={options}
              selected={model ? [model.id] : raw ? [raw] : []}
              onChange={(values) => {
                const next = models.find((model) => model.id === values[0]);
                if (next) onChange(buildCursorModelValue(next));
              }}
              accentColor={accentColor}
              multiSelect={false}
              disabled={disabled}
              placeholder={t("newSessionModelPlaceholder")}
            />
            {fast && (
              <button
                type="button"
                role="switch"
                aria-checked={parameters.fast === "true"}
                aria-label="Fast"
                title={t("cursorModelFastDescription")}
                className="new-session-fast-toggle"
                disabled={disabled}
                onClick={() =>
                  setParameter(
                    "fast",
                    parameters.fast === "true" ? "false" : "true",
                  )
                }
              >
                <span
                  className="new-session-fast-indicator"
                  aria-hidden="true"
                />
                Fast
              </button>
            )}
          </div>
        </div>
        {configs
          .filter((config) => config !== fast)
          .sort(
            (a, b) => Number(a.id === "context") - Number(b.id === "context"),
          )
          .map((config) => (
            <div className="new-session-config-field" key={config.id}>
              <h3>{configLabel(config)}</h3>
              <FilterDropdown
                label={configLabel(config)}
                options={config.options.map((option) => ({
                  value: option.value,
                  label: valueLabel(config, option),
                }))}
                selected={[parameters[config.id] ?? config.currentValue]}
                onChange={(values) => {
                  if (values[0]) setParameter(config.id, values[0]);
                }}
                accentColor={accentColor}
                multiSelect={false}
                disabled={disabled}
              />
            </div>
          ))}
      </div>
      {model?.id === "auto" && (
        <p className="new-session-section-hint">{t("cursorModelAutoHint")}</p>
      )}
      {raw && !model && (
        <p className="new-session-section-hint">
          {t("cursorModelSavedSelection")}
        </p>
      )}
    </div>
  );
}
