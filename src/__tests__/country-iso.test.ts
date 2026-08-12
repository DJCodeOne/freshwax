import { describe, it, expect } from 'vitest';
import { countryToISO, regionForCountry } from '../lib/order/shipping-rules';

// countryToISO is now the shippable-destinations allowlist. It replaced
// Stripe's shipping_address_collection[allowed_countries], so a gap here lets
// an unshippable order through — or blocks a legitimate one at checkout.
describe('countryToISO', () => {
  it('maps every name the checkout form offers', () => {
    // Must stay in sync with the <select> in lib/checkout/checkout-ui.ts
    expect(countryToISO('United Kingdom')).toBe('GB');
    expect(countryToISO('Ireland')).toBe('IE');
    expect(countryToISO('Germany')).toBe('DE');
    expect(countryToISO('France')).toBe('FR');
    expect(countryToISO('Netherlands')).toBe('NL');
    expect(countryToISO('Belgium')).toBe('BE');
    expect(countryToISO('USA')).toBe('US');
    expect(countryToISO('Canada')).toBe('CA');
    expect(countryToISO('Australia')).toBe('AU');
  });

  it('accepts ISO codes too, in either case', () => {
    expect(countryToISO('GB')).toBe('GB');
    expect(countryToISO('gb')).toBe('GB');
    expect(countryToISO('us')).toBe('US');
  });

  it('accepts "UK", which is not the ISO code but is what people type', () => {
    expect(countryToISO('UK')).toBe('GB');
    expect(countryToISO('uk')).toBe('GB');
  });

  it('accepts "United States" as well as "USA"', () => {
    expect(countryToISO('United States')).toBe('US');
  });

  it('tolerates surrounding whitespace', () => {
    expect(countryToISO('  United Kingdom  ')).toBe('GB');
  });

  it('rejects countries we do not ship to', () => {
    expect(countryToISO('Japan')).toBeNull();
    expect(countryToISO('JP')).toBeNull();
    expect(countryToISO('Brazil')).toBeNull();
  });

  it('rejects empty and missing values rather than defaulting to GB', () => {
    // Defaulting here would silently ship an addressless order to the UK.
    expect(countryToISO('')).toBeNull();
    expect(countryToISO('   ')).toBeNull();
    expect(countryToISO(null)).toBeNull();
    expect(countryToISO(undefined)).toBeNull();
  });

  it('returns a 2-letter uppercase code for everything it accepts', () => {
    for (const name of ['United Kingdom', 'Ireland', 'USA', 'Canada', 'Australia']) {
      const iso = countryToISO(name)!;
      expect(iso).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe('countryToISO agrees with regionForCountry', () => {
  // Both read the same country string off the order; if they disagree, a
  // customer gets charged one region's postage and shipped under another's.
  it('every shippable country resolves to a region', () => {
    for (const name of [
      'United Kingdom', 'Ireland', 'Germany', 'France', 'Netherlands',
      'Belgium', 'USA', 'Canada', 'Australia',
    ]) {
      expect(countryToISO(name)).not.toBeNull();
      expect(['UK', 'EU', 'INTL']).toContain(regionForCountry(name));
    }
  });

  it('UK names and codes agree across both helpers', () => {
    for (const v of ['United Kingdom', 'GB', 'UK']) {
      expect(countryToISO(v)).toBe('GB');
      expect(regionForCountry(v)).toBe('UK');
    }
  });

  it('EU members map to EU, non-EU shippables to INTL', () => {
    expect(regionForCountry('Germany')).toBe('EU');
    expect(regionForCountry('Ireland')).toBe('EU');
    expect(regionForCountry('USA')).toBe('INTL');
    expect(regionForCountry('Australia')).toBe('INTL');
  });
});
