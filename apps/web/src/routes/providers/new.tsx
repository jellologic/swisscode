import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Card, Page, Stack } from "../../design";
import { CustomProviderForm, blankCustomForm } from "../../components/CustomProviderForm";

export const Route = createFileRoute("/providers/new")({
  component: NewProviderPage,
});

function NewProviderPage() {
  const router = useRouter();
  return (
    <Page
      title="New custom provider"
      sub="Declare config fields and env mapping — it works everywhere built-ins do."
    >
      <Stack>
        <Card>
          <h2>Provider</h2>
          <CustomProviderForm
            initial={blankCustomForm()}
            submitLabel="Save provider"
            onSaved={() => void router.navigate({ to: "/providers" })}
          />
        </Card>
      </Stack>
    </Page>
  );
}
