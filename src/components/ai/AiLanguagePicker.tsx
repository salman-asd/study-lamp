"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AiLanguage } from "@/lib/ai/types";

interface AiLanguagePickerProps {
  value: AiLanguage;
  onChange: (language: AiLanguage) => void;
  disabled?: boolean;
}

export function AiLanguagePicker({ value, onChange, disabled }: AiLanguagePickerProps) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Language</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === "en" || next === "bn") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-32" aria-label="AI response language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">English (EN)</SelectItem>
          <SelectItem value="bn">Bengali (BN)</SelectItem>
        </SelectContent>
      </Select>
    </label>
  );
}
