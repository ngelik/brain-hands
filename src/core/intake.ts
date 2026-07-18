import { runIntakeSchema, configV2Schema } from "./schema.js";
import type { ConfigV2, ResolvedRunIntake, RoleName, RunIntake } from "./types.js";
import { DEFAULT_PHASE_REASONING, resolveReviewPolicy } from "./config.js";

const MISSING_RESOLUTION_ERROR =
  "mode, research, and reflection must be resolved before execution";

export function resolveRunIntake(
  intake: RunIntake,
  config: ConfigV2,
): ResolvedRunIntake {
  const parsedIntake = runIntakeSchema.parse(intake);
  if (
    parsedIntake.mode === undefined ||
    parsedIntake.research === undefined ||
    parsedIntake.reflection === undefined
  ) {
    throw new Error(MISSING_RESOLUTION_ERROR);
  }

  const parsedConfig = configV2Schema.parse({
    ...config,
    profiles: {
      brain: config.profiles.brain,
      hands: config.profiles.hands,
      verifier: config.profiles.verifier,
    },
  });
  const roles: Record<RoleName, string> = {
    brain: parsedIntake.brain_model ?? parsedIntake.models?.brain ?? parsedConfig.profiles.brain.model,
    hands: parsedIntake.hands_model ?? parsedIntake.models?.hands ?? parsedConfig.profiles.hands.model,
    verifier:
      parsedIntake.verifier_model ??
      parsedIntake.models?.verifier ??
      parsedConfig.profiles.verifier.model,
  };

  return {
    ...parsedIntake,
    mode: parsedIntake.mode,
    research: parsedIntake.research,
    reflection: parsedIntake.reflection,
    brain_model: roles.brain,
    hands_model: roles.hands,
    verifier_model: roles.verifier,
    models: roles,
    resolved_models: roles,
    roles: {
      brain: { ...parsedConfig.profiles.brain, model: roles.brain },
      hands: { ...parsedConfig.profiles.hands, model: roles.hands },
      verifier: { ...parsedConfig.profiles.verifier, model: roles.verifier },
    },
    phase_reasoning: parsedIntake.phase_reasoning ?? parsedConfig.phase_reasoning ?? DEFAULT_PHASE_REASONING,
    review_policy: resolveReviewPolicy(
      parsedConfig.retry_policy.max_hands_fix_attempts,
      parsedConfig.review_policy,
      parsedIntake.review_policy,
    ),
    ...(parsedIntake.review_policy?.on_limit === "continue_with_warning"
      ? { warning_continuation_authority: { actor: "run-intake", source: "run_override" as const } }
      : {}),
  };
}
