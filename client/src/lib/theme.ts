/** Shop appearance. Persisted in localStorage; default stays the current dark workspace. */

export const THEME_KEY = "print-ops-theme-shop";

export const THEMES = ["dark", "light"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_OPTIONS: Array<{
  id: Theme;
  label: string;
  hint: string;
}> = [
  { id: "dark", label: "Dark", hint: "Current workspace — near-black, teal actions" },
  { id: "light", label: "Light", hint: "Cool paper bench" },
];

export function parseTheme(value: string | null | undefined): Theme {
  if (value === "light" || value === "dark") return value;
  return "dark";
}

export function nextTheme(theme: Theme): Theme {
  const index = THEMES.indexOf(theme);
  return THEMES[(index + 1) % THEMES.length];
}

export function isDarkTheme(theme: Theme): boolean {
  return theme !== "light";
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  const dark = isDarkTheme(theme);
  root.classList.toggle("dark", dark);
  root.dataset.theme = theme;
  root.style.colorScheme = dark ? "dark" : "light";
}
