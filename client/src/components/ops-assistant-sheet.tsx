import { useState } from "react";
import { MessageSquareText } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TrackerAssistantPanel } from "@/components/tracker-assistant";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { cn } from "@/lib/utils";

/**
 * Shell chrome: Ask Ops — read-only tracker / Grok assistant on every unlocked page
 * (especially Queue + Labels). Deep-links only; never writes HubSpot.
 */
export function OpsAssistantSheet({ rail = false }: { rail?: boolean }) {
  const { isUnlocked, headers } = useOwnerSession();
  const [open, setOpen] = useState(false);

  if (!isUnlocked) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          title="Ask Ops — queue, labels, plates, costs"
          aria-label="Ask Ops assistant"
          data-testid="button-ops-assistant"
          className={cn(
            rail
              ? "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              : "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <MessageSquareText className="h-4 w-4 shrink-0" />
          <span className={rail ? "truncate" : "hidden sm:inline"}>Ask Ops</span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md"
        data-testid="sheet-ops-assistant"
      >
        <SheetHeader className="space-y-1 border-b border-border pb-3 text-left">
          <SheetTitle>Ask Ops</SheetTitle>
          <SheetDescription>
            Read-only briefing from live Queue, Labels, plates, costs, and intake. Optional Grok/OpenAI phrasing when a model key is set.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 py-4">
          <TrackerAssistantPanel
            headers={headers}
            variant="embedded"
            onNavigate={() => setOpen(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
