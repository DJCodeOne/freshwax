import { describe, it, expect } from 'vitest';
import { merchBrand, merchDisplayTitle } from '../lib/merch-title';

describe('merchBrand', () => {
  it('uses the label / sound-system categoryName', () => {
    expect(merchBrand({ name: 'Hoodie', categoryName: 'Underground Lair Recordings' })).toBe('Underground Lair Recordings');
  });

  it('prefers an explicit brand field', () => {
    expect(merchBrand({ brand: 'Rebel Culture', categoryName: 'Something Else' })).toBe('Rebel Culture');
  });

  it('falls back to Fresh Wax when nothing is set', () => {
    expect(merchBrand({ name: 'Mug' })).toBe('Fresh Wax');
    expect(merchBrand({ brand: '  ', categoryName: '' })).toBe('Fresh Wax');
  });
});

describe('merchDisplayTitle', () => {
  it('leads with the brand so generic names become distinct', () => {
    expect(merchDisplayTitle('Hoodie', 'Drum Unit Recordings')).toBe('Drum Unit Recordings Hoodie');
    expect(merchDisplayTitle('Mug', 'Danger Chamber Digital')).toBe('Danger Chamber Digital Mug');
  });

  it('does not repeat a brand the name already contains', () => {
    expect(merchDisplayTitle('Rebel Culture Classic Tee', 'Rebel Culture')).toBe('Rebel Culture Classic Tee');
    expect(merchDisplayTitle('fresh wax hoodie', 'Fresh Wax')).toBe('fresh wax hoodie');
  });

  it('handles blank names and brands', () => {
    expect(merchDisplayTitle('   ', 'Fresh Wax')).toBe('Fresh Wax Merchandise');
    expect(merchDisplayTitle('Hoodie', '')).toBe('Hoodie');
  });
});
