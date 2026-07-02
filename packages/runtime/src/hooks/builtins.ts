// Composition root for trusted built-in hook handlers (ADR job-pre-run-hooks.md).
//
// Importing this module evaluates each handler module, whose bottom-line
// registerHook(...) populates the registry as a load side-effect. Imported once
// at application composition time (server boot + CLI entry) and in any test that
// drives the scheduler or asserts a built-in is a member.
//
// It is NOT imported by the generic primitive (types/registry/runner/index) —
// those stay domain-free, so a consumer importing the primitive never drags a
// handler into its load path.

import "../capabilities/skill-script-hook"; // self-registers "skill-script"
