import { DocumentPanel } from "./src/app/prototype/document-panel";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { storedUiLanguage } from "./src/app/i18n";
import { AgencySidebarAccessory } from "./src/app/sidebar-accessory";
import { AgencyPrototype } from "./src/app/prototype/shell";
import { ComposerSessionBanner } from "./src/app/composer-session-banner";
import { OwnerQuestionInteraction } from "./src/app/prototype/owner-question-form";
import { OWNER_QUESTION_RENDERER_ID } from "./src/shared/contracts/owner-question";

export default definePluginApp((app) => {
  // BB reads titles once at load: they follow the language remembered by the last Agency view.
  const en = storedUiLanguage() === "en";
  app.slots.fileOpener({id:"agency-document",title:en?"Agency document":"Документ Агентства",extensions:["txt","json","yaml","yml","csv","png","jpg","jpeg","webp","gif"],component:DocumentPanel});
  app.slots.navPanel({
    id: "agency", title: en ? "Agency" : "Агентство", icon: "Workflow",
    path: "overview", component: AgencyPrototype,
    experimental_sidebarAccessory: AgencySidebarAccessory,
  });
  app.composer.customize({
    id: "agency-session-mode",
    actions: [{ id: "agency-session-mode", component: ComposerSessionBanner }],
  });
  app.slots.pendingInteraction({
    id: OWNER_QUESTION_RENDERER_ID,
    component: OwnerQuestionInteraction,
  });
});
