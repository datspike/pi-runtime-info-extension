# Repo guidance

## Что это за репозиторий

- Это публикуемый Pi package `@datspike/pi-runtime-info-extension`.
- Точка входа расширения: `src/index.ts`; чистая логика и типы runtime: `src/runtime.ts`.
- Пакет даёт агентам машинно проверяемые поля модели, thinking level и session metadata для артефактов.

## Как ориентироваться

- `runtime_info` и `/runtime-info` для текущей сессии должны опираться только на документированные Pi API: `ctx.model`, `ctx.sessionManager`, `pi.getThinkingLevel()`.
- `subagent_runtime_info` — best-effort интеграция с `pi-subagents` через `globalThis[Symbol.for("pi-subagents:manager")]`; держи эту зависимость изолированной в `src/runtime.ts` и явно покрытой тестами.
- `runtime_artifact_fields` должен оставаться тонким преобразованием runtime-info в поля артефакта, без знания о конкретных review/research workflow.

## Ограничения

- Не добавляй сетевые вызовы, фоновую запись состояния или внешние сервисы: расширение должно быть read-only introspection layer.
- Не импортируй приватные файлы Pi core; если нужен новый Pi seam, сначала оформи это как ограничение в README.
- Runtime-зависимости на Pi core packages держи в `peerDependencies` с `"*"`; сторонние runtime-зависимости добавляй только при реальной необходимости.
- Не включай тесты и локальные артефакты в npm tarball; список публикации задаёт `package.json.files`.

## Ожидания от изменений

- После правок запускай `npm run check`; перед публикацией дополнительно `npm pack --dry-run`.
- Для изменений public API обновляй README: tools, command, compatibility notes и limitations.
- Если меняется seam `pi-subagents`, добавляй тест на отсутствие manager и на найденную запись сабагента.
- Сохраняй маленькую поверхность расширения: новые tools добавляй только если они нужны агенту как отдельный стабильный контракт.
