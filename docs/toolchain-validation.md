# Проверка toolchain Агентства

Сверено 14 сентября 2026, Mac mini, thread `thr_vawing3wxf` / AGY-2.
Исторический прогон: тогда плагин был **0.1.0-alpha.12**. Текущий пакет —
**0.1.0-alpha.16**; engines в `package.json` те же диапазоны. Не читать этот файл
как «reload не делался».

## Заявленные engines

| Поле | Значение | Откуда |
| --- | --- | --- |
| `node` | `^22.19.0 \|\| ^24.0.0 \|\| ^26.0.0` | engines `bb-app@0.43.1` (build tool), не shell Node 26 |
| `bb` | `>=0.43.1 <0.44` | установленный BB |
| `bbPluginSdk` | `>=0.4.87 <0.5` | exact pin `@get-bb/plugin-sdk` 0.4.87 |

`@get-bb/plugin-sdk@0.4.87` своего `engines.node` не публикует. Host entry в руководстве автора — Node 22 ESM. Vitest 4.1.11 допускает `^20 \|\| ^22 \|\| >=24`; Vitest 5 не брался.

**Локально исполнено:** только **Node 26.3.1**. **Node 22 CI ещё не исполнен.** Homebrew Node 20/22 нет; глобальный Node не ставился.

## Vitest

Было 3.2.7 (GHSA-82fw-gwwq-j7x9). Патч 3.x нет. В lock exact **4.1.11**. Запуск: `vitest run`, mocker/dev-server наружу не открывался.

## bb-app не в графе плагина

`bb-app` **нет** в `dependencies` / `devDependencies` / `package-lock.json`. Это не устраняет advisory самого launcher: они остаются у `bb-app@0.43.1` и его вложенного `npm`. Перенос в отдельный prefix только убирает ~220 MB и findings из графа плагина.

Отдельного npm «plugin-build-only» нет. Локально `npm run build` берёт `bb` с PATH / `BB_CLI` (на Mini: `~/.local/bin/bb` 0.43.1). В CI CLI ставится **только** на шаг сборки.

## CI

[`.github/workflows/agency-check.yml`](../.github/workflows/agency-check.yml):

- `node-version: "22.19"` строкой (заявленный пол; этот job на Mini не гонялся).
- `npm ci` / typecheck / test плагина — без `bb`.
- SDK pin **offline**: exact `0.4.87` в package и lock. `bb plugin types --check` в чистом CI нет: ему может быть нужен live host, это не integration check.
- Сборка: `npm install --prefix "$RUNNER_TEMP/bb-toolchain" bb-app@0.43.1`, дальше только `$RUNNER_TEMP/bb-toolchain/node_modules/.bin/bb plugin build`.
- Кеша `~/.bb/plugins` нет (лишний runtime state).
- Gate audit — только граф плагина. Audit prefix `bb-app` пишется в лог и **не** является gate; isolation не считается исправлением advisory.

## Audit

| Область | Исход 14.09.2026 |
| --- | --- |
| граф плагина `npm audit --omit=dev` | **0** |
| граф плагина полный `npm audit` | **0** (после удаления `bb-app` из lock) |
| изолированный `bb-app@0.43.1` (свой prefix + свой lock) | **6 findings** (1 low, 4 high, 1 critical): `tar`, `pacote`, `undici`, `brace-expansion`, `ip-address`, `postcss-selector-parser` — вложенный `npm` launcher. Isolation **не** убирает эти advisory. |
| GHSA-82fw-gwwq-j7x9 | в графе плагина нет |

Когда `bb-app` сидел в lock плагина, полный audit показывал 8 строк (дополнительно родители `bb-app` / `npm`). Число строк изменилось из‑за другой формы графа, не потому что уязвимости launcher исчезли.

## React и shims

React не в manifest. В lock плагина peer `react@19.3.0` / `react-dom@19.3.0`. После `bb plugin build` в `dist/*` нет `@license React`. Host/server без `jsx-runtime`. App — shim host, не второй bundle.

## Локальные команды (Node 26.3.1)

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build          # PATH bb 0.43.1
npm audit --omit=dev
npm audit
```

Typecheck: 0; в программе `host.ts`, `server.ts`, `app.tsx`.  
Тесты после ci: **40 passed / 6 files** (37 исходных + параллельный AGY-3 `run-links`; тесты AGY-2 не менялись).  
SDK pin offline: package и lock `0.4.87`. `bb plugin types --check` локально с живым CLI печатает совпадение pin/host; в CI это не gate.

ACP warning `nativeSkillRoots` — среда CLI, не репозиторий Агентства.
