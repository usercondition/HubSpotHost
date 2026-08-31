/**
 * Clients — HubSpot contacts as a shop-floor browse surface.
 * CRM remains system of record; this is for quick lookup, copy, and jump-outs.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Building2,
  Check,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  Ship,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/shell";
import { StatusPill, WorkspaceSection } from "@/components/primitives";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { hubspotContactHref, hubspotAppHref } from "@/lib/workflow";
import type { HubSpotContactCard } from "@shared/schema";

type ContactsResponse = {
  ok: true;
  contacts: HubSpotContactCard[];
  total: number;
  query: string;
  hubspotPortalId: string | null;
};

type FilterChip = "all" | "ship_ready" | "missing_ship" | "has_email";
type SortMode = "recent" | "name";

function formatAddress(contact: HubSpotContactCard): string {
  const line2 = [contact.city, contact.state].filter(Boolean).join(", ");
  return [contact.address, line2, contact.postalCode, contact.country].filter(Boolean).join(" · ");
}

function isShipReady(contact: HubSpotContactCard): boolean {
  return Boolean(
    contact.address.trim() &&
      contact.city.trim() &&
      contact.state.trim() &&
      contact.postalCode.trim() &&
      (contact.phone.trim() || contact.email.trim()),
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
}

function relativeUpdated(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  const days = Math.round((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

async function copyText(label: string, value: string, toast: ReturnType<typeof useToast>["toast"]) {
  const text = value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: `${label} copied`, description: text.slice(0, 120) });
  } catch {
    toast({
      title: `Could not copy ${label.toLowerCase()}`,
      description: "Select the text and copy manually.",
      variant: "destructive",
    });
  }
}

function ContactRow({
  contact,
  portalId,
  toast,
}: {
  contact: HubSpotContactCard;
  portalId: string | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const address = formatAddress(contact);
  const ready = isShipReady(contact);
  const href = hubspotContactHref(contact.contactId, portalId);
  const updated = relativeUpdated(contact.updatedAt);

  return (
    <article
      className="glance-item glance-in flex-col items-stretch gap-2 sm:flex-row sm:items-center"
      data-tone={ready ? "good" : undefined}
      data-testid={`card-contact-${contact.contactId}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.6875rem] font-semibold tracking-tight text-primary">
          {initials(contact.fullName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold tracking-tight">{contact.fullName}</h3>
            {ready ? (
              <StatusPill tone="good" icon={Ship} label="Ship-ready" />
            ) : (
              <StatusPill tone="warn" icon={MapPin} label="Address gap" />
            )}
            {updated ? (
              <span className="text-[0.625rem] text-muted-foreground">{updated}</span>
            ) : null}
          </div>
          {contact.company ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-[0.6875rem] text-muted-foreground">
              <Building2 className="h-3 w-3 shrink-0" />
              {contact.company}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {contact.email ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Mail className="h-3 w-3 shrink-0" />
                <a className="truncate text-primary hover:underline" href={`mailto:${contact.email}`}>
                  {contact.email}
                </a>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-3 w-3 shrink-0" />
                No email
              </span>
            )}
            {contact.phone ? (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-3 w-3 shrink-0" />
                <a className="hover:underline" href={`tel:${contact.phone}`}>
                  {contact.phone}
                </a>
              </span>
            ) : null}
            {address ? (
              <span className="inline-flex items-start gap-1.5">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="leading-4">{address}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3 w-3 shrink-0" />
                No shipping address
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
        {contact.email ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyText("Email", contact.email, toast)}
            data-testid={`button-copy-email-${contact.contactId}`}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            <span className="ml-1.5 hidden md:inline">Email</span>
          </Button>
        ) : null}
        {contact.phone ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyText("Phone", contact.phone, toast)}
            data-testid={`button-copy-phone-${contact.contactId}`}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            <span className="ml-1.5 hidden md:inline">Phone</span>
          </Button>
        ) : null}
        {address ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyText("Address", address.replace(/ · /g, "\n"), toast)}
            data-testid={`button-copy-address-${contact.contactId}`}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            <span className="ml-1.5 hidden md:inline">Address</span>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost" data-testid={`button-open-hubspot-${contact.contactId}`}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="ml-1.5 hidden lg:inline">HubSpot</span>
          </a>
        </Button>
        <Button asChild size="sm" data-testid={`button-manual-order-${contact.contactId}`}>
          <Link href="/paid-orders">
            <UserRound className="mr-1.5 h-3.5 w-3.5" />
            Manual
          </Link>
        </Button>
      </div>
    </article>
  );
}

export default function ClientsPage() {
  const { toast } = useToast();
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Clients unlocked",
    successDescription: "Browse HubSpot contacts without leaving Print Ops.",
  });

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterChip>("all");
  const [sort, setSort] = useState<SortMode>("recent");

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
      params.set("limit", "60");
      const response = await apiRequest("GET", `/api/contacts?${params.toString()}`, undefined, {
        headers,
      });
      return (await response.json()) as ContactsResponse;
    },
  });

  const rows = useMemo(() => {
    const list = [...(contacts.data?.contacts ?? [])];
    const filtered = list.filter((contact) => {
      if (filter === "ship_ready") return isShipReady(contact);
      if (filter === "missing_ship") return !isShipReady(contact);
      if (filter === "has_email") return Boolean(contact.email.trim());
      return true;
    });
    if (sort === "name") {
      filtered.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
    }
    return filtered;
  }, [contacts.data?.contacts, filter, sort]);

  const shipReadyCount = useMemo(
    () => (contacts.data?.contacts ?? []).filter(isShipReady).length,
    [contacts.data?.contacts],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Clients"
        subtitle="HubSpot contacts — search, copy ship-to, jump to CRM or Manual entry."
        actions={
          isUnlocked ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button asChild size="sm" variant="outline">
                <a href={hubspotAppHref()} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  HubSpot
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/paid-orders">Manual order</Link>
              </Button>
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
            </div>
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
            <WorkspaceSection
              title="Find a buyer"
              description="Search HubSpot, then copy email / phone / address for labels or Marketplace."
              dense
              testId="panel-clients-search"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[14rem] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setQuery(draft.trim());
                      }
                    }}
                    placeholder="Search name, email, company…"
                    className="h-9 pl-8"
                    data-testid="input-clients-search"
                  />
                </div>
                {query ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft("");
                      setQuery("");
                    }}
                    data-testid="button-clear-clients-search"
                  >
                    Clear
                  </Button>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {(
                  [
                    ["all", "All"],
                    ["ship_ready", "Ship-ready"],
                    ["missing_ship", "Needs address"],
                    ["has_email", "Has email"],
                  ] as const
                ).map(([id, label]) => (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={filter === id ? "default" : "outline"}
                    onClick={() => setFilter(id)}
                    data-testid={`button-clients-filter-${id}`}
                  >
                    {filter === id ? <Check className="mr-1.5 h-3.5 w-3.5" /> : null}
                    {label}
                  </Button>
                ))}
                <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
                <Button
                  type="button"
                  size="sm"
                  variant={sort === "recent" ? "secondary" : "ghost"}
                  onClick={() => setSort("recent")}
                  data-testid="button-clients-sort-recent"
                >
                  Recent
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={sort === "name" ? "secondary" : "ghost"}
                  onClick={() => setSort("name")}
                  data-testid="button-clients-sort-name"
                >
                  A–Z
                </Button>
              </div>
            </WorkspaceSection>

            {contacts.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 rounded-lg" />
                ))}
              </div>
            ) : contacts.isError ? (
              <WorkspaceSection title="Could not load HubSpot contacts" testId="panel-clients-error">
                <p className="text-sm text-muted-foreground">
                  {(contacts.error as Error | null)?.message?.replace(/^\d+:\s*/, "") ||
                    "Check HubSpot connectivity and private-app scopes (crm.objects.contacts.read)."}
                </p>
              </WorkspaceSection>
            ) : (
              <WorkspaceSection
                eyebrow="Contacts"
                title={`${rows.length} shown`}
                description={
                  query
                    ? `Matching “${query}” · ${shipReadyCount} ship-ready in this fetch`
                    : `Recently updated · ${shipReadyCount} ship-ready in this fetch`
                }
                testId="panel-clients-list"
              >
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-clients-empty">
                    {query || filter !== "all"
                      ? "Nothing matches this search/filter. Try All, or open HubSpot."
                      : "HubSpot returned no contacts. Create buyers via Intake or Manual, then refresh."}
                  </p>
                ) : (
                  <div className="glance-list" data-testid="list-clients">
                    {rows.map((contact) => (
                      <ContactRow
                        key={contact.contactId}
                        contact={contact}
                        portalId={contacts.data?.hubspotPortalId ?? null}
                        toast={toast}
                      />
                    ))}
                  </div>
                )}
                <p
                  className={cn("mt-3 text-[0.6875rem] text-muted-foreground")}
                  data-testid="text-clients-count"
                >
                  Showing {rows.length}
                  {typeof contacts.data?.total === "number" && contacts.data.total > (contacts.data.contacts.length ?? 0)
                    ? ` · ${contacts.data.total} total in HubSpot`
                    : ""}
                  {" · "}
                  CRM stays the source of truth
                </p>
              </WorkspaceSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}
