import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatPacificUpdateStamp } from "@shared/ship-by";
import type { OrderUpdateEntry } from "@shared/schema";

export function OrderUpdates({
  orderKey,
  headers,
}: {
  orderKey: string;
  headers: Record<string, string>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const updates = useQuery({
    queryKey: ["/api/priority-stack/updates", orderKey],
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/priority-stack/updates?key=${encodeURIComponent(orderKey)}`,
        undefined,
        { headers },
      );
      return (await response.json()) as { ok: true; orderKey: string; entries: OrderUpdateEntry[] };
    },
  });
  const add = useMutation({
    mutationFn: async (text: string) => {
      await apiRequest(
        "POST",
        "/api/priority-stack/updates",
        { key: orderKey, text, source: "manual", author: "Miguel" },
        { headers },
      );
    },
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["/api/priority-stack/updates", orderKey] });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not add update",
        description: error.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    },
  });

  const entries = updates.data?.entries ?? [];

  return (
    <section className="space-y-3 rounded-md border border-border/80 p-3" data-testid="order-updates">
      <h3 className="text-sm font-semibold">Updates</h3>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text || add.isPending) return;
          add.mutate(text);
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What changed on this kit"
          rows={2}
          maxLength={4000}
          className="min-h-[4.5rem] w-full"
          data-testid="input-order-update"
        />
        <Button type="submit" size="sm" disabled={add.isPending || draft.trim().length === 0} data-testid="button-add-order-update">
          {add.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Add
        </Button>
      </form>
      {updates.isError ? (
        <p className="text-sm text-destructive" data-testid="text-order-updates-error">
          {(updates.error as Error).message.replace(/^\d+:\s*/, "") || "Could not load updates."}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-order-updates-empty">
          No updates yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="min-w-0" data-testid={`order-update-${entry.id}`}>
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <time dateTime={entry.createdAt} data-testid="order-update-time">
                  {formatPacificUpdateStamp(entry.createdAt)}
                </time>
                <span className="rounded border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide" data-testid="order-update-source">
                  {entry.source}
                </span>
                <span data-testid="order-update-author">{entry.author}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-testid="order-update-text">
                {entry.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
