# Референсы UI

Изучен публичный репозиторий https://github.com/multica-ai/multica,
commit a9e82c79739446111b8ca9acbb256f584072d20d, 13 сентября 2026.

Прочитаны исходники:
- packages/views/agents/components/agent-detail-page.tsx
- packages/views/agents/components/agent-detail-inspector.tsx
- packages/views/squads/components/squad-detail-page.tsx
- packages/views/autopilots/components/autopilot-dialog.tsx
- packages/views/issues/components/issues-page.tsx
- packages/views/my-issues/components/my-issues-page.tsx

Полезные идеи: несколько видов одной очереди; свойства сотрудника отдельно от
его деятельности; руководитель/состав отдела; разделение расписания, получателя
и инструкции автоматизации. Наши страницы написаны самостоятельно на SDK и
компонентах BB. Код, изображения и стили Multica не переносились.

Прочитан LICENSE: Apache 2.0 с дополнительными условиями в части I; решение
копировать исходники не принималось. Не называем источник безусловно Apache-only.

Основа нативного UI:
- BB Plugin Guide: Host frontend components, frontend-registration, testing.
- @get-bb/plugin-sdk 0.4.87: ProviderModelPicker, PermissionModePicker,
  NewThreadComposer, Markdown, SourceCode, navPanel/useBbNavigate.
- Официальный реестр компонентов BB desktop-v0.43.1 из components.json.
