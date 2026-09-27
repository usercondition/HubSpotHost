/** US state and territory names as HubSpot and labels actually store them. */
const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "puerto rico": "PR",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

export const US_STATE_CODES = new Set(Object.values(US_STATE_NAME_TO_CODE));

const US_CODE_TO_NAME: Record<string, string> = {};
for (const [name, code] of Object.entries(US_STATE_NAME_TO_CODE)) {
  if (!US_CODE_TO_NAME[code]) US_CODE_TO_NAME[code] = name;
}

/** Lowercase state name for a 2-letter code, or "" when the code is not a state. */
export function usStateName(code: string): string {
  return US_CODE_TO_NAME[code.trim().toUpperCase()] ?? "";
}

/** 2-letter codes for the state dropdown, sorted by name. */
export function usStateOptions(): Array<{ code: string; name: string }> {
  return Object.entries(US_STATE_NAME_TO_CODE)
    .map(([name, code]) => ({
      code,
      name: name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeUsStateProvince(state: string): string {
  const raw = state.trim();
  if (!raw) return "";
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const key = raw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  return US_STATE_NAME_TO_CODE[key] ?? raw;
}

/** A real US state or territory code, or null. Two random letters are not a state. */
export function usStateCode(value: string | null | undefined): string | null {
  const code = normalizeUsStateProvince(String(value ?? ""));
  return US_STATE_CODES.has(code) ? code : null;
}
