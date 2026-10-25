import type { ReactElement } from "react";
import type { ReadFile } from "../../api/runs.js";
import { counted } from "../../app/words.js";
import { covers, folderGroups, groupRead, leaveOutPath, leftOut, reading, sum, testsRead, withGroup, withPath, withTests, type FolderGroup } from "./reading.js";

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
  // Without its leave-outs the project is more than a run reads, so what they leave out is not listed: each is a row
  // of its own, ticked back in to read the project again.
  const uncounted = complete ? [] : exclude.filter((entry) => !files.some(({ path }) => covers(entry, path)));
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
      })}{uncounted.map((entry) => <tr data-read="false" key={`left out ${entry}`}>
        <td><input aria-label={`read ${entry}`} checked={false} type="checkbox" onChange={() => onExclude(withPath(exclude, leaveOutPath(entry), false))} /></td>
        <td>{entry}</td><td colSpan={2}>not counted</td><td>left out</td>
      </tr>)}</tbody>
    </table></div>
    {tests.length === 0 ? <p className="note">No tests found by their names or folders.</p> : <label className="box-row tick"><input aria-label="audit the tests" checked={testsOn} type="checkbox" onChange={(event) => onExclude(withTests(exclude, files, event.target.checked))} />
      <span><span className="mono box-row__title">Audit the tests too · {testsOn ? `${read.testLines.toLocaleString("en")} of these lines (${share(read.testLines, read.lines)})` : `${sum(tests).toLocaleString("en")} lines left out`}</span>
        <span className="field__hint">On four runs, 6 to 15% of confirmed issues were in tests, mostly tests that cannot catch the defect they are named for.</span></span></label>}
    {suggestions.length === 0 ? null : <details className="box-fold">
      <summary>Left out · {counted(generated.length, "generated file")} · {sum(generated).toLocaleString("en")} lines</summary>
      <ul aria-label="generated files" className="plain-list generated">{suggestions.map(({ path, lines, reason }) => {
        const out = exclude.includes(path);
        const above = !out && leftOut(exclude, path);
        return <li key={path}><label className="generated__row"><input aria-label={`leave out ${path}`} checked={out || above} disabled={above} type="checkbox" onChange={(event) => onSuggestion(path, event.target.checked)} />
          <span className="generated__path">{path}</span><span className="generated__why">{above ? "its folder is left out" : reason}</span><span className="generated__lines">{lines.toLocaleString("en")}</span></label></li>;
      })}</ul>
      <p className="field__hint generated__note">Generated, vendored or minified: an audit of them reports defects in code nobody edits. Untick one to read it anyway.</p>
    </details>}
    {uncounted.length === 0 ? null : <p className="note">Left out paths are not counted: without them the project is more than a run reads.</p>}
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
