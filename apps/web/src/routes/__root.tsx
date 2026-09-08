import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import "../design/tokens.css";
import "../design/components.css";
import { Button, Card, Code, Muted, Notice, Page, RowActions, Stack, ToastHost, Topbar } from "../design";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "swisscode" },
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Topbar
          brand="swisscode"
          links={[
            { to: "/", label: "Home", exact: true },
            { to: "/profiles", label: "Profiles" },
            { to: "/accounts", label: "Accounts" },
            { to: "/agents", label: "Agents" },
            { to: "/providers", label: "Providers" },
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
