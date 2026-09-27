/**
 * Public privacy policy and terms for the Google OAuth consent screen.
 * These pages are not behind the owner code. They do not read tokens or shop data.
 */
import type { Express } from "express";

const OPERATOR = "Miguel Mercado";
const CONTACT = "streetsofmerchant@gmail.com";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const REVOKE = "https://myaccount.google.com/permissions";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Print Ops</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      background: hsl(240 4% 3%);
      color: hsl(0 0% 97%);
      font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
    }
    main { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    .brand { margin: 0; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
    h1 { margin: 0.75rem 0 0; font-size: 1.75rem; letter-spacing: -0.03em; font-weight: 600; }
    h2 { margin: 1.75rem 0 0.4rem; font-size: 1rem; font-weight: 600; }
    p, li { color: hsl(240 5% 74%); font-size: 0.95rem; line-height: 1.55; }
    ul { padding-left: 1.15rem; }
    a { color: hsl(186 72% 58%); }
    nav { margin-top: 2rem; font-size: 0.875rem; }
    nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Print Ops</p>
    <h1>${title}</h1>
    ${body}
    <nav>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/">Shop</a>
    </nav>
  </main>
</body>
</html>`;
}

export function privacyPageHtml(): string {
  return page(
    "Privacy",
    `<p>Print Ops is a private shop tool operated by ${OPERATOR}. Contact <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
    <h2>Google sign-in</h2>
    <p>The app asks the shop owner to sign in with Google so it can keep print slice files in that person’s Google Drive. The only permission requested is <a href="${SCOPE}">${SCOPE}</a> (<code>drive.file</code>). That scope lets Print Ops upload files it creates and read those same files later. It does not give the app access to the rest of the Drive.</p>
    <h2>What is stored</h2>
    <p>Slice files for orders are uploaded into the owner’s Google Drive. Print Ops stores the OAuth refresh token on the server, and only so it can keep uploading and opening those files. The token is not shown in the app and is not written to HubSpot.</p>
    <h2>Sharing</h2>
    <p>Google data is not sold, shared, or used for ads.</p>
    <h2>Removing access</h2>
    <p>Disconnect Google Drive in Print Ops under Setup, or revoke the app at <a href="${REVOKE}">${REVOKE}</a>. After that, Print Ops can no longer upload until the owner connects again.</p>`,
  );
}

export function termsPageHtml(): string {
  return page(
    "Terms",
    `<p>Print Ops is a private tool for the shop owner, ${OPERATOR}. It is provided as-is, for use in that shop. It is not a public service.</p>
    <p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`,
  );
}

export function registerLegalPages(app: Express): void {
  app.get("/privacy", (_req, res) => {
    res.status(200).type("html").send(privacyPageHtml());
  });
  app.get("/terms", (_req, res) => {
    res.status(200).type("html").send(termsPageHtml());
  });
}
