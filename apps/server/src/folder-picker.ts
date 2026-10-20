import { execFile } from "node:child_process";

/**
 * Opens the operating system's own folder dialog on this machine and returns the chosen path, or null when the person
 * cancels. A browser page cannot learn a folder's full path itself, and the control plane only listens on loopback, so
 * the dialog opens on the same desktop as the browser. Windows uses Windows Forms through PowerShell, macOS
 * AppleScript, Linux zenity where it is installed.
 */
export function pickFolder(prompt: string): Promise<string | null> {
  const [command, args] = pickerCommand(prompt);
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 15 * 60_000 }, (error, stdout) => {
      const path = stdout.trim().replace(/(?<=.)[\\/]$/u, "");
      if (path !== "") { resolve(path); return; }
      // Every picker exits non-zero with nothing on stdout when the person cancels.
      if (error === null || typeof error.code === "number") { resolve(null); return; }
      reject(Object.assign(new Error(`FOLDER_PICKER_UNAVAILABLE: ${command} could not be started; type the path instead`), { statusCode: 501 }));
    });
  });
}

function pickerCommand(prompt: string): readonly [string, readonly string[]] {
  if (process.platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      // An owner window kept on top brings the dialog in front of the browser.
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${prompt.replace(/'/gu, "''")}'`,
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit 1 }",
    ].join("; ");
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]];
  }
  if (process.platform === "darwin") return ["osascript", ["-e", `POSIX path of (choose folder with prompt "${prompt.replace(/["\\]/gu, "")}")`]];
  return ["zenity", ["--file-selection", "--directory", `--title=${prompt}`]];
}
