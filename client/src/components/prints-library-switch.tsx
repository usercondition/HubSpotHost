import { Link, useLocation } from "wouter";

/** Phone-only Prints | Library switch. Desktop uses the sidebar Library item. */
export function PrintsLibrarySwitch() {
  const [location] = useLocation();
  const path = location.split("?")[0] || "/";
  return (
    <div className="prints-library-switch" role="tablist" aria-label="Prints or Library" data-testid="switch-prints-library">
      <Link
        href="/prints"
        role="tab"
        data-testid="switch-prints"
        data-active={path === "/prints" ? "true" : "false"}
        aria-selected={path === "/prints"}
      >
        Prints
      </Link>
      <Link
        href="/library"
        role="tab"
        data-testid="switch-library"
        data-active={path === "/library" ? "true" : "false"}
        aria-selected={path === "/library"}
      >
        Library
      </Link>
    </div>
  );
}
