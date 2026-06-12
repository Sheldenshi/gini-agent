---
name: phone-call
description: "Place outbound AI phone calls via Bland AI: book reservations, make appointments, ask businesses questions, then report back the transcript and summary."
license: MIT
allowed-tools: "skill_run read_skill"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    requires:
      credentials: [BLAND_API_KEY]
---

# Phone Call

Place outbound phone calls through Bland AI. An AI voice agent dials the number, follows your task prompt in a live conversation, and the full transcript plus a summary come back when the call ends. Everything runs through `skill_run`:

```
skill_run({ skill: "phone-call", script: "place-call",
            args: { phoneNumber: "+15551234567", task: "..." } })
```

The runtime injects `BLAND_API_KEY` into the scripts — you never see or pass the key.

## Workflow

1. **Gather the full task.** Before anything else, collect: who to call (name + number), the goal, hard constraints (dates, times, party size, budget), fallbacks if the first ask isn't available, and the name to give if the callee asks who's calling. A vague task produces a bad call.
2. **Confirm with the user before dialing.** State the exact number and what the agent will say/ask, and get an explicit go-ahead. Calls are outward-facing and irreversible.
3. **Place the call** with `place-call`. It returns `{ ok, callId }`.
4. **Wait for the result** with `check-call`, passing `waitSeconds: 240` — the script polls Bland every 10 seconds internally and returns as soon as the call completes (or when the budget runs out). If the result comes back with `completed: false`, call `check-call` again with the same args and repeat until `completed` is `true`.
5. **Report back** the `summary` and the key points of the `transcript` (quote relevant exchanges, don't dump the whole thing unless asked). Optional: for structured answers about the call (did they confirm? what time?), run `analyze-call`.

If the user wants to abort a call in progress, run `stop-call` with the `callId`.

## Scripts

### place-call

```
skill_run({ skill: "phone-call", script: "place-call", args: {
  phoneNumber: "+15551234567",   // required, E.164
  task: "...",                   // required, the call prompt
  voice: "maya",                 // optional, Bland voice id/name
  firstSentence: "...",          // optional, exact opening line
  waitForGreeting: true,         // default true — wait for the callee to speak first
  record: false,                 // default false — see Rules
  maxDurationMinutes: 10,        // default 10
  language: "en-US"              // optional
} })
```

Returns `{ ok, callId }` or `{ ok: false, error }`.

### check-call

```
skill_run({ skill: "phone-call", script: "check-call", args: { callId: "...", waitSeconds: 240 } })
```

Returns `{ ok, callId, status, completed, answeredBy, callLengthMinutes, to, from, transcript, summary, recordingUrl, errorMessage }`. `waitSeconds` (optional, default 0, max 240) makes the script wait for the call to finish, polling Bland every 10 seconds; if the budget runs out first it returns the latest status with `completed: false` — call again with the same args. Fields Bland hasn't populated yet are omitted; `transcript` and `summary` appear only after `completed` is `true`. `callLengthMinutes` is in minutes. `answeredBy` distinguishes `human` from `voicemail`.

### stop-call

```
skill_run({ skill: "phone-call", script: "stop-call", args: { callId: "..." } })
```

Ends an in-progress call. Returns `{ ok, message }`.

### analyze-call

```
skill_run({ skill: "phone-call", script: "analyze-call", args: {
  callId: "...",                                      // required
  goal: "Book a dinner reservation",                  // optional context
  questions: [                                        // required, non-empty
    ["Did they confirm the reservation?", "boolean"],
    ["What time was booked?", "string"]
  ]
} })
```

Use after `check-call` reports `completed: true` when you need structured answers instead of reading the transcript — e.g. "Did they confirm the reservation?" → `true`. Each question is a `[question, answerType]` pair (`"string"`, `"boolean"`, `"number"`); a bare string question defaults to `"string"`. Returns `{ ok, answers }` with one answer per question, in order. Each analysis costs Bland credits, so prefer the transcript/summary for simple cases.

## Background watching

The workflow above is synchronous — right for short errand calls where the user is waiting on the result. When the user doesn't want to wait, or the call may run long, hand the waiting to a scheduled job with a `call-watch` pre-run hook: the hook polls Bland with zero model turns while the call is in progress, and wakes the job's turn exactly once, when the call finishes.

1. Place the call with `place-call` as usual and note the `callId`.
2. Create the watcher job:

```
create_job({
  name: "call-watch <callId>",
  intervalSeconds: 30,
  oneShot: false,        // must stay false — the silent in-progress ticks would auto-pause a one-shot job before the call finishes
  timeoutSeconds: 120,
  preRunHook: {
    handlerId: "skill-script",
    config: { skill: "phone-call", script: "call-watch", callId: "<callId>" }
  },
  prompt: "A phone call placed in the background has finished. The call result (status, summary, transcript) is in the fenced context items above — report the summary and the key transcript exchanges. Then find this job by name with list_jobs and delete_job it; the call is done and the watcher is no longer needed."
})
```

3. Tell the user the call is underway and the result will arrive in the job's chat thread, then end your turn — do not poll with `check-call`.

Notes:

- The report lands in the job's own chat thread (scheduled jobs deliberately do not post into the main chat).
- `call-watch` is the job's hook script, not for direct `skill_run` use. A failed call (never answered, rejected) also wakes the turn, so the user always hears the outcome.

## Writing a good task prompt

The `task` is the agent's script for the whole conversation. Include the goal, context the callee will ask about, constraints, and fallbacks. Example:

```
You are calling Luigi's Restaurant to book a dinner reservation. Book a table
for 4 people this Friday at 7:00 PM under the name Shelden. If 7:00 PM is not
available, try 7:30 PM, then 6:30 PM. If none of those work, ask what times
are available Friday evening and say you'll call back. If they ask for a
phone number, give +15551234567. Be polite and concise.
```

Use `firstSentence` when the opening line matters (e.g. "Hi, I'm calling on behalf of Shelden to ask about your store hours.").

## Limitations

- **Outbound only** — this skill cannot answer incoming calls.
- **Rate limit**: about 1 call per 10 seconds to the same number.
- **Transcript and summary are only available after the call completes** — `check-call` during the call shows status only.

## Rules

1. **Always confirm the number and task with the user before placing a call.** Calls reach real people and cannot be un-placed.
2. **Never call emergency numbers** (911, 112, 999, etc.) under any circumstances.
3. Phone numbers must be E.164 format: `+15551234567`.
4. Don't store third-party phone numbers in memory — only the user's own.
5. Leave `record: false` unless the user explicitly asks for a recording — recording-consent laws vary by region.
6. Never include `BLAND_API_KEY` in a reply or tool argument — the runtime injects it into the scripts.
