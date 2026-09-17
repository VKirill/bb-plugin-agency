import { Checkbox } from "../../../components/ui/checkbox";
import { capabilityStatusLabel, type CapabilityChoice } from "../data/capability-catalog";
import { tr } from "../i18n";

export function CapabilityChecks({
  options,
  selected,
  onChange,
}: {
  options: CapabilityChoice[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {options.map((row) => {
        const checked = selected.includes(row.id);
        return (
          <label key={row.id} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-muted/50">
            <Checkbox
              className="mt-0.5"
              checked={checked}
              onCheckedChange={(value) => onChange(value ? [...selected, row.id] : selected.filter((id) => id !== row.id))}
            />
            <span className="min-w-0">
              <span className="block font-medium">{row.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {row.source === "saved" ? tr("сохранено в профиле") : row.source}
                {row.label !== row.id ? ` · ${row.id}` : ""}
                {` · ${tr(capabilityStatusLabel(row.available))}`}
              </span>
            </span>
          </label>
        );
      })}
      {!options.length && <p className="px-3 py-4 text-sm text-muted-foreground">{tr("В каталоге нет строк. Сохранённые ID появятся здесь, даже если их уже нет в каталоге.")}</p>}
    </div>
  );
}
