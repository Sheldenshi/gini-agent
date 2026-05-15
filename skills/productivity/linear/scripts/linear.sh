#!/usr/bin/env bash
# Thin curl wrapper around the Linear GraphQL endpoint. Pass the query as $1.
# LINEAR_API_KEY is injected by the Gini runtime when a healthy `linear`
# connector exists; the user does not export it manually.
set -euo pipefail

if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "LINEAR_API_KEY is not set. Add a 'linear' connector via the Skills page (Set up Linear button)." >&2
  exit 1
fi

QUERY="${1:-}"
if [[ -z "$QUERY" ]]; then
  echo "Usage: linear.sh '<graphql-query>'" >&2
  exit 1
fi

curl -sS https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$QUERY" '{query: $q}')"
