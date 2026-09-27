import { Link, useLocation } from "wouter";

/** Phone-only Supplies | Expenses switch. Desktop uses the sidebar. */
export function KeepSpendSwitch() {
  const [location] = useLocation();
  const path = location.split("?")[0] || "/";
  return (
    <div className="phone-section-switch" role="tablist" aria-label="Supplies or Expenses" data-testid="switch-supplies-expenses">
      <Link href="/supplies" role="tab" data-testid="switch-supplies" data-active={path === "/supplies" ? "true" : "false"} aria-selected={path === "/supplies"}>
        Supplies
      </Link>
      <Link href="/expenses" role="tab" data-testid="switch-expenses" data-active={path === "/expenses" ? "true" : "false"} aria-selected={path === "/expenses"}>
        Expenses
      </Link>
    </div>
  );
}
