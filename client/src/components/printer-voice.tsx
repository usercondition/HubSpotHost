import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Mic, MicOff, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { createSpeechRecognition, type SpeechRecognitionLike } from "@/lib/printer-assign";
import { shortPrinterName, type PrinterAssignedFile } from "@shared/printer-status";

export type VoiceCandidate = {
  key: string;
  name: string;
  score: number;
  state: "printing" | "idle";
  assigned: PrinterAssignedFile | null;
  estHours: string;
};

export type VoiceResult = {
  ok: true;
  started: boolean;
  reason: "started" | "no_match" | "ambiguous" | "no_file" | "busy";
  heard: string;
  printerKey: string | null;
  printerName: string | null;
  estHours: string;
  candidates: VoiceCandidate[];
};

function promptLine(result: VoiceResult): string {
  const name = result.printerName ? shortPrinterName(result.printerName) : "";
  switch (result.reason) {
    case "ambiguous":
      return "More than one printer fits. Which one did you start?";
    case "no_match":
      return "I didn't catch a printer name. Pick the one you started.";
    case "no_file":
      return `Heard ${name}, but no slice file is on its card. Drop the file on it first, then say it again.`;
    case "busy":
      return `${name} is still printing. Start the new file anyway?`;
    default:
      return "";
  }
}

/**
 * Mic button + confirm prompt. Never starts on a guess: the server only starts a clear match with a
 * file on the card; anything else comes back here as a pick/confirm prompt.
 */
export function VoiceStart({
  headers,
  onStarted,
  initialResult = null,
  initialText = "",
}: {
  headers: Record<string, string>;
  onStarted: (result: VoiceResult) => void;
  initialResult?: VoiceResult | null;
  initialText?: string;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const [showTyped, setShowTyped] = useState(false);
  const [text, setText] = useState(initialText);
  const [result, setResult] = useState<VoiceResult | null>(initialResult);
  const [error, setError] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const probe = createSpeechRecognition();
    setSupported(probe != null);
    return () => recRef.current?.stop();
  }, []);

  async function send(spoken: string, printerKey?: string) {
    const clean = spoken.trim();
    if (!clean) return;
    setPending(true);
    setError("");
    setText(clean);
    try {
      const response = await apiRequest("POST", "/api/printers/voice", printerKey ? { text: clean, printerKey } : { text: clean }, { headers });
      const body = (await response.json()) as VoiceResult;
      if (body.started) {
        setResult(null);
        onStarted(body);
      } else {
        setResult(body);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message.replace(/^\d+:\s*/, "").slice(0, 200) : "Voice start failed.");
    } finally {
      setPending(false);
    }
  }

  function listen() {
    const rec = createSpeechRecognition();
    if (!rec) {
      setSupported(false);
      setShowTyped(true);
      return;
    }
    recRef.current = rec;
    setError("");
    setResult(null);
    rec.onresult = (event) => {
      const said = event.results?.[0]?.[0]?.transcript ?? "";
      void send(said);
    };
    rec.onerror = (event) => {
      setError(event.error === "not-allowed" ? "Microphone is blocked for this site. Type it instead." : "Didn't hear that. Try again or type it.");
      setShowTyped(true);
    };
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }

  return (
    <div className="space-y-2" data-testid="voice-start">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className={`min-h-11 ${listening ? "bg-warn text-black hover:bg-warn/90" : ""}`}
          variant={listening ? "default" : "outline"}
          onClick={() => (listening ? recRef.current?.stop() : supported === false ? setShowTyped((v) => !v) : listen())}
          disabled={pending}
          aria-pressed={listening}
          data-testid="button-voice-start"
        >
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : supported === false ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
          {listening ? "Listening… say “<printer> print started”" : supported === false ? "Voice start (type it)" : "Voice start"}
        </Button>
        {supported === false ? (
          <span className="text-xs text-muted-foreground" data-testid="text-voice-unsupported">This browser has no speech input. Type what you'd say.</span>
        ) : null}
      </div>
      {showTyped || supported === false ? (
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(typed);
          }}
        >
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Mighty 12K Old print started"
            className="min-h-11 min-w-0 flex-1 text-base"
            aria-label="What you said"
            data-testid="input-voice-text"
          />
          <Button type="submit" className="min-h-11" disabled={pending || !typed.trim()} data-testid="button-voice-send">
            Go
          </Button>
        </form>
      ) : null}
      {error ? <p className="text-sm text-destructive" role="alert" data-testid="text-voice-error">{error}</p> : null}
      {result ? (
        <div className="rounded-lg border border-warn/50 bg-warn/10 p-3" role="dialog" aria-label="Confirm voice start" data-testid="panel-voice-confirm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Heard: <span className="font-semibold normal-case text-foreground" data-testid="text-voice-heard">“{text}”</span>
              </p>
              <p className="mt-1 text-sm font-medium" data-testid="text-voice-prompt">{promptLine(result)}</p>
            </div>
            <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted" onClick={() => setResult(null)} aria-label="Dismiss" data-testid="button-voice-dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
          {result.reason === "no_file" ? null : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="list-voice-candidates">
              {result.candidates.map((c) => {
                const canStart = c.assigned != null;
                return (
                  <li key={c.key}>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 w-full justify-start whitespace-normal py-2 text-left"
                      disabled={!canStart || pending}
                      onClick={() => void send(text, c.key)}
                      data-testid={`button-voice-pick-${c.key}`}
                    >
                      <Play className="mr-2 h-4 w-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block font-semibold">{shortPrinterName(c.name)}{c.state === "printing" ? " · printing" : ""}</span>
                        <span className="block text-xs text-muted-foreground">
                          {c.assigned ? (
                            <>
                              <FileText className="mr-1 inline h-3 w-3" aria-hidden />
                              {c.assigned.fileName}
                              {c.estHours ? ` · ≈ ${c.estHours}` : ""}
                            </>
                          ) : (
                            "No file on this card"
                          )}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
