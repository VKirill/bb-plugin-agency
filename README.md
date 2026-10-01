# Agency

**English** · [Русский](README.ru.md)

Agency is a BB plugin for managing AI employees, departments, jobs, launches, and reviewed result versions. Job execution runs through the plugin's launch coordinator and BB threads.

## What it does

- Organizes employees into departments with versioned instructions and policies.
- Tracks jobs, dependencies, questions, runs, files, and acceptance decisions.
- Connects jobs to BB projects, environments, and hosts.
- Provides a web interface and the `bb agency` command.

## Quick start

Install dependencies and build the plugin:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Install into BB and inspect the available commands:

```sh
bb plugin install .
bb agency status --json
bb agency help
```

## Documentation

- [Overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Deployment](docs/deployment.md)
- [Gotchas](docs/gotchas.md)
- [CLI](docs/cli.md)
- [Toolchain validation](docs/toolchain-validation.md)
