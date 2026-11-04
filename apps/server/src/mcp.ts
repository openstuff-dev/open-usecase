import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Actor } from './auth.js';
import { withScope, type Client, type Pool } from './db.js';
import { HttpError } from './errors.js';
import {
  commentByRef,
  proposeUseCase,
  reviseUseCase,
  type ProposeResult,
} from './service/usecases.js';

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

/** One server per request (stateless), for one agent. It only ever sees the agent's team. */
export function createMcpServer(pool: Pool, actor: Actor, version: string): McpServer {
  const server = new McpServer({ name: 'openusecase', version });

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

  return server;
}
