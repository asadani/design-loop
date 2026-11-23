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
