import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type OwnerAuthFailureListener = () => void;
const ownerAuthFailureListeners = new Set<OwnerAuthFailureListener>();

/** Subscribe to mid-session owner auth failures (401 on requests that sent the owner code). */
export function onOwnerAuthFailure(listener: OwnerAuthFailureListener): () => void {
  ownerAuthFailureListeners.add(listener);
  return () => {
    ownerAuthFailureListeners.delete(listener);
  };
}

function notifyOwnerAuthFailure() {
  ownerAuthFailureListeners.forEach((listener) => {
    listener();
  });
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  options?: { headers?: Record<string, string> },
): Promise<Response> {
  const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
  const headers: Record<string, string> = {
    ...(data && !isFormData ? { "Content-Type": "application/json" } : {}),
    ...(options?.headers ?? {}),
  };
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data ? (isFormData ? data : JSON.stringify(data)) : undefined,
  });

  const ownerCode = headers["x-paid-order-access-code"];
  if (res.status === 401 && typeof ownerCode === "string" && ownerCode.length > 0) {
    notifyOwnerAuthFailure();
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      // Shop-floor data goes stale in HubSpot; soft-refresh instead of hard reload.
      // 20s matches server print-order deal cache TTL.
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      refetchInterval: false,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
