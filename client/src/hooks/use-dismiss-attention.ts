import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest, queryClient } from "@/lib/queryClient";

/** Shared Skip mutation for attention alerts (bell + Performance). */
export function useDismissAttention(source: "alerts" | "performance" = "alerts") {
  const { toast } = useToast();
  const { headers } = useOwnerSession();
  const note = source === "performance" ? "Skipped from Performance" : "Skipped from alerts";

  return useMutation({
    mutationFn: async (input: { dealId: string; issueKey: string }) => {
      const response = await apiRequest(
        "POST",
        "/api/attention/dismiss",
        { dealId: input.dealId, issueKey: input.issueKey, note },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      toast({
        title: "Alert skipped",
        description:
          "That reminder is hidden for this order. Closing the deal in HubSpot also clears it.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not skip that alert",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 160),
        variant: "destructive",
      });
    },
  });
}
