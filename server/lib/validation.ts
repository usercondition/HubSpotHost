export function firstIssue(error: { issues: Array<{ message: string }> }, fallback = "Some details are missing or invalid"): string {
  return error.issues[0]?.message ?? fallback;
}
