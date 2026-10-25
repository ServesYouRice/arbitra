import type { ReactElement } from "react";
import type { ReadFile } from "../../api/runs.js";
import { counted } from "../../app/words.js";
import { folderGroups, groupRead, leftOut, reading, sum, testsRead, withGroup, withTests, type FolderGroup } from "./reading.js";

export interface Suggestion { readonly path: string; readonly lines: number; readonly reason: string }

/** A share of what the run reads, as people read one: "38%", "under 1%". */
export function share(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  const percent = Math.round(part / total * 100);
  return percent === 0 ? "under 1%" : `${percent}%`;
}

/**
 * What the run reads, from the check's list of the project's files: a tick per folder, one for the tests, and the
 * files that look generated, vendored or minified, left out with their reason unless ticked back in. Each changes
 * the scope's leave-outs, and the estimate follows at once.
 */
export function WhatToRead({ files, complete, suggestions, exclude, onExclude, onSuggestion }: {
  readonly files: readonly ReadFile[]; readonly complete: boolean; readonly suggestions: readonly Suggestion[]; readonly exclude: readonly string[];
  readonly onExclude: (next: readonly string[]) => void; readonly onSuggestion: (path: string, leave: boolean) => void;
}): ReactElement {
  const groups = folderGroups(files);
  const read = reading(files, exclude);
  const tests = files.filter(({ test }) => test);
  const testsOn = testsRead(files, exclude);
  const generated = suggestions.filter(({ path }) => leftOut(exclude, path));
  return <div className="reading">
    <div className="table-scroll"><table aria-label="folders" className="table reading-table">
      <thead><tr><th scope="col">read</th><th scope="col">folder</th><th scope="col">files</th><th scope="col">lines</th><th scope="col">of the estimate</th></tr></thead>
      <tbody>{groups.map((group) => {
        const on = groupRead(group, exclude);
        const groupLines = sum(group.files.filter(({ path }) => !leftOut(exclude, path)));
        return <tr data-read={on} key={group.id}>
          <td><input aria-label={`read ${group.label}`} checked={on} type="checkbox" onChange={(event) => onExclude(withGroup(exclude, groups, group, event.target.checked))} /></td>
          <td>{group.label}</td><td>{group.files.length.toLocaleString("en")}</td><td>{sum(group.files).toLocaleString("en")}</td>
          <td>{on ? share(groupLines, read.lines) : "left out"}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {tests.length === 0 ? <p className="note">No tests found by their names or folders.</p> : <div className="switch-row">
      <label className="tick"><input aria-label="audit the tests" checked={testsOn} type="checkbox" onChange={(event) => onExclude(withTests(exclude, files, event.target.checked))} />
        <span>Audit the tests · <span className="mono">{testsOn ? `${read.testLines.toLocaleString("en")} of these lines (${share(read.testLines, read.lines)})` : `${sum(tests).toLocaleString("en")} lines left out`}</span></span></label>
      <p className="field__hint">On four runs, 6 to 15% of the confirmed issues were in tests, mostly tests that cannot catch the defect they are named for; parts holding only tests took about 4 to 7% of the tokens.</p>
    </div>}
    {suggestions.length === 0 ? null : <details className="disclosure" open>
      <summary>Left out · {counted(generated.length, "file")} that look{generated.length === 1 ? "s" : ""} generated, vendored or minified · {sum(generated).toLocaleString("en")} lines</summary>
      <ul aria-label="generated files" className="plain-list generated">{suggestions.map(({ path, lines, reason }) => {
        const out = exclude.includes(path);
        const above = !out && leftOut(exclude, path);
        return <li key={path}><label className="tick"><input aria-label={`leave out ${path}`} checked={out || above} disabled={above} type="checkbox" onChange={(event) => onSuggestion(path, event.target.checked)} />
          <span><span className="mono">{path}</span> · {lines.toLocaleString("en")} lines<span className="field__hint"> {above ? "Its folder is left out." : reason}</span></span></label></li>;
      })}</ul>
      <p className="field__hint">An audit of them reports defects in code nobody edits. Untick one to read it anyway.</p>
    </details>}
    {complete ? null : <p className="note">Some leave-outs are not counted here: without them the project is more than a run reads.</p>}
  </div>;
}

/**
 * A project over the file limit: how many source files each folder holds, and one tick each to leave it out until the
 * rest fits. The page reads the project again after each tick; once it fits, the folder table above takes over.
 */
export function OverLimit({ folders, complete, limit, exclude, onExclude }: {
  readonly folders: readonly { readonly path: string; readonly files: number }[]; readonly complete: boolean; readonly limit: number;
  readonly exclude: readonly string[]; readonly onExclude: (next: readonly string[]) => void;
}): ReactElement {
  const groups: readonly (FolderGroup & { readonly count: number })[] = folders.map(({ path, files }) => ({ id: path, label: path === "" ? "files at the top" : path, leaveOut: path === "" ? [] : [path], files: [], count: files }));
  const read = (group: FolderGroup): boolean => group.leaveOut.length === 0 || groupRead(group, exclude);
  const total = groups.reduce((all, { count }) => all + count, 0);
  const kept = groups.filter(read).reduce((all, { count }) => all + count, 0);
  return <div className="reading">
    <p className="state" data-state="refuted">{total.toLocaleString("en")}{complete ? "" : " or more"} source files: a run reads at most {limit.toLocaleString("en")}. Leave out folders until it fits.</p>
    <div className="table-scroll"><table aria-label="folders" className="table reading-table">
      <thead><tr><th scope="col">read</th><th scope="col">folder</th><th scope="col">files</th></tr></thead>
      <tbody>{groups.map((group) => <tr data-read={read(group)} key={group.id}>
        <td>{group.leaveOut.length === 0 ? null : <input aria-label={`read ${group.label}`} checked={read(group)} type="checkbox" onChange={(event) => onExclude(withGroup(exclude, groups, group, event.target.checked))} />}</td>
        <td>{group.label}</td><td>{group.count.toLocaleString("en")}</td>
      </tr>)}</tbody>
    </table></div>
    {kept === total ? null : <p className="note" role="status">{kept.toLocaleString("en")} source files with these folders left out: {kept <= limit ? "that fits." : "still too many."}</p>}
  </div>;
}
