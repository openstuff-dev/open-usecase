import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Health, UseCaseStatus } from '@open-usecase/contracts';
import { z } from 'zod';
import type { Actor } from './auth.js';
import { withScope, type Client, type Pool } from './db.js';
import { HttpError } from './errors.js';
import { claimDone } from './service/reports.js';
import {
  commentByRef,
  listWithoutEvidence,
  proposeUseCase,
  readUseCase,
  requestRetirement,
  reviewUseCase,
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
4. If it isn't approved on arrival, end your turn and tell the user it's waiting for review. Don't keep checking its status, and don't start building, not even the parts you're sure about. If it was approved on arrival, that still covers only what the user asked for: it doesn't let you widen the task.

When the user comes back:
5. Call get_usecase once. Build only if the status is approved. If changes were requested, read the comments, call revise_usecase, and end your turn again. If it was rejected, tell the user why and don't build it.
6. Build only what the approved scenarios describe. Put the scenario's full ID in the name of each test that proves it, such as "UC-142/S2 refuses a bad colour". Name the use cases in the pull request body: "Use cases: UC-142, UC-150", or "No use case: <reason>". After the merge, call claim_done.

When you revise:
- Keep a scenario's tag only if you reworded it. If its meaning changed, even by one new step, leave the tag off so it gets a new ID. An old test must not appear to prove new behaviour.

When someone asks "isn't it true that...?":
- Answer from search_usecases and get_usecase first, and always say how well the answer is backed up.
- Covered and passing: "Yes, UC-142/S2, tests passing."
- Covered but weak: "It's specified, but failing, or there's no evidence." You can also check the code.
- Not covered: "There's no use case for this." You can say what the code appears to do, labelled as not confirmed, and offer to propose one. A reading of the code alone is never a confirmed yes.

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
    result.status === 'approved'
      ? 'It was approved on arrival, without review, because of your review mode. You may build it. That does not widen your task: it covers only what the user asked for.'
      : 'It is not approved yet. Do not build it. End your turn and tell the user it is waiting for review.',
    '',
    result.gherkin,
  ].join('\n');

const NEXT_STEP: Record<UseCaseStatus, (ref: string) => string> = {
  approved: () =>
    'It is ready to build, if it is not built yet. Build only what these scenarios describe. Then call claim_done after the merge.',
  proposed: () =>
    'It is waiting for review. Do not build it yet. End your turn and tell the user it is waiting in the inbox.',
  changes_requested: (ref) =>
    `A person asked for changes. Do not build it. Revise ${ref} first with revise_usecase, using the comments below, then end your turn.`,
  rejected: () =>
    'A person rejected it. Do not build it. The comments say why. Propose a new use case only if the user asks for it.',
  done: () => 'It is built and live. To change it, call revise_usecase: a person approves the change.',
  retired: () => 'It was built and later removed. Do not build it again without asking the user.',
};

const describeComment = (ref: string, comment: ReadUseCase['comments'][number]) => {
  const on =
    comment.scenario === null ? 'the whole use case' : `${ref}/S${String(comment.scenario)}`;
  return `- On ${on}, by ${comment.author} (revision ${String(comment.revision)}): ${comment.body}`;
};

/** A done use case can have a newer revision on the way. The live one stays in force until then. */
function describeNewerRevision(useCase: ReadUseCase): string[] {
  if (!useCase.live) return [];
  const on = `Revision ${String(useCase.live.revision)} is live and stays in force.`;
  const state = useCase.revisionState === 'changes_requested' ? 'changes requested' : useCase.revisionState;
  return [
    `${on} Revision ${String(useCase.revision)} is ${state}. Build it only once it's approved.`,
  ];
}

const HEALTH_WORDS: Record<Health, string> = {
  passing: 'passing',
  failing: 'failing',
  no_evidence: 'no evidence',
};

function describeEvidence(useCase: ReadUseCase): string[] {
  const lines = useCase.evidence.map((scenario) => {
    const id = `${useCase.ref}/S${String(scenario.number)}`;
    const manual = scenario.manual.length
      ? `, verified by hand by ${scenario.manual.map((m) => m.by).join(', ')}`
      : '';
    const tests = scenario.tests
      .map((t) => `${t.repository} ${t.suite} ${t.result}, ${String(t.names.length)} test(s) at ${t.commit.slice(0, 7)}`)
      .join('; ');
    return `- ${id}: ${HEALTH_WORDS[scenario.health]}${tests ? ` (${tests})` : ''}${manual}`;
  });
  return ['', 'Evidence:', ...lines];
}

const describeUseCase = (useCase: ReadUseCase) => {
  const latestComments = useCase.comments.filter((c) => c.revision === useCase.revision);
  return [
    `${useCase.ref}: ${useCase.title}. Status: ${useCase.status}. Health: ${HEALTH_WORDS[useCase.health]}. Revision ${String(useCase.revision)}.`,
    NEXT_STEP[useCase.status](useCase.ref),
    ...describeNewerRevision(useCase),
    ...(useCase.retireReason ? [`Why it was retired: ${useCase.retireReason}`] : []),
    ...(useCase.retirementRequested ? ['A request to retire it is waiting for a person.'] : []),
    // A person can comment and still approve. Their doubt shouldn't get lost.
    ...(useCase.status === 'approved' && latestComments.length
      ? ['A person left comments on this revision when approving. Read them, and raise them with the user before you build.']
      : []),
    ...(useCase.comments.length
      ? ['', 'Comments:', ...useCase.comments.map((c) => describeComment(useCase.ref, c))]
      : []),
    ...describeEvidence(useCase),
    '',
    useCase.gherkin,
    ...(useCase.live
      ? ['', `The live text, revision ${String(useCase.live.revision)}:`, '', useCase.live.gherkin]
      : []),
  ].join('\n');
};

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
        'Send new Gherkin for a use case, after a person asked for changes or to change one that is done. Keep the tag on a reworded scenario. Leave it off when the meaning changed, so it gets a new ID: an old test must not appear to prove new behaviour.',
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
    'review_usecase',
    {
      description:
        "Reviewer agents only: approve another agent's proposal or ask for changes. Check it against the user's original request, not against what the proposer says. You can't review a use case you wrote any revision of.",
      inputSchema: {
        remote,
        id: ref,
        decision: z.enum(['approve', 'request_changes']),
        comment: z.string().trim().max(10_000).optional().describe('Required when asking for changes'),
      },
    },
    (input) =>
      run(async (db) => {
        const { status } = await reviewUseCase(db, actor, {
          remote: input.remote,
          ref: input.id,
          decision: input.decision,
          comment: input.comment,
        });
        return answer(`${input.id} is now ${status}.`);
      }),
  );

  server.registerTool(
    'request_retirement',
    {
      description:
        'Ask a person to retire a done use case, because its behaviour was removed. You cannot retire it yourself: it goes to the inbox, and you carry on with other work.',
      inputSchema: {
        remote,
        id: ref,
        reason: z.string().trim().min(1).max(5000).describe('Why it should be retired'),
      },
    },
    (input) =>
      run(async (db) => {
        await requestRetirement(db, actor, {
          remote: input.remote,
          ref: input.id,
          reason: input.reason,
        });
        return answer(`Filed. A person decides on retiring ${input.id}. Carry on with other work.`);
      }),
  );

  server.registerTool(
    'claim_done',
    {
      description:
        "Say you merged an approved use case. It goes live when the default branch's next test report shows every scenario passing or verified by hand.",
      inputSchema: {
        remote,
        id: ref,
        pr_url: z.url().max(500),
        merge_sha: z.string().min(7).max(100).describe('The merge commit'),
      },
    },
    (input) =>
      run(async (db) => {
        await claimDone(db, {
          remote: input.remote,
          ref: input.id,
          prUrl: input.pr_url,
          mergeSha: input.merge_sha,
        });
        return answer(
          `Claimed. ${input.id} goes live when the next default-branch report shows every scenario passing.`,
        );
      }),
  );

  server.registerTool(
    'list_without_evidence',
    {
      description:
        'Scenarios of approved or done use cases with no evidence, for "write tests from the use cases".',
      inputSchema: { remote },
    },
    (input) =>
      run(async (db) => {
        const missing = await listWithoutEvidence(db, input.remote);
        if (!missing.length) return answer('Every scenario has evidence.');
        return answer(missing.map((m) => `- ${m.id}: ${m.title}`).join('\n'));
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
        status: z
          .enum(['proposed', 'changes_requested', 'approved', 'rejected', 'done', 'retired'])
          .optional(),
        health: z.enum(['passing', 'failing', 'no_evidence']).optional(),
        approval: z
          .enum(['human', 'agent_review', 'auto_approve'])
          .optional()
          .describe('How it was approved. auto_approve means no person or reviewer checked it'),
      },
    },
    (input) =>
      run(async (db) => {
        const found = await searchUseCases(db, input);
        if (!found.length) return answer('No use cases match.');
        return answer(
          found
            .map(
              (u) =>
                `- ${u.ref} (${u.project}): ${u.title}. Status: ${u.status}. Health: ${HEALTH_WORDS[u.health]}.`,
            )
            .join('\n'),
        );
      }),
  );

  return server;
}
