import { addGuideStep, type GuideResult, getGuide, SchaffaRequestError } from "./client.js";

type StepInput = Parameters<typeof addGuideStep>[0];

// Retry only a concurrent edit, retaining the original operation's identity.
export async function appendRecordedStep(input: StepInput): Promise<GuideResult> {
  try {
    return await addGuideStep(input);
  } catch (error) {
    if (
      !(error instanceof SchaffaRequestError) ||
      error.status !== 409 ||
      error.code !== "edit_conflict"
    )
      throw error;
    const current = await getGuide(input);
    return addGuideStep({ ...input, editRevision: current.editRevision });
  }
}

export interface UploadStep {
  sequence: number;
  target: string;
  status: "pending" | "uploaded" | "failed";
  stepId?: string;
  captureError?: string;
  uploadError?: string;
}

export function recordingUploadQueue(options: {
  guide: GuideResult;
  stopped: () => boolean;
  save: () => Promise<void>;
  onMessage?: ((message: string) => void) | undefined;
}) {
  let guide = options.guide;
  let blocked = false;
  let pending = Promise.resolve();
  return {
    get guide() {
      return guide;
    },
    drain: () => pending,
    enqueue(step: UploadStep, input: Omit<StepInput, "slug" | "editRevision">) {
      if (options.stopped()) return;
      pending = pending.then(async () => {
        if (options.stopped()) return;
        if (blocked) {
          step.status = "pending";
          step.uploadError =
            "Waiting for an earlier failed upload. Run `schaffa guide sync` to retry.";
          await options.save();
          return;
        }
        try {
          const append = (value: typeof input) =>
            appendRecordedStep({ ...value, slug: guide.slug, editRevision: guide.editRevision });
          try {
            guide = await append(input);
          } catch (error) {
            if (
              options.stopped() ||
              !input.screenshot ||
              !(error instanceof SchaffaRequestError) ||
              ![413, 422].includes(error.status)
            )
              throw error;
            const { screenshot: _screenshot, clickMarker: _marker, ...text } = input;
            guide = await append({ ...text, capture: false });
            step.captureError = `The server rejected the screenshot (HTTP ${error.status}); the text step was preserved.`;
          }
          step.status = "uploaded";
          const id = guide.steps.at(-1)?.id;
          if (id) step.stepId = id;
          delete step.uploadError;
          options.onMessage?.(`Step ${step.sequence} uploaded: ${step.target}`);
        } catch (error) {
          if (options.stopped()) {
            step.status = "pending";
            delete step.uploadError;
          } else {
            blocked = true;
            step.status = "failed";
            step.uploadError = error instanceof Error ? error.message : "Unknown upload error.";
            options.onMessage?.(
              `Step ${step.sequence} kept locally; upload failed: ${step.uploadError}`,
            );
          }
        }
        await options.save();
      });
    },
  };
}
