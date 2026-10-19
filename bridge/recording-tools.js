import { z } from 'zod';

const selector = z.string().min(1).max(1000);
const url = z
  .string()
  .url()
  .refine((value) => /^https?:/.test(value));
const check = z
  .object({
    selector: selector.optional(),
    text: z.string().max(2000).optional(),
    value: z.string().max(2000).optional(),
    checked: z.boolean().optional(),
    visible: z.boolean().optional(),
    url: url.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.url || value.selector) &&
      (value.url ||
        ['text', 'value', 'checked', 'visible'].some((key) => value[key] !== undefined)),
    'Specify a URL or a unique selector and expected state.',
  );
const action = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('navigate'), url }).strict(),
  z.object({ tool: z.literal('click'), selector }).strict(),
  z.object({ tool: z.literal('type'), selector, text: z.string().max(10000) }).strict(),
  z.object({ tool: z.literal('select'), selector, value: z.string().max(2000) }).strict(),
  z.object({ tool: z.literal('check'), selector, checked: z.boolean() }).strict(),
  z.object({ tool: z.literal('scroll'), deltaY: z.number().int().min(-10000).max(10000) }).strict(),
]);
const step = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
    description: z.string().min(1).max(500),
    before: z.array(check).min(1).max(10),
    actions: z.array(action).min(1).max(5),
    after: z.array(check).min(1).max(10),
  })
  .strict();
const recordingID = z.string().uuid();

export const recordingToolDefinitions = [
  [
    'start_recording',
    'Declare a task, goal, immutable action plan, and observable checks before making a verified video walkthrough. Use only a session-owned tab. Videos and manifests can contain sensitive page data; they remain local. Failed steps are excluded, not undone. Plan selectors must resolve uniquely; no ephemeral refs.',
    {
      tabID: z.number().int(),
      task: z.string().min(1).max(1000),
      goal: z.string().min(1).max(1000),
      steps: z
        .array(step)
        .min(1)
        .max(10)
        .refine(
          (steps) => new Set(steps.map((item) => item.id)).size === steps.length,
          'Step IDs must be unique.',
        ),
      goalChecks: z.array(check).min(1).max(10),
    },
  ],
  [
    'run_recording_step',
    'Execute all literal browser actions in the next declared step; approval covers the entire step, not separate click/type tool calls. Capture only this attempt and retain video/actions only if preconditions and postconditions pass. On failure restore preconditions using ordinary tools before retrying; side effects are not rolled back.',
    { recordingID, stepID: z.string().max(50) },
  ],
  [
    'finish_recording',
    'Verify the declared goal after every planned step passes, then export an edited WebM video and deterministic action manifest locally. The edited walkthrough excludes failed attempts, not proof of their absence. Does not upload or publish files.',
    { recordingID },
  ],
  [
    'cancel_recording',
    'Discard this session’s in-memory recording and detach capture. Does not undo browser actions or delete previously exported files.',
    { recordingID },
  ],
];
