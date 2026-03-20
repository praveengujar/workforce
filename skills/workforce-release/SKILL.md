---
name: workforce-release
description: Aggregate completed tasks into release notes, generate changelog, and optionally tag a release. Use when user wants to ship or document what was done.
---

When the user invokes /workforce-release, prepare a release from completed tasks.

## Steps

1. Call `workforce_list_tasks` to get all tasks
2. Filter for `status: "done"` tasks that are not yet released (no `release` tag in events)
3. If no unreleased done tasks, report nothing to release
4. For each done task, gather:
   - Task prompt (what was requested)
   - Result summary (from `resultSummary` field)
   - Files changed (from branch diff if available)
   - Cost
5. Group changes by category (features, fixes, refactors, tests, docs)
6. Present the release draft
7. On approval:
   - Create a git tag (e.g., `v{version}` or user-specified)
   - Archive released tasks via `workforce_archive_task`
   - Output the final changelog entry

## Change Categorization

Classify each task by its prompt and output:
- **Added**: New features, new files, new capabilities
- **Changed**: Modifications to existing behavior
- **Fixed**: Bug fixes, error corrections
- **Refactored**: Code restructuring without behavior change
- **Tests**: New or modified tests
- **Docs**: Documentation changes

## Template — Release Draft

```
━━━ RELEASE DRAFT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Version: {suggested_version}
Tasks: {count}   Total cost: ${total}

## Added
- {description from task prompt/summary}  ({id_8})
- {description}  ({id_8})

## Changed
- {description}  ({id_8})

## Fixed
- {description}  ({id_8})

## Refactored
- {description}  ({id_8})

➤ Tag and release, edit version, or cancel?
```

## Version Suggestion

- If the repo has existing tags, suggest incrementing the patch version
- If changes include "Added" items, suggest minor version bump
- If user specifies a version, use it
- Format: semver (vX.Y.Z)

## Conversation Style

- Default to including all unreleased done tasks
- Let user exclude specific tasks if needed
- Keep changelog entries concise — one line per task
