/**
 * Every recorded limitation withholds a handoff, so the prompts must say what one is. Real
 * models otherwise list findings ("no tests exist for X") and generic caveats about static
 * analysis as limitations (observed live on every Gemini Testing and Feature run).
 */
export const LIMITATIONS_DEFINITION = "A limitation is something you could not inspect or decide that leaves this result incomplete, such as a file you could not read; missing tests, risks, assumptions and generic caveats about static analysis are not limitations. Return an empty limitations array when your work was complete.";
