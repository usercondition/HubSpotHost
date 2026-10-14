import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type FollowupDraft = {
  status: "replied" | "handled";
  said: string;
  nextAction: string;
  reminderDate: string | null;
  hubspotUrl: string;
};

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

export function FollowupDialog({
  open,
  onOpenChange,
  status,
  clientName,
  listing,
  defaultSaid,
  defaultNextAction,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: "replied" | "handled";
  clientName: string;
  listing: string;
  defaultSaid: string;
  defaultNextAction: string;
  pending: boolean;
  onSubmit: (draft: FollowupDraft) => void;
}) {
  const [said, setSaid] = useState(defaultSaid);
  const [nextAction, setNextAction] = useState(defaultNextAction);
  const [reminderDate, setReminderDate] = useState<string>(addDays(status === "replied" ? 2 : 7));
  const [hubspotUrl, setHubspotUrl] = useState("");

  useEffect(() => {
    if (!open) return;
    setSaid(defaultSaid);
    setNextAction(defaultNextAction);
    setReminderDate(addDays(status === "replied" ? 2 : 7));
    setHubspotUrl("");
  }, [open, defaultSaid, defaultNextAction, status]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-followup">
        <DialogHeader>
          <DialogTitle>{status === "replied" ? "Mark replied" : "Mark handled"} · {clientName}</DialogTitle>
          <DialogDescription>{listing || "No listing"} — logs a follow-up in Notion (Client Follow-ups) and here.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="fu-said">What was said</Label>
            <Textarea id="fu-said" rows={3} value={said} onChange={(e) => setSaid(e.target.value)} data-testid="input-followup-said" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fu-next">Next action</Label>
            <Input id="fu-next" value={nextAction} onChange={(e) => setNextAction(e.target.value)} data-testid="input-followup-next" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fu-date">Reminder date</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="fu-date" type="date" className="w-44" value={reminderDate} onChange={(e) => setReminderDate(e.target.value)} data-testid="input-followup-date" />
              {[1, 3, 7].map((d) => (
                <Button key={d} type="button" size="sm" variant="outline" onClick={() => setReminderDate(addDays(d))}>+{d}d</Button>
              ))}
              <Button type="button" size="sm" variant="ghost" onClick={() => setReminderDate("")}>No reminder</Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fu-hs">HubSpot deal link (optional)</Label>
            <Input id="fu-hs" placeholder="https://app.hubspot.com/…" value={hubspotUrl} onChange={(e) => setHubspotUrl(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={pending || (hubspotUrl !== "" && !hubspotUrl.startsWith("https://"))}
            onClick={() => onSubmit({ status, said, nextAction, reminderDate: reminderDate || null, hubspotUrl })}
            data-testid="button-followup-save"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
