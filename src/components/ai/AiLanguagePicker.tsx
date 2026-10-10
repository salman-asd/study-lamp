"use client";

import * as React from "react";
import { Languages, RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAiLanguageContext } from "@/components/ai/AiLanguageProvider";
import { AI_LANGUAGE_LABELS, languagePickerTitle } from "@/lib/aiLanguageState";
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
  // One id per instance: several pickers can be on the same page.
  const labelId = React.useId();
  // A page that passes its own label keeps the visible text (hidden below sm); the default label becomes an icon.
  const customLabel = label !== "Language";

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {customLabel ? (
        <span id={labelId} className="hidden whitespace-nowrap sm:inline">{label}</span>
      ) : (
        <>
          <Languages className="h-3.5 w-3.5" aria-hidden />
          <span id={labelId} className="sr-only">{label}</span>
        </>
      )}
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === "en" || next === "bn") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-8 w-[4.5rem] px-2"
          aria-labelledby={labelId}
          aria-label={label === "Language" ? "AI response language" : label}
          title={languagePickerTitle(value, defaultLanguage)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(["en", "bn"] as const).map((language) => (
            <SelectItem
              key={language}
              value={language}
              title={language === defaultLanguage ? "Default language" : undefined}
              suffix={
                language === defaultLanguage ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" title="Default language" aria-hidden />
                ) : undefined
              }
            >
              {AI_LANGUAGE_LABELS[language]}
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
