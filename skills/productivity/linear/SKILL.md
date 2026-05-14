---
name: linear
description: "Query and update Linear issues via the Linear GraphQL API."
version: 1.0.0
author: Gini
license: MIT
prerequisites:
  env: [LINEAR_API_KEY]
requires:
  identities:
    - kind: linear
---

# Linear

Use the Linear GraphQL API to query issues, comments, projects, and teams, and to create or update issues on the user's behalf.

## Auth

Linear personal API keys are sent in the `Authorization` header as the **raw token**, not with a `Bearer` prefix. The gateway injects `LINEAR_API_KEY` into the subprocess environment when a healthy `linear` identity exists; do not ask the user for it.

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```

The helper at `scripts/linear.sh` wraps the curl call. Pass the GraphQL query as the first argument:

```bash
bash scripts/linear.sh '{ viewer { id name email } }'
```

## Examples

List issues assigned to the viewer:

```graphql
{
  viewer {
    assignedIssues(first: 20) {
      nodes { id identifier title state { name } }
    }
  }
}
```

Issues for a specific team (replace `<team-id>`):

```graphql
{
  team(id: "<team-id>") {
    issues(first: 20) { nodes { id identifier title state { name } } }
  }
}
```

Create an issue (mutation):

```graphql
mutation {
  issueCreate(input: { teamId: "<team-id>", title: "Title here", description: "Body" }) {
    success
    issue { id identifier title url }
  }
}
```

## Rules

- Always include the issue identifier (e.g. `GIN-42`) and URL in summaries so the user can jump to the issue.
- For multi-page results, ask the user before paginating — Linear pages can be large.
- Do not embed the API key in any output, log, or trace.
