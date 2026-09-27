import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest, queryClient } from "@/lib/queryClient";

type DriveStatus = {
  ok?: boolean;
  configured?: boolean;
  connected?: boolean;
  email?: string;
  reconnect?: boolean;
};

export function GoogleDriveConnect() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Owner tools unlocked",
    successDescription: "Google Drive can be connected from this page.",
  });
  const status = useQuery({
    queryKey: ["/api/google/drive", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/google/drive", undefined, { headers });
      return (await response.json()) as DriveStatus;
    },
  });

  async function connect() {
    const response = await apiRequest("GET", "/api/google/oauth/start", undefined, { headers });
    const body = (await response.json()) as { url?: string };
    if (body.url) window.location.assign(body.url);
  }

  async function disconnect() {
    await apiRequest("POST", "/api/google/drive/disconnect", {}, { headers });
    await queryClient.invalidateQueries({ queryKey: ["/api/google/drive"] });
  }

  const configured = status.data?.configured === true;
  const connected = status.data?.connected === true;
  const reconnect = status.data?.reconnect === true;
  const email = status.data?.email?.trim() || "";

  return (
    <section className="settings-card" data-testid="panel-google-drive">
      <h2 className="settings-card-title">Google Drive</h2>
      {!isUnlocked ? (
        <div data-testid="text-google-drive-locked">
          <p className="mb-3 text-sm text-muted-foreground">Unlock Print Ops to connect Google Drive.</p>
          <OwnerUnlockPanel
            title="Unlock Google Drive"
            description="Same owner code as Floor. Slice files stay in your Google Drive."
            buttonLabel="Unlock"
            testIdPrefix="google-drive"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        </div>
      ) : status.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking Google Drive.</p>
      ) : status.isError ? (
        <p className="text-sm text-destructive">Could not read Google Drive status.</p>
      ) : !configured ? (
        <p className="text-sm text-muted-foreground" data-testid="text-google-drive-unconfigured">
          Google Drive is not set up on this server yet.
        </p>
      ) : reconnect ? (
        <div className="space-y-3">
          <p className="text-sm" data-testid="text-google-drive-reconnect">
            Google Drive needs a reconnect{email ? ` for ${email}` : ""} before uploads can continue.
          </p>
          <Button type="button" size="sm" onClick={() => void connect()} data-testid="button-reconnect-google-drive">
            Reconnect Google Drive
          </Button>
        </div>
      ) : connected ? (
        <div className="space-y-3">
          <p className="text-sm" data-testid="text-google-drive-email">
            Connected as {email || "your Google account"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void connect()} data-testid="button-reconnect-google-drive">
              Reconnect
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void disconnect()} data-testid="button-disconnect-google-drive">
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Slice files upload to your Google Drive, in a Print Ops folder for each order.
          </p>
          <Button type="button" size="sm" onClick={() => void connect()} data-testid="button-connect-google-drive">
            Connect Google Drive
          </Button>
        </div>
      )}
    </section>
  );
}
