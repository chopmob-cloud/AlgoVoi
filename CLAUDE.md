# AlgoVoi Chrome Extension — Claude Instructions

## Comet validation tasks

When handling tasks received via the comet-claude-bridge (comet_read_reply, comet_wait_reply, comet_send_task), **all validation must use local data only**:

- Read source files directly from `C:\algo\chrome\` using file tools
- Do NOT use WebFetch, WebSearch, or any URL fetch to validate
- Do NOT call GitHub API or access any remote repository
- Do NOT fetch npm registry, docs sites, or external APIs as part of validation
- Use only: Read, Grep, Glob, Bash (local commands), and the comet bridge tools themselves
