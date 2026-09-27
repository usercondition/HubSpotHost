/**
 * Railway terminates TLS at one proxy. Trust that hop so req.ip is the client
 * and public rate limits are not shared by everyone behind the proxy.
 */
export function configureTrustProxy(
  app: { set: (name: string, value: unknown) => void },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const onRailway = Boolean(
    env.RAILWAY_ENVIRONMENT?.trim() ||
      env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
      env.RAILWAY_PROJECT_ID?.trim() ||
      env.RAILWAY_SERVICE_ID?.trim(),
  );
  if (onRailway) app.set("trust proxy", 1);
}
