### Worktree and simulator cleanup

Follow the [Pi execution contract](../../../docs/harness/pi.md). Preserve active or unmerged work, unrelated files, and session journals.

1. **Inventory.** Record available disk space and inspect `git worktree list` and the repository's available audit tooling. Record each worktree's branch, merge state, tracked and untracked changes, PR state, and known use. Treat automated classifications as leads, not permission.
2. **Verify use.** Check the task's own notes, sessions, and live processes where available. Authorized delegates can inspect independent candidates; otherwise inspect them serially. Do not search unrelated private chats. An unknown owner or use remains unknown.
3. **Select safely.** A clean, merged or obsolete task worktree that is not in use can be removed under the user's authority. Preserve dirty, unmerged, active, or uncertain work. Ask only when an irreversible loss or decision belongs to the user; name the exact affected files.
4. **Remove and verify.** Use `git worktree remove` on the confirmed paths, then re-list and record reclaimed space. Do not force-remove unrelated artifacts or delete session journals.
5. **Other storage.** Inspect simulators, build artifacts, and caches only within the requested cleanup scope. Delete user state or shared resources only with the required authorization; never assume an entire class of data is disposable.

**Reply:** space before and after, worktrees removed, and why each held-back candidate remains.
