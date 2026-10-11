"use client";

import * as React from "react";
import { Check, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VIEWER_LABELS, viewerCopy, type ViewerKind } from "@/lib/documentViewer";

/** Viewer choice on the document page. Only the options that exist for this file type are passed in. */
export function ViewerMenu({
  options, active, isDefault, typeLabel, onJustThisDocument, onUseForAll,
}: {
  options: ViewerKind[];
  active: ViewerKind;
  /** True when `active` comes from the saved default (Settings -> General), false for "this document only". */
  isDefault: boolean;
  /** Plural type name, e.g. "PDFs". */
  typeLabel: string;
  onJustThisDocument: (kind: ViewerKind) => void;
  onUseForAll: (kind: ViewerKind) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" aria-label={`Viewer: ${VIEWER_LABELS[active]}`}>
            <Eye className="h-4 w-4" />{VIEWER_LABELS[active]}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          {options.map((kind, index) => {
            const copy = viewerCopy(kind);
            return (
              <React.Fragment key={kind}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="space-y-0.5 font-normal">
                  <span className="block text-sm font-medium">{VIEWER_LABELS[kind]}</span>
                  <span className="block text-xs text-muted-foreground">+ {copy.pros}</span>
                  <span className="block text-xs text-muted-foreground">− {copy.cons}</span>
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onJustThisDocument(kind)}>
                  {active === kind && !isDefault ? <Check className="h-4 w-4" /> : <span className="w-4" />}Just this document
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onUseForAll(kind)}>
                  {active === kind && isDefault ? <Check className="h-4 w-4" /> : <span className="w-4" />}Use for all {typeLabel}
                </DropdownMenuItem>
              </React.Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-xs text-muted-foreground">{isDefault ? `Default for ${typeLabel}` : "This document only"}</span>
    </div>
  );
}
