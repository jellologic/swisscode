import type { FieldDef } from "@swisscode/core";
import { Field, Input } from "../design";
import { ModelField } from "./ModelPicker";

interface AccountFieldsProps {
  providerId: string;
  fields: FieldDef[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** True when the provider publishes a model catalog (model field → combobox). */
  modelCatalog?: boolean;
  /** True when per-model serving providers can be compared. */
  modelEndpoints?: boolean;
  /** Label suffix for secrets, e.g. "blank keeps stored" on the edit page. */
  secretNote?: string;
}

/** Provider config fields, shared by the add and edit pages. */
export function AccountFields(props: AccountFieldsProps) {
  return (
    <>
      {props.fields.map((f) =>
        f.key === "model" && props.modelCatalog ? (
          <ModelField
            key={f.key}
            providerId={props.providerId}
            label={f.label}
            hint={f.help}
            value={props.values[f.key] ?? ""}
            placeholder={f.placeholder}
            showEndpoints={props.modelEndpoints ?? false}
            onChange={(v) => props.onChange({ ...props.values, [f.key]: v })}
          />
        ) : (
          <Field
            key={f.key}
            label={f.secret && props.secretNote ? `${f.label} (${props.secretNote})` : f.label}
            hint={f.secret && props.secretNote ? undefined : f.help}
          >
            <Input
              type={f.secret ? "password" : "text"}
              value={props.values[f.key] ?? ""}
              placeholder={f.placeholder ?? ""}
              onChange={(e) => props.onChange({ ...props.values, [f.key]: e.target.value })}
            />
          </Field>
        ),
      )}
    </>
  );
}
