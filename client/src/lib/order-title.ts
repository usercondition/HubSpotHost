/** Drop a trailing " - Client" so the buyer name is shown once. */
export function orderTitle(name: string, contactName?: string | null): string {
  const trimmed = name.trim();
  const contact = contactName?.trim();
  if (!contact) return trimmed;
  for (const suffix of [` - ${contact}`, ` – ${contact}`, ` — ${contact}`, ` · ${contact}`]) {
    if (trimmed.toLowerCase().endsWith(suffix.toLowerCase())) {
      const cut = trimmed.slice(0, -suffix.length).trim();
      if (cut) return cut;
    }
  }
  return trimmed;
}
