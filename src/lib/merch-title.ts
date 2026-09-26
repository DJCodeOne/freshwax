// src/lib/merch-title.ts
// Display title + brand for merch products.
//
// Merch is named generically ("Hoodie", "Mug", "Classic Unisex T-Shirt"), so
// 21 products shared four page titles and four Google Shopping titles, and
// every item claimed brand "Fresh Wax" — including label and sound-system
// merch (Fresh Wax is the store, not their brand). The real brand is stored
// in categoryName by upload-merch, so titles lead with it and the brand
// reflects it. Used by the product page and the Shopping feed so they agree.

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The product's brand: an explicit `brand`, else its label/sound-system `categoryName`, else Fresh Wax. */
export function merchBrand(item: Record<string, unknown>): string {
  return clean(item.brand) || clean(item.categoryName) || 'Fresh Wax';
}

/** "<brand> <name>", unless the name already mentions the brand. */
export function merchDisplayTitle(name: string, brand: string): string {
  const productName = name.trim() || 'Merchandise';
  if (!brand || productName.toLowerCase().includes(brand.toLowerCase())) return productName;
  return `${brand} ${productName}`;
}
