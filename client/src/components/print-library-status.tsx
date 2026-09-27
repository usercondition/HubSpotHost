import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import {
  fingerprintFile,
  heldSliceFile,
  plainDriveMessage,
  preparePlateUpload,
  splitDealTitle,
  uploadPlateBytes,
} from "@/lib/plate-library-client";
import { guessPlatePrinter, type PrintLibraryMark } from "@shared/plate-files";

export interface LibraryJob {
  progress: number | null;
  error: string;
}

export function useSendPlateToLibrary(headers: Record<string, string>) {
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Record<number, LibraryJob>>({});

  async function send(input: {
    file: File;
    recordId: number;
    sha256: string;
    fileName: string;
    orderKey: string;
    kit: string;
    customer: string;
    printer: string;
  }) {
    setJobs((current) => ({ ...current, [input.recordId]: { progress: 0, error: "" } }));
    try {
      const prepared = await preparePlateUpload(
        {
          orderKey: input.orderKey,
          sha256: input.sha256,
          fileName: input.fileName,
          printRecordId: input.recordId,
          printer: input.printer,
          kit: input.kit,
          customer: input.customer,
        },
        headers,
      );
      if (prepared.action === "upload") {
        await uploadPlateBytes({
          file: input.file,
          orderKey: input.orderKey,
          printer: input.printer,
          notes: "",
          kit: input.kit,
          customer: input.customer,
          sha256: input.sha256,
          printRecordId: input.recordId,
          headers,
          onProgress: (fraction) => {
            setJobs((current) => ({ ...current, [input.recordId]: { progress: fraction, error: "" } }));
          },
        });
      }
      setJobs((current) => {
        const next = { ...current };
        delete next[input.recordId];
        return next;
      });
    } catch (error) {
      const message = plainDriveMessage(error instanceof Error ? error.message : "");
      setJobs((current) => ({ ...current, [input.recordId]: { progress: null, error: message } }));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
    }
  }

  return { jobs, send };
}

type LibraryPrintRecord = {
  id: number;
  sha256: string;
  fileName: string;
  hubspotDealName: string;
  hubspotDealId: string;
  library?: PrintLibraryMark;
};

export function PrintLibraryStatus({
  record,
  job,
  onSend,
  onMismatch,
}: {
  record: LibraryPrintRecord;
  headers: Record<string, string>;
  job?: LibraryJob;
  onSend: (file: File, record: LibraryPrintRecord, sha256: string) => void;
  onMismatch: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const mark = record.library;
  const inLibrary = mark?.status === "in_library" && !job?.error;
  if (inLibrary && job?.progress == null) return null;

  const detail = job?.error ? plainDriveMessage(job.error) : "";
  const status = detail && detail !== "Not in Library yet." ? detail : "Not in Library";

  async function sendFile(file: File) {
    const sha = await fingerprintFile(file);
    if (sha !== record.sha256) {
      onMismatch();
      return;
    }
    onSend(file, record, sha);
  }

  return (
    <div className="mt-1 min-w-0" data-testid={`print-library-${record.id}`}>
      {job?.progress != null ? (
        <p className="text-xs text-muted-foreground" data-testid={`text-library-progress-${record.id}`}>
          Sending to Library {Math.round(job.progress * 100)}%
        </p>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <p className="min-w-0 truncate text-xs text-muted-foreground" data-testid={`text-library-pending-${record.id}`}>
            {status}
          </p>
          <div className="relative shrink-0">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Actions for ${record.fileName}`}
              aria-expanded={menuOpen}
              data-testid={`button-print-library-menu-${record.id}`}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {menuOpen && job?.progress == null ? (
        <div className="mt-1 w-full max-w-[11rem] rounded-md border border-border bg-popover p-1 text-sm shadow-md">
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
            data-testid={`button-send-to-library-${record.id}`}
            onClick={() => {
              setMenuOpen(false);
              const held = heldSliceFile(record.sha256);
              if (held) void sendFile(held);
              else inputRef.current?.click();
            }}
          >
            Send to Library
          </button>
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept=".ctb,.ultx,.chitubox,.cbddlp,.goo,.prz,.lys,.stl,.3mf"
        className="hidden"
        data-testid={`input-send-to-library-${record.id}`}
        onChange={(event) => {
          const next = event.target.files?.[0];
          event.target.value = "";
          if (!next) return;
          void sendFile(next);
        }}
      />
    </div>
  );
}

export function librarySendInput(
  file: File,
  record: { id: number; sha256: string; fileName: string; hubspotDealName: string; hubspotDealId: string },
  sha256: string,
) {
  const names = splitDealTitle(record.hubspotDealName);
  return {
    file,
    recordId: record.id,
    sha256,
    fileName: file.name || record.fileName,
    orderKey: `deal:${record.hubspotDealId}`,
    kit: names.kit,
    customer: names.customer,
    printer: guessPlatePrinter(file.name || record.fileName),
  };
}
