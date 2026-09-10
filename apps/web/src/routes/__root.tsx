import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import "../design/tokens.css";
import "../design/components.css";
import { Button, Card, Code, Muted, Notice, Page, RowActions, Stack, ToastHost, Topbar } from "../design";
import { updateStatusFn, versionFn } from "../lib/functions";

export const Route = createRootRoute({
  // Version + update badge data: each failure degrades independently (no
  // badge / no warn state), never a crash page.
  loader: async () => {
    const [version, update] = await Promise.all([
      versionFn().catch(() => ({ version: "" })),
      updateStatusFn().catch(
        () => ({ updateAvailable: false as const, latest: null as string | null }),
      ),
    ]);
    return {
      version: version.version,
      updateAvailable: update.updateAvailable,
      latest: update.latest,
    };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "swisscode" },
    ],
    // Inline SVG so /favicon.ico is never requested: the production server
    // only serves real files under dist/client plus framework routes.
    links: [
      {
        rel: "icon",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23111827'/%3E%3Ctext x='8' y='12' font-size='11' text-anchor='middle' fill='white' font-family='sans-serif'%3Es%3C/text%3E%3C/svg%3E",
      },
    ],
  }),
  component: RootComponent,
  errorComponent: AppError,
  notFoundComponent: NotFound,
});

/** Designed crash page: what broke, in plain language, with a way back. */
function AppError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Page title="Something went wrong" sub="The app hit an error it couldn't recover from.">
      <Card>
        <Stack>
          <Notice tone="danger"><Code>{message}</Code></Notice>
          <p>
            <Muted>
              If this repeats, check the dev server terminal for the full stack —
              loader and server-function failures land there too.
            </Muted>
          </p>
          <RowActions>
            <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
            <Button to="/">Back home</Button>
          </RowActions>
        </Stack>
      </Card>
    </Page>
  );
}

function NotFound() {
  return (
    <Page title="Page not found" sub="That route doesn't exist in this app.">
      <Card>
        <Stack>
          <p>
            <Muted>
              Try one of the sections above — or check the address for a typo.
            </Muted>
          </p>
          <RowActions>
            <Button variant="primary" to="/">Back home</Button>
          </RowActions>
        </Stack>
      </Card>
    </Page>
  );
}

function RootComponent() {
  const { version, updateAvailable } = Route.useLoaderData();
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Topbar
          brand="swisscode"
          version={version || undefined}
          updateAvailable={updateAvailable}
          links={[
            { to: "/", label: "Home", exact: true },
            { to: "/profiles", label: "Profiles" },
            { to: "/accounts", label: "Accounts" },
            { to: "/agents", label: "Agents" },
            { to: "/providers", label: "Providers" },
            { to: "/proxy", label: "Proxy" },
            { to: "/help", label: "Help" },
            { to: "/settings", label: "Settings" },
          ]}
        />
        <main className="sw-main">
          <Outlet />
        </main>
        <ToastHost />
        <Scripts />
      </body>
    </html>
  );
}
