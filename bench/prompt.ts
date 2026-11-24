import { createHash } from "node:crypto";

/**
 * The cold-start task. It must not name, hint at or describe any component of the repos under test.
 * Any edit changes PROMPT_HASH, which is recorded with every result so runs are only compared like for like.
 */
export const COLD_START_PROMPT = `You are documenting the architecture of the repository in your current directory. Use the design-loop tools to build a design map of it.

1. Call map_status, then map_read. The map is empty and its kind is "architecture".
2. Explore the code with Read, Glob and Grep to find the main components and how they depend on each other.
3. Add components as nodes with map_propose. Every node must cite the real directory or file that implements it (the "cites" field). Use only the roles map_read lists. Add edges for real dependencies or data flow between components, with a short label.
4. Include external systems the code talks to (for example binaries or services) as nodes with role "external".
5. A reviewer applies your proposals within a second or two. After each proposal, call map_status to confirm it was applied before you build on it. Propose in several steps rather than one large change.
6. Stop when the map covers the main components of the system. Do not try to list every package.

Do not modify any files. The map is the deliverable; do not describe the architecture in prose.`;

export const PROMPT_HASH = createHash("sha256").update(COLD_START_PROMPT).digest("hex").slice(0, 12);

/**
 * The replay update task. The fixed text must not name any component; the variable part is the real commit
 * subjects and changed paths of the checkpoint, which is the context an agent that just made the change would have.
 * UPDATE_PROMPT_HASH covers the fixed text only.
 */
const UPDATE_HEAD = `You maintain the design map of the repository in your current directory, using the design-loop tools. The code has just changed. This is what changed since the map was last updated:`;
const UPDATE_TAIL = `What to do:
1. Call map_status. It reports drift signals and lists any "uncovered" folders (new code that no node covers). Then call map_read.
2. Look at the changed code as needed with Read, Glob and Grep.
3. Update the map with map_propose so it matches the code again:
   - add a node for each new component, citing its directory (the "cites" field); use only the roles map_read lists
   - add edges for dependencies between components that these changes introduced, and remove edges for dependencies they removed
   - for a node whose cited code changed, check it still fits; to re-anchor it, send its cites again in an update_node op
   - remove nodes whose code is gone
4. Change only what these changes require. Do not reorganise the rest of the map. If nothing architectural changed, propose nothing and say so in one sentence.
5. A reviewer applies proposals within a second or two. Call map_status to confirm one was applied before building on it.

Do not modify any files. The map is the deliverable.`;

export const UPDATE_PROMPT_HASH = createHash("sha256").update(UPDATE_HEAD + UPDATE_TAIL).digest("hex").slice(0, 12);

export function updatePrompt(subjects: string[], files: { status: string; path: string }[], maxFiles = 80): string {
  // added / deleted / renamed paths first: they are what changes architecture; modified files fill the rest
  const rank = (s: string) => (s.startsWith("M") ? 1 : 0);
  const sorted = [...files].sort((a, b) => rank(a.status) - rank(b.status) || a.path.localeCompare(b.path));
  const shown = sorted.slice(0, maxFiles).map((f) => `${f.status[0]} ${f.path}`);
  const more = sorted.length > maxFiles ? `\n(and ${sorted.length - maxFiles} more changed files)` : "";
  return `${UPDATE_HEAD}

Commits (oldest first):
${subjects.map((s) => `- ${s}`).join("\n") || "- (none)"}

Changed files (A added, D deleted, R renamed, M modified):
${shown.join("\n") || "(none)"}${more}

${UPDATE_TAIL}`;
}
