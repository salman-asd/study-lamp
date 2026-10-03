"use client";

import { RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAiLanguageContext } from "@/components/ai/AiLanguageProvider";
import { AI_LANGUAGE_LABELS } from "@/lib/aiLanguageState";
import type { AiLanguage } from "@/lib/ai/types";

interface AiLanguagePickerProps {
  value: AiLanguage;
  /** Overrides the language for the next generation only; never saves the default. */
  onChange: (language: AiLanguage) => void;
  disabled?: boolean;
  /** Visible label. Defaults to "Language". */
  label?: string;
}

/** Compact EN/BN picker shown next to an AI "generate" action. */
export function AiLanguagePicker({ value, onChange, disabled, label = "Language" }: AiLanguagePickerProps) {
  const { defaultLanguage } = useAiLanguageContext();
  const overridden = value !== defaultLanguage;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span id="ai-language-label" className="whitespace-nowrap">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === "en" || next === "bn") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-44" aria-label={label === "Language" ? "AI response language" : label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(["en", "bn"] as const).map((language) => (
            <SelectItem key={language} value={language}>
              {AI_LANGUAGE_LABELS[language]}{language === defaultLanguage ? " · default" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {overridden && (
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          onClick={() => onChange(defaultLanguage)}
          disabled={disabled}
          aria-label={`Reset language to default (${AI_LANGUAGE_LABELS[defaultLanguage]})`}
          title="Reset to your default language"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
