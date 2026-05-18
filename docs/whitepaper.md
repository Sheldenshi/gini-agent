# Gini Agent Whitepaper

OpenClaw gave us a glimpse of the future of autonomous AI agents by simply putting together a few memory files and a loop that takes initiative. It created moments of magic and a strange feeling of how it's different from a chatbot. But once you started actually depending on it, debugging the gateway after every update and teaching the claw agent to do the same task over and over became a full-time job. Hermes came along leaner, with fewer moving parts, and quietly pulled people across. Neither has closed the core gap: the agent stores facts about you, may or may not remember a caveat about a project, but doesn't reliably retrieve the way you'd expect a colleague to.

## What we're building 

A personal agent that can run without forcing you to read a log line. That's the bar.

## Gaps

These gaps are load-bearing today. More will surface as we build and as users tell us what's missing. Closing them is the difference between an agent that demos well and one that actually works.

**1. The agent remembers.** Talking to the agent should feel like talking to a colleague who has been working with you for a year. It knows the facts you've shared, the work you're doing, and why you're doing it. It surfaces relevant context without being asked. You don't tell it the same story twice, and you don't re-explain what you're trying to do.

The hard part is recall, not storage. Persisting text is solved. Deciding which facts matter for the current situation and bringing them in unprompted isn't. That's the problem users actually feel.

**2. What the agent learns, sticks.** Today's agents do a procedure once when you walk them through it. A week later, you're walking them through it again. That's not learning; that's a long autocomplete. The promise is the opposite: a thing you teach the agent today is a thing the agent owns next week. It runs the procedure on its own, judges whether the result was right, and when it wasn't, updates itself so the next run is better.

You don't read the agent's skills to decide whether they are usable. You rely on them because they've run before, against real situations, and worked.

**3. The interface fits the agent.** Current agents live inside messaging apps designed for human conversation, so the surface is a flat chat history. You can't see what's queued, what's running, or what's waiting on you. The agent is running scheduled jobs and multi-step work, and the interface treats all of it as just more chat. Working with your agent should feel like working with someone, not scrolling a thread.

## Approach

Closing these requires two architectural choices the current frameworks haven't made. The runtime is local-first, so the agent doesn't depend on third-party uptime. And it's modular, so a fix to one piece doesn't break the others. Implementation lives in [architecture-overview.md](./architecture-overview.md).
