/**
 * Every recorded limitation withholds a handoff, so the prompts must say what one is. Real
 * models otherwise list findings ("no tests exist for X") and generic caveats about static
 * analysis as limitations (observed live on every Gemini Testing and Feature run).
 */
export const LIMITATIONS_DEFINITION = "A limitation is something you could not inspect or decide that leaves this result incomplete, such as a file you could not read; missing tests, risks, assumptions and generic caveats about static analysis are not limitations. Return an empty limitations array when your work was complete.";

/**
 * Exploration surfaces must cite existing files. Observed live: a model with a feature that
 * needed a new test file gave it a surface with no paths, was refused, and on repair recorded
 * "no test file exists" as a limitation, which withheld the handoff of a complete exploration.
 */
export const NEW_FILES_ARE_NOT_SURFACES = "Surfaces name existing snapshot files only. A file the feature will have to create, such as a new test file, is neither a surface nor a limitation: mention it in the summary for the planner.";
