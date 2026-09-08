import { Outlet, createRootRoute, HeadContent, Scripts, Link } from "@tanstack/react-router";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "swisscode" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header className="topbar">
          <strong>swisscode</strong>
          <nav>
            <Link to="/" activeOptions={{ exact: true }}>Profiles</Link>
            {" · "}
            <Link to="/agents">Agents</Link>
            {" · "}
            <Link to="/providers">Providers</Link>
          </nav>
        </header>
        <main>
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}
