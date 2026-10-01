import { describe, expect, it } from 'vitest';
import { availableTabs, parseTab } from './tabs';

describe('portal tabs', () => {
  it('shows every tab when everything is allowed', () => {
    expect(availableTabs({ files: true, messages: true })).toEqual(['overview', 'upload', 'files', 'uploads', 'messages']);
  });
  it('hides files/uploads and messages independently', () => {
    expect(availableTabs({ files: false, messages: true })).toEqual(['overview', 'upload', 'messages']);
    expect(availableTabs({ files: true, messages: false })).toEqual(['overview', 'upload', 'files', 'uploads']);
    expect(availableTabs({ files: false, messages: false })).toEqual(['overview', 'upload']);
  });
  it('falls back to overview for unknown or hidden tabs', () => {
    const tabs = availableTabs({ files: false, messages: true });
    expect(parseTab('messages', tabs)).toBe('messages');
    expect(parseTab('files', tabs)).toBe('overview');
    expect(parseTab('nope', tabs)).toBe('overview');
    expect(parseTab(null, tabs)).toBe('overview');
  });
});
