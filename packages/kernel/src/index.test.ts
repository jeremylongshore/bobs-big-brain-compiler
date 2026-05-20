import { describe, expect, it } from 'vitest';

import * as kernel from './index.js';

describe('@ico/kernel barrel export', () => {
  it('exports all workspace functions', () => {
    expect(typeof kernel.initWorkspace).toBe('function');
  });

  it('exports all database functions', () => {
    expect(typeof kernel.initDatabase).toBe('function');
    expect(typeof kernel.closeDatabase).toBe('function');
    expect(typeof kernel.runMigrations).toBe('function');
  });

  it('exports all mount functions', () => {
    expect(typeof kernel.registerMount).toBe('function');
    expect(typeof kernel.listMounts).toBe('function');
    expect(typeof kernel.getMount).toBe('function');
    expect(typeof kernel.getMountByName).toBe('function');
    expect(typeof kernel.removeMount).toBe('function');
  });

  it('exports all source functions', () => {
    expect(typeof kernel.registerSource).toBe('function');
    expect(typeof kernel.getSource).toBe('function');
    expect(typeof kernel.listSources).toBe('function');
    expect(typeof kernel.isSourceChanged).toBe('function');
    expect(typeof kernel.computeFileHash).toBe('function');
  });

  it('exports all provenance functions', () => {
    expect(typeof kernel.recordProvenance).toBe('function');
    expect(typeof kernel.getProvenance).toBe('function');
    expect(typeof kernel.getDerivations).toBe('function');
  });

  it('exports all trace functions', () => {
    expect(typeof kernel.writeTrace).toBe('function');
    expect(typeof kernel.readTraces).toBe('function');
  });

  it('exports all task functions', () => {
    expect(typeof kernel.createTask).toBe('function');
    expect(typeof kernel.transitionTask).toBe('function');
    expect(typeof kernel.getTask).toBe('function');
    expect(typeof kernel.listTasks).toBe('function');
  });

  it('exports wiki and audit functions', () => {
    expect(typeof kernel.rebuildWikiIndex).toBe('function');
    expect(typeof kernel.appendAuditLog).toBe('function');
  });

  it('exports config and logging functions', () => {
    expect(typeof kernel.loadConfig).toBe('function');
    expect(typeof kernel.redactSecrets).toBe('function');
    expect(typeof kernel.createLogger).toBe('function');
    expect(typeof kernel.Logger).toBe('function');
  });

  it('exports version string', () => {
    expect(typeof kernel.version).toBe('string');
  });

  it('does NOT export internal helpers', () => {
    expect((kernel as Record<string, unknown>)['initDatabaseWithMigrations']).toBeUndefined();
  });
});
