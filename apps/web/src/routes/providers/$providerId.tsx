import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Card, Code, Page, Stack } from "../../design";
import { catalogFn } from "../../lib/functions";
import { CustomProviderForm, customDefToForm } from "../../components/CustomProviderForm";

export const Route = createFileRoute("/providers/$providerId")({
  loader: async ({ params }) => {
    const catalog = await catalogFn();
    const entry = catalog.providers.find((p) => p.id === params.providerId);
    if (!entry) throw new Error(`Unknown provider "${params.providerId}".`);
    if (!entry.custom) throw new Error(`"${params.providerId}" is built-in and can't be edited.`);
    return { def: entry.custom };
  },
  component: EditProviderPage,
});

function EditProviderPage() {
  const { def } = Route.useLoaderData();
  const router = useRouter();
  return (
    <Page
      title="Edit provider"
      sub={<>Custom provider <Code>{def.id}</Code>.</>}
    >
      <Stack>
        <Card>
          <h2>Provider</h2>
          <CustomProviderForm
            initial={customDefToForm(def)}
            idEditable={false}
            submitLabel="Save changes"
            onSaved={() => void router.navigate({ to: "/providers" })}
          />
        </Card>
      </Stack>
    </Page>
  );
}
