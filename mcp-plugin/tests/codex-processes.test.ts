import { expect, test } from "bun:test";
import { externalCodexPresent, parseProcesses } from "../codex/processes.ts";

test('process parser rejects invalid, zero and unsafe PIDs but permits root parent zero', () => {
  const rows=parseProcesses('0 1 codex\n-1 1 codex\n2 -1 codex\n9007199254740992 1 codex\n3 9007199254740992 codex\n1.5 1 codex\nno process\n  4 0 codex\r\n9007199254740991 9007199254740991 worker');
  expect(rows).toEqual([{pid:4,ppid:0,command:'codex'},{pid:Number.MAX_SAFE_INTEGER,ppid:Number.MAX_SAFE_INTEGER,command:'worker'}]);
});

test('recognizes quoted Windows paths and unquoted executable arguments', () => {
  for(const command of ['"C:\\Program Files\\Codex\\codex.exe" app-server','"/Applications/Codex App/codex" --help','/usr/local/bin/codex --model gpt-5','codex.exe --help',' CODEX.CMD --help ', 'C:\\bin\\codex.bat --help']) {
    expect(externalCodexPresent([{pid:20,ppid:1,command}],10)).toBe(true);
  }
});

test('preserves unquoted macOS paths with spaces and exact executable matching', () => {
  for(const command of ['/Applications/Codex App/codex','/Applications/My Apps/codex','/app/codex','codex']) {
    expect(externalCodexPresent([{pid:20,ppid:1,command}],10)).toBe(true);
  }
  for(const command of ['codex-helper --help','/usr/bin/not-codex','"/app/codex-helper" codex','"/app/codex --help','/usr/bin/node --help']) {
    expect(externalCodexPresent([{pid:20,ppid:1,command}],10)).toBe(false);
  }
});

test('invalid manager PID cannot classify unrelated root processes as children', () => {
  for(const managerPid of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
    expect(externalCodexPresent([{pid:20,ppid:0,command:'codex'},{pid:21,ppid:20,command:'worker'}],managerPid)).toBe(true);
  }
});

test('valid manager excludes all descendants regardless of row order and tolerates cycles', () => {
  const rows=parseProcesses('13 12 codex --help\n12 11 worker\n11 10 worker\n10 1 codex\n30 31 worker\n31 30 worker');
  expect(externalCodexPresent(rows,10)).toBe(false);
  expect(externalCodexPresent([...rows,{pid:40,ppid:1,command:'codex --model gpt-5'}],10)).toBe(true);
});

test('parser skips control-bearing rows and caps inspected input at 65536 lines', () => {
  for (const control of ['\x00','\x01','\x08','\x09','\x0b','\x0c','\x1f','\x7f']) expect(parseProcesses(`1 0 code${control}x\n2 0 worker`)).toEqual([{pid:2,ppid:0,command:'worker'}]);
  const lines = Array.from({length:65_536}, (_,i) => `${i+1} 0 worker`);
  expect(parseProcesses([...lines,'70000 0 codex'].join('\n'))).toHaveLength(65_536);
  expect(parseProcesses([...Array(65_536).fill('invalid'),'70000 0 codex'].join('\n'))).toEqual([]);
});

test('deep reversed trees and connected cycles traverse each parent once', () => {
  let reads=0;
  const rows=Array.from({length:20_000}, (_,i) => {
    const pid=20_001-i;
    return {pid, get ppid() { reads++; return pid-1; }, command:'codex'};
  });
  rows.push({pid:1,ppid:20_001,command:'worker'});
  expect(externalCodexPresent(rows,1)).toBe(false); expect(reads).toBeLessThanOrEqual(rows.length*2);
  expect(externalCodexPresent([...rows,{pid:30_000,ppid:30_001,command:'codex'},{pid:30_001,ppid:30_000,command:'worker'}],1)).toBe(true);
});
