import { Copy, Mail, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  buildShippingEmailPackage,
  type ShippingEmailTemplateInput,
} from "@shared/shipping-email-template";
import { buyerTrackingMailtoHref } from "@shared/shipping-draft";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: ShippingEmailTemplateInput | null;
  contactEmail?: string | null;
  onCopyText: (text: string) => void;
};

/**
 * Preview the quirky “order on its way” email template (hero + stamp images).
 * Mailto uses plain text (HTML isn’t supported in mailto); HTML is ready for a future sender.
 */
export function ShippingEmailPreviewDialog({
  open,
  onOpenChange,
  input,
  contactEmail,
  onCopyText,
}: Props) {
  if (!input?.trackingNumber) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg" data-testid="dialog-shipping-email-empty">
          <DialogHeader>
            <DialogTitle>Email template</DialogTitle>
            <DialogDescription>Add a tracking number first to preview the email.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const assetBaseUrl =
    input.brand?.assetBaseUrl ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const pack = buildShippingEmailPackage({
    ...input,
    brand: { ...input.brand, assetBaseUrl },
  });
  const mailto = contactEmail
    ? buyerTrackingMailtoHref({
        email: contactEmail,
        subject: pack.subject,
        body: pack.text,
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] max-w-2xl overflow-y-auto"
        data-testid="dialog-shipping-email-template"
      >
        <DialogHeader>
          <DialogTitle>Shipped email preview</DialogTitle>
          <DialogDescription>
            Hipster-maker HTML template (hero + stamp). Subject: {pack.subject}
            {contactEmail ? ` · To: ${contactEmail}` : " · No HubSpot email on this contact yet"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            className="overflow-hidden rounded-lg border border-border bg-[#e8e2d6]"
            data-testid="panel-shipping-email-html-preview"
          >
            <iframe
              title="Shipping email preview"
              sandbox="allow-same-origin"
              srcDoc={pack.html}
              className="h-[32rem] w-full border-0 bg-[#e8e2d6]"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Images load from <span className="font-medium text-foreground">/email/</span> on this app.
            Tweak shop name &amp; copy in{" "}
            <span className="font-medium text-foreground">shared/brand.ts</span>. Mailto sends
            plain text only — HTML waits for a real sender.
          </p>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {mailto ? (
              <Button asChild size="sm" data-testid="button-email-template-mailto">
                <a href={mailto}>
                  <Mail className="mr-2 h-3.5 w-3.5" />
                  Open mail app
                </a>
              </Button>
            ) : (
              <Button size="sm" disabled data-testid="button-email-template-mailto-disabled">
                <Mail className="mr-2 h-3.5 w-3.5" />
                Open mail app
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCopyText(pack.text)}
              data-testid="button-copy-email-template-text"
            >
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy plain text
            </Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="mr-2 h-3.5 w-3.5" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
