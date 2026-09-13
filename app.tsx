import { DocumentPanel } from "./src/app/prototype/document-panel";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AgencyPrototype } from "./src/app/prototype/shell";

export default definePluginApp((app) => {
  app.slots.fileOpener({id:"agency-document",title:"Документ Агентства",extensions:["md","markdown","txt","json","yaml","yml","csv","png","jpg","jpeg","webp","gif"],component:DocumentPanel});
  app.slots.navPanel({
    id: "agency", title: "Агентство", icon: "Workflow",
    path: "overview", component: AgencyPrototype,
  });
});
