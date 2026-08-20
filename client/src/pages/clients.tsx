import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import { hubspotContactHref } from "@/lib/workflow";
import type { HubSpotContactCard } from "@shared/schema";

type ContactsResponse = {
  ok: true;
  contacts: HubSpotContactCard[];
  total: number;
  query: string;
  hubspotPortalId: string | null;
};

function formatAddress(contact: HubSpotContactCard): string {
  const line2 = [contact.city, contact.state].filter(Boolean).join(", ");
  return [contact.address, line2, contact.postalCode, contact.country].filter(Boolean).join(" · ");
}

function ContactCard({
  contact,
  portalId,
}: {
  contact: HubSpotContactCard;
  portalId: string | null;
}) {
  const address = formatAddress(contact);
  const href = hubspotContactHref(contact.contactId, portalId);

  return (
    <article
      className="flex flex-col rounded-md border border-card-border bg-card p-3 shadow-sm"
      data-testid={`card-contact-${contact.contactId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold tracking-tight">{contact.fullName}</h3>
              {contact.company ? (
                <p className="mt-0.5 flex items-center gap-1 truncate text-[0.6875rem] text-muted-foreground">
                  <Building2 className="h-3 w-3 shrink-0" />
                  {contact.company}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <StatusPill tone="neutral" label="HubSpot" />
      </div>

      <dl className="mt-3 space-y-1.5 text-xs">
        {contact.email ? (
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <a className="break-all text-primary hover:underline" href={`mailto:${contact.email}`}>
              {contact.email}
            </a>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            No email
          </div>
        )}
        {contact.phone ? (
          <div className="flex items-center gap-2">
            <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <a className="text-foreground hover:underline" href={`tel:${contact.phone}`}>
              {contact.phone}
            </a>
          </div>
        ) : null}
        {address ? (
          <div className="flex items-start gap-2 text-muted-foreground">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="leading-4">{address}</span>
          </div>
        ) : null}
      </dl>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-2.5 mt-3">
        <Button asChild size="sm" variant="outline" data-testid={`button-open-hubspot-${contact.contactId}`}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open in HubSpot
          </a>
        </Button>
        <span className="numeric text-[0.625rem] text-muted-foreground">ID {contact.contactId}</span>
      </div>
    </article>
  );
}

/**
 * Clients — HubSpot contacts as cards inside Print Ops.
 * CRM remains the system of record; this is a shop-floor browse surface.
 */
export default function ClientsPage() {
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Clients unlocked",
    successDescription: "Browse HubSpot contacts as cards without leaving Print Ops.",
  });

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const contacts = useQuery<ContactsResponse>({
    queryKey: ["/api/contacts", query, headers],
    enabled: isUnlocked,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("limit", "48");
      const response = await apiRequest(
        "GET",
        `/api/contacts?${params.toString()}`,
        undefined,
        { headers },
      );
      return (await response.json()) as ContactsResponse;
    },
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Clients"
        subtitle="HubSpot contacts as cards — search buyers, confirm address, jump into CRM."
        actions={
          isUnlocked ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => contacts.refetch()}
              disabled={contacts.isFetching}
              data-testid="button-refresh-clients"
            >
              {contacts.isFetching ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          ) : null
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock clients"
            description="Same owner code as Queue and Intake. Reads live HubSpot contacts — Print Ops does not store a second CRM."
            buttonLabel="Unlock Clients"
            testIdPrefix="clients"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[16rem] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Search name, email, company…"
                  className="pl-8"
                  data-testid="input-clients-search"
                />
              </div>
              {query ? (
                <Button size="sm" variant="ghost" onClick={() => setDraft("")} data-testid="button-clear-clients-search">
                  Clear
                </Button>
              ) : null}
            </div>

            {contacts.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="h-44 rounded-md" />
                ))}
              </div>
            ) : contacts.isError ? (
              <Panel title="Could not load HubSpot contacts">
                <p className="text-sm text-muted-foreground">
                  {(contacts.error as Error | null)?.message?.replace(/^\d+:\s*/, "") ||
                    "Check HubSpot connectivity and private-app scopes (crm.objects.contacts.read)."}
                </p>
              </Panel>
            ) : (
              <>
                <p className="text-xs text-muted-foreground" data-testid="text-clients-count">
                  {contacts.data?.contacts.length ?? 0} contact
                  {(contacts.data?.contacts.length ?? 0) === 1 ? "" : "s"}
                  {query ? ` matching “${query}”` : " · recently updated"}
                  {typeof contacts.data?.total === "number" && contacts.data.total > (contacts.data.contacts.length ?? 0)
                    ? ` · ${contacts.data.total} total in HubSpot`
                    : ""}
                </p>
                {(contacts.data?.contacts.length ?? 0) === 0 ? (
                  <Panel title="No contacts found">
                    <p className="text-sm text-muted-foreground">
                      {query
                        ? "Try another search, or open HubSpot to confirm the contact exists."
                        : "HubSpot returned no contacts. Create buyers via Intake or Manual, then refresh."}
                    </p>
                  </Panel>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {contacts.data!.contacts.map((contact) => (
                      <ContactCard
                        key={contact.contactId}
                        contact={contact}
                        portalId={contacts.data?.hubspotPortalId ?? null}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
