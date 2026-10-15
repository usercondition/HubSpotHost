import assert from "node:assert/strict";
import test from "node:test";
import { applyTheme, isDarkTheme, nextTheme, parseTheme, THEMES } from "../client/src/lib/theme";

function fakeRoot() {
  const classes = new Set<string>();
  return {
    classList: {
      toggle(name: string, force?: boolean) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    dataset: {} as { theme?: string },
    style: { colorScheme: "" },
  };
}

test("theme parse keeps the current dark workspace as the default", () => {
  assert.equal(parseTheme(null), "dark");
  assert.equal(parseTheme(undefined), "dark");
  assert.equal(parseTheme("nope"), "dark");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("workshop"), "dark");
  assert.equal(parseTheme("chillsynth"), "dark");
});

test("theme cycle stays dark → light and does not add a third color theme", () => {
  assert.deepEqual([...THEMES], ["dark", "light"]);
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});

test("light is the only non-dark appearance", () => {
  assert.equal(isDarkTheme("dark"), true);
  assert.equal(isDarkTheme("light"), false);
});

test("applyTheme toggles the dark class without changing other pages", () => {
  const root = fakeRoot();

  applyTheme("dark", root as unknown as HTMLElement);
  assert.equal(root.classList.contains("dark"), true);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");

  applyTheme("light", root as unknown as HTMLElement);
  assert.equal(root.classList.contains("dark"), false);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
});
