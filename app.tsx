import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AgencyPrototype } from "./src/app/prototype/shell";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agency", title: "Агентство", icon: "Workflow",
    path: "overview", component: AgencyPrototype,
  });
});
