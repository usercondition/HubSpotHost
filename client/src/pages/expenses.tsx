import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { PageHeader, } from "@/components/shell";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";

type Expense = { id: string; vendor: string; name: string; category: string; amount_cents: number; cadence: string; start_date: string; end_date: string | null };
const cents = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
export default function Expenses() {
  const { isUnlocked, headers } = useOwnerSession(); const unlock = useOwnerUnlock({ successTitle: "Expenses unlocked", successDescription: "Print Ops-only overhead." });
  const [category, setCategory] = useState(""); const [period, setPeriod] = useState(""); const [draft, setDraft] = useState(false);
  const query = useQuery<{ expenses: Expense[] }>({ queryKey: ["/api/expenses"], enabled: isUnlocked, queryFn: async () => (await apiRequest("GET", "/api/expenses", undefined, { headers })).json() });
  const rows = (query.data?.expenses ?? []).filter((row) => (!category || row.category === category) && (!period || row.start_date.startsWith(period)));
  const recurring = rows.filter((row) => row.cadence === "monthly" || row.cadence === "yearly");
  const oneOff = rows.filter((row) => !recurring.includes(row));
  const total = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  return <div className="mx-auto max-w-6xl"><PageHeader title="Expenses" subtitle="Shop overhead stored only in Print Ops." actions={<Button size="sm" onClick={() => setDraft(true)}>Add expense</Button>} />
    {!isUnlocked ? <OwnerUnlockPanel title="Unlock expenses" description="Enter the owner code to manage shop overhead." buttonLabel="Unlock expenses" testIdPrefix="expenses" pending={unlock.isPending} onUnlock={(code) => unlock.mutate(code)} /> :
      <div className="page-stack"><div className="flex gap-2 overflow-x-auto"><input aria-label="Filter category" placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded border bg-background px-2 text-sm" /><input aria-label="Filter period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-9 rounded border bg-background px-2 text-sm" /><p className="numeric ml-auto whitespace-nowrap pt-2 text-sm">This period {cents(total)}</p></div>
      {draft ? <ExpenseForm headers={headers} done={() => { setDraft(false); query.refetch(); }} /> : null}
      <Group title="Recurring" rows={recurring} /><Group title="One-off" rows={oneOff} /></div>}</div>;
}
function Group({ title, rows }: { title: string; rows: Expense[] }) { return <section><h2 className="mb-2 text-base font-semibold">{title}</h2>{rows.length ? rows.map((row) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3 border-b py-2"><span className="truncate">{row.vendor} · {row.name}<small className="ml-2 text-muted-foreground">{row.category} · {row.cadence}</small></span><span className="numeric text-right">{cents(row.amount_cents)}</span></div>) : <p className="text-sm text-muted-foreground">No expenses recorded.</p>}</section>; }
function ExpenseForm({ headers, done }: { headers: HeadersInit; done: () => void }) { const [vendor, setVendor] = useState(""); const [amount, setAmount] = useState(""); return <form className="rounded border p-3" onSubmit={async (e) => { e.preventDefault(); await apiRequest("POST", "/api/expenses", { idempotencyKey: crypto.randomUUID(), vendor, name: vendor, category: "Other", amountCents: Math.round(Number(amount) * 100), cadence: "one-off", startDate: new Date().toISOString().slice(0, 10) }, { headers }); done(); }}><input required placeholder="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} className="mr-2 h-9 rounded border bg-background px-2" /><input required type="number" min="0" step="0.01" placeholder="USD" value={amount} onChange={(e) => setAmount(e.target.value)} className="mr-2 h-9 w-28 rounded border bg-background px-2" /><Button size="sm" type="submit">Save</Button></form>; }
