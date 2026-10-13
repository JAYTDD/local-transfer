import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { autostartWorkdir, enableTaskScript, launcherPath, launcherScript, productionEntry, quotePs } from '../src/autostart.js';

describe('autostart command', () => {
  it('registers wscript so the logon task does not open a console', () => {
    const script = enableTaskScript(
      'C:\\Windows\\System32\\wscript.exe',
      'D:\\ProjectSave\\local-transfer\\data\\autostart.vbs',
      'D:\\ProjectSave\\local-transfer',
    );
    expect(script).toContain("-Execute 'C:\\Windows\\System32\\wscript.exe'");
    expect(script).toContain('-Argument \'"D:\\ProjectSave\\local-transfer\\data\\autostart.vbs"\'');
    expect(script).toContain("-WorkingDirectory 'D:\\ProjectSave\\local-transfer'");
    expect(script).toContain("-TaskName 'AiHub'");
    expect(script).not.toContain('schtasks');
  });

  it('starts node hidden from the launcher script', () => {
    const script = launcherScript(
      'C:\\Program Files\\nodejs\\node.exe',
      'D:\\ProjectSave\\local-transfer\\apps\\server\\dist\\index.js',
      'D:\\ProjectSave\\local-transfer',
    );
    expect(script).toContain('shell.CurrentDirectory = "D:\\ProjectSave\\local-transfer"');
    expect(script).toContain('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""D:\\ProjectSave\\local-transfer\\apps\\server\\dist\\index.js""", 0, False');
    expect(launcherPath('D:\\ProjectSave\\local-transfer')).toBe('D:\\ProjectSave\\local-transfer\\data\\autostart.vbs');
  });

  it('escapes single quotes in paths', () => {
    expect(quotePs("C:\\Users\\O'Brien\\node.exe")).toBe("'C:\\Users\\O''Brien\\node.exe'");
  });

  it('points a src module at the sibling dist entry and the repo root', () => {
    const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/autostart.ts')).href;
    const entry = productionEntry(moduleUrl);
    expect(entry).toMatch(/[\\/]apps[\\/]server[\\/]dist[\\/]index\.js$/);
    expect(autostartWorkdir(entry)).toMatch(/local-transfer$/);
  });
});
