import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bold,
  dim,
  formatError,
  formatHeader,
  formatInfo,
  formatJSON,
  formatKeyValue,
  formatSuccess,
  formatTable,
  formatWarning,
} from './output.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all ANSI escape sequences from a string for plain-text assertions. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe('formatTable', () => {
  it('aligns columns correctly', () => {
    const headers = ['Type', 'Count'];
    const rows = [
      ['pdf', '12'],
      ['markdown', '8'],
      ['html', '3'],
    ];

    const result = formatTable(headers, rows);
    const lines = result.split('\n');

    // Header line
    expect(lines[0]).toContain('Type');
    expect(lines[0]).toContain('Count');

    // Rule line uses ─ characters
    expect(lines[1]).toMatch(/^─/);
    expect(lines[1]).not.toContain('Type');

    // Data lines present
    expect(lines[2]).toContain('pdf');
    expect(lines[3]).toContain('markdown');
    expect(lines[4]).toContain('html');
  });

  it('aligns columns so each column starts at the same position in every row', () => {
    const headers = ['Name', 'Value'];
    const rows = [
      ['short', '1'],
      ['a-much-longer-name', '999'],
    ];

    const result = formatTable(headers, rows);
    const lines = result.split('\n');

    // All lines (header, rule, data) should have the same length when padded
    // — actually they should all be equal because every cell is padded to column width.
    const headerLen = lines[0]!.length;
    for (const line of lines) {
      expect(line.length).toBe(headerLen);
    }
  });

  it('returns header and rule only when rows is empty', () => {
    const result = formatTable(['Type', 'Count'], []);
    const lines = result.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Type');
    expect(lines[1]).toMatch(/^─+/);
  });

  it('uses the widest data cell to size each column, not just the header', () => {
    const headers = ['A', 'B'];
    const rows = [['long-value', 'x']];

    const result = formatTable(headers, rows);
    const lines = result.split('\n');

    // Column A header should be padded to at least 'long-value'.length
    expect(lines[0]!.startsWith('A' + ' '.repeat('long-value'.length - 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status formatters
// ---------------------------------------------------------------------------

describe('formatSuccess', () => {
  it('contains the checkmark and the message', () => {
    const result = stripAnsi(formatSuccess('All good'));
    expect(result).toContain('✓');
    expect(result).toContain('All good');
  });
});

describe('formatError', () => {
  it('contains the X symbol and the message', () => {
    const result = stripAnsi(formatError('Something broke'));
    expect(result).toContain('✗');
    expect(result).toContain('Something broke');
  });
});

describe('formatWarning', () => {
  it('contains the warning triangle and the message', () => {
    const result = stripAnsi(formatWarning('Watch out'));
    expect(result).toContain('⚠');
    expect(result).toContain('Watch out');
  });
});

describe('formatInfo', () => {
  it('contains the info circle and the message', () => {
    const result = stripAnsi(formatInfo('Here is some info'));
    expect(result).toContain('●');
    expect(result).toContain('Here is some info');
  });
});

// ---------------------------------------------------------------------------
// formatJSON
// ---------------------------------------------------------------------------

describe('formatJSON', () => {
  it('produces valid JSON with 2-space indentation', () => {
    const data = { name: 'ico', version: 1, active: true };
    const result = formatJSON(data);

    // Must be parseable JSON
    const parsed = JSON.parse(result) as typeof data;
    expect(parsed).toEqual(data);

    // Must use 2-space indent (inner keys are indented by 2 spaces)
    expect(result).toContain('\n  "name"');
  });

  it('handles arrays', () => {
    const result = formatJSON([1, 2, 3]);
    expect(JSON.parse(result)).toEqual([1, 2, 3]);
  });

  it('returns a fallback string for circular references rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = formatJSON(circular);
    expect(typeof result).toBe('string');
    expect(result).toContain('unserializable');
  });
});

// ---------------------------------------------------------------------------
// formatKeyValue
// ---------------------------------------------------------------------------

describe('formatKeyValue', () => {
  it('right-pads keys to a consistent width', () => {
    const pairs: [string, string | number][] = [
      ['Sources', 23],
      ['Compiled', 18],
      ['Tasks', 2],
    ];

    const result = formatKeyValue(pairs);
    const lines = result.split('\n');

    // The position of the value should be the same on every line.
    // We find where the first digit/non-space character after the colon appears.
    const valuePositions = lines.map((line) => {
      // After the key+colon block, values start after the padding.
      const match = line.match(/:\s+(\S)/);
      return match ? line.indexOf(match[1]!) : -1;
    });

    const firstPos = valuePositions[0]!;
    for (const pos of valuePositions) {
      expect(pos).toBe(firstPos);
    }
  });

  it('returns an empty string for an empty pairs array', () => {
    expect(formatKeyValue([])).toBe('');
  });

  it('includes both the key and the value in the output', () => {
    const result = formatKeyValue([['Status', 'ok']]);
    expect(result).toContain('Status');
    expect(result).toContain('ok');
  });
});

// ---------------------------------------------------------------------------
// formatHeader
// ---------------------------------------------------------------------------

describe('formatHeader', () => {
  it('returns the title followed by an underline of equal length', () => {
    const title = 'Knowledge Base';
    const result = formatHeader(title);

    expect(result).toContain(title);

    const lines = result.split('\n');
    // First line is blank (leading newline), second is the title, third is rule.
    expect(lines).toHaveLength(3);
    const ruleLine = lines[2]!;
    expect(ruleLine.length).toBe(title.length);
    expect(ruleLine).toMatch(/^─+$/);
  });
});

// ---------------------------------------------------------------------------
// NO_COLOR suppression
// ---------------------------------------------------------------------------

describe('color suppression via NO_COLOR', () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
  });

  it('formatSuccess returns plain text without ANSI codes when NO_COLOR is set', () => {
    const result = formatSuccess('done');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/\x1b\[/);
    expect(result).toContain('✓');
    expect(result).toContain('done');
  });

  it('formatError returns plain text without ANSI codes when NO_COLOR is set', () => {
    const result = formatError('boom');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/\x1b\[/);
  });

  it('bold returns plain text without ANSI codes when NO_COLOR is set', () => {
    const result = bold('important');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/\x1b\[/);
    expect(result).toBe('important');
  });

  it('dim returns plain text without ANSI codes when NO_COLOR is set', () => {
    const result = dim('secondary');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/\x1b\[/);
    expect(result).toBe('secondary');
  });
});

// ---------------------------------------------------------------------------
// bold and dim produce correct ANSI codes when colors ARE enabled
// ---------------------------------------------------------------------------

describe('bold and dim ANSI codes', () => {
  // Force colors on for these tests by temporarily making isTTY truthy
  // and ensuring NO_COLOR is absent.
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env['NO_COLOR'];
    delete process.env['NO_COLOR'];

    originalIsTTY = process.stdout.isTTY;
    // Cast to allow assignment in test environment (process.stdout is writable).
    (process.stdout as { isTTY: boolean }).isTTY = true;
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
    (process.stdout as { isTTY: boolean | undefined }).isTTY = originalIsTTY;
  });

  it('bold wraps text with BOLD and RESET codes', () => {
    const result = bold('headline');
    expect(result).toBe('\x1b[1mheadline\x1b[0m');
  });

  it('dim wraps text with DIM and RESET codes', () => {
    const result = dim('hint');
    expect(result).toBe('\x1b[2mhint\x1b[0m');
  });
});
