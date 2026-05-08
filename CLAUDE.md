# Runtime logs

Gini captures every spawned child's stdio into log files under
`~/.gini/instances/<instance>/logs/`. The instance is the workspace
directory basename (e.g. `rabat` for this workspace). All files are
appended to (not truncated) so logs survive restarts.

| File                  | Contents                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `web.log`             | Next.js dev server stdout + stderr (control-plane UI)                    |
| `runtime-stdout.log`  | Gini runtime server stdout + stderr (the Bun process behind the API)     |
| `runtime.jsonl`       | Structured gini runtime events (e.g. `runtime.started`); separate stream |

To read recent output:

```bash
INSTANCE=$(basename $(pwd))
tail -n 200 ~/.gini/instances/$INSTANCE/logs/web.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime-stdout.log
tail -n 200 ~/.gini/instances/$INSTANCE/logs/runtime.jsonl
```
