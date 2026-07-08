---
name: Shallow-clone git push failures
description: How to diagnose and fix "did not receive expected object" errors when pushing a repo whose local history is a shallow clone.
---

## Symptom
`git push` (including `--force`) fails with:
```
remote: fatal: did not receive expected object <sha>
error: remote unpack failed: index-pack failed
```
This happens even after `git gc`, `--no-thin`, or repacking.

## Root cause
The local repo's oldest ("root") commit has a `parent` field baked into its content
(`git cat-file -p <root-commit>` shows a `parent <sha>` line), but that parent
object was never actually fetched into the local object store — a byproduct of a
shallow clone (`git rev-parse --is-shallow-repository` returns `true`, and
`.git/shallow` lists that root commit as the shallow boundary).

`git fetch --unshallow` / `--depth=<huge>` will NOT fix this if the only
available remote has an unrelated history (different root entirely) — there is
nowhere to fetch the missing parent from.

**Why:** Git can't build a valid pack to send without the referenced parent
object, so the remote rejects the pack during unpacking, regardless of force-push
permissions or branch protection settings (both can check out fine while this
still fails).

## How to apply
When you hit this and the missing parent is unrecoverable (no remote/mirror has
it):
1. Create an orphan branch from current HEAD: `git checkout --orphan <tmp>`
2. `git add -A && git commit -m "..."` — this creates one clean root commit with
   no missing-parent reference, preserving all current file contents (only
   commit-by-commit history is lost, not the working tree).
3. Force-push that branch to the target ref: `git push <remote> <tmp>:<branch> --force`
4. Reset local branch to match: `git checkout <tmp> -B <branch>`, delete the tmp
   branch, set upstream tracking.

This is safe when the user has confirmed they're OK losing commit history (their
working files are unaffected).
