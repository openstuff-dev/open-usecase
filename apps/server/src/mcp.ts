import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UseCaseStatus } from '@open-usecase/contracts';
import { z } from 'zod';
import type { Actor } from './auth.js';
import { withScope, type Client, type Pool } from './db.js';
import { HttpError } from './errors.js';
import {
  commentByRef,
  proposeUseCase,
  readUseCase,
  reviseUseCase,
  searchUseCases,
  type ProposeResult,
  type ReadUseCase,
} from './service/usecases.js';

/** What every agent is told when it connects. Draft: the real agent runs in the trial test it. */
export const SERVER_INSTRUCTIONS = `OpenUsecase holds what a product visibly does, as Gherkin use cases that a person approves.

Before you build:
1. If your task changes behaviour a user can observe, it needs an approved use case first. Refactors, dependency bumps, CI and internal tooling need none. If you're unsure, ask the user.
2. Call search_usecases to see whether a use case already covers it. If one does, read it with get_usecase.
3. If none does, write one and call propose_usecase. Describe behaviour, not implementation, and keep to about seven scenarios. Send the user's request word for word as original_request.

While it waits:
4. If it isn't approved on arrival, end your turn and tell the user it's waiting in the inbox. Don't keep checking its status, and don't start building, not even the parts you're sure about.

When the user comes back:
5. Call get_usecase once. Build only if the status is approved. If changes were requested, read the comments, call revise_usecase, and end your turn again.
6. Build only what the approved scenarios describe. Put the scenario's full ID in the name of each test that proves it, such as "UC-142/S2 refuses a bad colour".

When you find behaviour no use case covers:
7. Always ask the user whether to build it with the current task. If yes, propose it. If no, or nobody can answer, propose it anyway so it reaches the inbox, and carry on without building it.`;

const remote = z.string().min(1).max(500).describe('Output of `git remote get-url origin`');
const gherkin = z
  .string()
  .min(1)
  .max(100_000)
  .describe(
    'Standard Gherkin, written as behaviour: "When I change the primary colour", not "When I click #color-btn". The server tags scenarios without a tag.',
  );
const ref = z.string().max(20).describe('The use case ID, e.g. UC-142');

const answer = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const describeResult = (result: ProposeResult, verb: string) =>
  [
    `${verb} ${result.ref} (revision ${String(result.revision)}). Status: ${result.status}.`,
    ...result.scenarios.map((s) => `- ${s.id}: ${s.name}`),
    '',
    'It is not approved yet. Do not build it. End your turn and tell the user it is waiting in the inbox.',
    '',
    result.gherkin,
  ].join('\n');

const NEXT_STEP: Record<UseCaseStatus, (ref: string) => string> = {
  approved: () => 'It is ready to build. Build only what these scenarios describe.',
  proposed: () =>
    'It is waiting for review. Do not build it yet. End your turn and tell the user it is waiting in the inbox.',
  changes_requested: (ref) =>
    `A person asked for changes. Do not build it. Revise ${ref} first with revise_usecase, using the comments below, then end your turn.`,
};

const describeComment = (ref: string, comment: ReadUseCase['comments'][number]) => {
  const on =
    comment.scenario === null ? 'the whole use case' : `${ref}/S${String(comment.scenario)}`;
  return `- On ${on}, by ${comment.author} (revision ${String(comment.revision)}): ${comment.body}`;
};

const describeUseCase = (useCase: ReadUseCase) =>
  [
    `${useCase.ref}: ${useCase.title}. Status: ${useCase.status}. Revision ${String(useCase.revision)}.`,
    NEXT_STEP[useCase.status](useCase.ref),
    ...(useCase.comments.length
      ? ['', 'Comments:', ...useCase.comments.map((c) => describeComment(useCase.ref, c))]
      : []),
    '',
    useCase.gherkin,
  ].join('\n');

/** One server per request (stateless), for one agent. It only ever sees the agent's team. */
export function createMcpServer(pool: Pool, actor: Actor, version: string): McpServer {
  const server = new McpServer(
    { name: 'openusecase', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** Runs in the agent's team, and turns a refusal into text the agent can act on. */
  const run = async (fn: (db: Client) => Promise<ReturnType<typeof answer>>) => {
    try {
      return await withScope(pool, { teamId: actor.teamId }, fn);
    } catch (error) {
      if (error instanceof HttpError) return { ...answer(error.message), isError: true };
      throw error;
    }
  };

  server.registerTool(
    'propose_usecase',
    {
      description:
        'Propose the behaviour you will build as a use case, before you build it. A person reviews it in the inbox.',
      inputSchema: {
        remote,
        title: z.string().trim().min(1).max(200).describe('What the use case is, in a few words'),
        gherkin,
        original_request: z
          .string()
          .max(20_000)
          .optional()
          .describe("The user's request, word for word"),
      },
    },
    (input) =>
      run(async (db) =>
        answer(
          describeResult(
            await proposeUseCase(db, actor, {
              remote: input.remote,
              title: input.title,
              gherkin: input.gherkin,
              originalRequest: input.original_request,
            }),
            'Proposed',
          ),
        ),
      ),
  );

  server.registerTool(
    'revise_usecase',
    {
      description:
        'Send new Gherkin for a use case after a person asked for changes. Keep the tag on a reworded scenario. Leave it off when the meaning changed, so it gets a new ID.',
      inputSchema: {
        remote,
        id: ref,
        gherkin,
        what_changed: z.string().trim().min(1).max(5000).describe('What you changed, and why'),
      },
    },
    (input) =>
      run(async (db) =>
        answer(
          describeResult(
            await reviseUseCase(db, actor, {
              remote: input.remote,
              ref: input.id,
              gherkin: input.gherkin,
              whatChanged: input.what_changed,
            }),
            'Revised',
          ),
        ),
      ),
  );

  server.registerTool(
    'comment_on_usecase',
    {
      description: 'Reply to review feedback, on the whole use case or on one scenario.',
      inputSchema: {
        remote,
        id: ref,
        body: z.string().trim().min(1).max(10_000),
        scenario: z.number().int().positive().optional().describe('2 for UC-142/S2'),
      },
    },
    (input) =>
      run(async (db) => {
        await commentByRef(db, actor, {
          remote: input.remote,
          ref: input.id,
          body: input.body,
          scenario: input.scenario,
        });
        return answer(`Commented on ${input.id}.`);
      }),
  );

  server.registerTool(
    'get_usecase',
    {
      description:
        'Read one use case: its status, its text, the comments on it, and whether you may build it.',
      inputSchema: { remote, id: ref },
    },
    (input) =>
      run(async (db) =>
        answer(describeUseCase(await readUseCase(db, { remote: input.remote, ref: input.id }))),
      ),
  );

  server.registerTool(
    'search_usecases',
    {
      description:
        "Find your team's use cases by the words in their title and text, optionally with one status.",
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe('Words to look for, e.g. "primary colour"'),
        status: z.enum(['proposed', 'changes_requested', 'approved']).optional(),
      },
    },
    (input) =>
      run(async (db) => {
        const found = await searchUseCases(db, input);
        if (!found.length) return answer('No use cases match.');
        return answer(
          found
            .map((u) => `- ${u.ref} (${u.project}): ${u.title}. Status: ${u.status}.`)
            .join('\n'),
        );
      }),
  );

  return server;
}
