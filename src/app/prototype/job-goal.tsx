import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { GoalViewRecord, rpcContract } from "../../shared/rpc-contract";
import { failureNotice } from "../data/persist";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";
import { tr } from "../i18n";
import type { Job } from "./data";
import { Choice } from "./shared";

/** Goal of a main job, chosen right in the card rail. */
export function JobGoalChoice({ job, notice }: { job: Job; notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [goals, setGoals] = useState<GoalViewRecord[] | null>(null);
  const [value, setValue] = useState(job.goalId ?? "none");
  useEffect(() => setValue(job.goalId ?? "none"), [job.goalId]);
  const apiRef = useRef(api);
  apiRef.current = api;
  // Goals are read once per card; the RPC client identity is not relied on.
  useEffect(() => {
    let live = true;
    void apiRef.current.listGoals().then((result) => {
      if (live && result.ok && Array.isArray(result.value)) setGoals(result.value);
    });
    return () => {
      live = false;
    };
  }, [job.recordId]);
  if (!goals || !job.recordId) return <span className="text-muted-foreground">{tr("не задана")}</span>;
  const options = goals.filter((goal) => goal.status === "active" || goal.id === value);
  if (!options.length) return <span className="text-muted-foreground">{tr("целей нет")}</span>;
  return (
    <div className="w-44">
      <Choice
        label="Цель задачи"
        value={value}
        onChange={(next) => {
          const previous = value;
          setValue(next);
          void api.setJobGoal({ jobId: job.recordId!, goalId: next === "none" ? null : next }).then((result) => {
            if (!result.ok) {
              setValue(previous);
              notice(failureNotice(result.failure));
            }
          });
        }}
        options={[{ value: "none", label: "Без цели" }, ...options.map((goal) => ({ value: goal.id, label: goal.title }))]}
      />
    </div>
  );
}
