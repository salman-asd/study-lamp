"use client";

import * as React from "react";
import { Maximize2, Minimize2, PanelBottom, PanelRight, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StudyDock } from "@/lib/readerLayout";

const DOCKS: Array<{ value: StudyDock; label: string; icon: typeof PanelRight }> = [
  { value: "right", label: "Study panel on the right", icon: PanelRight },
  { value: "bottom", label: "Study panel at the bottom", icon: PanelBottom },
  { value: "hidden", label: "Hide the study panel", icon: PanelRightClose },
];

/** Strip above the reader: study-panel position, focus mode, and (children) the viewer menu. Large screens only for the dock. */
export function ReaderToolbar({
  dock, onDockChange, focus, onFocusChange, children,
}: {
  dock: StudyDock;
  onDockChange: (dock: StudyDock) => void;
  focus: boolean;
  onFocusChange: (focus: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <div className="flex items-center gap-1">
        <div className="hidden items-center gap-0.5 rounded-md border border-border p-0.5 lg:flex" role="group" aria-label="Study panel position">
          {DOCKS.map(({ value, label, icon: Icon }) => (
            <Button key={value} type="button" size="icon" variant={dock === value ? "secondary" : "ghost"} className="h-8 w-8" title={label} aria-label={label} aria-pressed={dock === value} onClick={() => onDockChange(value)}>
              <Icon className="h-4 w-4" />
            </Button>
          ))}
        </div>
        <Button type="button" size="icon" variant={focus ? "secondary" : "outline"} className="hidden h-9 w-9 lg:inline-flex" title={focus ? "Exit focus mode (Esc)" : "Focus mode"} aria-label={focus ? "Exit focus mode" : "Focus mode"} aria-pressed={focus} onClick={() => onFocusChange(!focus)}>
          {focus ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
