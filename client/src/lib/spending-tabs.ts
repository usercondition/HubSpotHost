/** Which Spending tab a route opens: /supplies and /spending → Supplies; /expenses and /spending/overhead → Overhead. */
export function spendingTabFor(path: string): "supplies" | "overhead" {
  return path === "/expenses" || path === "/spending/overhead" ? "overhead" : "supplies";
}
