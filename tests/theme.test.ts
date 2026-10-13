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
  assert.equal(parseTheme("chillsynth"), "chillsynth");
});

test("theme cycle keeps the existing dark → light first click", () => {
  assert.deepEqual([...THEMES], ["dark", "light", "chillsynth"]);
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "chillsynth");
  assert.equal(nextTheme("chillsynth"), "dark");
});

test("chillsynth is a dark color scheme", () => {
  assert.equal(isDarkTheme("dark"), true);
  assert.equal(isDarkTheme("chillsynth"), true);
  assert.equal(isDarkTheme("light"), false);
});

test("applyTheme toggles html classes without dropping dark for chillsynth", () => {
  const root = fakeRoot();

  applyTheme("chillsynth", root as unknown as HTMLElement);
  assert.equal(root.classList.contains("dark"), true);
  assert.equal(root.classList.contains("theme-chillsynth"), true);
  assert.equal(root.dataset.theme, "chillsynth");
  assert.equal(root.style.colorScheme, "dark");

  applyTheme("dark", root as unknown as HTMLElement);
  assert.equal(root.classList.contains("dark"), true);
  assert.equal(root.classList.contains("theme-chillsynth"), false);
  assert.equal(root.dataset.theme, "dark");

  applyTheme("light", root as unknown as HTMLElement);
  assert.equal(root.classList.contains("dark"), false);
  assert.equal(root.classList.contains("theme-chillsynth"), false);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
});
