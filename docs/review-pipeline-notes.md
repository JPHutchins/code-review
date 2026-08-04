# Review pipeline notes

A short, benign scratch document used to exercise the review pipeline end to end
without touching CI configuration, hooks, or secrets.

## Phases

The reviewer runs in two phases. Phase 1 is a data-only security triage that
decides whether the changed code is safe to check out and execute. Phase 2 is
the agentic review itself: it reads the diff and the surrounding code, then
writes its findings to a draft the commenter later posts.

## Why this file exists

It gives the pipeline a small, obviously-safe diff to review — plain prose, no
workflow changes, no executable payloads — so a run can confirm the machinery
works before a change with real risk goes through it.
