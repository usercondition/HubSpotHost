import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { fingerprintFile, heldSliceFile, preparePlateUpload, splitDealTitle, uploadPlateBytes } from "@/lib/plate-library-client";
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
      const message = error instanceof Error ? error.message : "Drive upload failed.";
      setJobs((current) => ({ ...current, [input.recordId]: { progress: null, error: message } }));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
    }
  }

  return { jobs, send };
}

export function PrintLibraryStatus({
  record,
  headers,
  job,
  onSend,
  onMismatch,
}: {
  record: { id: number; sha256: string; fileName: string; hubspotDealName: string; hubspotDealId: string; library?: PrintLibraryMark };
  headers: Record<string, string>;
  job?: LibraryJob;
  onSend: (file: File, record: PrintLibraryStatus["record"]) => void;
  onMismatch: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mark = record.library;
  const inLibrary = mark?.status === "in_library" && !job?.error;
  const warning = job?.error || (mark?.status === "pending" ? mark.error : "");
  if (inLibrary && job?.progress == null) return null;

  return (
    <div className="mt-1 min-w-0" data-testid={`print-library-${record.id}`}>
      {job?.progress != null ? (
        <p className="text-xs text-muted-foreground" data-testid={`text-library-progress-${record.id}`}>
          Sending to Library {Math.round(job.progress * 100)}%
        </p>
      ) : null}
      {warning ? (
        <p className="text-xs text-destructive" data-testid={`text-library-pending-${record.id}`}>
          {warning}{" "}
          {/connect drive/i.test(warning) ? (
            <Link href="/setup" className="underline">
              Connect Drive
            </Link>
          ) : null}
        </p>
      ) : null}
      {!inLibrary && job?.progress == null ? (
        <button
          type="button"
          className="text-xs font-medium text-primary underline"
          data-testid={`button-send-to-library-${record.id}`}
          onClick={() => {
            const held = heldSliceFile(record.sha256);
            if (held) onSend(held, record);
            else inputRef.current?.click();
          }}
        >
          Send to Library
        </button>
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
          void fingerprintFile(next).then((sha) => {
            if (sha !== record.sha256) {
              onMismatch();
              return;
            }
            onSend(next, record);
          });
        }}
      />
    </div>
  );
}

export function librarySendInput(
  file: File,
  record: { id: number; sha256: string; fileName: string; hubspotDealName: string; hubspotDealId: string },
) {
  const names = splitDealTitle(record.hubspotDealName);
  return {
    file,
    recordId: record.id,
    sha256: record.sha256,
    fileName: file.name || record.fileName,
    orderKey: `deal:${record.hubspotDealId}`,
    kit: names.kit,
    customer: names.customer,
    printer: guessPlatePrinter(file.name || record.fileName),
  };
}
