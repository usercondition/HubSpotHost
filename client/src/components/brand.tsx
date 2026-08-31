import { cn } from "@/lib/utils";

/** Public URL for files in `client/public` (works with Vite `base: "./"`). */
export function brandAsset(path: string): string {
  const base = import.meta.env.BASE_URL || "./";
  const normalized = path.replace(/^\//, "");
  return `${base}${normalized}`;
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Print Operations"
      role="img"
      className={className}
    >
      <rect x="3.5" y="3.5" width="25" height="25" rx="7" stroke="currentColor" strokeWidth="1.6" opacity="0.28" />
      <ellipse cx="16" cy="22.4" rx="7.4" ry="2.7" stroke="currentColor" strokeWidth="1.4" opacity="0.38" />
      <circle cx="13.1" cy="22.4" r="0.5" fill="currentColor" opacity="0.4" />
      <circle cx="16" cy="22.4" r="0.5" fill="currentColor" opacity="0.65" />
      <circle cx="18.9" cy="22.4" r="0.5" fill="currentColor" opacity="0.4" />
      <rect x="9" y="17.3" width="14" height="3" rx="1.5" fill="currentColor" opacity="0.42" />
      <rect x="10.5" y="13.5" width="11" height="2.8" rx="1.4" fill="currentColor" opacity="0.72" />
      <rect x="12.2" y="9.8" width="7.6" height="2.6" rx="1.3" fill="currentColor" />
      <circle cx="16" cy="7.15" r="1.65" fill="currentColor" />
    </svg>
  );
}

/** Generated 3D emblem — use at 32px+ so the glow still reads. */
export function BrandMarkImage({
  className,
  size = 36,
  alt = "Print Ops",
}: {
  className?: string;
  size?: number;
  alt?: string;
}) {
  return (
    <img
      src={brandAsset("brand/logo-mark-128.jpg")}
      alt={alt}
      width={size}
      height={size}
      className={cn("rounded-lg object-cover ring-1 ring-border/80", className)}
    />
  );
}
