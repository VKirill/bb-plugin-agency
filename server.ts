import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAgency } from "./src/server/register";

export default function plugin(bb: BbPluginApi) {
  registerAgency(bb);
}
