import { useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import { Choice, Field } from "./shared";

/** Which department this one reports to. Saved at once; a cycle is refused by the server. */
export function DepartmentParentField({
  departmentId,
  parentId,
  departments,
  notice,
}: {
  departmentId: string;
  parentId: string | null;
  departments: readonly { id: string; name: string }[];
  notice: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [value, setValue] = useState(parentId ?? "none");
  const [pending, setPending] = useState(false);
  const change = async (next: string) => {
    if (pending || next === value) return;
    setPending(true);
    const result = await api.setDepartmentParent({ departmentId, parentDepartmentId: next === "none" ? null : next });
    setPending(false);
    if (!result.ok) {
      notice(failureNotice(result.failure));
      return;
    }
    setValue(next);
    notice(next === "none" ? tr("Отдел больше не подчиняется другому.") : tr("Подчинённость сохранена: долго ждущие решения задачи этого отдела будут эскалироваться выше."));
  };
  return (
    <Field
      label="Подчиняется отделу"
      info={
        <>
          <p>{tr("Вышестоящий отдел видит эскалации: главные задачи этого отдела, которые ждут решения дольше срока из правила «Эскалировать в вышестоящий отдел через».")}</p>
          <p>{tr("Отдел не может подчиняться сам себе или своему подчинённому.")}</p>
        </>
      }
    >
      <Choice
        label="Вышестоящий отдел"
        value={value}
        disabled={pending}
        onChange={(next) => void change(next)}
        options={[{ value: "none", label: "Не подчиняется" }, ...departments.filter((item) => item.id !== departmentId).map((item) => ({ value: item.id, label: item.name }))]}
      />
    </Field>
  );
}
