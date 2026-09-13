import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { OverviewPage } from "./src/app/pages/overview";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agency", title: "Агентство", icon: "Workflow",
    path: "overview", component: OverviewPage,
  });
});
