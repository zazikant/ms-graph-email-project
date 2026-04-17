# Agent Documentation

This folder contains AI agent working files for the ms-graph-email-project.

## Folder Structure

```
.agent/
├── readme.md       # This file
├── SESSION.md      # Current session summary (auto-updated)
├── research/       # Research files (topic-seed.md, topic-sources.md, topic-examples.md)
├── sops/           # Standard Operating Procedures — lessons learned, mistakes logged
├── system/         # System documentation — edge functions, DB tables, architecture
└── task/           # Task plans — PRDs, implementation plans
```

## Purpose

- **research/** — Deep research findings with verified sources and code examples
- **sops/** — Lessons learned from bugs/mistakes to avoid repeating them
- **system/** — Architecture, API specs, edge function documentation, DB schemas
- **task/** — Feature plans and implementation roadmaps

## Maintenance

Run `/update-doc reindex` after adding new files to rebuild navigation.
