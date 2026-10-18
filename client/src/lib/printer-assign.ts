import { ASSIGN_PREFIX_BYTES, ASSIGNABLE_SLICE_EXTENSIONS, isAssignableSliceName } from "@shared/printer-status";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Inline message for a file that can't go on a printer, or "" when it can. */
export function rejectSliceFileReason(fileName: string): string {
  if (isAssignableSliceName(fileName)) return "";
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  const allowed = ASSIGNABLE_SLICE_EXTENSIONS.join(" / ");
  return ext ? `.${ext} isn't a slice file. Drop a ${allowed} from ChiTuBox.` : `Drop a ${allowed} slice file from ChiTuBox.`;
}

/**
 * Send only the first 2 MB (the CTB header + settings) and the real size. The server parses
 * layer count and print time and stores that metadata; the file never leaves this browser whole.
 */
export async function assignSliceFile(printerKey: string, file: File, headers: Record<string, string>): Promise<void> {
  const reason = rejectSliceFileReason(file.name);
  if (reason) throw new Error(reason);
  const prefix = file.slice(0, Math.min(file.size, ASSIGN_PREFIX_BYTES));
  const params = new URLSearchParams({ fileName: file.name, fullFileSize: String(file.size) });
  const response = await fetch(`${API_BASE}/api/printers/status/${encodeURIComponent(printerKey)}/assign?${params.toString()}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: prefix,
  });
  if (!response.ok) {
    let message = "Could not read that slice file.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the default
    }
    throw new Error(message);
  }
}

/** Browser speech recognition, or null where it isn't available (Firefox, some iOS shells). */
export type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function createSpeechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  try {
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    return rec;
  } catch {
    return null;
  }
}
